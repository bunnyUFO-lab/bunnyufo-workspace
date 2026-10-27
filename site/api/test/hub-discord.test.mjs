// The Asks bot's two routes on the site API, over the stand-in S3: who may answer, what the token can
// and cannot do, and that a click is bound to the Ask it showed. Every id here is made up; the token is
// made inside the test.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSiteApi } from '../server.mjs';
import { createBucket } from '../s3.mjs';
import { createHub } from '../hub.mjs';
import { askRev } from '../hub-model.mjs';
import { startFakeS3 } from './fake-s3.mjs';
import { askJson, eventJson, seeder } from './hub-fixtures.mjs';

const OWNER = '100000000000000001';
const OTHER = '100000000000000002';
const INTERACTION = '200000000000000001';
const MESSAGE = '300000000000000001';
const NOW = new Date();
const day = NOW.toISOString().slice(0, 10).replace(/-/g, '');
const askId = (slug, n = 'a1b2') => `${day}-probe-${slug}-${n}`;
const sha = text => createHash('sha256').update(text).digest('hex');
const twoOptions = () => [{ id: 'A', label: 'Yes' }, { id: 'B', label: 'No' }];

async function fixture({ discord = true, token = `buwd_${randomBytes(32).toString('base64url')}` } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'buw-discord-'));
  const fake = await startFakeS3();
  const bucket = createBucket({ bucket: fake.bucket, endpoint: fake.endpoint, credentials: fake.credentials, region: 'us-east-1' });
  fake.seed('sections/inbox/workspace.json', '{"name":"Inbox","hidden":true,"entities":[]}\n', 'application/json');
  fake.seed('state.json', '{"version":1,"cards":{}}', 'application/json');
  const logs = [];
  const env = discord ? { HUB_DISCORD_TOKEN_SHA256: sha(token), HUB_DISCORD_OWNER_ID: OWNER } : {};
  const hub = createHub({ bucket, enabled: true, env, log: line => logs.push(line) });
  const server = createSiteApi({ bucket, templateDir: path.join(root, 'none'), stateFile: path.join(root, 'card-state.json'), sectionsTtl: 0, requireRemoteUser: true, hub });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const origin = `http://127.0.0.1:${port}`;
  const call = async (method, route, { body, headers = {} } = {}) => {
    const answer = await fetch(`${origin}/api${route}`, {
      method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    return { status: answer.status, body: await answer.json().catch(() => null) };
  };
  const bearer = { Authorization: `Bearer ${token}` };
  const list = () => call('GET', '/hub/discord/asks', { headers: bearer });
  const answerBody = (ask, rev, extra = {}) => ({ ask: ask.id, choice: 'A', rev, user: OWNER, interaction: INTERACTION, message: MESSAGE, ...extra });
  const answer = (body, headers = bearer) => call('POST', '/hub/discord/answer', { body, headers });
  const seed = seeder(fake);
  const ask = (slug, extra = {}, files = {}, n) => {
    const made = { ...askJson({ id: askId(slug, n), now: NOW, options: twoOptions(), allowDrawing: false }), ...extra };
    seed.ask(made, { files });
    return made;
  };
  const askKey = made => `sections/inbox/asks/${made.id}/ask.json`;
  const answerKey = made => `sections/inbox/asks/${made.id}/answer.json`;
  const revOf = made => askRev(fake.text(askKey(made)));
  const writes = () => fake.log.filter(entry => entry.method === 'PUT' || entry.method === 'DELETE').length;
  const close = async () => { server.close(); await fake.close(); };
  return { fake, token, logs, port, call, list, answer, answerBody, ask, askKey, answerKey, revOf, writes, bearer, seed, close };
}

test('1. another user\'s click is refused and writes nothing', async () => {
  const f = await fixture();
  try {
    const ask = f.ask('who');
    const { body: { asks } } = await f.list();
    const refused = await f.answer(f.answerBody(ask, asks[0].rev, { user: OTHER }));
    assert.equal(refused.status, 403);
    assert.equal(f.fake.text(f.answerKey(ask)), null);
    assert.ok(!f.logs.some(line => line.includes(OTHER)), 'The clicker\'s id is not logged.');
  } finally { await f.close(); }
});

test('2. a choice outside the options is refused', async () => {
  const f = await fixture();
  try {
    const ask = f.ask('choice');
    const refused = await f.answer(f.answerBody(ask, f.revOf(ask), { choice: 'Z' }));
    assert.equal(refused.status, 400);
    assert.equal(f.fake.text(f.answerKey(ask)), null);
  } finally { await f.close(); }
});

test('3. a click on an answered Ask is refused with the first answer, and the file stays as it was', async () => {
  const f = await fixture();
  try {
    const ask = f.ask('twice');
    const rev = f.revOf(ask);
    const first = await f.answer(f.answerBody(ask, rev, { choice: 'B' }));
    assert.equal(first.status, 201);
    const before = f.fake.text(f.answerKey(ask));
    const second = await f.answer(f.answerBody(ask, rev, { choice: 'A', interaction: '200000000000000002' }));
    assert.equal(second.status, 409);
    assert.equal(second.body.answer.choice, 'B');
    assert.equal(second.body.answer.via, 'discord');
    const replay = await f.answer(f.answerBody(ask, rev, { choice: 'B' }));
    assert.equal(replay.status, 409, 'The same interaction id again is no new answer.');
    assert.equal(f.fake.text(f.answerKey(ask)), before, 'answer.json is byte-identical.');
    const web = f.ask('webfirst', {}, { 'answer.json': { at: 'x', by: 'owner', choice: 'A' } }, 'c3c3');
    const late = await f.answer(f.answerBody(web, f.revOf(web)));
    assert.equal(late.status, 409, 'An answer from the web app came first.');
    assert.equal(late.body.answer.by, 'owner');
  } finally { await f.close(); }
});

test('4. a passkey-only Ask has no buttons: not listed, and a click on it is refused', async () => {
  const f = await fixture();
  try {
    const plain = f.ask('plain');
    const locked = f.ask('locked', { requirePasskey: true }, {}, 'b2b2');
    const drawn = f.ask('drawn', { allowDrawing: true }, {}, 'b3b3');
    const pictured = f.ask('pictured', { options: [{ id: 'A', label: 'Yes', image: 'a.png' }, { id: 'B', label: 'No' }] }, {}, 'b4b4');
    const { status, body } = await f.list();
    assert.equal(status, 200);
    assert.deepEqual(body.asks.map(item => item.id), [plain.id], 'Only the simple Ask is listed.');
    for (const made of [locked, drawn, pictured]) {
      const refused = await f.answer(f.answerBody(made, f.revOf(made)));
      assert.equal(refused.status, 403, made.id);
      assert.equal(f.fake.text(f.answerKey(made)), null);
    }
  } finally { await f.close(); }
});

test('5. the narrow token writes nothing else, and the routes match exactly', async () => {
  const f = await fixture();
  try {
    const ask = f.ask('narrow');
    const review = f.seed.event(eventJson({ kind: 'ready-for-review', ts: NOW, title: 'A review' }));
    const before = f.writes();
    const targets = [
      ['POST', `/hub/asks/${ask.id}/answer`, { choice: 'A' }], ['POST', `/hub/asks/${ask.id}/snooze`, { hours: 1 }], ['POST', `/hub/asks/${ask.id}/cancel`, {}],
      ['POST', `/hub/reviews/${review}/done`, {}], ['POST', '/hub/requests', { project: 'probe', text: 'x', when: 'record' }], ['POST', '/hub/drawings', {}],
      ['POST', '/workspace/pin', { workspace: 'inbox', id: 'x', pinned: true }], ['POST', '/workspace/status', { workspace: 'inbox', id: 'x', status: 'archived' }],
      ['POST', '/workspace/tags', { workspace: 'inbox', id: 'x', tags: [] }], ['POST', '/workspace/icon', { workspace: 'inbox', id: 'x', emoji: '' }],
      ['POST', '/workspace/pins', { list: [{ id: 'x' }] }], ['POST', '/sections', { name: 'Sneaky' }],
      ['POST', '/cards/markdown', {}], ['POST', '/cards/drawing', {}],
    ];
    for (const [method, route, body] of targets) {
      const refused = await f.call(method, route, { body, headers: f.bearer });
      assert.equal(refused.status, 401, `${method} ${route}`);
    }
    assert.equal(f.writes(), before, 'The bucket was not written.');

    // Exact match: a trailing slash is no route, and a path with .. is the generic route, which wants Remote-User.
    const body = f.answerBody(ask, f.revOf(ask));
    assert.equal((await f.call('POST', '/hub/discord/answer/', { body, headers: f.bearer })).status, 404);
    assert.equal((await f.call('GET', '/hub/discord/asks/', { headers: f.bearer })).status, 404);
    assert.equal((await f.call('POST', '/hub/discord/other', { body, headers: f.bearer })).status, 404);
    assert.equal((await f.call('PUT', '/hub/discord/answer', { body, headers: f.bearer })).status, 404);
    assert.equal((await f.call('POST', `/hub/discord/../asks/${ask.id}/answer`, { body: { choice: 'A' }, headers: f.bearer })).status, 401);
    assert.equal((await f.call('POST', '/HUB/discord/answer', { body, headers: f.bearer })).status, 401);
    const raw = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: f.port, method: 'POST', path: `/api/hub/discord/../asks/${ask.id}/answer`, headers: { ...f.bearer, 'Content-Type': 'application/json' } }, res => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject);
      req.end(JSON.stringify({ choice: 'A' }));
    });
    assert.equal(raw, 401, 'Sent un-normalized, it is still the generic route.');
    assert.equal(f.writes(), before);
    assert.equal(f.fake.text(f.answerKey(ask)), null);

    // The answer body is exactly six keys.
    for (const extra of [{ note: 'hello' }, { drawing: { scene: '{}', png: '' } }, { extra: 1 }]) {
      assert.equal((await f.answer({ ...body, ...extra })).status, 400, Object.keys(extra)[0]);
    }
    const { rev, ...missing } = body;
    assert.equal((await f.answer(missing)).status, 400);
    assert.equal((await f.answer({ ...body, interaction: 'not-an-id' })).status, 400);
    assert.equal((await f.answer({ ...body, message: '12' })).status, 400);
    assert.equal((await f.call('POST', '/hub/discord/answer', { body: '{nope', headers: f.bearer })).status, 400);
    assert.equal((await f.call('POST', '/hub/discord/answer', { body: JSON.stringify({ ...body, pad: 'x'.repeat(5000) }), headers: f.bearer })).status, 413);
    assert.equal(f.writes(), before);
  } finally { await f.close(); }
});

