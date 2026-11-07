// The card API against the stand-in S3: tokens and section limits, reading and resolving cards,
// uploading files and adding the entry, and scripts/cards.mjs driving it end to end.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createBucket } from '../../api/s3.mjs';
import { startFakeS3 } from '../../api/test/fake-s3.mjs';
import { createHub } from '../../api/hub.mjs';
import { CHAT_PERSONAS } from '../../api/chat-personas.mjs';
import { createCardApi, handler, parseRef, parseScope, parseTokens } from '../handler.mjs';
import { listenOnGoodPort } from '../../../server/listen.mjs';

const sha = text => createHash('sha256').update(text).digest('hex');
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const card = (id, extra = {}) => ({
  id, folder: `2026-10-01_${id}`, title: `Card ${id}`, description: 'A card.', category: 'test',
  created: '2026-10-01', status: 'active', type: 'standalone', steps: [{ title: 'One', file: 'index.md' }], ...extra,
});

async function setup() {
  const fake = await startFakeS3();
  const bucket = createBucket({ bucket: fake.bucket, endpoint: fake.endpoint, credentials: fake.credentials, region: 'us-east-1' });
  const section = (id, entities, name) => {
    fake.seed(`sections/${id}/workspace.json`, JSON.stringify({ name, entities }), 'application/json');
    for (const entity of entities) fake.seed(`sections/${id}/${entity.folder}/index.md`, `# ${entity.title}`, 'text/markdown');
  };
  section('magic-loops', [card('loops-plan'), card('loops-art', { title: 'Shared Title' })], 'Magic Loops');
  section('bunnylink', [card('proxy', { title: 'Shared Title' })], 'Bunnylink');
  fake.seed('sections/inbox/workspace.json', JSON.stringify({ name: 'Inbox', hidden: true, entities: [] }), 'application/json');
  fake.seed('state.json', '{}');
  const tokens = parseTokens([
    `all=${sha('tok-all')}`,
    `loops=${sha('tok-loops')}:magic-loops`,
    `reader=${sha('tok-reader')}:read=*`,
    `hermes=${sha('tok-hermes')}:read=*;write=inbox|assistant`,
    `deploy=${sha('tok-deploy')}:read=inbox;write=inbox`,
    `cloud=${sha('tok-cloud')}:read=*;write=inbox`,
    `devbot=${sha('tok-devbot')}:read=*;write=inbox-dev`,
    `deleter=${sha('tok-deleter')}:read=*;write=inbox;delete=inbox`,
    `pc-runner=${sha('tok-pc-runner')}:read=*;write=inbox|inbox-dev`,
    `cloud-magic-loops=${sha('tok-cloud-ml')}:read=*;write=inbox|inbox-dev`,
    `cloud-sprite-studio=${sha('tok-cloud-ss')}:read=*;write=inbox`,
    `cloud-magic=${sha('tok-cloud-m')}:read=*;write=inbox`,
    `agent-session=${sha('tok-agent')}:read=*;write=inbox|inbox-dev`,
    `hermes-main=${sha('tok-hermes-main')}:read=*;write=inbox|assistant`,
    `agentish=${sha('tok-agentish')}:read=*;write=inbox`,
    `hermes-config=${sha('tok-hermes-config')}:write=inbox`,
    `apply-action=${sha('tok-apply-action')}:read=*;write=inbox`,
  ].join(', '));
  const api = createCardApi({ bucket, tokens, today: () => '2026-10-12' });
  const call = async (method, rawPath, { token = 'tok-all', body, query, base64, headers = {} } = {}) => {
    const response = await api({
      requestContext: { http: { method } },
      rawPath,
      queryStringParameters: query,
      headers: { Authorization: `Bearer ${token}`, ...headers },
      body: body === undefined ? undefined : base64 ? body.toString('base64') : typeof body === 'string' ? body : JSON.stringify(body),
      isBase64Encoded: Boolean(base64),
    });
    const data = response.isBase64Encoded ? Buffer.from(response.body, 'base64') : JSON.parse(response.body);
    return { status: response.statusCode, data, headers: response.headers };
  };
  return { fake, api, call, bucket };
}

/** The handler behind a local HTTP server, as API Gateway puts it on the internet. */
async function serve(api) {
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const url = new URL(request.url, 'http://local');
    const result = await api({
      requestContext: { http: { method: request.method } },
      rawPath: url.pathname,
      queryStringParameters: Object.fromEntries(url.searchParams),
      headers: request.headers,
      body: chunks.length ? Buffer.concat(chunks).toString('base64') : undefined,
      isBase64Encoded: true,
    });
    response.writeHead(result.statusCode, result.headers);
    response.end(result.isBase64Encoded ? Buffer.from(result.body, 'base64') : result.body);
  });
  await listenOnGoodPort(server, '127.0.0.1');
  server.url = `http://127.0.0.1:${server.address().port}`;
  return server;
}

