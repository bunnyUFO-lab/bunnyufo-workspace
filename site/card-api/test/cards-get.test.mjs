// `cards get` on a large card: bounded parallel downloads, media left out with a note, and a partial get
// that `put` never reads as "these files were removed".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBucket } from '../../api/s3.mjs';
import { startFakeS3 } from '../../api/test/fake-s3.mjs';
import { createCardApi, parseTokens } from '../handler.mjs';
import { listenOnGoodPort } from '../../../server/listen.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const sha = text => createHash('sha256').update(text).digest('hex');
const entity = { id: 'big', folder: '2026-11-01_big', title: 'Big card', description: 'Many files.', category: 'plan', created: '2026-11-01', status: 'active', type: 'standalone', steps: [{ name: 'Notes', path: 'index.md' }] };
const TEXT_FILES = 40;

async function harness({ delay = 25, throttle = Infinity, apiOnly = false } = {}) {
  const fake = await startFakeS3();
  const bucket = createBucket({ bucket: fake.bucket, endpoint: fake.endpoint, credentials: fake.credentials, region: 'us-east-1' });
  fake.seed('sections/plans/workspace.json', JSON.stringify({ name: 'Plans', entities: [entity] }), 'application/json');
  const seed = (name, body, type) => fake.seed(`sections/plans/${entity.folder}/${name}`, body, type);
  seed('index.md', '# Big', 'text/markdown');
  for (let i = 0; i < TEXT_FILES; i += 1) seed(`notes/n${i}.md`, `note ${i}`, 'text/markdown');
  seed('shots/small.png', Buffer.alloc(2000, 1), 'image/png');
  seed('shots/large.png', Buffer.alloc(1_500_000, 2), 'image/png');
  const api = createCardApi({ bucket, tokens: parseTokens(`all=${sha('tok-all')}`), today: () => '2026-11-05' });
  const stats = { now: 0, max: 0, fileGets: 0 };
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const url = new URL(request.url, 'http://local');
    const isFile = request.method === 'GET' && /\/files\/.+/.test(url.pathname);
    if (isFile && stats.now >= throttle) {
      stats.throttled = (stats.throttled ?? 0) + 1;
      response.writeHead(429, { 'retry-after': '0', 'content-type': 'application/json' });
      return response.end('{"message":"Too Many Requests"}');
    }
    if (isFile) {
      stats.fileGets += 1;
      stats.now += 1;
      stats.max = Math.max(stats.max, stats.now);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
    try {
      const result = await api({
        requestContext: { http: { method: request.method } },
        rawPath: url.pathname,
        queryStringParameters: Object.fromEntries(url.searchParams),
        headers: request.headers,
        body: chunks.length ? Buffer.concat(chunks).toString('base64') : undefined,
        isBase64Encoded: true,
      });
      let body = result.isBase64Encoded ? Buffer.from(result.body, 'base64') : result.body;
      // A session that reaches only the API host: the bucket URLs in the card listing go nowhere.
      if (apiOnly && /\/cards\/[^/]+$/.test(url.pathname) && request.method === 'GET') body = body.toString().replace(/"url":"[^"]*"/g, '"url":"http://127.0.0.1:1/x"');
      response.writeHead(result.statusCode, { ...result.headers, 'content-length': Buffer.byteLength(body) });
      response.end(body);
    } finally {
      if (isFile) stats.now -= 1;
    }
  });
  await listenOnGoodPort(server, '127.0.0.1');
  const url = `http://127.0.0.1:${server.address().port}`;
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cards-get-'));
  const run = (...args) => new Promise(resolve => {
    execFile(process.execPath, [path.join(repo, 'scripts/cards.mjs'), ...args], {
      env: { ...process.env, BUW_CARDS_RETRY_MS: '5', BUW_CARD_API: url, BUW_CARDS_PASSWORD: 'tok-all', BUW_CARDS_VIA: 'api' },
    }, (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr }));
  });
  const has = file => access(path.join(dir, entity.folder, file)).then(() => true, () => false);
  const finish = async () => { server.close(); await fake.close(); await rm(dir, { recursive: true, force: true }); };
  return { fake, run, dir, stats, has, finish };
}

test('cards get: reads the files from the bucket, not through the API, and put --edit works on what it read', async () => {
  const t = await harness();
  try {
    const got = await t.run('get', 'plans/big', '--into', t.dir);
    assert.equal(got.code, 0, got.stderr);
    assert.equal(t.stats.fileGets, 0, 'no per-file request reached the API');
    assert.equal(await readFile(path.join(t.dir, entity.folder, 'notes', 'n7.md'), 'utf8'), 'note 7');
    const base = JSON.parse(await readFile(path.join(t.dir, '.cards-base.json'), 'utf8'));
    assert.equal(base[`plans/${entity.folder}/notes/n7.md`], createHash('md5').update('note 7').digest('hex'));
    await writeFile(path.join(t.dir, entity.folder, 'index.md'), '# Edited');
    const put = await t.run('put', t.dir, '--section', 'plans', '--card', 'big', '--edit', '--agent', 'A', '--why', 'because');
    assert.equal(put.code, 0, put.stderr);
    assert.equal(t.fake.text(`sections/plans/${entity.folder}/index.md`), '# Edited');
  } finally { await t.finish(); }
});