test('6. an Ask that changed since it was listed is refused', async () => {
  const f = await fixture();
  try {
    const ask = f.ask('moved');
    const { body: { asks } } = await f.list();
    assert.equal(asks[0].rev, f.revOf(ask));
    f.fake.seed(f.askKey(ask), JSON.stringify({ ...ask, options: [{ id: 'A', label: 'Yes, delete it' }, ...twoOptions().slice(1)] }), 'application/json');
    const refused = await f.answer(f.answerBody(ask, asks[0].rev));
    assert.equal(refused.status, 409);
    assert.equal(refused.body.error, 'This Ask changed since it was posted.');
    assert.equal(f.fake.text(f.answerKey(ask)), null);

    const locked = f.ask('lockedlater', {}, {}, 'd4d4');
    const listed = (await f.list()).body.asks.find(item => item.id === locked.id);
    f.fake.seed(f.askKey(locked), JSON.stringify({ ...locked, requirePasskey: true }), 'application/json');
    const after = await f.answer(f.answerBody(locked, listed.rev));
    assert.equal(after.status, 409);
    assert.equal(after.body.error, 'This Ask changed since it was posted.');
    assert.equal(f.fake.text(f.answerKey(locked)), null);
  } finally { await f.close(); }
});

test('7. a good click is recorded as the owner, via Discord, with the rev and the ids, and no note or user id', async () => {
  const f = await fixture();
  try {
    const ask = f.ask('good');
    const { body: { asks } } = await f.list();
    assert.deepEqual(Object.keys(asks[0]).sort(), ['createdAt', 'expiresAt', 'id', 'options', 'project', 'question', 'requirePasskey', 'rev']);
    const made = await f.answer(f.answerBody(ask, asks[0].rev, { choice: 'B' }));
    assert.equal(made.status, 201);
    const stored = f.fake.json(f.answerKey(ask));
    assert.deepEqual(Object.keys(stored).sort(), ['at', 'by', 'choice', 'discord', 'rev', 'via']);
    assert.equal(stored.by, 'owner');
    assert.equal(stored.via, 'discord');
    assert.equal(stored.choice, 'B');
    assert.equal(stored.rev, asks[0].rev);
    assert.deepEqual(stored.discord, { interaction: INTERACTION, message: MESSAGE });
    assert.ok(!f.fake.text(f.answerKey(ask)).includes(OWNER), 'The owner\'s id is not stored.');
    assert.deepEqual(f.logs, [`[hub] discord answer ${ask.id} B interaction=${INTERACTION}`]);
    assert.ok(!f.logs.join().includes(f.token) && !f.logs.join().includes(OWNER));
    assert.equal((await f.list()).body.asks.length, 0, 'An answered Ask is no longer listed.');
  } finally { await f.close(); }
});