test('tokens: parsed from hashes, checked, and limited to their sections', async () => {
  assert.throws(() => parseTokens('broken'), /name=<sha256>/);
  const { fake, api, call } = await setup();
  try {
    assert.equal((await call('GET', '/sections', { token: 'nope' })).status, 401);
    assert.equal((await api({ requestContext: { http: { method: 'GET' } }, rawPath: '/sections', headers: {} })).statusCode, 401);
    const client = await api({ requestContext: { http: { method: 'GET' } }, rawPath: '/cards.mjs', headers: {} });
    assert.equal(client.statusCode, 200, 'The client needs no token.');
    assert.match(client.body, /async function login\(/);
    const preflight = await api({ requestContext: { http: { method: 'OPTIONS' } }, rawPath: '/sections/bunnylink/files/card-responses/x/y.json', headers: {} });
    assert.equal(preflight.statusCode, 204, 'A CORS preflight needs no token.');
    assert.deepEqual((await call('GET', '/sections')).data.sections.map(item => item.id).sort(), ['bunnylink', 'inbox', 'magic-loops']);
    assert.deepEqual((await call('GET', '/sections', { token: 'tok-loops' })).data.sections.map(item => item.id), ['magic-loops']);
    assert.equal((await call('GET', '/sections/bunnylink', { token: 'tok-loops' })).status, 403);
    assert.equal((await call('GET', '/sections/state.json')).status, 400, 'Only section ids, never other keys.');
  } finally {
    await fake.close();
  }
});

test('tokens: the scope grammar, and a bad entry names itself and never its hash', () => {
  assert.deepEqual(parseScope(''), { read: null, write: null, delete: null });
  assert.deepEqual(parseScope('a|b'), { read: new Set(['a', 'b']), write: new Set(['a', 'b']), delete: new Set(['a', 'b']) });
  assert.deepEqual(parseScope('read=*;write=inbox|assistant'), { read: null, write: new Set(['inbox', 'assistant']), delete: new Set() });
  const hash = sha('x');
  for (const bad of ['read=*;read=inbox', 'write=', 'admin=*', 'read=*;', 'read=Inbox', 'read=a b']) {
    assert.throws(() => parseTokens(`odd=${hash}:${bad}`), error => /entry that is not name=<sha256>.*: odd$/.test(error.message) && !error.message.includes(hash), bad);
  }
  assert.throws(() => parseTokens('broken'), /: broken$/);
  assert.deepEqual(parseTokens(`a=${hash}, b=${hash}:read=*`).map(token => token.name), ['a', 'b']);
});

test('rights: an old-form token keeps every verb on its sections and is refused elsewhere', async () => {
  const { fake, call } = await setup();
  try {
    const mine = { token: 'tok-loops', body: Buffer.from('x'), base64: true };
    assert.equal((await call('PUT', '/sections/magic-loops/files/2026-10-01_loops-plan/note.md', mine)).status, 200);
    assert.equal((await call('DELETE', '/sections/magic-loops/files/2026-10-01_loops-plan/note.md', { token: 'tok-loops' })).status, 200);
    const denied = await call('PUT', '/sections/bunnylink/files/2026-10-01_proxy/note.md', mine);
    assert.equal(denied.status, 403);
    assert.equal(denied.data.error, 'This token may not write section "bunnylink".');
    assert.equal((await call('DELETE', '/sections/bunnylink/files/2026-10-01_proxy/index.md', { token: 'tok-loops' })).status, 403);
    assert.ok(fake.text('sections/bunnylink/2026-10-01_proxy/index.md'));
  } finally {
    await fake.close();
  }
});

test('rights: read=* reads everything and writes, deletes and uploads nothing', async () => {
  const { fake, call } = await setup();
  try {
    const t = { token: 'tok-reader' };
    assert.equal((await call('GET', '/sections/magic-loops', t)).status, 200);
    assert.equal((await call('GET', '/sections/magic-loops/files/2026-10-01_loops-plan/index.md', t)).status, 200);
    assert.equal((await call('GET', '/sections/magic-loops/files', { ...t, query: { prefix: '2026' } })).status, 200);
    const put = await call('PUT', '/sections/magic-loops/files/2026-10-01_loops-plan/n.md', { ...t, body: Buffer.from('x'), base64: true });
    assert.equal(put.status, 403);
    assert.equal(put.data.error, 'This token may not write section "magic-loops".');
    assert.equal((await call('PUT', '/sections/magic-loops/cards/loops-plan', { ...t, body: card('loops-plan') })).status, 403);
    assert.equal((await call('DELETE', '/sections/magic-loops/files/2026-10-01_loops-plan/index.md', t)).status, 403);
    assert.equal((await call('POST', '/sections/magic-loops/uploads', { ...t, body: { files: [{ path: '2026-10-01_loops-plan/a.mp4' }] } })).status, 403);
    assert.ok(fake.text('sections/magic-loops/2026-10-01_loops-plan/index.md'));
  } finally {
    await fake.close();
  }
});

test('a direct write with a generic type is stored with the type the file name gives; a real type is kept', async () => {
  const { fake, call } = await setup();
  try {
    fake.seed('sections/assistant/workspace.json', '{"name":"Assistant","entities":[]}', 'application/json');
    const put = (file, type) => call('PUT', `/sections/assistant/files/probes/${file}`, { token: 'tok-hermes', body: Buffer.from('<p>x</p>'), base64: true, headers: { 'content-type': type } });
    assert.equal((await put('x.html', 'application/octet-stream')).status, 200);
    assert.equal(fake.objects.get('sections/assistant/probes/x.html').contentType, 'text/html; charset=utf-8');
    assert.equal((await put('y.png', 'image/png')).status, 200);
    assert.equal(fake.objects.get('sections/assistant/probes/y.png').contentType, 'image/png');
  } finally { await fake.close(); }
});

test('rights: a token that writes inbox writes there only, and cannot delete', async () => {
  const { fake, call } = await setup();
  try {
    const put = (section, folder, token) => call('PUT', `/sections/${section}/files/${folder}/p.json`, { token, body: Buffer.from('{}'), base64: true });
    assert.equal((await put('inbox', 'probes', 'tok-cloud')).status, 200);
    assert.equal((await put('magic-loops', 'probes', 'tok-cloud')).status, 403);
    assert.equal((await put('assistant', 'probes', 'tok-cloud')).status, 403, 'cloud may not write assistant.');
    assert.equal((await call('DELETE', '/sections/inbox/files/probes/p.json', { token: 'tok-cloud' })).status, 403);
    assert.ok(fake.text('sections/inbox/probes/p.json'));
    // hermes: inbox and assistant, nothing else; deploy: inbox only, and cannot read the others.
    assert.equal((await call('PUT', '/sections/inbox/cards/not-a-card', { token: 'tok-cloud', body: card('not-a-card') })).status, 403, 'The inbox holds files, not cards.');
    assert.equal((await put('inbox', 'probes', 'tok-hermes')).status, 200);
    assert.equal((await put('magic-loops', 'probes', 'tok-hermes')).status, 403);
    assert.equal((await put('assistant', 'probes', 'tok-hermes')).status, 404, 'Allowed to try; the test bucket has no such section.');
    assert.equal((await call('GET', '/sections/magic-loops', { token: 'tok-deploy' })).status, 403);
    assert.deepEqual((await call('GET', '/sections', { token: 'tok-deploy' })).data.sections.map(item => item.id), ['inbox']);
    assert.equal((await put('inbox', 'probes', 'tok-deploy')).status, 200);
    assert.equal((await put('magic-loops', 'probes', 'tok-deploy')).status, 403);
    assert.equal((await call('GET', '/resolve', { token: 'tok-deploy', query: { ref: 'magic-loops/loops-plan' } })).status, 403);
  } finally {
    await fake.close();
  }
});

test('a ready-for-review event needs a pull request link or an ask; every other event and review passes', async () => {
  const { fake, call } = await setup();
  try {
    const put = (token, file, event) => call('PUT', `/sections/inbox-dev/files/events/2026-11-03/${file}`, { token, body: Buffer.from(typeof event === 'string' ? event : JSON.stringify(event)), base64: true });
    fake.seed('sections/inbox-dev/workspace.json', JSON.stringify({ name: 'Inbox (dev)', hidden: true, entities: [] }), 'application/json');
    const review = extra => ({ kind: 'ready-for-review', title: 'x', ...extra });
    const refused = await put('tok-devbot', 'a.json', review({}));
    assert.equal(refused.status, 422);
    assert.match(JSON.stringify(refused.data), /pull request link/);
    assert.equal(fake.text('sections/inbox-dev/events/2026-11-03/a.json'), null, 'nothing stored');
    assert.equal((await put('tok-devbot', 'b.json', review({ url: 'https://example.test/card', ask: '   ' }))).status, 422, 'a link that is no pull request, and a blank ask');
    assert.equal((await put('tok-devbot', 'sub/b1.json', review({}))).status, 422, 'a subfolder of the day, which the Hub reads too');
    assert.equal((await put('tok-all', 'b2.json', review({ prs: ['https://example.test/x'] }))).status, 422, 'every caller, the unrestricted one too');
    assert.equal((await put('tok-devbot', 'c.json', review({ url: 'https://github.com/example/app/pull/7' }))).status, 200);
    assert.equal((await put('tok-devbot', 'd.json', review({ prs: ['https://github.com/example/app/pull/7'] }))).status, 200);
    assert.equal((await put('tok-devbot', 'e.json', review({ ask: 'Merge when you are happy with it' }))).status, 200);
    assert.equal((await put('tok-devbot', 'f.json', { kind: 'deployed', title: 'x' })).status, 200, 'other kinds are unchanged');
    assert.equal((await put('tok-devbot', 'g.json', '{"n":1')).status, 200, 'a file that does not parse is unchanged');
    assert.equal((await call('PUT', '/sections/inbox-dev/files/other/h.json', { token: 'tok-devbot', body: Buffer.from(JSON.stringify(review({}))), base64: true })).status, 200, 'only events/<day>/ files');
  } finally {
    await fake.close();
  }
});

test('rights: the development inbox is guarded like the inbox, and a limited token cannot write the Hub\'s files there', async () => {
  const { fake, call } = await setup();
  try {
    fake.seed('sections/inbox-dev/workspace.json', JSON.stringify({ name: 'Inbox (dev)', hidden: true, entities: [] }), 'application/json');
    const put = (token, file) => call('PUT', `/sections/inbox-dev/files/${file}`, { token, body: Buffer.from('{}'), base64: true });
    assert.equal((await put('tok-cloud', 'asks/x/answer.json')).status, 403, 'answers are the Hub\'s.');
    assert.equal(fake.text('sections/inbox-dev/asks/x/answer.json'), null);
    assert.equal((await put('tok-devbot', 'events/p.json')).status, 200, 'events are not.');
    assert.equal((await call('PUT', '/sections/inbox-dev/cards/not-a-card', { token: 'tok-devbot', body: card('not-a-card') })).status, 403, 'The dev inbox holds files, not cards.');
  } finally {
    await fake.close();
  }
});

test('conditional writes: If-None-Match: * creates only, If-Match replaces only the version read', async () => {
  const { fake, call } = await setup();
  try {
    const url = '/sections/inbox/files/events/p.json';
    const write = (headers, body = '{"n":1}') => call('PUT', url, { token: 'tok-cloud', body: Buffer.from(body), base64: true, headers });
    assert.equal((await write({ 'If-None-Match': '*' })).status, 200);
    const again = await write({ 'If-None-Match': '*' });
    assert.equal(again.status, 412);
    assert.equal(again.data.error, 'That file already exists.');
    const etag = (await call('GET', url, { token: 'tok-cloud' })).headers.etag;
    const stale = await write({ 'If-Match': '"stale"' }, '{"n":2}');
    assert.equal(stale.status, 412);
    assert.equal(stale.data.error, 'That file changed since you read it.');
    assert.equal(fake.text('sections/inbox/events/p.json'), '{"n":1}');
    assert.equal((await write({ 'If-Match': etag }, '{"n":3}')).status, 200);
    assert.equal(fake.text('sections/inbox/events/p.json'), '{"n":3}');
    assert.equal((await write({}, '{"n":4}')).status, 200, 'Without a condition it replaces.');
  } finally {
    await fake.close();
  }
});

test('inbox: answers, snoozes and declines are the Hub\'s, so a limited writer is refused', async () => {
  const { fake, call } = await setup();
  try {
    const put = (token, file) => call('PUT', `/sections/inbox/files/${file}`, { token, body: Buffer.from('{}'), base64: true });
    for (const file of ['asks/x-1/answer.json', 'asks/x-1/answer.png', 'asks/x-1/answer.pic-20261106T101112123Z-ab12.jpg', 'asks/x-1/snooze.json', 'requests/r-1/declined.json']) {
      const refused = await put('tok-cloud', file);
      assert.equal(refused.status, 403, file);
      assert.equal(refused.data.error, 'Only the Hub writes answers.');
      assert.equal((await put('tok-hermes', file)).status, 403, file);
      assert.equal((await call('POST', '/sections/inbox/uploads', { token: 'tok-cloud', body: { files: [{ path: file }] } })).status, 403, `${file} by upload URL`);
    }
    assert.equal(fake.text('sections/inbox/asks/x-1/answer.json'), null);
    assert.equal((await call('PUT', '/sections/inbox/files/asks/x-1/ask.json', { token: 'tok-cloud', body: Buffer.from('{}'), base64: true, headers: { 'If-None-Match': '*' } })).status, 200, 'Asks themselves are created by agents.');
    assert.equal((await put('tok-cloud', 'asks/x-1/pickup.json')).status, 200);
    assert.equal((await put('tok-all', 'asks/x-1/answer.json')).status, 200, 'The passphrase may.');
  } finally {
    await fake.close();
  }
});

test('inbox: delivered.json and watch-<session>.json are create-only for a limited token: the first create passes, a replace, an upload URL and a delete are refused', async () => {
  const { fake, call } = await setup();
  try {
    const put = (token, file, headers) => call('PUT', `/sections/inbox/files/${file}`, { token, body: Buffer.from('{"v":1}'), base64: true, headers });
    for (const file of ['asks/x-1/delivered.json', 'asks/x-1/watch-abcd1234.json', 'checklists/x-2/delivered.json', 'checklists/x-2/watch-abcd1234.json']) {
      assert.equal((await put('tok-cloud', file, { 'If-None-Match': '*' })).status, 200, `${file} the first create`);
      assert.equal((await put('tok-cloud', file, { 'If-None-Match': '*' })).status, 412, `${file} a second create finds it`);
      const replace = await put('tok-cloud', file);
      assert.equal(replace.status, 403, `${file} replace`);
      assert.match(replace.data.error, /create-only/);
      assert.equal((await put('tok-cloud', file, { 'If-Match': '"x"' })).status, 403, `${file} conditional replace`);
      assert.equal((await call('POST', '/sections/inbox/uploads', { token: 'tok-cloud', body: { files: [{ path: file }] } })).status, 403, `${file} by upload URL`);
      assert.equal((await call('DELETE', `/sections/inbox/files/${file}`, { token: 'tok-cloud' })).status, 403, `${file} delete`);
      assert.equal((await call('DELETE', `/sections/inbox/files/${file}`, { token: 'tok-deleter' })).status, 403, `${file} delete by a limited deleter`);
    }
    assert.equal(fake.text('sections/inbox/asks/x-1/delivered.json'), '{"v":1}');
    assert.equal((await put('tok-all', 'asks/x-1/delivered.json')).status, 200, 'The passphrase may replace.');
    assert.equal((await put('tok-all', 'checklists/x-2/delivered.json')).status, 200, 'The passphrase may replace a checklist copy too.');
    assert.equal((await call('DELETE', '/sections/inbox/files/asks/x-1/watch-abcd1234.json', { token: 'tok-all' })).status, 200, 'The passphrase may delete.');
  } finally {
    await fake.close();
  }
});

test('inbox: asks/<id>/applied.json is the apply job\'s alone, once, and marked so the Hub can tell it from a forgery', async () => {
  const { fake, call } = await setup();
  try {
    const file = 'asks/20261105-probe-ab12/applied.json';
    const put = (token, headers = { 'If-None-Match': '*' }, name = file) => call('PUT', `/sections/inbox/files/${name}`, { token, body: Buffer.from('{"v":1}'), base64: true, headers });
    for (const token of ['tok-agent', 'tok-cloud', 'tok-pc-runner', 'tok-hermes-main', 'tok-hermes-config', 'tok-agentish']) {
      assert.equal((await put(token)).status, 403, `${token} cannot write it`);
    }
    assert.equal(fake.text(`sections/inbox/${file}`), null);
    assert.equal((await put('tok-apply-action', { 'If-None-Match': '*', 'x-amz-meta-writer': 'none' })).status, 200);
    assert.deepEqual(fake.objects.get(`sections/inbox/${file}`).metadata, { writer: 'apply-action' }, 'the mark is the handler\'s own');
    assert.equal((await put('tok-apply-action')).status, 412, 'not replaced');
    assert.equal((await put('tok-apply-action', {}, 'asks/20261105-probe-cd34/applied.json')).status, 403, 'create-only: a plain put is refused');
    assert.equal((await call('POST', '/sections/inbox/uploads', { token: 'tok-apply-action', body: { files: [{ path: 'asks/20261105-probe-cd34/applied.json' }] } })).status, 403, 'no upload URL');
    assert.equal((await call('POST', '/sections/inbox/uploads', { token: 'tok-agent', body: { files: [{ path: 'asks/20261105-probe-cd34/applied.json' }] } })).status, 403, 'an agent gets no upload URL for it');
    assert.equal((await call('DELETE', `/sections/inbox/files/${file}`, { token: 'tok-deleter' })).status, 403, 'a limited deleter keeps off it');
    // The passphrase can still write it, with no mark, so the Hub ignores that copy.
    assert.equal((await put('tok-all', { 'If-None-Match': '*' }, 'asks/20261105-probe-ef56/applied.json')).status, 200);
    assert.deepEqual(fake.objects.get('sections/inbox/asks/20261105-probe-ef56/applied.json').metadata ?? {}, {});
  } finally {
    await fake.close();
  }
});

test('inbox: the owner\'s Roadmap marks are the Hub\'s; an agent may only add an applied note, once', async () => {
  const { fake, call } = await setup();
  try {
    const base = 'bead-marks/probe/pb-1';
    const put = (token, file, headers = { 'If-None-Match': '*' }) => call('PUT', `/sections/inbox/files/${base}/${file}`, { token, body: Buffer.from('{}'), base64: true, headers });
    for (const verdict of ['done', 'not-needed', 'unblock', 'undo']) {
      const refused = await put('tok-cloud', `20261030T100000000Z-${verdict}-ab12.json`);
      assert.equal(refused.status, 403, verdict);
      assert.equal(refused.data.error, 'Only the Hub writes answers.');
      assert.equal((await call('POST', '/sections/inbox/uploads', { token: 'tok-cloud', body: { files: [{ path: `${base}/20261030T100000000Z-${verdict}-ab12.json` }] } })).status, 403, `${verdict} by upload URL`);
    }
    assert.equal(fake.text(`sections/inbox/${base}/20261030T100000000Z-done-ab12.json`), null);
    // The applied note: create-only, once.
    const applied = '20261030T110000000Z-applied-cd34.json';
    assert.equal((await put('tok-cloud', applied)).status, 200, 'An agent writes the applied note.');
    assert.equal((await put('tok-cloud', applied)).status, 412, 'It is not overwritten.');
    assert.equal((await put('tok-cloud', '20261030T120000000Z-applied-ef56.json', {})).status, 403, 'Without If-None-Match: * it is refused.');
    assert.equal((await put('tok-cloud', 'notes.json')).status, 403, 'Any other name under bead-marks/ is refused.');
    assert.equal((await call('POST', '/sections/inbox/uploads', { token: 'tok-cloud', body: { files: [{ path: `${base}/20261030T130000000Z-applied-gh78.json` }] } })).status, 403, 'An upload URL cannot be create-only.');
    assert.equal((await call('DELETE', `/sections/inbox/files/${base}/${applied}`, { token: 'tok-deleter' })).status, 403, 'A limited deleter keeps off it.');
    // Whatever this API writes there is tagged, so the Hub reads a verdict only from a file it wrote itself.
    assert.equal(fake.objects.get(`sections/inbox/${base}/${applied}`).metadata.writer, 'card-api');
    // The passphrase may put both kinds, and its verdict is tagged too.
    assert.equal((await put('tok-all', '20261030T140000000Z-done-ij90.json')).status, 200);
    assert.equal((await put('tok-all', '20261030T150000000Z-applied-kl12.json')).status, 200);
    assert.equal(fake.objects.get(`sections/inbox/${base}/20261030T140000000Z-done-ij90.json`).metadata.writer, 'card-api');
    // The development inbox follows the same rules.
    fake.seed('sections/inbox-dev/workspace.json', JSON.stringify({ name: 'Inbox (dev)', hidden: true, entities: [] }), 'application/json');
    assert.equal((await call('PUT', `/sections/inbox-dev/files/${base}/20261030T100000000Z-done-ab12.json`, { token: 'tok-devbot', body: Buffer.from('{}'), base64: true })).status, 403);
  } finally {
    await fake.close();
  }
});

test("inbox: the owner's Not useful record is the Hub's; an agent may only add a filed note, once", async () => {
  const { fake, call } = await setup();
  try {
    const base = 'feedback/probe/review/rv-1';
    const noIf = { 'If-None-Match': '*' };
    const put = (token, file, headers = noIf) => call('PUT', `/sections/inbox/files/${base}/${file}`, { token, body: Buffer.from('{}'), base64: true, headers });
    for (const token of ['tok-cloud', 'tok-agent', 'tok-pc-runner', 'tok-hermes-main']) {
      const refused = await put(token, 'not-useful.json');
      assert.equal(refused.status, 403, token);
      assert.equal(refused.data.error, 'Only the Hub writes answers.');
      assert.equal((await put(token, 'not-useful.json', {})).status, 403, `${token} replacing`);
      assert.equal((await call('POST', '/sections/inbox/uploads', { token, body: { files: [{ path: `${base}/not-useful.json` }] } })).status, 403, `${token} by upload URL`);
    }
    assert.equal(fake.text(`sections/inbox/${base}/not-useful.json`), null, 'nothing was written');
    // Any other name under feedback/ is refused to a limited writer.
    assert.equal((await put('tok-cloud', 'notes.json')).status, 403);
    assert.equal((await put('tok-cloud', 'picture-1.jpg')).status, 403, 'A picture beside a Not useful record is refused too.');
    assert.equal((await put('tok-cloud', 'filed-20261030T110000000Z-ab12.json.bak')).status, 403);
    assert.equal((await call('PUT', '/sections/inbox/files/feedback/probe/not-useful.json', { token: 'tok-cloud', body: Buffer.from('{}'), base64: true, headers: noIf })).status, 403, 'a shallower path');
    // The filed note: create-only, once, never by upload URL.
    const filed = 'filed-20261030T110000000Z-ab12.json';
    assert.equal((await put('tok-cloud', filed)).status, 200, 'An agent writes the filed note.');
    assert.equal((await put('tok-cloud', filed)).status, 412, 'It is not overwritten.');
    assert.equal((await put('tok-cloud', 'filed-20261030T120000000Z-cd34.json', {})).status, 403, 'Without If-None-Match: * it is refused.');
    assert.equal((await call('POST', '/sections/inbox/uploads', { token: 'tok-cloud', body: { files: [{ path: `${base}/filed-20261030T130000000Z-ef56.json` }] } })).status, 403, 'An upload URL cannot be create-only.');
    assert.equal((await call('DELETE', `/sections/inbox/files/${base}/${filed}`, { token: 'tok-deleter' })).status, 403, 'A limited deleter keeps off it.');
    assert.equal((await call('DELETE', `/sections/inbox/files/${base}/not-useful.json`, { token: 'tok-deleter' })).status, 403);
    assert.ok(fake.objects.get(`sections/inbox/${base}/${filed}`));
    // Whatever this API writes there is tagged and served with the tag; the Hub's own write carries none.
    assert.equal(fake.objects.get(`sections/inbox/${base}/${filed}`).metadata.writer, 'card-api');
    assert.equal((await put('tok-all', 'not-useful.json')).status, 200, 'The passphrase may put it.');
    assert.equal(fake.objects.get(`sections/inbox/${base}/not-useful.json`).metadata.writer, 'card-api', 'its copy is tagged');
    assert.equal((await call('GET', `/sections/inbox/files/${base}/not-useful.json`, { token: 'tok-agent' })).headers['x-card-writer'], 'card-api');
    fake.seed('sections/inbox/feedback/probe/review/rv-2/not-useful.json', '{}', 'application/json');
    assert.equal((await call('GET', '/sections/inbox/files/feedback/probe/review/rv-2/not-useful.json', { token: 'tok-agent' })).headers['x-card-writer'], 'none', 'a Hub write has no mark');
    // The development inbox follows the same rules.
    fake.seed('sections/inbox-dev/workspace.json', JSON.stringify({ name: 'Inbox (dev)', hidden: true, entities: [] }), 'application/json');
    assert.equal((await call('PUT', `/sections/inbox-dev/files/${base}/not-useful.json`, { token: 'tok-devbot', body: Buffer.from('{}'), base64: true })).status, 403);
  } finally {
    await fake.close();
  }
});

test('a section that is not an inbox: presence.json at its root is a 400, and a read sends no x-card-writer', async () => {
  const { fake, call } = await setup();
  try {
    const away = Buffer.from(JSON.stringify({ v: 1, away: true, until: '2099-01-01T00:00:00Z', by: 'x' }));
    for (const section of ['magic-loops', 'bunnylink']) {
      for (const method of ['PUT', 'GET', 'DELETE']) {
        const response = await call(method, `/sections/${section}/files/presence.json`, { token: 'tok-all', body: method === 'PUT' ? away : undefined, base64: true });
        assert.equal(response.status, 400, `${method} ${section}`);
      }
      assert.equal((await call('POST', `/sections/${section}/uploads`, { token: 'tok-all', body: { files: [{ path: 'presence.json' }] } })).status, 400, `${section} by upload URL`);
    }
    assert.equal(fake.objects.get('sections/magic-loops/presence.json'), undefined, 'nothing was written');
    // Files below a card folder read fine, and with no writer header whatever their mark: only the inbox sections speak for the Hub.
    fake.seed('sections/magic-loops/2026-10-01_loops-plan/presence.json', away, 'application/json');
    const read = await call('GET', '/sections/magic-loops/files/2026-10-01_loops-plan/presence.json', { token: 'tok-all' });
    assert.equal(read.status, 200);
    assert.equal(read.headers['x-card-writer'], undefined);
    assert.equal((await call('GET', '/sections/inbox/files/presence.json', { token: 'tok-all' })).status, 404, 'the inbox still has its own root file');
  } finally {
    await fake.close();
  }
});

test('inbox: presence.json (the Away switch) is owned by the Hub; no limited token puts, uploads or removes it, and a read names the writer mark', async () => {
  const { fake, call } = await setup();
  try {
    const away = Buffer.from(JSON.stringify({ v: 1, away: true, until: '2099-01-01T00:00:00Z', by: 'x' }));
    const put = (token, headers = {}) => call('PUT', '/sections/inbox/files/presence.json', { token, body: away, base64: true, headers });
    // An agent, the PC runner, Hermes, a cloud routine and the config exporter: all 403, with or without If-None-Match.
    for (const token of ['tok-agent', 'tok-agentish', 'tok-pc-runner', 'tok-hermes-main', 'tok-hermes', 'tok-cloud', 'tok-cloud-ml', 'tok-hermes-config', 'tok-deleter']) {
      for (const headers of [{}, { 'If-None-Match': '*' }]) {
        const refused = await put(token, headers);
        assert.equal(refused.status, 403, `${token} ${JSON.stringify(headers)}`);
        assert.equal(refused.data.error, 'Only the Hub writes answers.');
      }
      // An upload URL is for card files; the root file has none (and a URL would write it with no mark).
      assert.equal((await call('POST', '/sections/inbox/uploads', { token, body: { files: [{ path: 'presence.json' }] } })).status, 400, `${token} by upload URL`);
    }
    assert.equal(fake.objects.get('sections/inbox/presence.json'), undefined, 'nothing was written');
    // The Hub writes it itself (no mark). A limited deleter cannot remove it.
    fake.seed('sections/inbox/presence.json', away, 'application/json');
    assert.equal((await call('DELETE', '/sections/inbox/files/presence.json', { token: 'tok-deleter' })).status, 403);
    assert.ok(fake.objects.get('sections/inbox/presence.json'));
    // A read names the stored writer mark: `none` for the Hub's file.
    assert.equal((await call('GET', '/sections/inbox/files/presence.json', { token: 'tok-agent' })).headers['x-card-writer'], 'none');
    // The passphrase may write it through this API, and what it writes carries a mark, which hub-hooks reads as "not the owner's".
    assert.equal((await put('tok-all')).status, 200);
    assert.equal(fake.objects.get('sections/inbox/presence.json').metadata.writer, 'card-api');
    assert.equal((await call('GET', '/sections/inbox/files/presence.json', { token: 'tok-agent' })).headers['x-card-writer'], 'card-api');
    // Only the root file: a look-alike in a folder is not it.
    assert.equal((await call('PUT', '/sections/inbox/files/notes/presence.json', { token: 'tok-agent', body: away, base64: true })).status, 200);
  } finally {
    await fake.close();
  }
});

test('inbox: an avatar choice is written by the Hub, so a limited writer cannot put or remove one', async () => {
  const { fake, call } = await setup();
  try {
    const put = (token, file) => call('PUT', `/sections/inbox/files/${file}`, { token, body: Buffer.from('{}'), base64: true });
    const file = 'team/x/avatar-1.json';
    for (const token of ['tok-cloud', 'tok-hermes']) {
      const refused = await put(token, file);
      assert.equal(refused.status, 403, token);
      assert.equal(refused.data.error, 'Only the Hub writes answers.');
    }
    assert.equal((await call('POST', '/sections/inbox/uploads', { token: 'tok-cloud', body: { files: [{ path: 'team/x/avatar-20260101T000000Z-ab12.json' }] } })).status, 403, 'by upload URL');
    assert.equal(fake.text('sections/inbox/team/x/avatar-1.json'), null);
    assert.equal((await put('tok-cloud', 'team/x/notes.json')).status, 200, 'Other files in the folder stay open to agents.');
    assert.equal((await put('tok-all', file)).status, 200, 'The passphrase may.');
    assert.equal((await call('DELETE', `/sections/inbox/files/${file}`, { token: 'tok-cloud' })).status, 403, 'A limited deleter keeps off it.');
    assert.ok(fake.text('sections/inbox/team/x/avatar-1.json'));
  } finally {
    await fake.close();
  }
});

test('inbox: ask.json is create-only for a limited token, and a limited deleter keeps off the Hub files', async () => {
  const { fake, call } = await setup();
  try {
    const url = '/sections/inbox/files/asks/x-2/ask.json';
    const put = (token, headers, text = '{"n":1}') => call('PUT', url, { token, body: Buffer.from(text), base64: true, headers });
    assert.equal((await put('tok-cloud', {})).status, 403, 'No If-None-Match: refused.');
    assert.equal((await put('tok-cloud', { 'If-Match': '"abc"' })).status, 403, 'If-Match is no way round it.');
    assert.equal(fake.text('sections/inbox/asks/x-2/ask.json'), null);
    assert.equal((await put('tok-cloud', { 'If-None-Match': '*' })).status, 200, 'The first put creates it.');
    assert.equal((await put('tok-cloud', { 'If-None-Match': '*' }, '{"n":2}')).status, 412, 'A second put finds it there.');
    assert.equal((await put('tok-hermes', {}, '{"n":3}')).status, 403);
    assert.equal(fake.text('sections/inbox/asks/x-2/ask.json'), '{"n":1}');
    const upload = await call('POST', '/sections/inbox/uploads', { token: 'tok-cloud', body: { files: [{ path: 'asks/x-2/ask.json' }] } });
    assert.equal(upload.status, 403, 'A presigned URL cannot be create-only.');
    assert.equal((await call('POST', '/sections/inbox/uploads', { token: 'tok-cloud', body: { files: [{ path: 'asks/x-2/option-a.png' }] } })).status, 200, 'Pictures still upload.');

    // Deleting: a limited deleter may not remove asks, answers, snoozes or declines; anything else it may.
    fake.seed('sections/inbox/asks/x-2/answer.json', '{}', 'application/json');
    fake.seed('sections/inbox/events/e.json', '{}', 'application/json');
    for (const file of ['asks/x-2/ask.json', 'asks/x-2/answer.json', 'asks/x-2/snooze.json', 'requests/r-2/declined.json']) {
      assert.equal((await call('DELETE', `/sections/inbox/files/${file}`, { token: 'tok-deleter' })).status, 403, file);
    }
    assert.ok(fake.text('sections/inbox/asks/x-2/ask.json') && fake.text('sections/inbox/asks/x-2/answer.json'));
    assert.equal((await call('DELETE', '/sections/inbox/files/events/e.json', { token: 'tok-deleter' })).status, 200);

    // The passphrase can still do all of it.
    assert.equal((await put('tok-all', {}, '{"n":4}')).status, 200);
    assert.equal(fake.text('sections/inbox/asks/x-2/ask.json'), '{"n":4}');
    assert.equal((await call('POST', '/sections/inbox/uploads', { token: 'tok-all', body: { files: [{ path: 'asks/x-2/ask.json' }] } })).status, 200);
    assert.equal((await call('DELETE', '/sections/inbox/files/asks/x-2/answer.json', { token: 'tok-all' })).status, 200);
    assert.equal((await call('DELETE', url, { token: 'tok-all' })).status, 200);
  } finally {
    await fake.close();
  }
});

test('inbox: a checklist is written once by an agent; ticks and the submission are the Hub\'s, and a limited deleter keeps off all of it', async () => {
  const { fake, call } = await setup();
  try {
    const folder = 'checklists/20261027-probe-x-a1b2';
    const put = (token, file, headers = {}, text = '{}') => call('PUT', `/sections/inbox/files/${folder}/${file}`, { token, body: Buffer.from(text), base64: true, headers });
    const owned = ['tick-01-20261027T143012123Z-a1b2.json', 'untick-01-20261027T143012123Z-a1b2.json', 'submit.json', 'evidence-01-20261027T143012123Z-a1b2.png', 'evidence-01-20261027T143012123Z-a1b2.jpg', 'shot-20261027T143012123Z-a1b2.png', 'shot-note-20261027T143012123Z-a1b2.png'];
    for (const file of owned) {
      for (const token of ['tok-cloud', 'tok-hermes']) {
        const refused = await put(token, file, { 'If-None-Match': '*' });
        assert.equal(refused.status, 403, `${token} ${file}`);
      }
      assert.equal((await call('POST', '/sections/inbox/uploads', { token: 'tok-cloud', body: { files: [{ path: `${folder}/${file}` }] } })).status, 403, `${file} by upload URL`);
      assert.equal(fake.text(`sections/inbox/${folder}/${file}`), null);
    }
    for (const file of owned.slice(3)) {
      assert.equal((await call('PUT', `/sections/inbox/files/${folder}/${file}`, { token: 'tok-all', body: Buffer.from('x'), base64: true })).status, 200, `the passphrase writes ${file}`);
      fake.seed(`sections/inbox/${folder}/${file}`, 'x', 'image/png');
      assert.equal((await call('DELETE', `/sections/inbox/files/${folder}/${file}`, { token: 'tok-deleter' })).status, 403, `a limited deleter keeps off ${file}`);
    }
    // checklist.json: create-only for a limited writer, with If-None-Match: * and never by upload URL.
    assert.equal((await put('tok-cloud', 'checklist.json')).status, 403, 'No If-None-Match: refused.');
    assert.equal((await put('tok-cloud', 'checklist.json', { 'If-Match': '"abc"' })).status, 403, 'If-Match is no way round it.');
    assert.equal((await call('POST', '/sections/inbox/uploads', { token: 'tok-cloud', body: { files: [{ path: `${folder}/checklist.json` }] } })).status, 403);
    assert.equal(fake.text(`sections/inbox/${folder}/checklist.json`), null);
    assert.equal((await put('tok-cloud', 'checklist.json', { 'If-None-Match': '*' }, '{"n":1}')).status, 200, 'An agent creates the list.');
    assert.equal((await put('tok-cloud', 'checklist.json', { 'If-None-Match': '*' }, '{"n":2}')).status, 412, 'A second put finds it there.');
    assert.equal(fake.text(`sections/inbox/${folder}/checklist.json`), '{"n":1}');
    assert.equal((await put('tok-cloud', 'pickup.json')).status, 200, 'pickup.json is the agent\'s.');
    assert.equal((await put('tok-cloud', 'cancel.json')).status, 200, 'cancel.json is the agent\'s.');

    // The Hub's own writes (the passphrase) go through, and a limited deleter cannot remove any Hub file.
    for (const file of owned) assert.equal((await put('tok-all', file)).status, 200, `the passphrase writes ${file}`);
    for (const file of [...owned, 'checklist.json']) {
      assert.equal((await call('DELETE', `/sections/inbox/files/${folder}/${file}`, { token: 'tok-deleter' })).status, 403, file);
      assert.ok(fake.text(`sections/inbox/${folder}/${file}`), `${file} is still there`);
    }
    assert.equal((await call('DELETE', `/sections/inbox/files/${folder}/pickup.json`, { token: 'tok-deleter' })).status, 200, 'The rest may go.');
    assert.equal((await call('DELETE', `/sections/inbox/files/${folder}/submit.json`, { token: 'tok-all' })).status, 200);
  } finally {
    await fake.close();
  }
});

test('inbox: nothing nested below a checklist folder can be written or deleted by a limited token', async () => {
  const { fake, call } = await setup();
  try {
    const folder = 'checklists/20261027-probe-x-a1b2';
    const files = ['x/submit.json', 'x/tick-01-29991231T235959999Z-zzzz.json', 'x/untick-01-29991231T235959999Z-zzzz.json', 'x/y/submit.json', 'x/checklist.json', 'x/pickup.json', 'submit.json/x', 'tick-01-29991231T235959999Z-zzzz.json/x'];
    for (const file of files) {
      for (const token of ['tok-cloud', 'tok-hermes']) {
        const refused = await call('PUT', `/sections/inbox/files/${folder}/${file}`, { token, body: Buffer.from('{}'), base64: true, headers: { 'If-None-Match': '*' } });
        assert.equal(refused.status, 403, `${token} ${file}`);
      }
      assert.equal((await call('POST', '/sections/inbox/uploads', { token: 'tok-cloud', body: { files: [{ path: `${folder}/${file}` }] } })).status, 403, `${file} by upload URL`);
      assert.equal(fake.text(`sections/inbox/${folder}/${file}`), null);
      fake.seed(`sections/inbox/${folder}/${file}`, '{}', 'application/json');
      assert.equal((await call('DELETE', `/sections/inbox/files/${folder}/${file}`, { token: 'tok-deleter' })).status, 403, `delete ${file}`);
      assert.equal((await call('PUT', `/sections/inbox/files/${folder}/${file}`, { token: 'tok-all', body: Buffer.from('{}'), base64: true })).status, 200, `the passphrase writes ${file}`);
    }
  } finally {
    await fake.close();
  }
});

test('listing: files under a prefix, sorted, capped at 1000 with truncated, and only for a reader', async () => {
  const { fake, call } = await setup();
  try {
    for (const name of ['b', 'a']) fake.seed(`sections/inbox/events/2026-10-26/${name}.json`, '{}', 'application/json');
    fake.seed('sections/inbox/events/2026-10-25/c.json', '{}', 'application/json');
    fake.seed('sections/inbox/asks/202610/x-1/ask.json', '{}', 'application/json');
    const listed = await call('GET', '/sections/inbox/files', { token: 'tok-cloud', query: { prefix: 'events/2026-10-26/' } });
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.data.files.map(file => file.path), ['events/2026-10-26/a.json', 'events/2026-10-26/b.json']);
    assert.deepEqual(Object.keys(listed.data.files[0]).sort(), ['etag', 'lastModified', 'path', 'size']);
    assert.equal(listed.data.truncated, false);
    assert.equal((await call('GET', '/sections/inbox/files', { token: 'tok-all' })).data.files.length, 4, 'No prefix: all of them.');
    assert.deepEqual((await call('GET', '/sections/inbox/files', { token: 'tok-all', query: { prefix: 'asks/2026' } })).data.files.map(file => file.path), ['asks/202610/x-1/ask.json']);
    for (const bad of ['../x', '/events', '_shared', '.hidden', 'events/../asks']) {
      assert.equal((await call('GET', '/sections/inbox/files', { token: 'tok-all', query: { prefix: bad } })).status, 400, bad);
    }
    assert.equal((await call('GET', '/sections/magic-loops/files', { token: 'tok-deploy' })).status, 403, 'No read, no listing.');
    assert.equal((await call('GET', '/sections/inbox/files', { token: 'nope' })).status, 401);

    for (let i = 0; i < 1001; i += 1) fake.seed(`sections/inbox/many/${String(i).padStart(4, '0')}.json`, '{}', 'application/json');
    const many = await call('GET', '/sections/inbox/files', { token: 'tok-all', query: { prefix: 'many/' } });
    assert.equal(many.data.files.length, 1000);
    assert.equal(many.data.truncated, true);
    assert.equal(many.data.files[0].path, 'many/0000.json');
  } finally {
    await fake.close();
  }
});

