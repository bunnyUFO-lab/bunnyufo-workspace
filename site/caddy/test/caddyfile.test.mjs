// The real site/caddy/Caddyfile in a capped throwaway `caddy:2-alpine` container, in front of a fake upstream
// started here: what is compressed, what is never (event streams, media, ranges), that conditional requests
// still reach the service with the plain ETag, and which answers may be cached for a year.
// Without Docker the tests skip, except under CI, where a missing Docker is a failure.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CADDYFILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'Caddyfile');
const IMAGE = 'caddy:2-alpine';
const DEADLINE_MS = 110_000;
const NAME = `buw-caddyfile-test-${process.pid}-${Date.now()}`;
const HEADERS = { 'Accept-Encoding': 'zstd, gzip' };

const hasDocker = (() => { try { execFileSync('docker', ['version', '--format', '{{.Server.Version}}'], { stdio: 'ignore', timeout: 20_000 }); return true; } catch { return false; } })();
if (!hasDocker && process.env.CI) throw new Error('Docker is required in CI: the Caddyfile test must not pass by skipping.');
const skip = hasDocker ? false : 'Docker is not available here, so the Caddyfile is not tested (CI fails instead of skipping).';

const json = 'x'.repeat(100) + JSON.stringify(Array.from({ length: 800 }, (_, i) => ({ i, name: `row${i}` })));
const small = '{"ok":true}';
const bytes = Buffer.alloc(5000, 7);
let workDir; let upstream; let hostPort; let gatePort; let child; let gateChild; let removed = false;
const GATE_NAME = `${NAME}-gate`;
const upstreamSaw = { inm: undefined, writes: [], remoteUser: undefined };
const streams = {}; // route -> { timedOut, ack(n) }

const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const removeContainer = () => { if (removed) return; removed = true; for (const name of [NAME, GATE_NAME]) { try { execFileSync('docker', ['rm', '-f', name], { stdio: 'ignore', timeout: 30_000 }); } catch { /* already gone */ } } };

/** An event stream that writes the next event only once the test has seen the previous one: a proxy that buffers or compresses it in blocks makes the wait run out. */
function lockstepStream(response, route) {
  let waiting = null;
  const state = streams[route] = { timedOut: false, ack: n => { if (waiting?.n === n) waiting.done(); } };
  response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' });
  (async () => {
    for (let n = 0; n < 4; n += 1) {
      response.write(`event: tick\ndata: ${n}\n\n`);
      const got = await new Promise(resolve => { const t = setTimeout(() => resolve(false), 5000); waiting = { n, done: () => { clearTimeout(t); resolve(true); } }; });
      if (!got) { state.timedOut = true; break; }
    }
    response.end();
  })();
}

