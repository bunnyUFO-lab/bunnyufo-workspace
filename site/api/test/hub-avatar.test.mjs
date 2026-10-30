// The sprite flow: what answering an avatar Ask does (hub-avatar.mjs), over the stand-in S3 and a real signing key.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { createSiteApi } from '../server.mjs';
import { createBucket } from '../s3.mjs';
import { createHub } from '../hub.mjs';
import { checkAvatarField, sheetRequestId } from '../hub-avatar.mjs';
import { parsePublicKey, publicKeyPem, sign, verify } from '../signing.mjs';
import { validId } from '../hub-model.mjs';
import { startFakeS3 } from './fake-s3.mjs';
import { askJson, seeder, teamSheet } from './hub-fixtures.mjs';

const SITE = 'https://site.example';
const NOW = new Date();
const day = NOW.toISOString().slice(0, 10).replace(/-/g, '');
const keyPair = generateKeyPairSync('ed25519');
const KEY_ENV = { HUB_SIGNING_KEY: keyPair.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64') };
const PUB = parsePublicKey(publicKeyPem(keyPair.privateKey));
const OPTIONS = ['a', 'b', 'c', 'd'].map(id => ({ id, label: `${id.toUpperCase()}: a robot` }));
const USE_SKIP = [{ id: 'use', label: 'Use it' }, { id: 'skip', label: 'Not this one' }];
const SUBJECT = 'subjects/claude-avatar';
const askId = tail => `${day}-sprite-studio-pick-${tail}`;

async function fixture({ env = KEY_ENV } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'buw-avatar-'));
  const fake = await startFakeS3();
  const bucket = createBucket({ bucket: fake.bucket, endpoint: fake.endpoint, credentials: fake.credentials, region: 'us-east-1' });
  fake.seed('sections/inbox/workspace.json', '{"name":"Inbox","hidden":true,"entities":[]}\n', 'application/json');
  fake.seed('state.json', '{"version":1,"cards":{}}', 'application/json');
  const hub = createHub({ bucket, enabled: true, now: () => NOW, env });
  const server = createSiteApi({ bucket, templateDir: path.join(root, 'none'), stateFile: path.join(root, 'card-state.json'), sectionsTtl: 0, requireRemoteUser: false, hub, allowedOrigins: [SITE] });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, route, data, headers = {}) => {
    const answered = await fetch(`${origin}/api${route}`, {
      method, headers: { ...(method === 'GET' ? {} : { Origin: SITE, 'Content-Type': 'application/json' }), ...headers },
      body: method === 'GET' ? undefined : JSON.stringify(data ?? {}),
    });
    const text = await answered.text();
    let body = null;
    try { body = JSON.parse(text); } catch { /* not JSON */ }
    return { status: answered.status, body };
  };
  const post = (route, data) => call('POST', route, data, { 'Remote-User': 'owner' });
  const seed = seeder(fake);
  const sheetRequests = () => [...fake.objects.keys()].filter(key => /requests\/[^/]+\/request\.json$/.test(key)).map(key => fake.json(key)).filter(request => request.preset === 'agent-avatar-sheet');
  /** An agent-avatar request for `agent`, approved unless told not to; returns its id. */
  const avatarRequest = async (agent = 'claude', { approve = true } = {}) => {
    const made = await post('/hub/requests', { project: 'sprite-studio', preset: 'agent-avatar', text: `Pixel sprite for ${agent}`, agent });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    if (approve) assert.equal((await post(`/hub/requests/${made.body.id}/approve`, {})).status, 201);
    return made.body.id;
  };
  const pickAsk = (tail, avatar, extra = {}) => {
    const ask = { ...askJson({ id: askId(tail), project: 'sprite-studio', now: NOW, options: OPTIONS, question: 'Which avatar for claude?' }), requirePasskey: true, avatar, ...extra };
    seed.ask(ask);
    return ask.id;
  };
  const sheetAsk = (tail, avatar) => {
    const ask = { ...askJson({ id: askId(tail), project: 'sprite-studio', now: NOW, options: USE_SKIP, question: 'Use this sheet for claude?' }), requirePasskey: true, avatar };
    seed.ask(ask);
    return ask.id;
  };
  const answer = (id, choice) => post(`/hub/asks/${id}/answer`, { choice });
  return { askId, fake, hub, post, call, seed, sheetRequests, avatarRequest, pickAsk, sheetAsk, answer, close: async () => { server.close(); await fake.close(); } };
}