test('no token reaches state.json or anything outside a section', async () => {
  const { fake, call } = await setup();
  try {
    for (const token of ['tok-all', 'tok-cloud', 'tok-reader']) {
      for (const route of ['/sections/../state.json', '/sections/state.json', '/sections/inbox/files/../../state.json']) {
        const answer = await call('GET', route, { token });
        assert.ok([400, 404].includes(answer.status), `${token} ${route}: ${answer.status}`);
      }
      assert.equal((await call('GET', '/sections/inbox/files', { token, query: { prefix: '../..' } })).status, 400);
      assert.equal((await call('PUT', '/sections/inbox/files/../../state.json', { token, body: Buffer.from('x'), base64: true })).status, 400);
    }
    assert.equal(fake.text('state.json'), '{}');
  } finally {
    await fake.close();
  }
});

test('reading: a section, a card with download URLs, a file', async () => {
  const { fake, call } = await setup();
  try {
    const section = await call('GET', '/sections/magic-loops');
    assert.equal(section.data.name, 'Magic Loops');
    assert.deepEqual(section.data.cards.map(item => item.id), ['loops-plan', 'loops-art']);

    const got = await call('GET', '/sections/magic-loops/cards/loops-plan');
    assert.equal(got.status, 200);
    assert.equal(got.data.entity.folder, '2026-10-01_loops-plan');
    assert.deepEqual(got.data.files.map(file => file.path), ['2026-10-01_loops-plan/index.md']);
    assert.match(got.data.files[0].url, /X-Amz-Signature=[0-9a-f]{64}$/);

    const file = await call('GET', '/sections/magic-loops/files/2026-10-01_loops-plan/index.md');
    assert.equal(file.data.toString(), '# Card loops-plan');
    assert.equal((await call('GET', '/sections/magic-loops/files/_shared/report.css')).status, 400);
    assert.equal((await call('GET', '/sections/magic-loops/cards/missing')).status, 404);
  } finally {
    await fake.close();
  }
});