/** One request; `onChunk` sees each chunk as it arrives. */
function ask(url, headers = {}, { method = 'GET', body, onChunk, port = hostPort } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: url, method, headers: { ...HEADERS, ...headers } }, res => {
      let size = 0; const chunks = [];
      res.on('data', chunk => { size += chunk.length; chunks.push(chunk); onChunk?.(chunk); });
      res.on('end', () => resolve({ status: res.statusCode, h: res.headers, size, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(15_000, () => req.destroy(new Error(`timeout: ${url}`)));
    req.end(body);
  });
}

before(async () => {
  if (skip) return;
  workDir = mkdtempSync(path.join(tmpdir(), 'buw-caddyfile-'));
  const ui = path.join(workDir, 'ui');
  mkdirSync(path.join(ui, 'assets'), { recursive: true });
  writeFileSync(path.join(ui, 'index.html'), `<!doctype html>${'<p>shell</p>'.repeat(300)}`);
  writeFileSync(path.join(ui, 'sw.js'), '// worker\n'.repeat(400));
  writeFileSync(path.join(ui, 'manifest.webmanifest'), `{"a":"${'b'.repeat(2000)}"}`);
  writeFileSync(path.join(ui, 'assets', 'index-AbCd_-12.js'), 'var a=1;\n'.repeat(1000));
  writeFileSync(path.join(ui, 'assets', 'index-Zy9_x-81.css'), 'a{color:red}\n'.repeat(500));
  writeFileSync(path.join(ui, 'assets', 'icon-maskable-512.png'), Buffer.alloc(3000, 1));

  upstream = http.createServer((req, res) => {
    const url = req.url;
    if (url.startsWith('/api/hub/requests/r1/events')) return lockstepStream(res, 'run');
    if (url === '/api/hub/chat' && req.method === 'POST') { req.resume(); return lockstepStream(res, 'chat'); }
    if (req.method === 'POST' && url.startsWith('/api/hub/team/')) { upstreamSaw.writes.push(url); req.resume(); res.writeHead(201, { 'Content-Type': 'application/json' }); return res.end('{"reached":true}'); }
    if (url === '/api/whoami') { upstreamSaw.remoteUser = req.headers['remote-user']; res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{}'); }
    if (url === '/api/json') { res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(json), 'Cache-Control': 'no-store' }); return res.end(json); }
    if (url === '/api/small') { res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': small.length }); return res.end(small); }
    if (url.startsWith('/w/x/a.json')) {
      upstreamSaw.inm = req.headers['if-none-match'];
      if (upstreamSaw.inm === '"md5abc"') { res.writeHead(304, { ETag: '"md5abc"', 'Cache-Control': 'no-cache' }); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(json), ETag: '"md5abc"', 'Cache-Control': 'no-cache' }); return res.end(json);
    }
    if (url.startsWith('/w/x/v.mp4')) { res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': bytes.length, ETag: '"vid"' }); return res.end(bytes); }
    if (url.startsWith('/w/x/p.png')) { res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': bytes.length }); return res.end(bytes); }
    res.writeHead(404); res.end();
  });
  await new Promise(resolve => upstream.listen(0, '0.0.0.0', resolve));
  hostPort = await freePort();

  const args = ['run', '--rm', '--name', NAME, '--cpus=1', '--memory=256m', '-p', `127.0.0.1:${hostPort}:4000`, '--add-host=host.docker.internal:host-gateway',
    '-e', `BUW_SITE_API=host.docker.internal:${upstream.address().port}`, '-e', 'NPM_IP=0.0.0.0/0', '-e', 'BUW_CONTENT_HOST=content.test',
    '--mount', `type=bind,src=${CADDYFILE},dst=/etc/caddy/Caddyfile,readonly`, '--mount', `type=bind,src=${ui},dst=/srv/buw-docs/_app/ui,readonly`, IMAGE];
  child = spawn('docker', args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let err = ''; child.stderr.on('data', chunk => { err += chunk; });
  // Whatever happens, the container goes: a deadline for the whole file, and a sweep on exit.
  setTimeout(() => { removeContainer(); process.exit(1); }, DEADLINE_MS).unref();
  process.on('exit', removeContainer);
  let up = false;
  for (let i = 0; i < 160 && !up; i += 1) {
    await new Promise(resolve => setTimeout(resolve, 250));
    up = await ask('/index.html').then(() => true, () => false);
  }
  if (!up) throw new Error(`Caddy did not start: ${err.slice(-800)}`);
  // A second, smaller one in which the login proxy is a peer this test is not: the write gate. Both go in `after`, and removeContainer sweeps both.
  gatePort = await freePort();
  gateChild = spawn('docker', ['run', '--rm', '--name', GATE_NAME, '--cpus=0.5', '--memory=128m', '-p', `127.0.0.1:${gatePort}:4000`, '--add-host=host.docker.internal:host-gateway',
    '-e', `BUW_SITE_API=host.docker.internal:${upstream.address().port}`, '-e', 'NPM_IP=203.0.113.9', '-e', 'BUW_CONTENT_HOST=content.test',
    '--mount', `type=bind,src=${CADDYFILE},dst=/etc/caddy/Caddyfile,readonly`, '--mount', `type=bind,src=${ui},dst=/srv/buw-docs/_app/ui,readonly`, IMAGE], { stdio: ['ignore', 'ignore', 'pipe'] });
  let up2 = false;
  for (let i = 0; i < 160 && !up2; i += 1) {
    await new Promise(resolve => setTimeout(resolve, 250));
    up2 = await ask('/index.html', {}, { port: gatePort }).then(() => true, () => false);
  }
  if (!up2) throw new Error('The gate Caddy did not start.');
}, { timeout: 90_000 });

after(() => {
  removeContainer();
  child?.kill();
  gateChild?.kill();
  upstream?.closeAllConnections?.();
  upstream?.close();
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

const sizes = {};
const encoded = (answer, label) => { assert.match(answer.h['content-encoding'] ?? '', /^(zstd|gzip)$/, `${label} is compressed`); assert.match(answer.h.vary ?? '', /Accept-Encoding/i); };
const plain = (answer, label) => assert.equal(answer.h['content-encoding'], undefined, `${label} is not compressed`);

for (const [label, route, method, key] of [['the run stream', '/api/hub/requests/r1/events', 'GET', 'run'], ['the chat stream', '/api/hub/chat', 'POST', 'chat']]) {
  test(`${label} arrives event by event, never compressed`, { skip, timeout: 60_000 }, async () => {
    const seen = [];
    const answer = await ask(route, { Accept: 'text/event-stream', ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}) }, {
      method, body: method === 'POST' ? '{}' : undefined,
      onChunk: chunk => { for (const m of chunk.toString().matchAll(/data: (\d+)/g)) { seen.push(Number(m[1])); streams[key].ack(Number(m[1])); } },
    });
    assert.equal(streams[key].timedOut, false, 'the next event was written only after the previous one arrived, so a buffering proxy would time out here');
    assert.deepEqual(seen, [0, 1, 2, 3]);
    plain(answer, label);
  });
}

test('JSON of 20 KB is compressed and smaller; under 1 KB it is left alone; an identity request is too', { skip }, async () => {
  const big = await ask('/api/json');
  encoded(big, '/api JSON');
  assert.ok(big.size < json.length / 4);
  sizes['/api/json'] = [json.length, big.size];
  plain(await ask('/api/small'), 'a small JSON');
  plain(await ask('/api/json', { 'Accept-Encoding': 'identity' }), 'an identity request');
});

test('the app shell, a deep link, the worker, the manifest and hashed JS and CSS are compressed', { skip }, async () => {
  for (const url of ['/index.html', '/magic-loops', '/sw.js', '/manifest.webmanifest', '/assets/index-AbCd_-12.js', '/assets/index-Zy9_x-81.css']) {
    const answer = await ask(url);
    assert.equal(answer.status, 200, url);
    encoded(answer, url);
    const plainSize = (await ask(url, { 'Accept-Encoding': 'identity' })).size;
    sizes[url] = [plainSize, answer.size];
  }
  assert.equal((await ask('/manifest.webmanifest')).h['content-type'], 'application/manifest+json');
});

test('/w/ JSON is compressed on the app host and on the content host, which keeps its CSP; media passes through whole', { skip }, async () => {
  encoded(await ask('/w/x/a.json', { 'Sec-Fetch-Dest': 'empty' }), '/w/ JSON');
  const content = await ask('/w/x/a.json', { Host: 'content.test' });
  encoded(content, 'content-host JSON');
  assert.match(content.h['content-security-policy'], /^sandbox /);
  for (const [url, dest] of [['/w/x/v.mp4', 'video'], ['/w/x/p.png', 'image']]) {
    const answer = await ask(url, { 'Sec-Fetch-Dest': dest });
    plain(answer, url);
    assert.equal(answer.h['content-length'], String(bytes.length), `${url} keeps its length`);
  }
  assert.equal((await ask('/nope', { Host: 'content.test' })).status, 404);
});

test('a Range request on a file is a 206, not compressed, with its Content-Range', { skip }, async () => {
  const answer = await ask('/assets/index-AbCd_-12.js', { Range: 'bytes=0-99' });
  assert.equal(answer.status, 206);
  plain(answer, 'the range answer');
  assert.match(answer.h['content-range'], /^bytes 0-99\//);
  assert.equal(answer.size, 100);
});

test('a conditional GET on /w/ gets a 304 twice, and the service sees the plain ETag', { skip }, async () => {
  const first = await ask('/w/x/a.json', { 'Sec-Fetch-Dest': 'empty' });
  assert.match(first.h.etag, /^"md5abc-(zstd|gzip)"$/, 'Caddy marks the encoding on a strong ETag');
  const second = await ask('/w/x/a.json', { 'Sec-Fetch-Dest': 'empty', 'If-None-Match': first.h.etag });
  assert.equal(second.status, 304);
  assert.equal(upstreamSaw.inm, '"md5abc"', 'the service saw the plain ETag');
  const third = await ask('/w/x/a.json', { 'Sec-Fetch-Dest': 'empty', 'If-None-Match': second.h.etag ?? '"md5abc"' });
  assert.equal(third.status, 304);
  assert.equal(upstreamSaw.inm, '"md5abc"');
  const sw = await ask('/sw.js');
  assert.equal((await ask('/sw.js', { 'If-None-Match': sw.h.etag })).status, 304, 'file_server answers its own 304s');
});

test('hashed JS and CSS are kept for a year; a missing hashed name, the worker, the shell and the maskable icon are not', { skip }, async () => {
  const forever = 'private, max-age=31536000, immutable';
  assert.equal((await ask('/assets/index-AbCd_-12.js')).h['cache-control'], forever);
  assert.equal((await ask('/assets/index-Zy9_x-81.css')).h['cache-control'], forever);
  for (const url of ['/assets/gone-AbCd_-12.js', '/sw.js', '/index.html', '/assets/icon-maskable-512.png', '/magic-loops']) {
    assert.equal((await ask(url)).h['cache-control'], 'no-cache', url);
  }
  const missing = await ask('/assets/gone-AbCd_-12.js', { 'Accept-Encoding': 'identity' });
  assert.match(missing.body.toString(), /shell/, 'a missing name still falls back to the shell');
});

test('sizes (plain, compressed)', { skip }, t => { t.diagnostic(JSON.stringify(sizes)); });

// --- the write gate (ws-ubo.4): a model change signs at once, so who may send it matters ---

test('a write from a peer that is not the login proxy is refused before the service sees it, and a forged Remote-User never reaches the service', { skip, timeout: 30_000 }, async () => {
  upstreamSaw.writes.length = 0;
  const forged = { 'Remote-User': 'owner', Origin: 'https://site.example', 'Content-Type': 'application/json', Connection: 'close' };
  const body = JSON.stringify({ primary: { provider: 'a', model: 'b' }, fallbacks: [], base: { provider: 'a', model: 'c', fallbacks: [] } });
  for (const route of ['/api/hub/team/teardown/profile-change', '/api/hub/team/briefs/profile-change']) {
    for (const method of ['POST', 'PUT', 'DELETE']) {
      const refused = await ask(route, forged, { method, body, port: gatePort });
      assert.equal(refused.status, 403, `${method} ${route}`);
      assert.match(refused.body.toString(), /Read-only here/);
    }
  }
  assert.deepEqual(upstreamSaw.writes, [], 'the service saw none of them');
  // Where the peer is the proxy, the same request reaches the service: the gate is the peer, not the path.
  const through = await ask('/api/hub/team/teardown/profile-change', forged, { method: 'POST', body });
  assert.equal(through.status, 201);
  assert.deepEqual(upstreamSaw.writes, ['/api/hub/team/teardown/profile-change']);
  // A forged Remote-User on a read from anyone but the proxy is stripped on the way.
  upstreamSaw.remoteUser = 'unset';
  assert.equal((await ask('/api/whoami', { 'Remote-User': 'owner' }, { port: gatePort })).status, 200);
  assert.equal(upstreamSaw.remoteUser, undefined, 'the header did not reach the service');
});

test('the app shell cannot be framed or scripted from a card: frame-ancestors none, X-Frame-Options and a same-origin opener policy', { skip, timeout: 30_000 }, async () => {
  const shell = await ask('/index.html');
  assert.match(shell.h['content-security-policy'] ?? '', /frame-ancestors 'none'/);
  assert.equal(shell.h['x-frame-options'], 'DENY');
  assert.equal(shell.h['cross-origin-opener-policy'], 'same-origin');
});