test('an answered variant pick makes one signed sheet request, and nothing else can make a second', async () => {
  const f = await fixture();
  try {
    const request = await f.avatarRequest('claude');
    const id = f.pickAsk('a1b2', { agent: 'claude', request, subject: SUBJECT });
    const done = await f.answer(id, 'b');
    assert.equal(done.status, 201, JSON.stringify(done.body));
    assert.equal(done.body.state, 'answered');
    assert.equal(done.body.avatar.started, true);
    assert.equal(done.body.avatar.message, 'The sprite sheet starts on the Gaming PC within about an hour.');
    const [sheet] = f.sheetRequests();
    assert.equal(f.sheetRequests().length, 1);
    assert.equal(sheet.id, done.body.avatar.request);
    assert.equal(sheet.id, sheetRequestId(id));
    assert.ok(validId(sheet.id), 'a valid request id');
    assert.deepEqual([sheet.preset, sheet.agent, sheet.fromAsk, sheet.choice, sheet.subject, sheet.target, sheet.project], ['agent-avatar-sheet', 'claude', id, 'b', SUBJECT, 'pc', 'sprite-studio']);
    assert.equal(sheet.origin.kind, 'owner');
    const approved = f.fake.json(`sections/inbox/requests/${sheet.id}/approved.json`);
    assert.equal(verify(approved, PUB), true, 'the approval of M3a, signed with the server key');
    assert.equal(approved.target, 'pc');
    assert.equal(approved.limits.minutes, 120);
    assert.equal(approved.run.preset, 'agent-avatar-sheet');
    assert.equal(approved.run.model, null);
    assert.match(approved.run.brief, new RegExp(`choice \`b\`, Sprite Studio subject \`${SUBJECT}\``));
    assert.match(approved.run.brief, /source: "pc"/);

    // A second answer is a 409 and starts nothing.
    const again = await f.answer(id, 'c');
    assert.equal(again.status, 409);
    assert.equal(f.sheetRequests().length, 1);
    // A second call of the hook itself, as a retry would make, starts nothing either.
    const ask = (await f.call('GET', `/hub/asks/${id}`)).body;
    const retry = await f.hub.avatar.afterAnswer({ ask, answer: { choice: 'b' }, user: 'owner', at: NOW });
    assert.equal(retry.started, false);
    assert.match(retry.why, /already started/);
    assert.equal(f.sheetRequests().length, 1);
  } finally { await f.close(); }
});

test('a pick that cannot be trusted starts nothing, and the answer stands', async () => {
  const f = await fixture();
  try {
    const good = await f.avatarRequest('claude');
    const other = await f.avatarRequest('hermes');
    const plain = await f.post('/hub/requests', { project: 'sprite-studio', preset: 'sprite-set', text: 'Draw a thing' });
    assert.equal((await f.post(`/hub/requests/${plain.body.id}/approve`, {})).status, 201);
    const unapproved = await f.avatarRequest('claude', { approve: false });
    const cases = [
      ['another preset', f.pickAsk('c001', { agent: 'claude', request: plain.body.id, subject: SUBJECT }), /not a agent-avatar request/],
      ['another agent', f.pickAsk('c002', { agent: 'claude', request: other, subject: SUBJECT }), /another agent/],
      ['no approval', f.pickAsk('c003', { agent: 'claude', request: unapproved, subject: SUBJECT }), /never approved/],
      ['a request that does not exist', f.pickAsk('c004', { agent: 'claude', request: `${day}-sprite-studio-gone-zz99`, subject: SUBJECT }), /No such request/],
      ['no subject', f.pickAsk('c005', { agent: 'claude', request: good }), /no Sprite Studio subject/],
      ['no passkey flag', f.pickAsk('c006', { agent: 'claude', request: good, subject: SUBJECT }, { requirePasskey: false }), /does not require a passkey/],
      ['an unknown agent', f.pickAsk('c007', { agent: 'nobody', request: good, subject: SUBJECT }), /no known agent/],
      ['a malformed field', f.pickAsk('c008', { agent: 'claude', request: 'x' }), /no known agent/],
    ];
    for (const [name, id, why] of cases) {
      const done = await f.answer(id, 'a');
      assert.equal(done.status, 201, name);
      assert.equal(done.body.state, 'answered', name);
      assert.equal(done.body.avatar.started, false, name);
      assert.match(done.body.avatar.why, why, name);
    }
    assert.equal(f.sheetRequests().length, 0);
  } finally { await f.close(); }
});