test('resolve: site links, section/card, ids and titles', async () => {
  assert.deepEqual(parseRef('https://workspaces.example.net/magic-loops#/loops-plan/2'), { section: 'magic-loops', card: 'loops-plan', folder: null });
  assert.deepEqual(parseRef('https://workspaces.example.net/w/bunnylink/2026-10-01_proxy/index.md'), { section: 'bunnylink', card: null, folder: '2026-10-01_proxy' });
  const { fake, call } = await setup();
  try {
    const one = await call('GET', '/resolve', { query: { ref: 'https://workspaces.example.net/magic-loops#/loops-plan' } });
    assert.deepEqual(one.data.matches.map(match => `${match.section}/${match.id}`), ['magic-loops/loops-plan']);
    assert.equal((await call('GET', '/resolve', { query: { ref: 'shared title' } })).data.matches.length, 2);
    assert.equal((await call('GET', '/resolve', { query: { ref: 'shared title' }, token: 'tok-loops' })).data.matches.length, 1, 'Only sections the token may use.');
    assert.equal((await call('GET', '/resolve', { query: { ref: 'bunnylink/proxy' } })).data.matches[0].id, 'proxy');
    assert.equal((await call('GET', '/resolve', { query: { ref: 'nothing-here' } })).status, 404);
  } finally {
    await fake.close();
  }
});

test('writing: files first, then the entry; secrets and stray folders refused', async () => {
  const { fake, call } = await setup();
  try {
    const entity = card('remote-note');
    const early = await call('PUT', '/sections/magic-loops/cards/remote-note', { body: entity });
    assert.equal(early.status, 409, 'No files yet.');

    assert.equal((await call('PUT', `/sections/magic-loops/files/${entity.folder}/index.md`, { body: Buffer.from('# Hi'), base64: true })).status, 200);
    assert.equal((await call('PUT', `/sections/magic-loops/files/${entity.folder}/.env`, { body: Buffer.from('x'), base64: true })).status, 400);
    assert.equal((await call('PUT', `/sections/magic-loops/files/${entity.folder}/api-token.json`, { body: Buffer.from('x'), base64: true })).status, 422);
    assert.equal((await call('PUT', '/sections/magic-loops/files/workspace.json', { body: Buffer.from('{}'), base64: true })).status, 400);

    const added = await call('PUT', '/sections/magic-loops/cards/remote-note', { body: entity });
    assert.equal(added.status, 200);
    assert.equal(added.data.created, true);
    const registry = fake.json('sections/magic-loops/workspace.json');
    assert.deepEqual(registry.entities.map(item => item.id), ['loops-plan', 'loops-art', 'remote-note']);
    assert.equal(registry.entities[2].updated, '2026-10-12');
    assert.equal(registry.name, 'Magic Loops', 'The rest of the card list is kept.');

    const clash = await call('PUT', '/sections/magic-loops/cards/other', { body: card('other', { folder: entity.folder }) });
    assert.equal(clash.status, 409);
    assert.equal((await call('PUT', '/sections/magic-loops/cards/x', { body: card('y') })).status, 400);

    const uploads = await call('POST', '/sections/magic-loops/uploads', { body: { files: [{ path: `${entity.folder}/clip.mp4` }] } });
    assert.match(uploads.data.uploads[0].url, /sections\/magic-loops\/2026-10-01_remote-note\/clip\.mp4\?/);
    assert.equal((await call('DELETE', `/sections/magic-loops/files/${entity.folder}/index.md`)).status, 200);
    assert.equal(fake.text(`sections/magic-loops/${entity.folder}/index.md`), null);
    assert.equal(fake.text('state.json'), '{}', 'state.json is never touched.');
  } finally {
    await fake.close();
  }
});

test('the entry write retries when another device changed the card list', async () => {
  const { fake, call } = await setup();
  try {
    const entity = card('racer');
    fake.seed(`sections/magic-loops/${entity.folder}/index.md`, '# racer');
    // The first conditional write loses: someone else adds a card between our read and our put.
    let raced = false;
    fake.log.length = 0;
    const original = fake.objects.get.bind(fake.objects);
    fake.objects.get = key => {
      const value = original(key);
      if (!raced && key === 'sections/magic-loops/workspace.json' && fake.log.at(-1)?.method === 'PUT') {
        raced = true;
        const list = JSON.parse(value.body.toString());
        list.entities.push(card('from-phone'));
        fake.seed(key, JSON.stringify(list));
        return original(key);
      }
      return value;
    };
    assert.equal((await call('PUT', '/sections/magic-loops/cards/racer', { body: entity })).status, 200);
    assert.ok(raced);
    assert.deepEqual(fake.json('sections/magic-loops/workspace.json').entities.map(item => item.id), ['loops-plan', 'loops-art', 'from-phone', 'racer']);
  } finally {
    await fake.close();
  }
});

test('GET /cards.mjs fills in the host that served it', async () => {
  const { fake, api } = await setup();
  try {
    const ask = event => api({ requestContext: { http: { method: 'GET' }, ...event.requestContext }, rawPath: '/cards.mjs', headers: event.headers ?? {} });
    const served = await ask({ requestContext: { domainName: 'api.example.net' } });
    assert.equal(served.statusCode, 200);
    assert.match(served.body, /const SERVED_API = "https:\/\/api\.example\.net";/);
    assert.equal((await ask({ headers: { Host: 'api.example.org' } })).body.includes('"https://api.example.org"'), true);
    const bare = await ask({});
    assert.ok(bare.body.includes("const SERVED_API = '';"), 'The marker exists in cards.mjs, and is left alone with no host.');
  } finally {
    await fake.close();
  }
});

test('cards.mjs with no card API set says so, and reads config.json', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cards-cfg-'));
  const run = (env) => promisify(execFile)(process.execPath, [path.join(repo, 'scripts/cards.mjs'), 'sections', '--via', 'api'], {
    env: { PATH: process.env.PATH, HOME: dir, USERPROFILE: dir, BUW_CARDS_PASSWORD: 'x', ...env },
  });
  await assert.rejects(run({ BUW_CONFIG: path.join(dir, 'missing.json') }), error => /No card API is set/.test(error.stderr));
  const fake = await startFakeS3();
  const bucket = createBucket({ bucket: fake.bucket, endpoint: fake.endpoint, credentials: fake.credentials, region: 'us-east-1' });
  fake.seed('state.json', '{}');
  const server = await serve(createCardApi({ bucket, tokens: parseTokens(`all=${sha('x')}`), today: () => '2026-10-12' }));
  try {
    await writeFile(path.join(dir, 'config.json'), JSON.stringify({ cardApi: server.url }));
    const { stdout } = await run({ BUW_CONFIG: path.join(dir, 'config.json') });
    assert.doesNotMatch(stdout, /No card API/);
  } finally {
    await server.close();
    await fake.close();
  }
});

