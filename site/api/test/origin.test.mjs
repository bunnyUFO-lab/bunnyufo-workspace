// Writes to the site API come only from the site's own pages, in JSON. No network, no real bucket.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSiteApi, allowedOriginsFrom, writeOriginsFor } from '../server.mjs';
import { createBucket } from '../s3.mjs';
import { createHub } from '../hub.mjs';
import { startFakeS3 } from './fake-s3.mjs';

const SITE = 'https://site.example';
const user = { 'Remote-User': 'owner' };
const pin = { workspace: 'one', id: 'alpha', pinned: true };
const json = { 'Content-Type': 'application/json' };

async function fixture({ allowedOrigins = [SITE], requireRemoteUser = true } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'buw-origin-'));
  const fake = await startFakeS3();
  const bucket = createBucket({ bucket: fake.bucket, endpoint: fake.endpoint, credentials: fake.credentials, region: 'us-east-1' });
  const entity = { id: 'alpha', folder: 'alpha', title: 'alpha', description: 'A card.', category: 'test', created: '2026-01-01', updated: '2026-01-01', status: 'active', steps: [{ name: 'Page', path: 'index.html' }] };
  fake.seed('sections/one/workspace.json', JSON.stringify({ entities: [entity] }), 'application/json');
  fake.seed('sections/one/alpha/index.html', '<h1>alpha</h1>', 'text/html');
  fake.seed('state.json', '{"version":1,"cards":{}}', 'application/json');
  const server = createSiteApi({
    bucket, templateDir: path.join(root, 'none'), stateFile: path.join(root, 'card-state.json'), sectionsTtl: 0, requireRemoteUser,
    hub: createHub({ bucket, enabled: true, env: { STT_URL: 'http://127.0.0.1:9/none', HUB_DISCORD_TOKEN_SHA256: 'a'.repeat(64), HUB_DISCORD_OWNER_ID: '100000000000000001' } }), allowedOrigins,
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const send = async (route, { method = 'POST', headers = {}, body = JSON.stringify(pin) } = {}) => {
    const answer = await fetch(base + route, { method, headers, body: method === 'GET' || method === 'OPTIONS' ? undefined : body });
    return { status: answer.status, body: await answer.json().catch(() => null) };
  };
  const close = async () => { server.closeAllConnections?.(); server.close(); await fake.close(); };
  return { send, close, fake };
}

test('a signed-in write passes only from the site origin, and only as JSON', async () => {
  const { send, close, fake } = await fixture();
  try {
    assert.equal((await send('/workspace/pin', { headers: { ...user, ...json, Origin: SITE } })).status, 200);

    for (const origin of ['https://evil.example', 'null', 'http://site.example', 'https://site.example.evil.example']) {
      const refused = await send('/workspace/pin', { headers: { ...user, ...json, Origin: origin } });
      assert.equal(refused.status, 403, origin);
      assert.match(refused.body.error, /own pages/);
    }
    assert.equal((await send('/workspace/pin', { headers: { ...user, ...json } })).status, 403, 'No Origin at all is refused.');

    for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x']) {
      const refused = await send('/workspace/pin', { headers: { ...user, 'Content-Type': type, Origin: SITE } });
      assert.equal(refused.status, 415, type);
      assert.equal(refused.body.error, 'Send JSON.');
    }
    assert.equal((await send('/workspace/pin', { headers: { ...user, 'Content-Type': 'application/json; charset=utf-8', Origin: SITE } })).status, 200);

    // A refused write changes nothing: the state holds only the pin the passing writes made.
    assert.equal(Object.keys(fake.json('state.json').cards).length, 1);
  } finally { await close(); }
});

test('the Hub routes sit behind the same check', async () => {
  const { send, close } = await fixture();
  try {
    assert.equal((await send('/hub/asks/x/snooze', { headers: { ...user, ...json }, body: '{}' })).status, 403);
    assert.equal((await send('/hub/asks/x/snooze', { headers: { ...user, Origin: SITE, 'Content-Type': 'text/plain' }, body: '{}' })).status, 415);
    const passed = await send('/hub/asks/x/snooze', { headers: { ...user, ...json, Origin: SITE }, body: '{}' });
    assert.notEqual(passed.status, 403);
    assert.notEqual(passed.status, 415);
  } finally { await close(); }
});