test('8. without a bearer, or with a wrong one, 401; without the env keys, 404', async () => {
  const f = await fixture();
  try {
    const ask = f.ask('auth');
    const body = f.answerBody(ask, f.revOf(ask));
    assert.equal((await f.call('GET', '/hub/discord/asks')).status, 401);
    assert.equal((await f.call('GET', '/hub/discord/asks', { headers: { Authorization: 'Bearer wrong' } })).status, 401);
    assert.equal((await f.call('GET', '/hub/discord/asks', { headers: { Authorization: f.bearer.Authorization.replace('Bearer', 'Basic') } })).status, 401);
    assert.equal((await f.call('POST', '/hub/discord/answer', { body })).status, 401);
    assert.equal((await f.call('POST', '/hub/discord/answer', { body, headers: { Authorization: 'Bearer wrong' } })).status, 401);
    assert.equal((await f.call('POST', '/hub/discord/answer', { body, headers: { 'Remote-User': 'owner' } })).status, 401, 'A passkey session has no way in.');
    assert.equal((await f.call('GET', '/hub/discord/asks', { headers: { 'Remote-User': 'owner' } })).status, 401);
    assert.equal(f.fake.text(f.answerKey(ask)), null);
  } finally { await f.close(); }

  const off = await fixture({ discord: false });
  try {
    const ask = off.ask('off');
    const body = off.answerBody(ask, off.revOf(ask));
    assert.equal((await off.list()).status, 404);
    assert.equal((await off.answer(body)).status, 404);
    assert.equal((await off.call('GET', '/hub/discord/asks')).status, 404, 'Whoever holds a token, nothing answers.');
    assert.equal(off.fake.text(off.answerKey(ask)), null);
  } finally { await off.close(); }

  // One key is not enough.
  const root = await mkdtemp(path.join(tmpdir(), 'buw-discord-'));
  const fake = await startFakeS3();
  const bucket = createBucket({ bucket: fake.bucket, endpoint: fake.endpoint, credentials: fake.credentials, region: 'us-east-1' });
  const hub = createHub({ bucket, enabled: true, env: { HUB_DISCORD_TOKEN_SHA256: sha('t') } });
  const server = createSiteApi({ bucket, templateDir: path.join(root, 'none'), stateFile: path.join(root, 's.json'), requireRemoteUser: true, hub });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const answer = await fetch(`http://127.0.0.1:${server.address().port}/api/hub/discord/asks`, { headers: { Authorization: 'Bearer t' } });
    assert.equal(answer.status, 404, 'Without the owner id the routes are off.');
  } finally { server.close(); await fake.close(); }
});