test('scripts/cards.mjs: link and get give the address a person opens, from any form of link', async () => {
  const { fake, api } = await setup();
  const server = await serve(api);
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cards-link-'));
  const run = (env, ...args) => promisify(execFile)(process.execPath, [path.join(repo, 'scripts/cards.mjs'), ...args], {
    env: { PATH: process.env.PATH, HOME: dir, USERPROFILE: dir, BUW_CONFIG: path.join(dir, 'none.json'), BUW_HUB_CONFIG: path.join(dir, 'none.json'), BUW_CARD_API: server.url, BUW_CARDS_PASSWORD: 'tok-all', BUW_CARDS_VIA: 'api', ...env },
  });
  const site = { BUW_SITE_URL: 'https://site.example/' };
  const page = 'https://site.example/magic-loops#/loops-plan';
  try {
    for (const ref of [
      'magic-loops/loops-plan',
      'loops-plan',
      'https://site.example/magic-loops#/loops-plan',
      'https://cards.site.example/w/magic-loops/loops-plan',
      'https://site.example/w/magic-loops/2026-10-01_loops-plan/index.md',
    ]) {
      assert.equal((await run(site, 'link', ref)).stdout.trim(), page, ref);
    }
    assert.match((await run(site, 'get', 'magic-loops/loops-plan', '--into', dir)).stdout, /Link to give people: https:\/\/site\.example\/magic-loops#\/loops-plan/);
    assert.match((await run(site, 'put', dir, '--section', 'magic-loops', '--card', 'loops-plan')).stdout, /Link to give people: https:\/\/site\.example\/magic-loops#\/loops-plan/);
    await assert.rejects(run({}, 'link', 'magic-loops/loops-plan'), error => /The site is not known/.test(error.stderr), 'A local API address names no site.');
  } finally {
    await server.close();
    await fake.close();
  }
});

test('scripts/cards.mjs: get a card by link into an empty folder, change it, put it back', async () => {
  const { fake, api } = await setup();
  const server = await serve(api);
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cards-'));
  const run = (...args) => promisify(execFile)(process.execPath, [path.join(repo, 'scripts/cards.mjs'), ...args], {
    env: { ...process.env, BUW_CARD_API: server.url, BUW_CARDS_PASSWORD: 'tok-all', BUW_CARDS_VIA: 'api' },
  });
  try {
    await run('get', 'https://workspaces.example.net/magic-loops#/loops-plan', '--into', dir);
    const folder = path.join(dir, '2026-10-01_loops-plan');
    assert.equal(await readFile(path.join(folder, 'index.md'), 'utf8'), '# Card loops-plan');
    assert.deepEqual(JSON.parse(await readFile(path.join(dir, 'workspace.json'), 'utf8')).entities.map(item => item.id), ['loops-plan']);

    await writeFile(path.join(folder, 'index.md'), '# Changed remotely');
    await mkdir(path.join(folder, 'media'));
    await writeFile(path.join(folder, 'media', 'note.txt'), 'new');
    const { stdout } = await run('put', dir, '--section', 'magic-loops', '--card', 'loops-plan');
    assert.match(stdout, /2 to upload, 0 to remove/);
    assert.equal(fake.text('sections/magic-loops/2026-10-01_loops-plan/index.md'), '# Changed remotely');
    assert.equal(fake.text('sections/magic-loops/2026-10-01_loops-plan/media/note.txt'), 'new');

    await rm(path.join(folder, 'media'), { recursive: true });
    // put removes nothing without --remove, in every section (it said "1 to remove" and removed before); it says so.
    const kept = (await run('put', dir, '--section', 'magic-loops', '--card', 'loops-plan')).stdout;
    assert.match(kept, /0 to upload, 0 to remove, 1 unchanged, 1 kept/);
    assert.match(kept, /put removes nothing without --remove/);
    assert.equal(fake.text('sections/magic-loops/2026-10-01_loops-plan/media/note.txt'), 'new');
    assert.match((await run('put', dir, '--section', 'magic-loops', '--card', 'loops-plan', '--remove')).stdout, /0 to upload, 1 to remove, 1 unchanged/);
    assert.equal(fake.text('sections/magic-loops/2026-10-01_loops-plan/media/note.txt'), null);
    // The uploads were conditional: a new file create-only, a changed one on the version `get` read; the base file stays here.
    const puts = fake.log.filter(entry => entry.method === 'PUT' && entry.key.startsWith('sections/magic-loops/2026-10-01_loops-plan/'));
    assert.equal(puts.find(entry => entry.key.endsWith('media/note.txt')).headers['if-none-match'], '*');
    assert.match(puts.find(entry => entry.key.endsWith('index.md')).headers['if-match'], /^"[0-9a-f]{32}"$/);
    assert.equal([...fake.objects.keys()].some(key => key.includes('.cards-base')), false);
    assert.ok(JSON.parse(await readFile(path.join(dir, '.cards-base.json'), 'utf8'))['magic-loops/2026-10-01_loops-plan/index.md']);
  } finally {
    server.close();
    await fake.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('scripts/cards.mjs: the API when there is a passphrase, the bucket when there are only AWS keys', async () => {
  const { fake, api } = await setup();
  const server = await serve(api);
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cards-'));
  const base = { ...process.env, HOME: dir, USERPROFILE: dir, BUW_REGISTRY: path.join(dir, 'none.json'), BUW_CARD_API: '', BUW_CARDS_PASSWORD: '', BUW_CARDS_VIA: '' };
  delete base.AWS_ACCESS_KEY_ID;
  delete base.AWS_PROFILE;
  const run = (env, ...args) => promisify(execFile)(process.execPath, [path.join(repo, 'scripts/cards.mjs'), ...args], { env: { ...base, ...env } });
  try {
    const direct = { AWS_ACCESS_KEY_ID: 'test', AWS_SECRET_ACCESS_KEY: 'test', BUW_S3_BUCKET: fake.bucket, BUW_S3_ENDPOINT: fake.endpoint, BUW_S3_REGION: 'us-east-1' };
    const got = await run(direct, 'get', 'bunnylink/proxy', '--into', dir);
    assert.match(got.stderr, /via s3:\/\/test-bucket/);
    assert.equal(await readFile(path.join(dir, '2026-10-01_proxy', 'index.md'), 'utf8'), '# Shared Title');

    await writeFile(path.join(dir, '2026-10-01_proxy', 'index.md'), '# Edited with a key');
    await run(direct, 'put', dir, '--section', 'bunnylink', '--card', 'proxy');
    assert.equal(fake.text('sections/bunnylink/2026-10-01_proxy/index.md'), '# Edited with a key');

    // No key and no passphrase: it asks the API bare (a cloud secret adds the header on the way),
    // and a 401 says how to give it one.
    await assert.rejects(run({ BUW_CARD_API: server.url }, 'sections'), /cards\.mjs login/);
    // The passphrase `login` keeps in ~/.buw is used when the variable is not set.
    await mkdir(path.join(dir, '.buw'), { recursive: true });
    await writeFile(path.join(dir, '.buw', 'card-api-password'), 'tok-loops\n');
    assert.match((await run({ BUW_CARD_API: server.url }, 'sections')).stdout, /^magic-loops\t/);
    // With both a passphrase and keys, the API wins; --via s3 still goes to the bucket.
    assert.match((await run({ ...direct, BUW_CARD_API: server.url }, 'sections')).stderr, /via the card API/);
    assert.match((await run({ ...direct, BUW_CARD_API: server.url }, 'sections', '--via', 's3')).stderr, /via s3:\/\/test-bucket/);
    await assert.rejects(run({ ...direct, BUW_CARD_API: 'http://127.0.0.1:9', BUW_CARDS_PASSWORD: 'x' }, 'sections', '--via', 'api'), /fetch failed|ECONNREFUSED/, '--via api skips the key.');
  } finally {
    server.close();
    await fake.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('the Lambda entry point: the passphrase set at deploy opens every section', async () => {
  const { fake } = await setup();
  const saved = { ...process.env };
  try {
    Object.assign(process.env, {
      BUW_S3_BUCKET: fake.bucket, BUW_S3_REGION: 'us-east-1', BUW_S3_ENDPOINT: fake.endpoint,
      AWS_ACCESS_KEY_ID: 'test', AWS_SECRET_ACCESS_KEY: 'test',
      BUW_CARD_PASSPHRASE: 'four random words here', BUW_CARD_TOKENS: '',
    });
    const ask = password => handler({ requestContext: { http: { method: 'GET' } }, rawPath: '/sections', headers: { Authorization: `Bearer ${password}` } });
    const ok = await ask('four random words here');
    assert.equal(ok.statusCode, 200);
    assert.equal(JSON.parse(ok.body).sections.length, 3);
    assert.equal((await ask('four random words')).statusCode, 401);
  } finally {
    process.env = saved;
    await fake.close();
  }
});

const HUB_ONLY = [
  'requests/r-1/approved.json', 'requests/r-1/stop.json', 'requests/r-1/hermes-run.json', 'requests/r-1/hermes-retry.json', 'requests/r-1/allow-grant.json', 'requests/r-1/continued.json',
  'requests/r-1/sprint.json', 'requests/r-1/sprint-end.json',
  'requests/r-1/reply-20261029T100000000Z-ab12.json', 'requests/r-1/reply-20261029T100000000Z-ab12.sent.json',
  'requests/r-1/fire-20261029T100000000Z-ab12.json', 'requests/r-1/answer-20261029T100000000Z-ab12.json',
  'hermes-approvals/h-1/approval.json', 'hermes-approvals/h-1/answer.json',
];
const RUN_FILES = ['taken.json', 'run-20261029T100000000Z-ab12.json', 'result.json', 'report.md'];
const bytes = text => Buffer.from(text);

test('inbox: approvals, stops, Hermes runs, fire records, answers and Hermes approvals are written by the Hub only, in both inboxes', async () => {
  const { fake, call } = await setup();
  try {
    fake.seed('sections/inbox-dev/workspace.json', JSON.stringify({ name: 'Inbox (dev)', hidden: true, entities: [] }), 'application/json');
    for (const inbox of ['inbox', 'inbox-dev']) {
      const put = (token, file) => call('PUT', `/sections/${inbox}/files/${file}`, { token, body: bytes('{}'), base64: true });
      for (const file of HUB_ONLY) {
        for (const token of ['tok-pc-runner', 'tok-cloud-ml', ...(inbox === 'inbox' ? ['tok-hermes', 'tok-cloud'] : ['tok-devbot'])]) {
          const refused = await put(token, file);
          assert.equal(refused.status, 403, `${inbox} ${file} ${token}`);
          assert.equal(refused.data.error, 'Only the Hub writes answers.');
        }
        assert.equal((await call('POST', `/sections/${inbox}/uploads`, { token: 'tok-pc-runner', body: { files: [{ path: file }] } })).status, 403, `${file} by upload URL`);
        assert.equal(fake.text(`sections/${inbox}/${file}`), null);
        assert.equal((await put('tok-all', file)).status, 200, `${file} by the passphrase`);
        if (inbox === 'inbox') assert.equal((await call('DELETE', `/sections/${inbox}/files/${file}`, { token: 'tok-deleter' })).status, 403, `${file} delete`);
        assert.ok(fake.text(`sections/${inbox}/${file}`), `${file} is still there`);
      }
    }
  } finally {
    await fake.close();
  }
});

test('inbox: nothing else widened; other request files and other folders stay writable by a limited token', async () => {
  const { fake, call } = await setup();
  try {
    const put = (token, file, headers) => call('PUT', `/sections/inbox/files/${file}`, { token, body: bytes('{}'), base64: true, headers });
    for (const file of [
      'events/e.json', 'asks/x/pickup.json', 'requests/r-1/fired.json', 'requests/r-1/running.json', 'requests/r-1/taken.json.bak',
      'requests/r-1/sub/taken.json', 'requests/r-1/result.json.txt', 'requests/r-1/answers.json', 'requests/r-1/approved.jsonl',
      'hermes-approvalsx/h-1/a.json', 'beads/p/c.jsonl',
    ]) {
      assert.equal((await put('tok-hermes', file)).status, 200, file);
    }
    assert.equal((await put('tok-cloud', 'requests/r-1/declined.json')).status, 403, 'still the Hub\'s');
    assert.equal((await call('PUT', '/sections/inbox/cards/c', { token: 'tok-pc-runner', body: card('c') })).status, 403, 'a runner writes no cards');
    assert.equal((await call('GET', '/sections', { token: 'tok-pc-runner' })).status, 200);
  } finally {
    await fake.close();
  }
});

test('inbox: run files go to pc-runner, to cloud-<project> for its own project\'s request, and to the passphrase, nobody else', async () => {
  const { fake, call } = await setup();
  try {
    fake.seed('sections/inbox-dev/workspace.json', JSON.stringify({ name: 'Inbox (dev)', hidden: true, entities: [] }), 'application/json');
    for (const inbox of ['inbox', 'inbox-dev']) {
      fake.seed(`sections/${inbox}/requests/m-1/request.json`, JSON.stringify({ id: 'm-1', project: 'magic-loops' }), 'application/json');
      fake.seed(`sections/${inbox}/requests/s-1/request.json`, JSON.stringify({ id: 's-1', project: 'sprite-studio' }), 'application/json');
      fake.seed(`sections/${inbox}/requests/bad-1/request.json`, 'not json', 'text/plain');
      let n = 0;
      let tookIt = false;
      const put = (token, id, file) => call('PUT', `/sections/${inbox}/files/requests/${id}/${file}`, { token, body: bytes(`{"n":${n += 1}}`), base64: true });
      const upload = (token, id, file) => call('POST', `/sections/${inbox}/uploads`, { token, body: { files: [{ path: `requests/${id}/${file}` }] } });
      for (const file of RUN_FILES) {
        const label = `${inbox} ${file}`;
        assert.equal((await put('tok-all', 'm-1', file)).status, 200, `${label} passphrase`);
        // pc-runner's run and result files follow its take: a request whose taken.json does not name the PC runner is refused.
        const gated = /^(run-|result)/.test(file);
        if (gated && !tookIt) {
          assert.equal((await put('tok-pc-runner', 'm-1', file)).status, 403, `${label} pc-runner before the take`);
          fake.seed(`sections/${inbox}/requests/m-1/taken.json`, JSON.stringify({ runner: 'pc', host: 'pc', at: '2026-10-30T10:00:00Z' }), 'application/json');
          tookIt = true;
        }
        assert.equal((await put('tok-pc-runner', 'm-1', file)).status, 200, `${label} pc-runner on a request it took`);
        assert.equal((await put('tok-pc-runner', 'nothing-here', file)).status, gated ? 403 : 200, `${label} pc-runner, no request.json yet`);
        assert.equal((await put('tok-cloud-ml', 'm-1', file)).status, 200, `${label} own project`);
        assert.equal((await upload('tok-cloud-ml', 'm-1', file)).status, 200, `${label} own project by upload URL`);
        for (const [token, id] of [['tok-cloud-ml', 's-1'], ['tok-cloud-ml', 'nothing-here'], ['tok-cloud-ml', 'bad-1']]) {
          const refused = await put(token, id, file);
          assert.equal(refused.status, 403, `${label} ${token} on ${id}`);
          assert.equal(refused.data.error, 'Only a run writes run files.');
        }
        assert.equal((await upload('tok-cloud-ml', 's-1', file)).status, 403, `${label} wrong project by upload URL`);
        if (inbox === 'inbox') {
          assert.equal((await call('DELETE', `/sections/inbox/files/requests/m-1/${file}`, { token: 'tok-deleter' })).status, 403, `${label} delete`);
          assert.equal((await upload('tok-deploy', 'm-1', file)).status, 403, `${label} deploy by upload URL`);
          assert.equal((await put('tok-cloud-ss', 's-1', file)).status, 200, `${label} the other cloud token, its own project`);
          assert.equal((await put('tok-cloud-ss', 'm-1', file)).status, 403, `${label} the other cloud token, wrong project`);
          assert.equal((await put('tok-cloud-m', 'm-1', file)).status, 403, `${label} a name that is only a prefix of the project`);
          for (const token of ['tok-hermes', 'tok-cloud', 'tok-deploy', 'tok-deleter']) {
            const refused = await put(token, 'm-1', file);
            assert.equal(refused.status, 403, `${label} ${token}`);
            assert.equal(refused.data.error, 'Only a run writes run files.');
          }
        }
      }
    }
  } finally {
    await fake.close();
  }
});

test('inbox: request.json is create-only for a limited writer, which cannot claim origin owner', async () => {
  const { fake, call } = await setup();
  try {
    const url = '/sections/inbox/files/requests/q-1/request.json';
    const write = (token, text, headers = {}) => call('PUT', url, { token, body: bytes(text), base64: true, headers });
    const agent = JSON.stringify({ id: 'q-1', project: 'magic-loops', origin: { kind: 'agent', name: 'x' } });
    assert.equal((await write('tok-cloud', agent)).status, 403, 'no condition');
    assert.equal((await write('tok-cloud', agent, { 'If-Match': '"x"' })).status, 403, 'a replace');
    assert.equal(fake.text('sections/inbox/requests/q-1/request.json'), null);
    assert.equal((await call('POST', '/sections/inbox/uploads', { token: 'tok-cloud', body: { files: [{ path: 'requests/q-1/request.json' }] } })).status, 403, 'by upload URL');
    const owner = JSON.stringify({ id: 'q-1', project: 'magic-loops', origin: { kind: 'owner', name: 'me' } });
    assert.equal((await write('tok-hermes', owner, { 'If-None-Match': '*' })).status, 403, 'origin owner');
    assert.equal(fake.text('sections/inbox/requests/q-1/request.json'), null);
    const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes(owner)]);
    const bomWrite = (token, body) => call('PUT', url, { token, body, base64: true, headers: { 'If-None-Match': '*' } });
    assert.equal((await bomWrite('tok-hermes', bom)).status, 403, 'a BOM does not hide origin owner');
    assert.equal((await bomWrite('tok-hermes', bytes('{ not json'))).status, 403, 'unparsable is refused');
    const noCondition = await write('tok-cloud', agent);
    assert.match(noCondition.data.error, /request\.json/);
    assert.equal(fake.text('sections/inbox/requests/q-1/request.json'), null);
    assert.equal((await write('tok-hermes', agent, { 'If-None-Match': '*' })).status, 200, 'created once');
    assert.equal((await write('tok-hermes', agent, { 'If-None-Match': '*' })).status, 412, 'not twice');
    assert.equal((await call('DELETE', url, { token: 'tok-deleter' })).status, 403, 'a limited deleter keeps off it');
    assert.equal((await write('tok-all', owner)).status, 200, 'the passphrase may replace, and may write origin owner');
  } finally {
    await fake.close();
  }
});

test('inbox: agent-config/ takes create-only exports from the hermes-config token alone, and marks them', async () => {
  const { fake, call } = await setup();
  try {
    const file = 'agent-config/export-20261101T101500Z.json';
    const url = name => `/sections/inbox/files/${name}`;
    const put = (token, name, headers = { 'If-None-Match': '*' }) => call('PUT', url(name), { token, body: Buffer.from('{"v":1}'), base64: true, headers });
    const created = await put('tok-hermes-config', file, { 'If-None-Match': '*', 'x-amz-meta-writer': 'agent', 'X-Amz-Meta-Extra': 'y' });
    assert.equal(created.status, 200);
    assert.deepEqual(fake.objects.get(`sections/inbox/${file}`).metadata, { writer: 'hermes-config' }, 'the mark is the handler own, caller metadata is not stored');
    assert.equal((await put('tok-hermes-config', file)).status, 412, 'not replaced');
    assert.equal((await put('tok-hermes-config', 'agent-config/export-20261101T111500Z.json', {})).status, 403, 'a replace-able write (no If-None-Match) is refused');
    assert.equal((await call('POST', '/sections/inbox/uploads', { token: 'tok-hermes-config', body: { files: [{ path: 'agent-config/export-20261101T121500Z.json' }] } })).status, 403, 'no upload URL');
    for (const name of ['agent-config/current.json', 'agent-config/export-2026.json', 'agent-config/sub/export-20261101T131500Z.json', 'agent-config/export-20261101T131500Z.json.bak', 'agent-config/export-20261101T13Z.json']) {
      assert.equal((await put('tok-hermes-config', name)).status, 403, name);
    }
    // The exporter writes nothing else in the inbox.
    for (const name of ['asks/x/ask.json', 'requests/x/request.json', 'events/e.json', 'team/hermes/note.json']) {
      assert.equal((await put('tok-hermes-config', name)).status, 403, `hermes-config: ${name}`);
    }
    assert.equal((await call('POST', '/sections/inbox/uploads', { token: 'tok-hermes-config', body: { files: [{ path: 'events/e.json' }] } })).status, 403, 'hermes-config: no upload URL elsewhere');
    // Nobody else limited may write there, with any case of the folder.
    for (const token of ['tok-hermes-main', 'tok-hermes', 'tok-agent', 'tok-pc-runner', 'tok-cloud', 'tok-deleter']) {
      assert.equal((await put(token, 'agent-config/export-20261101T141500Z.json')).status, 403, token);
      assert.equal((await put(token, 'Agent-Config/export-20261101T141500Z.json')).status, 403, `${token} (case)`);
    }
    assert.equal(fake.text('sections/inbox/agent-config/export-20261101T141500Z.json'), null);
    // A limited deleter cannot remove an export.
    assert.equal((await call('DELETE', url(file), { token: 'tok-deleter' })).status, 403);
    assert.ok(fake.text(`sections/inbox/${file}`));
    // The passphrase is not limited and its file carries no mark (the Hub ignores it).
    assert.equal((await put('tok-all', 'agent-config/export-20261101T151500Z.json')).status, 200);
    assert.deepEqual(fake.objects.get('sections/inbox/agent-config/export-20261101T151500Z.json').metadata, {});
    // The token reads and deletes nothing, and creates no cards.
    assert.equal((await call('GET', '/sections', { token: 'tok-hermes-config' })).status, 200);
    assert.equal((await call('GET', url(file), { token: 'tok-hermes-config' })).status, 403);
    assert.equal((await call('DELETE', url(file), { token: 'tok-hermes-config' })).status, 403);
    // The development inbox follows the same rules.
    fake.seed('sections/inbox-dev/workspace.json', JSON.stringify({ name: 'Inbox (dev)', hidden: true, entities: [] }), 'application/json');
    assert.equal((await call('PUT', `/sections/inbox-dev/files/${file}`, { token: 'tok-hermes-config', body: Buffer.from('{}'), base64: true, headers: { 'If-None-Match': '*' } })).status, 403, 'its token has no right on inbox-dev');
    assert.equal((await call('PUT', `/sections/inbox-dev/files/${file}`, { token: 'tok-devbot', body: Buffer.from('{}'), base64: true, headers: { 'If-None-Match': '*' } })).status, 403, 'devbot is refused there');
  } finally {
    await fake.close();
  }
});

test('inbox: request.json written by an agent-session token carries writer: agent; no other token, and no client header, sets it', async () => {
  const { fake, call } = await setup();
  try {
    fake.seed('sections/inbox-dev/workspace.json', JSON.stringify({ name: 'Inbox (dev)', hidden: true, entities: [] }), 'application/json');
    const body = JSON.stringify({ id: 'w-1', project: 'magic-loops', origin: { kind: 'agent', name: 'x' } });
    const write = (inbox, token, id, headers = {}) => call('PUT', `/sections/${inbox}/files/requests/${id}/request.json`, { token, body: Buffer.from(body), base64: true, headers: { 'If-None-Match': '*', ...headers } });
    const writerOf = (inbox, id) => fake.objects.get(`sections/${inbox}/requests/${id}/request.json`).metadata?.writer;
    for (const inbox of ['inbox', 'inbox-dev']) {
      assert.equal((await write(inbox, 'tok-agent', 'a-1')).status, 200);
      assert.equal(writerOf(inbox, 'a-1'), 'agent', `${inbox}: agent session`);
      // A client trying to set it on its own, with any case or with a second value, gets nothing from a non-agent token.
      for (const [token, id] of [['tok-pc-runner', 'p-1'], ['tok-cloud-ml', 'c-1']]) {
        assert.equal((await write(inbox, token, id, { 'x-amz-meta-writer': 'agent', 'X-Amz-Meta-Origin': 'owner' })).status, 200, `${inbox} ${token}`);
        assert.equal(writerOf(inbox, id), undefined, `${inbox} ${token}: no writer`);
        assert.deepEqual(fake.objects.get(`sections/${inbox}/requests/${id}/request.json`).metadata, {}, 'no metadata at all');
      }
    }
    for (const [token, id] of [['tok-hermes-main', 'h-1'], ['tok-hermes', 'h-2'], ['tok-cloud', 'o-1'], ['tok-cloud-ss', 'o-2'], ['tok-agentish', 'o-3']]) {
      assert.equal((await write('inbox', token, id, { 'x-amz-meta-writer': 'agent' })).status, 200, token);
      assert.equal(writerOf('inbox', id), undefined, `${token}: no writer`);
    }
    // An agent token's own header cannot add anything else, nor change its value.
    assert.equal((await write('inbox', 'tok-agent', 'a-2', { 'x-amz-meta-writer': 'owner', 'x-amz-meta-extra': 'y' })).status, 200);
    assert.deepEqual(fake.objects.get('sections/inbox/requests/a-2/request.json').metadata, { writer: 'agent' });
    // Other files an agent writes carry nothing, and the passphrase's own request.json carries nothing.
    assert.equal((await call('PUT', '/sections/inbox/files/events/e.json', { token: 'tok-agent', body: Buffer.from('{}'), base64: true, headers: { 'x-amz-meta-writer': 'agent' } })).status, 200);
    assert.deepEqual(fake.objects.get('sections/inbox/events/e.json').metadata, {});
    assert.equal((await write('inbox', 'tok-all', 'z-1', { 'x-amz-meta-writer': 'agent' })).status, 200);
    assert.equal(writerOf('inbox', 'z-1'), undefined);
    // A BOM-less owner claim is still refused for the agent token, and an agent token still cannot replace.
    assert.equal((await call('PUT', '/sections/inbox/files/requests/a-1/request.json', { token: 'tok-agent', body: Buffer.from(body), base64: true })).status, 403);
  } finally {
    await fake.close();
  }
});

test('moved and deleted cards: a write is refused, a read says where it went, resolve follows the move', async () => {
  const { fake, call } = await setup();
  try {
    // The site moved `loops-plan` to bunnylink and put `loops-art` in the Trash of magic-loops.
    const list = fake.json('sections/magic-loops/workspace.json');
    const [plan, art] = list.entities;
    fake.seed('sections/magic-loops/workspace.json', JSON.stringify({
      ...list,
      entities: [],
      retired: {
        'loops-plan': { kind: 'moved', to: 'bunnylink', folder: plan.folder, at: '2026-10-30' },
        'loops-art': { kind: 'deleted', at: '2026-10-30', entity: art },
      },
    }), 'application/json');
    const target = fake.json('sections/bunnylink/workspace.json');
    fake.seed('sections/bunnylink/workspace.json', JSON.stringify({ ...target, entities: [...target.entities, plan] }), 'application/json');

    const put = await call('PUT', '/sections/magic-loops/cards/loops-plan', { body: plan });
    assert.equal(put.status, 409);
    assert.deepEqual(put.data.movedTo, { section: 'bunnylink', folder: plan.folder });
    assert.match(put.data.error, /moved to bunnylink/);
    const trashed = await call('PUT', '/sections/magic-loops/cards/loops-art', { body: art });
    assert.equal(trashed.status, 409);
    assert.match(trashed.data.error, /Trash.*restore it first/);
    assert.equal(fake.json('sections/magic-loops/workspace.json').entities.length, 0, 'Neither card was added back.');

    const got = await call('GET', '/sections/magic-loops/cards/loops-plan');
    assert.equal(got.status, 404);
    assert.equal(got.data.movedTo.section, 'bunnylink');
    assert.equal((await call('GET', `/sections/magic-loops/cards/${plan.folder}`)).data.movedTo.section, 'bunnylink', 'By folder too.');
    const inTrash = await call('GET', '/sections/magic-loops/cards/loops-art');
    assert.equal(inTrash.status, 404);
    assert.equal(inTrash.data.movedTo, undefined);
    assert.match(inTrash.data.error, /Trash/);

    for (const ref of ['magic-loops/loops-plan', 'loops-plan', `https://workspaces.example.net/magic-loops#/loops-plan`]) {
      const found = await call('GET', '/resolve', { query: { ref } });
      assert.deepEqual(found.data.matches.map(match => `${match.section}/${match.id}:${match.movedFrom}`), ['bunnylink/loops-plan:magic-loops'], ref);
    }
    assert.equal((await call('GET', '/resolve', { query: { ref: 'magic-loops/loops-art' } })).status, 404);
    assert.equal((await call('GET', '/resolve', { query: { ref: 'magic-loops/loops-plan' }, token: 'tok-loops' })).status, 404, 'A token that cannot read the new workspace is not sent there.');
    // A token that cannot read the new workspace is not told its name.
    const blindGet = await call('GET', '/sections/magic-loops/cards/loops-plan', { token: 'tok-loops' });
    const blindPut = await call('PUT', '/sections/magic-loops/cards/loops-plan', { token: 'tok-loops', body: plan });
    assert.equal(blindGet.status, 404);
    assert.equal(blindPut.status, 409);
    for (const blind of [blindGet, blindPut]) {
      assert.equal(blind.data.movedTo, undefined);
      assert.doesNotMatch(JSON.stringify(blind.data), /bunnylink/);
      assert.match(blind.data.error, /moved to another workspace/);
    }
    // A new id cannot claim the folder of a moved or Trashed card.
    const claimMoved = await call('PUT', '/sections/magic-loops/cards/other-one', { body: card('other-one', { folder: plan.folder }) });
    assert.equal(claimMoved.status, 409);
    assert.equal(claimMoved.data.movedTo.section, 'bunnylink');
    const claimTrash = await call('PUT', '/sections/magic-loops/cards/other-two', { body: card('other-two', { folder: art.folder }) });
    assert.equal(claimTrash.status, 409);
    assert.match(claimTrash.data.error, /Trash/);
    assert.equal(fake.json('sections/magic-loops/workspace.json').entities.length, 0);
    // Live cards and other tokens are untouched.
    assert.equal((await call('GET', '/sections/bunnylink/cards/loops-plan')).status, 200);
    assert.equal((await call('PUT', '/sections/magic-loops/cards/loops-plan', { body: plan, token: 'tok-reader' })).status, 403);
  } finally {
    await fake.close();
  }
});

test('inbox: ask.json carries the writer mark of the token kind (pc-runner, agent, other), the passphrase none, and no client header changes it', async () => {
  const { fake, call } = await setup();
  try {
    fake.seed('sections/inbox-dev/workspace.json', JSON.stringify({ name: 'Inbox (dev)', hidden: true, entities: [] }), 'application/json');
    const body = JSON.stringify({ id: 'x', project: 'magic-loops', question: 'Q?', options: [] });
    const write = (inbox, token, id, headers = {}) => call('PUT', `/sections/${inbox}/files/asks/${id}/ask.json`, { token, body: Buffer.from(body), base64: true, headers: { 'If-None-Match': '*', ...headers } });
    const metaOf = (inbox, id) => fake.objects.get(`sections/${inbox}/asks/${id}/ask.json`).metadata;
    for (const inbox of ['inbox', 'inbox-dev']) {
      // The client tries to claim the watcher's mark (any case) and a second field: only the handler's value is stored.
      const forged = { 'x-amz-meta-writer': 'pc-runner', 'X-Amz-Meta-Writer': 'pc-runner', 'x-amz-meta-extra': 'y' };
      assert.equal((await write(inbox, 'tok-pc-runner', 'p-1', forged)).status, 200);
      assert.deepEqual(metaOf(inbox, 'p-1'), { writer: 'pc-runner' }, `${inbox}: the watcher's token`);
      assert.equal((await write(inbox, 'tok-agent', 'a-1', forged)).status, 200);
      assert.deepEqual(metaOf(inbox, 'a-1'), { writer: 'agent' }, `${inbox}: an agent token cannot claim pc-runner`);
      assert.equal((await write(inbox, 'tok-cloud-ml', 'c-1', forged)).status, 200);
      assert.deepEqual(metaOf(inbox, 'c-1'), { writer: 'other' }, `${inbox}: a cloud token cannot claim pc-runner`);
    }
    for (const [token, id] of [['tok-hermes-main', 'h-1'], ['tok-hermes', 'h-2'], ['tok-cloud', 'o-1'], ['tok-agentish', 'o-3']]) {
      assert.equal((await write('inbox', token, id, { 'x-amz-meta-writer': 'pc-runner' })).status, 200, token);
      assert.deepEqual(fake.objects.get(`sections/inbox/asks/${id}/ask.json`).metadata, { writer: 'other' }, `${token}: other, never pc-runner`);
    }
    // The passphrase's own ask.json carries nothing, and a header does not give it a mark.
    assert.equal((await write('inbox', 'tok-all', 'z-1', { 'x-amz-meta-writer': 'pc-runner' })).status, 200);
    assert.deepEqual(metaOf('inbox', 'z-1'), {});
    // Other Ask files and other tokens' other files carry nothing; ask.json is still create-only and not an upload URL.
    assert.equal((await call('PUT', '/sections/inbox/files/asks/p-1/picture.png', { token: 'tok-pc-runner', body: Buffer.from('x'), base64: true, headers: { 'x-amz-meta-writer': 'pc-runner' } })).status, 200);
    assert.deepEqual(fake.objects.get('sections/inbox/asks/p-1/picture.png').metadata, {});
    assert.equal((await call('PUT', '/sections/inbox/files/asks/p-1/ask.json', { token: 'tok-pc-runner', body: Buffer.from(body), base64: true })).status, 403, 'not replaceable');
    assert.equal((await call('POST', '/sections/inbox/uploads', { token: 'tok-pc-runner', body: { files: [{ path: 'asks/u-1/ask.json' }] } })).status, 403, 'not by upload URL');
  } finally {
    await fake.close();
  }
});

test('inbox: pc-runner writes run-* and result files only for a request taken by the PC runner; taken.json, report.md and other tokens are not gated by it', async () => {
  const { fake, call, bucket } = await setup();
  try {
    fake.seed('sections/inbox-dev/workspace.json', JSON.stringify({ name: 'Inbox (dev)', hidden: true, entities: [] }), 'application/json');
    for (const inbox of ['inbox', 'inbox-dev']) {
      const put = (token, id, file, headers = {}) => call('PUT', `/sections/${inbox}/files/requests/${id}/${file}`, { token, body: bytes('{"n":1}'), base64: true, headers });
      const files = ['run-20261030T101500123Z-ab12.json', 'result.json'];
      // Never taken: refused with the reason, and nothing is stored.
      for (const file of files) {
        const refused = await put('tok-pc-runner', 'n-1', file, { 'If-None-Match': '*' });
        assert.equal(refused.status, 403, `${inbox} ${file}`);
        assert.match(refused.data.error, /taken\.json is not there/);
        assert.equal(fake.text(`sections/${inbox}/requests/n-1/${file}`), null);
      }
      // The claim comes first: taken.json and the report are not gated, and then the run files go.
      assert.equal((await put('tok-pc-runner', 'n-1', 'taken.json', { 'If-None-Match': '*' })).status, 200, 'the take itself');
      // A taken.json that names another runner (or none) is not the PC runner's take.
      assert.equal((await put('tok-pc-runner', 'n-1', 'run-20261030T101500123Z-ab12.json')).status, 403, 'taken.json without runner: pc');
      fake.seed(`sections/${inbox}/requests/n-1/taken.json`, JSON.stringify({ runner: 'cloud' }), 'application/json');
      assert.equal((await put('tok-pc-runner', 'n-1', 'result.json')).status, 403, 'taken by the cloud runner');
      fake.seed(`sections/${inbox}/requests/n-1/taken.json`, JSON.stringify({ runner: 'pc', host: 'pc' }), 'application/json');
      for (const file of files) assert.equal((await put('tok-pc-runner', 'n-1', file)).status, 200, `${inbox} ${file} after the take`);
      assert.equal((await put('tok-pc-runner', 'n-1', 'report.md')).status, 200, 'the report is not gated');
      // A taken.json that does not parse is no take (403); a storage error is not an answer (503, so the client retries), and nothing is stored.
      fake.seed(`sections/${inbox}/requests/n-3/taken.json`, 'not json', 'text/plain');
      const garbled = await put('tok-pc-runner', 'n-3', 'result.json');
      assert.equal(garbled.status, 403, `${inbox} unparseable taken.json`);
      const real = bucket.getJson;
      bucket.getJson = async name => { if (name.endsWith('/taken.json')) throw Object.assign(new Error('storage is down'), { status: 500 }); return real.call(bucket, name); };
      try {
        const down = await put('tok-pc-runner', 'n-1', 'result.json', { 'If-None-Match': '*' });
        assert.equal(down.status, 503, `${inbox} a storage error is not a refusal`);
        assert.match(down.data.error, /try again/);
      } finally { bucket.getJson = real; }
      assert.equal(fake.text(`sections/${inbox}/requests/n-3/result.json`), null);
      // The passphrase is not limited, and a cloud token keeps its own project rule.
      assert.equal((await put('tok-all', 'n-2', 'result.json')).status, 200, 'the passphrase needs no take');
    }
  } finally {
    await fake.close();
  }
});

test('inbox: an Ask whose change list is not valid is refused for a limited token (422, the problems named); a good one, and an Ask with no changes, pass', async () => {
  const { fake, call } = await setup();
  try {
    const putAsk = (token, id, body) => call('PUT', `/sections/inbox/files/asks/${id}/ask.json`, { token, body: Buffer.from(JSON.stringify(body)), base64: true, headers: { 'If-None-Match': '*' } });
    const ask = changes => ({ id: 'x-3', project: 'wk', question: 'Apply this?', kind: 'decision', changes });
    const bad = await putAsk('tok-cloud', 'x-3', ask([{ op: 'create', title: 'Run `git push --force` now' }, { op: 'label', bead: 'wk-1', add: ['p0'] }]));
    assert.equal(bad.status, 422);
    assert.match(bad.data.error, /The change list is not valid: change 1: title has a command in its text/);
    assert.match(bad.data.error, /change 2: add is 1 to 5 different labels/);
    assert.equal(fake.text('sections/inbox/asks/x-3/ask.json'), null, 'Nothing was written.');
    assert.equal((await putAsk('tok-cloud', 'x-3', ask([]))).status, 422, 'An empty list.');
    assert.equal((await putAsk('tok-cloud', 'x-3', ask('close everything'))).status, 422, 'Not a list.');
    assert.equal((await putAsk('tok-cloud', 'x-3', ask([{ op: 'close', bead: 'wk-1', reason: 'Done.' }, { op: 'create', title: 'Next', parent: '#1' }]))).status, 422, 'A ref to a change that is no create.');
    assert.equal((await putAsk('tok-hermes', 'x-3', ask([{ op: 'delete', bead: 'wk-1' }]))).status, 422, 'The Hermes token is checked like the others.');
    const good = await putAsk('tok-hermes', 'x-3', ask([{ op: 'create', title: 'Sprint 4', type: 'epic' }, { op: 'create', title: 'Child', parent: '#1' }, { op: 'close', bead: 'wk-1', reason: 'Covered.' }]));
    assert.equal(good.status, 200, JSON.stringify(good.data));
    assert.equal(JSON.parse(fake.text('sections/inbox/asks/x-3/ask.json')).changes.length, 3);
    assert.equal((await putAsk('tok-cloud', 'x-4', { id: 'x-4', project: 'wk', question: 'Which?' })).status, 200, 'An Ask without changes is as before.');
    assert.equal((await call('PUT', '/sections/inbox/files/asks/x-5/ask.json', { token: 'tok-cloud', body: Buffer.from('not json'), base64: true, headers: { 'If-None-Match': '*' } })).status, 200, 'What does not parse is the Hub\'s to ignore, as before.');
    assert.equal((await putAsk('tok-all', 'x-6', ask([{ op: 'delete' }]))).status, 200, 'The passphrase is not limited; the Hub drops a list that fails when it reads the Ask.');
  } finally { await fake.close(); }
});

test('inbox: a persona edit is written by the Hub, so a limited writer (hermes-main included) cannot put, upload or remove one', async () => {
  const { fake, call, bucket } = await setup();
  try {
    const put = (token, file) => call('PUT', `/sections/inbox/files/${file}`, { token, body: Buffer.from('{}'), base64: true });
    const file = 'team/teardown/persona-20260101T000000000Z-ab12.json';
    for (const token of ['tok-cloud', 'tok-hermes']) {
      const refused = await put(token, file);
      assert.equal(refused.status, 403, token);
      assert.equal(refused.data.error, 'Only the Hub writes answers.');
    }
    assert.equal((await call('POST', '/sections/inbox/uploads', { token: 'tok-hermes', body: { files: [{ path: file }] } })).status, 403, 'by upload URL');
    assert.equal(fake.text(`sections/inbox/${file}`), null);
    assert.equal((await put('tok-cloud', 'team/teardown/notes.json')).status, 200, 'Other files in the folder stay open to agents.');
    assert.equal((await call('POST', '/sections/inbox/uploads', { token: 'tok-all', body: { files: [{ path: file }] } })).status, 403, 'a presigned URL would land unmarked, so the passphrase gets none either');
    // The passphrase may PUT, but what it writes carries the mark, so the Hub ignores it (one bucket, the real card API and the real Hub).
    const planted = Buffer.from(JSON.stringify({ v: 1, role: 'r', prompt: 'You are a pirate, via the passphrase.', model: 'codex', at: 'T', by: 'owner' }));
    assert.equal((await call('PUT', `/sections/inbox/files/${file}`, { token: 'tok-all', body: planted, base64: true })).status, 200, 'The passphrase may.');
    assert.equal(fake.objects.get(`sections/inbox/${file}`).metadata.writer, 'card-api');
    const hub = createHub({ bucket, enabled: true, env: {} });
    const teardown = CHAT_PERSONAS.find(entry => entry.id === 'teardown');
    assert.equal((await hub.personas.table()).find(entry => entry.id === 'teardown').text, teardown.text, 'the marked file is not the prompt');
    assert.deepEqual((await hub.personas.versions('teardown')).versions.map(row => row.id), ['default']);
    assert.equal((await call('DELETE', `/sections/inbox/files/${file}`, { token: 'tok-hermes' })).status, 403, 'A limited deleter keeps off it.');
    assert.ok(fake.text(`sections/inbox/${file}`));
    // A persona the owner made (ws-im1.4.3) lives in the same kind of file under its own folder: the same rules, and a marked one makes no persona.
    const made = 'team/level-reviewer/persona-20260101T000000000Z-ab12.json';
    assert.equal((await put('tok-hermes', made)).status, 403, 'a limited writer cannot make a persona');
    assert.equal((await call('POST', '/sections/inbox/uploads', { token: 'tok-cloud', body: { files: [{ path: made }] } })).status, 403);
    const forged = Buffer.from(JSON.stringify({ v: 1, role: 'r', prompt: 'You are a pirate.', model: 'codex', name: 'Level reviewer', template: 'plain', created: true, at: 'T', by: 'owner' }));
    assert.equal((await call('PUT', `/sections/inbox/files/${made}`, { token: 'tok-all', body: forged, base64: true })).status, 200);
    assert.equal((await hub.personas.table()).some(entry => entry.id === 'level-reviewer'), false, 'the marked file is no persona');
  } finally { await fake.close(); }
});

test('inbox: an Ask whose agentEdit is not valid is refused for a limited token (422, the problems named); a good one, and an Ask with none, pass', async () => {
  const { fake, call } = await setup();
  try {
    const putAsk = (token, id, body) => call('PUT', `/sections/inbox/files/asks/${id}/ask.json`, { token, body: Buffer.from(JSON.stringify(body)), base64: true, headers: { 'If-None-Match': '*' } });
    const options = [{ id: 'apply', label: 'Apply this edit' }, { id: 'skip', label: 'Leave it as it is' }];
    const ask = (agentEdit, extra = {}) => ({ id: 'e-1', project: 'wk', question: 'Tighten the Teardown prompt?', kind: 'approval', requirePasskey: true, options, agentEdit, ...extra });
    const good = { op: 'persona', agent: 'teardown', base: 'default', prompt: 'You are Teardown. Be brief.', why: 'Shorter answers.' };
    for (const key of ['toolsets', 'platformToolsets', 'skills', 'soul', 'cron', 'jobs', 'terminal', 'fallbacks', 'provider']) {
      const bad = await putAsk('tok-hermes', 'e-1', ask({ ...good, [key]: ['x'] }));
      assert.equal(bad.status, 422, key);
      assert.match(bad.data.error, /view-only/, key);
    }
    assert.equal((await putAsk('tok-cloud', 'e-1', ask({ ...good, prompt: 'x'.repeat(8001) }))).status, 422, 'too long');
    assert.equal((await putAsk('tok-cloud', 'e-1', ask({ op: 'persona', agent: 'teardown', base: 'default' }))).status, 422, 'changes nothing');
    assert.equal((await putAsk('tok-cloud', 'e-1', ask(good, { requirePasskey: false }))).status, 422, 'no passkey');
    assert.equal((await putAsk('tok-cloud', 'e-1', ask(good, { options: [{ id: 'apply', label: 'Do it now' }, options[1]] }))).status, 422, 'other options');
    assert.equal(fake.text('sections/inbox/asks/e-1/ask.json'), null, 'Nothing was written.');
    assert.equal((await putAsk('tok-hermes', 'e-1', ask(good))).status, 200);
    assert.equal(JSON.parse(fake.text('sections/inbox/asks/e-1/ask.json')).agentEdit.agent, 'teardown');
    assert.equal((await putAsk('tok-cloud', 'e-2', { id: 'e-2', project: 'wk', question: 'Which?' })).status, 200, 'An Ask without agentEdit is as before.');
    assert.equal((await putAsk('tok-all', 'e-3', ask({ op: 'x' }))).status, 200, 'The passphrase is not limited.');
  } finally { await fake.close(); }
});

test('inbox: the hermes-config token creates a change result once and reads the signed changes and results only, in the inbox only', async () => {
  const { fake, call } = await setup();
  try {
    const id = '20261103-profile-main-ab12';
    const approved = `agent-config/changes/${id}/approved.json`;
    const result = `agent-config/changes/${id}/result.json`;
    const url = name => `/sections/inbox/files/${name}`;
    const put = (token, name, headers = { 'If-None-Match': '*' }, body = '{"v":1}') => call('PUT', url(name), { token, body: Buffer.from(body), base64: true, headers });
    // The Hub's approval (the passphrase writes it here; the real Hub writes it with its own credentials).
    assert.equal((await put('tok-all', approved)).status, 200);
    // The host creates its result once, marked, never an upload URL, never the approval.
    const created = await put('tok-hermes-config', result, { 'If-None-Match': '*', 'x-amz-meta-writer': 'agent' });
    assert.equal(created.status, 200);
    assert.deepEqual(fake.objects.get(`sections/inbox/${result}`).metadata, { writer: 'hermes-config' });
    assert.equal((await put('tok-hermes-config', result)).status, 412, 'not replaced');
    assert.equal((await put('tok-hermes-config', `agent-config/changes/${id}/result.json`, {})).status, 403, 'no replace');
    assert.equal((await call('POST', '/sections/inbox/uploads', { token: 'tok-hermes-config', body: { files: [{ path: `agent-config/changes/20261103-profile-main-ab13/result.json` }] } })).status, 403, 'no upload URL');
    for (const name of [approved, `agent-config/changes/${id}/other.json`, `agent-config/changes/${id}/sub/result.json`, 'agent-config/changes/result.json', 'agent-config/changes/not-an-ask/result.json', `agent-config/changes/${id}/result.json.bak`]) {
      assert.equal((await put('tok-hermes-config', name.replace(id, '20261103-profile-main-ab14'))).status, 403, `write ${name}`);
    }
    for (const token of ['tok-hermes-main', 'tok-hermes', 'tok-agent', 'tok-pc-runner', 'tok-cloud', 'tok-deleter']) {
      assert.equal((await put(token, `agent-config/changes/20261103-profile-main-ab15/result.json`)).status, 403, token);
    }
    // The owner's press signs through the site API only: no card token, the host's own included, may create or replace an approval (ws-ubo.4).
    for (const token of ['tok-hermes-config', 'tok-hermes-main', 'tok-hermes', 'tok-agent', 'tok-pc-runner', 'tok-cloud', 'tok-deleter']) {
      assert.equal((await put(token, `agent-config/changes/20261103-profile-main-ab16/approved.json`)).status, 403, `approved.json: ${token}`);
      assert.equal((await put(token, `agent-config/changes/${id}/approved.json`, {})).status, 403, `approved.json, replace: ${token}`);
    }
    assert.equal(fake.objects.has(`sections/inbox/agent-config/changes/20261103-profile-main-ab16/approved.json`), false);

    // The narrow read: a listing under agent-config/changes/ shows approved.json and result.json files and nothing else.
    fake.seed(`sections/inbox/agent-config/changes/${id}/note.json`, '{}', 'application/json');
    fake.seed('sections/inbox/agent-config/export-20261103T101500Z.json', '{"v":1}', 'application/json');
    fake.seed(`sections/inbox/asks/${id}/ask.json`, '{}', 'application/json');
    const listed = await call('GET', '/sections/inbox/files', { token: 'tok-hermes-config', query: { prefix: 'agent-config/changes/202611' } });
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.data.files.map(file => file.path), [approved, result]);
    const got = await call('GET', url(approved), { token: 'tok-hermes-config' });
    assert.equal(got.status, 200);
    assert.equal((await call('GET', url(result), { token: 'tok-hermes-config' })).status, 200);
    // Nothing else is readable: the token still has no read right on the inbox.
    for (const name of [`agent-config/changes/${id}/note.json`, 'agent-config/export-20261103T101500Z.json', `asks/${id}/ask.json`, 'agent-config/changes/x/approved.json/../../../export-20261103T101500Z.json']) {
      assert.equal((await call('GET', url(name), { token: 'tok-hermes-config' })).status, name.includes('..') ? 400 : 403, `read ${name}`);
    }
    for (const prefix of ['agent-config/', 'agent-config/changes', 'agent-config/export-2026', 'asks/', 'agent-config/changes/../export', '']) {
      const refused = await call('GET', '/sections/inbox/files', { token: 'tok-hermes-config', query: { prefix } });
      assert.ok([400, 403].includes(refused.status), `list ${JSON.stringify(prefix)}: ${refused.status}`);
    }
    assert.equal((await call('GET', '/sections/inbox/cards/anything', { token: 'tok-hermes-config' })).status, 403, 'no card reads either');
    assert.equal((await call('DELETE', url(result), { token: 'tok-hermes-config' })).status, 403);
    // The development inbox is not covered by the narrow read, even when the section exists.
    fake.seed('sections/inbox-dev/workspace.json', JSON.stringify({ name: 'Inbox (dev)', hidden: true, entities: [] }), 'application/json');
    fake.seed(`sections/inbox-dev/${approved}`, '{}', 'application/json');
    assert.equal((await call('GET', `/sections/inbox-dev/files/${approved}`, { token: 'tok-hermes-config' })).status, 403);
    assert.equal((await call('GET', '/sections/inbox-dev/files', { token: 'tok-hermes-config', query: { prefix: 'agent-config/changes/' } })).status, 403);
    // Other limited tokens gain nothing: a token with a read right reads as before, and one without still does not.
    assert.equal((await call('GET', url(approved), { token: 'tok-reader' })).status, 200);
    assert.equal((await call('GET', url(approved), { token: 'tok-deploy' })).status, 200);
    assert.equal((await call('GET', url(approved), { token: 'tok-devbot' })).status, 200, 'read=* includes the inbox, as before');
  } finally {
    await fake.close();
  }
});

// ---- cards.mjs against a project section a token may only add to (the `@library` right) ----

const ownerCard = { id: 'owner-card', folder: '2026-11-01_owner', title: 'Owner card', description: 'Mine.', category: 'plan', created: '2026-11-01', status: 'active', type: 'standalone', steps: [{ name: 'Notes', path: 'index.md' }] };

async function libraryClient() {
  const fake = await startFakeS3();
  const bucket = createBucket({ bucket: fake.bucket, endpoint: fake.endpoint, credentials: fake.credentials, region: 'us-east-1' });
  const list = (id, body) => fake.seed(`sections/${id}/workspace.json`, JSON.stringify(body), 'application/json');
  list('magic-loops', { name: 'Magic Loops', entities: [ownerCard] });
  fake.seed(`sections/magic-loops/${ownerCard.folder}/index.md`, '# Owner', 'text/markdown');
  fake.seed(`sections/magic-loops/${ownerCard.folder}/extra.txt`, 'extra', 'text/plain');
  list('assistant', { name: 'Assistant', entities: [] });
  list('inbox', { name: 'Inbox', hidden: true, entities: [] });
  const tokens = parseTokens([
    `all=${sha('tok-all')}`,
    `lib=${sha('tok-lib')}:read=*;write=inbox|assistant|@library`,
    `reader=${sha('tok-reader')}:read=*`,
  ].join(', '));
  const server = await serve(createCardApi({ bucket, tokens, today: () => '2026-11-05' }));
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cards-lib-'));
  /** Runs cards.mjs; never rejects: { code, stdout, stderr }. */
  const run = (token, ...args) => new Promise(resolve => {
    execFile(process.execPath, [path.join(repo, 'scripts/cards.mjs'), ...args], {
      env: { ...process.env, BUW_CARD_API: server.url, BUW_CARDS_PASSWORD: token, BUW_CARDS_VIA: 'api' },
    }, (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr }));
  });
  const lib = (...args) => run('tok-lib', ...args);
  const written = (key = ownerCard.folder) => [...fake.objects.keys()].filter(item => item.includes(key));
  const puts = () => fake.log.filter(entry => entry.method === 'PUT').length;
  const records = () => [...fake.objects.keys()].filter(key => key.startsWith('sections/inbox/card-writes/')).sort().map(key => fake.json(key));
  /** A new card folder in dir, with its entry in dir/workspace.json. */
  const newCard = async (files = { 'index.md': '# Agent note' }, id = 'agent-note') => {
    const folder = `2026-11-05_${id}`;
    await mkdir(path.join(dir, folder), { recursive: true });
    for (const [name, body] of Object.entries(files)) await writeFile(path.join(dir, folder, name), body);
    const registry = JSON.parse(await readFile(path.join(dir, 'workspace.json'), 'utf8').catch(() => '{"entities":[]}'));
    registry.entities.push({ id, folder, title: 'Agent note', description: 'Notes.', category: 'plan', created: '2026-11-05', type: 'standalone', steps: [{ name: 'Notes', path: 'index.md' }] });
    await writeFile(path.join(dir, 'workspace.json'), JSON.stringify(registry));
    return folder;
  };
  const finish = async () => { server.close(); await fake.close(); await rm(dir, { recursive: true, force: true }); };
  return { fake, lib, run, dir, written, puts, records, newCard, finish };
}
const WHO = ['--agent', 'Researcher', '--why', 'Notes for the owner'];

test('cards put in a project section: a new card needs who and why, and leaves records', async () => {
  const t = await libraryClient();
  try {
    assert.match((await t.lib('sections')).stdout, /^magic-loops\t1 card\(s\)\tMagic Loops\tadd$/m);
    assert.match((await t.lib('sections')).stdout, /^assistant\t0 card\(s\)\tAssistant\twrite$/m);
    const folder = await t.newCard();
    const before = t.puts();
    const none = await t.lib('put', t.dir, '--section', 'magic-loops', '--card', 'agent-note');
    assert.equal(none.code, 2);
    assert.match(none.stderr, /--agent <name> is needed/);
    assert.equal(t.puts(), before, 'nothing was written');
    const dry = await t.lib('put', t.dir, '--section', 'magic-loops', '--card', 'agent-note', '--dry-run');
    assert.equal(dry.code, 0, 'a dry run needs no agent');
    assert.match(dry.stdout, /1 new, 0 edit, 0 unchanged, 0 kept/);
    assert.equal(t.puts(), before);

    const done = await t.lib('put', t.dir, '--section', 'magic-loops', '--card', 'agent-note', ...WHO);
    assert.equal(done.code, 0, done.stderr);
    assert.match(done.stdout, /\+ 2026-11-05_agent-note\/index\.md/);
    assert.match(done.stdout, /Added magic-loops\/agent-note as Researcher\./);
    assert.equal(done.stderr.includes('not recorded'), false);
    assert.deepEqual(t.fake.json('sections/magic-loops/workspace.json').entities.map(item => item.id), ['owner-card', 'agent-note']);
    const rows = t.records().filter(row => !row.entry);
    assert.deepEqual(rows.map(row => [row.kind, row.agent, row.token, row.context, row.file]), [['new-card', 'Researcher', 'lib', 'chat', `${folder}/index.md`]]);
    const put = t.fake.log.find(entry => entry.method === 'PUT' && entry.key.endsWith(`${folder}/index.md`));
    assert.equal(put.headers['if-none-match'], '*');
  } finally {
    await t.finish();
  }
});

test('cards put in a project section: a changed file needs --edit and the version get read', async () => {
  const t = await libraryClient();
  const key = `sections/magic-loops/${ownerCard.folder}/index.md`;
  try {
    await t.lib('get', 'magic-loops/owner-card', '--into', t.dir);
    const file = path.join(t.dir, ownerCard.folder, 'index.md');
    await writeFile(file, '# Owner, edited');
    const before = t.puts();
    const plain = await t.lib('put', t.dir, '--section', 'magic-loops', '--card', 'owner-card', ...WHO);
    assert.equal(plain.code, 2);
    assert.match(plain.stderr, /needs --edit[\s\S]*index\.md/);
    assert.equal(t.puts(), before);
    assert.equal(t.fake.text(key), '# Owner');

    // The owner changes the file meanwhile: the edit is refused (exit 3) and the owner's version stays.
    t.fake.seed(key, '# Owner, changed by the owner', 'text/markdown');
    const lost = await t.lib('put', t.dir, '--section', 'magic-loops', '--card', 'owner-card', '--edit', '--context', 'chat', ...WHO);
    assert.equal(lost.code, 3);
    assert.match(lost.stderr, /Stopped: .*index\.md changed in the bucket/);
    assert.equal(t.fake.text(key), '# Owner, changed by the owner');

    // Read again, edit, put: it goes up, and the record names the version it replaced.
    const again = await mkdtemp(path.join(os.tmpdir(), 'cards-lib2-'));
    try {
      await t.lib('get', 'magic-loops/owner-card', '--into', again);
      await writeFile(path.join(again, ownerCard.folder, 'index.md'), '# Owner, then the agent');
      const ok = await t.lib('put', again, '--section', 'magic-loops', '--card', 'owner-card', '--edit', '--context', 'job:20261105-x', ...WHO);
      assert.equal(ok.code, 0, ok.stderr);
      assert.equal(t.fake.text(key), '# Owner, then the agent');
      const edit = t.records().find(row => row.kind === 'edit');
      assert.equal(edit.context, 'job:20261105-x');
      assert.ok(edit.previousVersionId, 'the earlier version is recorded');
    } finally {
      await rm(again, { recursive: true, force: true });
    }

    // A folder with no .cards-base.json cannot be edited: there is no version to be conditional on.
    const bare = await mkdtemp(path.join(os.tmpdir(), 'cards-lib3-'));
    try {
      await t.lib('get', 'magic-loops/owner-card', '--into', bare);
      await rm(path.join(bare, '.cards-base.json'));
      await writeFile(path.join(bare, ownerCard.folder, 'index.md'), '# Without a base');
      const none = await t.lib('put', bare, '--section', 'magic-loops', '--card', 'owner-card', '--edit', ...WHO);
      assert.equal(none.code, 2);
      assert.match(none.stderr, /get did not record the version/);
    } finally {
      await rm(bare, { recursive: true, force: true });
    }
  } finally {
    await t.finish();
  }
});

test('cards put in a project section: a file gone here stays, --remove is refused, a big file is refused first', async () => {
  const t = await libraryClient();
  const extra = `sections/magic-loops/${ownerCard.folder}/extra.txt`;
  try {
    await t.lib('get', 'magic-loops/owner-card', '--into', t.dir);
    await rm(path.join(t.dir, ownerCard.folder, 'extra.txt'));
    const kept = await t.lib('put', t.dir, '--section', 'magic-loops', '--card', 'owner-card', ...WHO);
    assert.equal(kept.code, 0, kept.stderr);
    assert.match(kept.stdout, /0 new, 0 edit, 1 unchanged, 1 kept \(in the bucket, not here\)/);
    assert.match(kept.stdout, /= .*extra\.txt/);
    assert.equal(t.fake.text(extra), 'extra');
    const before = t.puts();
    const removed = await t.lib('put', t.dir, '--section', 'magic-loops', '--card', 'owner-card', '--remove', ...WHO);
    assert.equal(removed.code, 2);
    assert.match(removed.stderr, /--remove is not allowed/);
    assert.equal(t.fake.text(extra), 'extra');
    assert.equal(t.fake.log.some(entry => entry.method === 'DELETE'), false);
    assert.equal(t.puts(), before);

    await t.newCard({ 'index.md': '# Big', 'big.bin': Buffer.alloc(5 * 1024 * 1024, 1) }, 'big-card');
    const uploadsBefore = t.fake.log.length;
    const big = await t.lib('put', t.dir, '--section', 'magic-loops', '--card', 'big-card', ...WHO);
    assert.equal(big.code, 2);
    assert.match(big.stderr, /at most 4 MB[\s\S]*big\.bin/);
    assert.equal(t.written('big-card').length, 0, 'not even the small file went up');
    assert.equal(t.fake.log.slice(uploadsBefore).some(entry => entry.method === 'PUT'), false);
  } finally {
    await t.finish();
  }
});

test('cards put: a token that may only read is refused before any write', async () => {
  const t = await libraryClient();
  try {
    await t.newCard();
    const refused = await t.run('tok-reader', 'put', t.dir, '--section', 'magic-loops', '--card', 'agent-note', ...WHO);
    assert.equal(refused.code, 2);
    assert.match(refused.stderr, /may not add to magic-loops/);
    assert.equal(t.puts(), 0);
  } finally {
    await t.finish();
  }
});

test('cards put in assistant (a literal right): headers are optional, and it still removes nothing without --remove', async () => {
  const t = await libraryClient();
  try {
    await t.newCard({ 'index.md': '# A', 'b.txt': 'b' });
    const first = await t.lib('put', t.dir, '--section', 'assistant', '--card', 'agent-note');
    assert.equal(first.code, 0, first.stderr);
    assert.match(first.stdout, /2 to upload, 0 to remove, 0 unchanged/);
    assert.equal(t.fake.log.filter(entry => entry.method === 'PUT' && entry.key.includes('agent-note/')).every(entry => entry.headers['if-none-match'] === '*'), true);
    await rm(path.join(t.dir, '2026-11-05_agent-note', 'b.txt'));
    const again = await t.lib('put', t.dir, '--section', 'assistant', '--card', 'agent-note');
    assert.match(again.stdout, /1 kept/);
    assert.equal(t.fake.text('sections/assistant/2026-11-05_agent-note/b.txt'), 'b');
  } finally {
    await t.finish();
  }
});

test('cards request card prints the card a finished request made, or exits 3', async () => {
  const t = await libraryClient();
  try {
    const id = '20261105-demo-note-ab12';
    t.fake.seed(`sections/inbox/requests/${id}/request.json`, JSON.stringify({ project: 'magic-loops' }), 'application/json');
    const none = await t.run('tok-all', 'request', 'card', id);
    assert.equal(none.code, 3);
    assert.match(none.stderr, /No card yet\./);
    assert.equal(none.stdout, '');
    t.fake.seed(`sections/inbox/requests/${id}/result.json`, JSON.stringify({ v: 1, outcome: 'card', card: 'magic-loops/2026-11-05_note' }), 'application/json');
    const done = await t.run('tok-all', 'request', 'card', id);
    assert.equal(done.code, 0, done.stderr);
    assert.equal(done.stdout.trim(), 'magic-loops/2026-11-05_note');
  } finally {
    await t.finish();
  }
});

test('cards put --via s3: the handler runs here with an unrestricted caller, so access is direct', async () => {
  const t = await libraryClient();
  try {
    await t.newCard();
    const env = { ...process.env, HOME: t.dir, USERPROFILE: t.dir, BUW_REGISTRY: path.join(t.dir, 'none.json'), BUW_CARD_API: '', BUW_CARDS_PASSWORD: '', BUW_CARDS_VIA: '', AWS_ACCESS_KEY_ID: 'test', AWS_SECRET_ACCESS_KEY: 'test', BUW_S3_BUCKET: t.fake.bucket, BUW_S3_ENDPOINT: t.fake.endpoint, BUW_S3_REGION: 'us-east-1' };
    delete env.AWS_PROFILE;
    const { stdout, stderr } = await promisify(execFile)(process.execPath, [path.join(repo, 'scripts/cards.mjs'), 'put', t.dir, '--section', 'magic-loops', '--card', 'agent-note', '--via', 's3'], { env });
    assert.match(stderr, /via s3:\/\/test-bucket/);
    assert.match(stdout, /1 to upload, 0 to remove, 0 unchanged/);
    assert.equal(t.fake.text('sections/magic-loops/2026-11-05_agent-note/index.md'), '# Agent note');
  } finally {
    await t.finish();
  }
});

test('inbox: chat/ (the queue and the stored lines) is the Hub\'s, so a limited writer is refused and the passphrase still may', async () => {
  const { fake, call } = await setup();
  try {
    const put = (token, file) => call('PUT', `/sections/inbox/files/${file}`, { token, body: Buffer.from('{}'), base64: true });
    for (const file of ['chat/queue/20261104-abcdef.json', 'chat/20261104-abcdef.jsonl', 'chat/20261104-abcdef/pic.png', 'chat/state.json']) {
      for (const token of ['tok-cloud', 'tok-hermes']) {
        const refused = await put(token, file);
        assert.equal(refused.status, 403, `${token} ${file}`);
        assert.equal(refused.data.error, 'Only the Hub writes answers.');
      }
      assert.equal((await call('POST', '/sections/inbox/uploads', { token: 'tok-cloud', body: { files: [{ path: file }] } })).status, 403, `${file} by upload URL`);
      assert.equal((await call('DELETE', `/sections/inbox/files/${file}`, { token: 'tok-cloud' })).status, 403, `${file} delete`);
    }
    assert.equal(fake.text('sections/inbox/chat/queue/20261104-abcdef.json'), null, 'nothing was planted');
    assert.equal(fake.text('sections/inbox/chat/state.json'), null, 'no chat state was planted');
    assert.equal((await put('tok-all', 'chat/queue/20261104-abcdef.json')).status, 200, 'The passphrase may.');
  } finally {
    await fake.close();
  }
});