test('transcribe takes audio of any codec and nothing else', async () => {
  const { send, close } = await fixture();
  try {
    const post = type => send('/hub/transcribe', { headers: { ...user, 'Content-Type': type, Origin: SITE }, body: 'x' });
    assert.equal((await post('application/json')).status, 415);
    assert.equal((await post('text/plain')).status, 415);
    for (const type of ['audio/webm', 'audio/webm;codecs=opus', 'audio/mp4']) {
      const got = await post(type);
      assert.notEqual(got.status, 415, type);
      assert.notEqual(got.status, 403, type);
    }
    assert.equal((await send('/hub/transcribe', { headers: { ...user, 'Content-Type': 'audio/webm' }, body: 'x' })).status, 403, 'Audio still needs the origin.');
  } finally { await close(); }
});

test('the Asks bot routes keep their bearer check and need no Origin', async () => {
  const { send, close } = await fixture();
  try {
    const got = await send('/hub/discord/answer', { headers: { Authorization: 'Bearer nope', 'Content-Type': 'text/plain' }, body: 'x' });
    assert.equal(got.status, 401, 'The bearer check answers, not the origin check.');
  } finally { await close(); }
});

test('reads and preflights ignore Origin', async () => {
  const { send, close } = await fixture();
  try {
    for (const headers of [{}, { Origin: 'https://evil.example' }, { Origin: 'null' }]) {
      assert.equal((await send('/card-state', { method: 'GET', headers })).status, 200);
      assert.equal((await send('/capabilities', { method: 'GET', headers })).status, 200);
    }
    assert.notEqual((await send('/workspace/pin', { method: 'OPTIONS', headers: { ...user, Origin: 'https://evil.example' } })).status, 403);
  } finally { await close(); }
});

test('with no allowed origin and sign-in required, every write is off', async () => {
  const { send, close } = await fixture({ allowedOrigins: [] });
  try {
    const refused = await send('/workspace/pin', { headers: { ...user, ...json, Origin: SITE } });
    assert.equal(refused.status, 403);
    assert.match(refused.body.error, /no allowed origin is configured/i);
  } finally { await close(); }
});

test('with sign-in off, the check runs only when origins were given', async () => {
  const open = await fixture({ requireRemoteUser: false, allowedOrigins: null });
  try { assert.equal((await open.send('/workspace/pin', { headers: json })).status, 200, 'Local tests send no Origin.'); } finally { await open.close(); }
  const guarded = await fixture({ requireRemoteUser: false });
  try {
    assert.equal((await guarded.send('/workspace/pin', { headers: json })).status, 403);
    assert.equal((await guarded.send('/workspace/pin', { headers: { ...json, Origin: SITE } })).status, 200);
  } finally { await guarded.close(); }
});

test('allowed origins come from BUW_SITE_ORIGINS, else the origin of BUW_SITE_URL, and a bad address fails closed', () => {
  assert.deepEqual(allowedOriginsFrom({ siteUrl: 'https://site.example/some/path' }), [SITE]);
  assert.deepEqual(allowedOriginsFrom({ origins: 'https://a.example, https://b.example:8443/', siteUrl: SITE }), ['https://a.example', 'https://b.example:8443']);
  assert.deepEqual(allowedOriginsFrom({ siteUrl: 'not a url' }), []);
  assert.deepEqual(allowedOriginsFrom({}), []);
});

test('main.mjs options: sign-in off and nothing set passes null, so a local run is not refused', async () => {
  assert.equal(writeOriginsFor({}), null);
  assert.equal(writeOriginsFor({ siteUrl: 'not a url' }), null);
  assert.deepEqual(writeOriginsFor({ requireRemoteUser: true }), [], 'Sign-in on and nothing set fails closed.');
  assert.deepEqual(writeOriginsFor({ siteUrl: SITE }), [SITE], 'An origin set locally is enforced.');
  assert.deepEqual(writeOriginsFor({ requireRemoteUser: true, siteUrl: SITE }), [SITE]);

  const local = await fixture({ requireRemoteUser: false, allowedOrigins: writeOriginsFor({}) });
  try { assert.equal((await local.send('/workspace/pin', { headers: { ...json, Origin: 'http://localhost:5173' } })).status, 200); } finally { await local.close(); }
});