test('cards get: downloads files in parallel, at most 8 at once (a session that reaches only the API)', async () => {
  const t = await harness({ apiOnly: true });
  try {
    const got = await t.run('get', 'plans/big', '--into', t.dir, '--all');
    assert.equal(got.code, 0, got.stderr);
    assert.ok(t.stats.max > 1, `parallel (saw ${t.stats.max})`);
    assert.ok(t.stats.max <= 8, `bounded (saw ${t.stats.max})`);
    assert.equal(await readFile(path.join(t.dir, entity.folder, 'notes', 'n39.md'), 'utf8'), 'note 39');
    assert.ok(Object.keys(JSON.parse(await readFile(path.join(t.dir, '.cards-base.json'), 'utf8'))).length >= TEXT_FILES, 'an etag for every small file');
  } finally { await t.finish(); }
});

test('cards get: a throttled API (429) slows the pool down and every file still arrives', async () => {
  const t = await harness({ throttle: 2, apiOnly: true });
  try {
    const got = await t.run('get', 'plans/big', '--into', t.dir, '--all');
    assert.equal(got.code, 0, got.stderr);
    assert.ok(t.stats.throttled > 0, 'the fake did throttle');
    for (const n of [0, 17, 39]) assert.equal(await readFile(path.join(t.dir, entity.folder, 'notes', `n${n}.md`), 'utf8'), `note ${n}`);
    assert.ok(Object.keys(JSON.parse(await readFile(path.join(t.dir, '.cards-base.json'), 'utf8'))).length >= TEXT_FILES);
  } finally { await t.finish(); }
});

test('cards get: media over 1 MB is left out with a note; --all and --text change that', async () => {
  const t = await harness({ delay: 0 });
  try {
    const plain = await t.run('get', 'plans/big', '--into', t.dir);
    assert.equal(plain.code, 0, plain.stderr);
    assert.equal(await t.has('shots/small.png'), true, 'a small picture comes');
    assert.equal(await t.has('shots/large.png'), false);
    assert.match(plain.stdout, /Left out 1 file\(s\)[\s\S]*shots\/large\.png[\s\S]*--all/);
    assert.match(plain.stdout, /put will not remove them/);

    const text = await t.run('get', 'plans/big', '--into', t.dir, '--text');
    assert.match(text.stdout, /Left out 2 file\(s\)/);
    assert.equal(await t.has('notes/n0.md'), true);

    const all = await t.run('get', 'plans/big', '--into', t.dir, '--all');
    assert.equal(await t.has('shots/large.png'), true);
    assert.doesNotMatch(all.stdout, /Left out/);
    assert.equal(await t.has('index.md'), true);
  } finally { await t.finish(); }
});

test('cards get then put: left-out files are never removed, and put says so', async () => {
  const t = await harness({ delay: 0 });
  const large = `sections/plans/${entity.folder}/shots/large.png`;
  try {
    await t.run('get', 'plans/big', '--into', t.dir, '--text');
    await writeFile(path.join(t.dir, entity.folder, 'index.md'), '# Big, edited');
    const put = await t.run('put', t.dir, '--section', 'plans', '--card', 'big', '--remove');
    assert.equal(put.code, 0, put.stderr);
    assert.match(put.stdout, /1 to upload, 0 to remove/);
    assert.match(put.stdout, /2 left out by get, not removed/);
    assert.equal(t.fake.text(`sections/plans/${entity.folder}/index.md`), '# Big, edited');
    assert.ok(t.fake.objects.has(large), 'the left-out file is still there');
    assert.equal(t.fake.log.some(entry => entry.method === 'DELETE'), false);

    // A file that was fetched and then deleted here is still removed by --remove.
    await rm(path.join(t.dir, entity.folder, 'notes', 'n0.md'));
    const again = await t.run('put', t.dir, '--section', 'plans', '--card', 'big', '--remove');
    assert.match(again.stdout, /1 to remove/);
    assert.equal(t.fake.objects.has(`sections/plans/${entity.folder}/notes/n0.md`), false);
    assert.ok(t.fake.objects.has(large));

    // A full get afterwards forgets the left-out list.
    await t.run('get', 'plans/big', '--into', t.dir, '--all');
    const full = await t.run('put', t.dir, '--section', 'plans', '--card', 'big', '--dry-run');
    assert.doesNotMatch(full.stdout, /left out by get/);
  } finally { await t.finish(); }
});