test('an approval of an edited request, or one signed by another key, does not count', async () => {
  const f = await fixture();
  try {
    const request = await f.avatarRequest('claude');
    const key = `sections/inbox/requests/${request}/approved.json`;
    const approved = f.fake.json(key);
    const requestKey = `sections/inbox/requests/${request}/request.json`;
    const stored = f.fake.json(requestKey);
    // The request text changed after it was signed.
    f.fake.seed(requestKey, JSON.stringify({ ...stored, text: 'Something else' }), 'application/json');
    let done = await f.answer(f.pickAsk('d001', { agent: 'claude', request, subject: SUBJECT }), 'a');
    assert.match(done.body.avatar.why, /does not (verify|match)/);
    f.fake.seed(requestKey, JSON.stringify(stored), 'application/json');
    // A signature from another key.
    const forged = generateKeyPairSync('ed25519');
    const { signature: _drop, ...body } = approved;
    f.fake.seed(key, JSON.stringify(sign(body, forged.privateKey)), 'application/json');
    done = await f.answer(f.pickAsk('d002', { agent: 'claude', request, subject: SUBJECT }), 'a');
    assert.match(done.body.avatar.why, /does not verify/);
    assert.equal(f.sheetRequests().length, 0);
  } finally { await f.close(); }
});

test('without a signing key a pick starts nothing', async () => {
  const f = await fixture({ env: {} });
  try {
    const id = f.pickAsk('e001', { agent: 'claude', request: `${day}-sprite-studio-x-a1b2`, subject: SUBJECT });
    const done = await f.answer(id, 'a');
    assert.equal(done.body.avatar.started, false);
    assert.equal(f.sheetRequests().length, 0);
  } finally { await f.close(); }
});

test('use on a listed sheet makes it the sprite; a bad sheet is not chosen; skip does nothing', async () => {
  const f = await fixture();
  try {
    const sheet = teamSheet('claude', {});
    for (const [name, body] of Object.entries(sheet.files)) f.seed.put(`team/claude/${name}`, body, name.endsWith('.png') ? 'image/png' : 'application/json');
    const avatarFiles = () => [...f.fake.objects.keys()].filter(key => /team\/claude\/avatar-/.test(key));

    const used = await f.answer(f.sheetAsk('f001', { agent: 'claude', sheet: sheet.id }), 'use');
    assert.equal(used.status, 201, JSON.stringify(used.body));
    assert.deepEqual(used.body.avatar, { chosen: true, sheet: sheet.id });
    assert.equal(avatarFiles().length, 1);
    const stored = f.fake.json(avatarFiles()[0]);
    assert.deepEqual([stored.kind, stored.sheet, stored.sha256.length], ['custom', sheet.id, 64]);
    const team = (await f.call('GET', '/hub/team')).body.agents.find(agent => agent.id === 'claude');
    assert.equal(team.sprite.kind, 'custom');
    assert.equal(team.sprite.sheet, sheet.id);

    const missing = await f.answer(f.sheetAsk('f002', { agent: 'claude', sheet: 'sheet-20261029T110000Z-zz99' }), 'use');
    assert.equal(missing.status, 201);
    assert.equal(missing.body.avatar.chosen, false);
    assert.match(missing.body.avatar.why, /isn't ready or failed its check/);
    assert.equal(avatarFiles().length, 1, 'A bad sheet is not chosen.');

    const skipped = await f.answer(f.sheetAsk('f003', { agent: 'claude', sheet: sheet.id }), 'skip');
    assert.equal(skipped.status, 201);
    assert.equal(skipped.body.avatar, undefined);
    assert.equal(avatarFiles().length, 1);
    assert.equal(f.sheetRequests().length, 0);
  } finally { await f.close(); }
});

test('an Ask with no avatar field answers as before, and the pure helpers', async () => {
  const f = await fixture();
  try {
    f.seed.ask({ ...askJson({ id: askId('g001'), project: 'sprite-studio', now: NOW, options: OPTIONS }) });
    const done = await f.answer(askId('g001'), 'a');
    assert.equal(done.status, 201);
    assert.equal(done.body.avatar, undefined);
  } finally { await f.close(); }
  assert.deepEqual(checkAvatarField({ agent: 'claude', request: `${day}-p-x-a1b2`, subject: ' a\n b ', extra: 1 }), { agent: 'claude', request: `${day}-p-x-a1b2`, subject: 'a b' });
  assert.deepEqual(checkAvatarField({ agent: 'claude', sheet: 'sheet-20261029T100000Z-ab12' }), { agent: 'claude', sheet: 'sheet-20261029T100000Z-ab12' });
  for (const bad of [null, 'x', [], {}, { agent: 'Bad' }, { agent: 'claude' }, { agent: 'claude', sheet: 'sheet-1' }, { agent: 'claude', request: 'nope' }, { agent: 'claude', request: `${day}-p-x-a1b2`, subject: 'x'.repeat(201) }]) assert.equal(checkAvatarField(bad), null, JSON.stringify(bad));
  const long = `${day}-${'a'.repeat(100)}-b2c3`;
  assert.ok(sheetRequestId(long).length <= 120 && validId(sheetRequestId(long)));
  assert.equal(sheetRequestId(long), sheetRequestId(long));
  assert.notEqual(sheetRequestId(`${day}-a-b2c3`), sheetRequestId(`${day}-a-b2c4`));
});