test('9. an Ask that is expired, cancelled or picked up is refused; a snoozed one can be answered but is not listed', async () => {
  const f = await fixture();
  try {
    const expired = f.ask('expired', { expiresAt: new Date(NOW.getTime() - 3600_000).toISOString() }, {}, 'e1e1');
    const cancelled = f.ask('cancelled', {}, { 'cancel.json': { at: 'x', by: 'owner' } }, 'e2e2');
    const pickedUp = f.ask('pickedup', {}, { 'pickup.json': { at: 'x', host: 'h' } }, 'e3e3');
    const snoozed = f.ask('snoozed', {}, { 'snooze.json': { at: 'x', by: 'owner', until: new Date(NOW.getTime() + 3600_000).toISOString() } }, 'e4e4');
    assert.deepEqual((await f.list()).body.asks, [], 'None of them is listed.');
    for (const made of [expired, cancelled, pickedUp]) {
      const refused = await f.answer(f.answerBody(made, f.revOf(made)));
      assert.equal(refused.status, 409, made.id);
      assert.equal(f.fake.text(f.answerKey(made)), null);
    }
    const allowed = await f.answer(f.answerBody(snoozed, f.revOf(snoozed)));
    assert.equal(allowed.status, 201);
    assert.equal(f.fake.json(f.answerKey(snoozed)).via, 'discord');
  } finally { await f.close(); }
});
