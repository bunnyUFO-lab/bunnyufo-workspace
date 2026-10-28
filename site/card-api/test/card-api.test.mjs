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
import { createCardApi, handler, parseRef, parseScope, parseTokens } from '../handler.mjs';

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
    `deleter=${sha('tok-deleter')}:read=*;write=inbox;delete=inbox`,
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
  return { fake, api, call };
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
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
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
    for (const file of ['asks/x-1/answer.json', 'asks/x-1/answer.png', 'asks/x-1/snooze.json', 'requests/r-1/declined.json']) {
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
    const owned = ['tick-01-20261027T143012123Z-a1b2.json', 'untick-01-20261027T143012123Z-a1b2.json', 'submit.json'];
    for (const file of owned) {
      for (const token of ['tok-cloud', 'tok-hermes']) {
        const refused = await put(token, file, { 'If-None-Match': '*' });
        assert.equal(refused.status, 403, `${token} ${file}`);
      }
      assert.equal((await call('POST', '/sections/inbox/uploads', { token: 'tok-cloud', body: { files: [{ path: `${folder}/${file}` }] } })).status, 403, `${file} by upload URL`);
      assert.equal(fake.text(`sections/inbox/${folder}/${file}`), null);
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
    assert.match((await run('put', dir, '--section', 'magic-loops', '--card', 'loops-plan')).stdout, /0 to upload, 1 to remove, 1 unchanged/);
    assert.equal(fake.text('sections/magic-loops/2026-10-01_loops-plan/media/note.txt'), null);
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
