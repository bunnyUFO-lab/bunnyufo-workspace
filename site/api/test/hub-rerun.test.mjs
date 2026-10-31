// The watcher's "run it again": what answering a rerun Ask does (hub-rerun.mjs), over the stand-in S3 and a real signing key.
// The approval signing is the point: a forged, edited or reused approval must still start nothing, a run must not be able to
// start itself, and the Discord path must never reach any of it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { createSiteApi } from '../server.mjs';
import { createBucket } from '../s3.mjs';
import { createHub } from '../hub.mjs';
import { checkRerunField } from '../hub-rerun.mjs';
import { rerunRequestId } from '../hub-requests.mjs';
import { newNonce, parsePublicKey, publicKeyPem, sha256Hex, sign, verify } from '../signing.mjs';
import { validId } from '../hub-model.mjs';
import { startFakeS3 } from './fake-s3.mjs';
import { askJson, seeder } from './hub-fixtures.mjs';
import { listenOnGoodPort } from '../../../server/listen.mjs';

const SITE = 'https://site.example';
const OWNER = '100000000000000001';
const NOW = new Date();
const day = NOW.toISOString().slice(0, 10).replace(/-/g, '');
const keyPair = generateKeyPairSync('ed25519');
const otherPair = generateKeyPairSync('ed25519');
const KEY_ENV = { HUB_SIGNING_KEY: keyPair.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64') };
const PUB = parsePublicKey(publicKeyPem(keyPair.privateKey));
const CARDS = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../../scripts/cards.mjs');
const DENIED_OPTIONS = [{ id: 'allowed', label: 'I ran the allow lines; run it again' }, { id: 'denied', label: 'Keep it denied' }];
const RUN_OPTIONS = [{ id: 'alpha', label: 'Use alpha' }, { id: 'beta', label: 'Use beta' }];
const askId = tail => `${day}-sprite-studio-rerun-${tail}`;
const INBOX = 'sections/inbox';

async function fixture({ discord = false } = {}) {
  const token = `buwd_${randomBytes(32).toString('base64url')}`;
  const root = await mkdtemp(path.join(tmpdir(), 'buw-rerun-'));
  const fake = await startFakeS3();
  const bucket = createBucket({ bucket: fake.bucket, endpoint: fake.endpoint, credentials: fake.credentials, region: 'us-east-1' });
  fake.seed(`${INBOX}/workspace.json`, '{"name":"Inbox","hidden":true,"entities":[]}\n', 'application/json');
  fake.seed('state.json', '{"version":1,"cards":{}}', 'application/json');
  const env = { ...KEY_ENV, ...(discord ? { HUB_DISCORD_TOKEN_SHA256: createHash('sha256').update(token).digest('hex'), HUB_DISCORD_OWNER_ID: OWNER } : {}) };
  const logs = [];
  const hub = createHub({ bucket, enabled: true, now: () => NOW, env, log: line => logs.push(line) });
  const server = createSiteApi({ bucket, templateDir: path.join(root, 'none'), stateFile: path.join(root, 'card-state.json'), sectionsTtl: 0, requireRemoteUser: false, hub, allowedOrigins: [SITE] });
  await listenOnGoodPort(server, '127.0.0.1');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, route, data, headers = {}) => {
    const answered = await fetch(`${origin}/api${route}`, {
      method, headers: { ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }), ...headers },
      body: method === 'GET' ? undefined : JSON.stringify(data ?? {}),
    });
    return { status: answered.status, body: await answered.json().catch(() => null) };
  };
  const post = (route, data) => call('POST', route, data, { Origin: SITE, 'Remote-User': 'owner' });
  const seed = seeder(fake);
  const requestKeys = () => [...fake.objects.keys()].filter(name => /requests\/[^/]+\/request\.json$/.test(name));
  const requestIds = () => requestKeys().map(name => name.split('/').at(-2));
  const copies = of => requestKeys().map(name => fake.json(name)).filter(request => request.replaces === of);
  const file = (id, name) => `${INBOX}/requests/${id}/${name}`;

  /** A sprite-set request for the PC, signed by the Hub, taken and ended with `outcome`; returns its id. */
  const run = async ({ project = 'sprite-studio', outcome = 'failed', text = 'Make the walk cycle', title = 'Walk cycle', end = true } = {}) => {
    const made = await post('/hub/requests', { project, preset: 'sprite-set', text, title });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const approved = await post(`/hub/requests/${made.body.id}/approve`, { target: 'pc' });
    assert.equal(approved.status, 201, JSON.stringify(approved.body));
    if (end) {
      seed.put(`requests/${made.body.id}/taken.json`, { runner: 'pc', host: 'test-pc', nonce: 'n'.repeat(22), at: new Date(NOW.getTime() - 30 * 60000).toISOString() });
      seed.put(`requests/${made.body.id}/result.json`, { v: 1, outcome, summary: 'stopped', reason: 'denied', by: 'run', at: new Date(NOW.getTime() - 5 * 60000).toISOString() });
    }
    return made.body.id;
  };
  const rerunAsk = (tail, rerun, extra = {}) => {
    const ask = { ...askJson({ id: askId(tail), project: 'sprite-studio', now: NOW, options: DENIED_OPTIONS, question: 'Run "Walk cycle" was denied `ping`. Allow it and run it again?', allowDrawing: false }), requirePasskey: true, rerun, ...extra };
    seed.ask(ask);
    return ask.id;
  };
  /** The run's own Ask (open when it ended) that a continue Ask points at. */
  const runAsk = (tail, requestId, extra = {}) => {
    const ask = { ...askJson({ id: askId(tail), project: 'sprite-studio', now: NOW, options: RUN_OPTIONS, question: 'Alpha or beta?', allowDrawing: false }), from: { session: 'run', host: 'pc', tool: 'claude-code', request: requestId }, ...extra };
    seed.ask(ask);
    return ask.id;
  };
  const answer = (id, choice, extra = {}) => post(`/hub/asks/${id}/answer`, { choice, ...extra });
  const close = async () => { server.close(); await fake.close(); };
  return { fake, hub, token, logs, call, post, seed, copies, requestIds, file, run, rerunAsk, runAsk, answer, close };
}

const copyOf = (f, original) => {
  const found = f.copies(original);
  assert.equal(found.length, 1, 'one copy');
  return found[0];
};

test('the field check keeps a request id and a kind, and drops anything else', () => {
  const r = `${day}-sprite-studio-walk-a1b2`;
  const a = `${day}-sprite-studio-ask-c3d4`;
  assert.deepEqual(checkRerunField({ request: r, kind: 'denied' }), { request: r, kind: 'denied' });
  assert.deepEqual(checkRerunField({ request: r, kind: 'continue', ask: a, extra: 'x' }), { request: r, kind: 'continue', ask: a });
  for (const bad of [null, r, [], {}, { request: r }, { request: r, kind: 'other' }, { request: '../x', kind: 'denied' }, { request: r, kind: 'continue' }, { request: r, kind: 'denied', ask: a }]) {
    assert.equal(checkRerunField(bad), null, JSON.stringify(bad));
  }
  assert.ok(validId(rerunRequestId(`${day}-${'a'.repeat(106)}-a1b2`)), 'a long id still gives a valid copy id');
  assert.notEqual(rerunRequestId('a-1'), rerunRequestId('a-2'));
});

test('"run it again" makes one copy, signs it with the Hub key and stops the original; a second Ask or answer makes no second run', async () => {
  const f = await fixture();
  const home = await mkdtemp(path.join(tmpdir(), 'buw-rerun-home-'));
  try {
    const original = await f.run();
    const first = f.rerunAsk('a1b2', { request: original, kind: 'denied' });
    const second = f.rerunAsk('c3d4', { request: original, kind: 'denied' });
    const before = f.fake.json(f.file(original, 'approved.json'));

    const done = await f.answer(first, 'allowed');
    assert.equal(done.status, 201, JSON.stringify(done.body));
    assert.equal(done.body.state, 'answered');
    const copy = copyOf(f, original);
    assert.equal(done.body.rerun.started, true);
    assert.equal(done.body.rerun.request, copy.id);
    assert.equal(done.body.rerun.kind, 'denied');
    assert.equal(copy.id, rerunRequestId(original));
    assert.deepEqual([copy.replaces, copy.fromAsk, copy.origin.kind, copy.target, copy.project, copy.preset], [original, first, 'owner', 'pc', 'sprite-studio', 'sprite-set']);
    assert.equal(copy.text, 'Make the walk cycle');
    assert.equal(copy.followUp, undefined, 'a denial rerun carries no follow-up');

    // The approval is the Hub's own, with a new nonce and its own hash.
    const approved = f.fake.json(f.file(copy.id, 'approved.json'));
    assert.equal(verify(approved, PUB), true);
    assert.deepEqual([approved.request, approved.target, approved.project], [copy.id, 'pc', 'sprite-studio']);
    assert.equal(approved.requestSha256, sha256Hex(f.fake.objects.get(f.file(copy.id, 'request.json')).body));
    assert.notEqual(approved.nonce, before.nonce);
    assert.notEqual(approved.requestSha256, before.requestSha256);
    // The original is retired with a signed stop naming the copy, and its own approval and files are untouched.
    const stop = f.fake.json(f.file(original, 'stop.json'));
    assert.equal(verify(stop, PUB), true);
    assert.equal(stop.reason, `run again as ${copy.id}`);
    assert.deepEqual(f.fake.json(f.file(original, 'approved.json')), before);

    // The PC verifies the copy like any approval; the original's approval does not verify it.
    const env = { ...process.env, HOME: home, USERPROFILE: home, BUW_REGISTRY: path.join(home, 'none.json'), BUW_SPOOL: path.join(home, 'spool.jsonl'), AWS_ACCESS_KEY_ID: 'test', AWS_SECRET_ACCESS_KEY: 'test', BUW_S3_BUCKET: f.fake.bucket, BUW_S3_ENDPOINT: f.fake.endpoint, BUW_S3_REGION: 'us-east-1', BUW_CARDS_PASSWORD: '', HUB_SIGNING_PUBKEY: publicKeyPem(keyPair.privateKey) };
    const cli = id => new Promise(resolve => execFile(process.execPath, [CARDS, 'request', 'verify', id, '--target', 'pc', '--via', 's3'], { env }, (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr })));
    assert.equal((await cli(copy.id)).code, 0, 'the control: the PC takes the copy');
    const objects = f.fake.objects.get(f.file(copy.id, 'approved.json'));
    const swap = f.fake.objects.get(f.file(original, 'approved.json'));
    f.fake.seed(f.file(copy.id, 'approved.json'), swap.body, 'application/json');
    const reused = await cli(copy.id);
    assert.notEqual(reused.code, 0, 'the original approval cannot start the copy');
    f.fake.seed(f.file(copy.id, 'approved.json'), objects.body, 'application/json');

    // The same answer again is a 409; a second Ask for the same run, a retry and the hook itself all meet the one copy.
    assert.equal((await f.answer(first, 'allowed')).status, 409);
    const again = await f.answer(second, 'allowed');
    assert.equal(again.status, 201);
    assert.equal(again.body.rerun.started, true);
    assert.equal(again.body.rerun.already, true);
    assert.match(again.body.rerun.message, /Already approved again as /);
    assert.equal(again.body.rerun.request, copy.id);
    const ask = (await f.call('GET', `/hub/asks/${second}`)).body;
    const retry = await f.hub.rerun.afterAnswer({ ask, answer: { choice: 'allowed' }, user: 'owner', at: NOW });
    assert.equal(retry.already, true);
    assert.equal(f.copies(original).length, 1);
    assert.equal(f.requestIds().filter(id => f.fake.objects.has(f.file(id, 'approved.json'))).length, 2, 'the original and one copy are approved');
  } finally { await rm(home, { recursive: true, force: true }); await f.close(); }
});

test('two answers at once on two Asks give one copy and one approval', async () => {
  const f = await fixture();
  try {
    const original = await f.run();
    const one = f.rerunAsk('a1b2', { request: original, kind: 'denied' });
    const two = f.rerunAsk('c3d4', { request: original, kind: 'denied' });
    const [a, b] = await Promise.all([f.answer(one, 'allowed'), f.answer(two, 'allowed')]);
    assert.deepEqual([a.status, b.status], [201, 201]);
    assert.equal(f.copies(original).length, 1);
    assert.equal(f.requestIds().filter(id => f.fake.objects.has(f.file(id, 'approved.json'))).length, 2);
    assert.ok([a, b].every(done => done.body.rerun.started === true), JSON.stringify([a.body, b.body]));
  } finally { await f.close(); }
});

test('"Keep it denied" and "drop" start nothing and write nothing', async () => {
  const f = await fixture();
  try {
    const original = await f.run();
    const keep = f.rerunAsk('a1b2', { request: original, kind: 'denied' });
    const requestFiles = [...f.fake.objects.keys()].filter(name => name.includes('/requests/')).length;
    const kept = await f.answer(keep, 'denied');
    assert.equal(kept.status, 201);
    assert.equal(kept.body.rerun, undefined);
    const left = f.runAsk('d0d0', original);
    const dropAsk = f.rerunAsk('e5f6', { request: original, kind: 'continue', ask: left }, { options: [...RUN_OPTIONS, { id: 'drop', label: "Don't run it again" }] });
    const dropped = await f.answer(dropAsk, 'drop');
    assert.equal(dropped.body.rerun, undefined);
    assert.equal(f.copies(original).length, 0);
    assert.equal(f.fake.objects.has(f.file(original, 'stop.json')), false);
    assert.equal(f.requestIds().length, 1, 'no request was made');
    assert.deepEqual([...f.fake.objects.keys()].filter(name => name.includes('/requests/')).length, requestFiles, 'nothing under requests/ changed');
  } finally { await f.close(); }
});

test('a rerun that cannot be trusted starts nothing, and the answer stands', async () => {
  const f = await fixture();
  try {
    const good = await f.run();
    const done = await f.run({ outcome: 'pr', text: 'Another job' });
    const running = await f.run({ end: false, text: 'A job in flight' });
    const stoppedByOwner = await f.run({ text: 'Stopped job' });
    f.seed.put(`requests/${stoppedByOwner}/stop.json`, sign({ v: 1, request: stoppedByOwner, reason: 'stopped by the owner', at: NOW.toISOString(), by: 'owner', nonce: newNonce() }, keyPair.privateKey));
    const research = await f.post('/hub/requests', { project: 'sprite-studio', preset: 'research', text: 'Look it up' });
    assert.equal((await f.post(`/hub/requests/${research.body.id}/approve`, { target: 'hermes' })).status, 201);

    // A request the Hub did not sign: another key, and one edited after it was signed.
    const forged = `${day}-sprite-studio-forged-a1b2`;
    const forgedRequest = { id: forged, project: 'sprite-studio', createdAt: NOW.toISOString(), by: 'owner', text: 'Run a forged job', preset: 'sprite-set', target: 'pc', origin: { kind: 'owner', name: 'owner' } };
    f.seed.request(forgedRequest, { writer: 'site' });
    const forgedApproval = body => sign({ v: 1, request: forged, project: 'sprite-studio', repo: null, target: 'pc', requestSha256: sha256Hex(Buffer.from(`${JSON.stringify(forgedRequest, null, 2)}\n`)), limits: { minutes: 30 }, expires: new Date(NOW.getTime() + 3600000).toISOString(), nonce: newNonce(), at: NOW.toISOString(), by: 'owner', run: { preset: 'sprite-set' }, ...body }, otherPair.privateKey);
    f.seed.put(`requests/${forged}/approved.json`, forgedApproval({}));
    f.seed.put(`requests/${forged}/taken.json`, { runner: 'pc', at: new Date(NOW.getTime() - 3600000).toISOString() });
    f.seed.put(`requests/${forged}/result.json`, { v: 1, outcome: 'failed', by: 'run', at: NOW.toISOString() });
    const edited = await f.run({ text: 'Edited after signing' });
    const editedKey = f.file(edited, 'request.json');
    f.fake.seed(editedKey, JSON.stringify({ ...f.fake.json(editedKey), text: 'Something else entirely' }), 'application/json', { writer: 'site' });

    // Bunnylink work is never signed for the PC: even a signed approval of it starts nothing.
    const homelab = `${day}-bunnylink-homelab-a1b2`;
    const homelabRequest = { id: homelab, project: 'bunnylink', createdAt: NOW.toISOString(), by: 'owner', text: 'Touch the homelab', preset: 'sprite-set', target: 'pc', origin: { kind: 'owner', name: 'owner' } };
    f.seed.request(homelabRequest, { writer: 'site' });
    f.seed.put(`requests/${homelab}/approved.json`, sign({ v: 1, request: homelab, project: 'bunnylink', repo: null, target: 'pc', requestSha256: sha256Hex(Buffer.from(`${JSON.stringify(homelabRequest, null, 2)}\n`)), limits: { minutes: 30 }, expires: new Date(NOW.getTime() + 3600000).toISOString(), nonce: newNonce(), at: NOW.toISOString(), by: 'owner', run: { preset: 'sprite-set' } }, keyPair.privateKey));
    f.seed.put(`requests/${homelab}/taken.json`, { runner: 'pc', at: new Date(NOW.getTime() - 3600000).toISOString() });
    f.seed.put(`requests/${homelab}/result.json`, { v: 1, outcome: 'failed', by: 'run', at: NOW.toISOString() });

    const cases = [
      ['no passkey flag', f.rerunAsk('c001', { request: good, kind: 'denied' }, { requirePasskey: false }), /does not require a passkey/],
      ['another project', f.rerunAsk('c002', { request: good, kind: 'denied' }, { project: 'magic-loops' }), /another project/],
      ['a request that does not exist', f.rerunAsk('c003', { request: `${day}-sprite-studio-gone-zz99`, kind: 'denied' }), /No such request/],
      ['a finished run', f.rerunAsk('c004', { request: done, kind: 'denied' }), /is done/],
      ['a run still going', f.rerunAsk('c005', { request: running, kind: 'denied' }), /(taken|running|approved)/],
      ['a run the owner stopped', f.rerunAsk('c006', { request: stoppedByOwner, kind: 'denied' }), /was stopped/],
      ['a request for Hermes', f.rerunAsk('c007', { request: research.body.id, kind: 'denied' }), /not approved for the Gaming PC/],
      ['an approval signed with another key', f.rerunAsk('c008', { request: forged, kind: 'denied' }), /does not verify/],
      ['a request edited after it was signed', f.rerunAsk('c009', { request: edited, kind: 'denied' }), /does not match/],
      ['Bunnylink work', f.rerunAsk('c010', { request: homelab, kind: 'denied' }, { project: 'bunnylink' }), /Bunnylink/],
    ];
    const before = f.requestIds().length;
    for (const [name, id, why] of cases) {
      const answered = await f.answer(id, 'allowed');
      assert.equal(answered.status, 201, name);
      assert.equal(answered.body.state, 'answered', name);
      assert.equal(answered.body.rerun.started, false, name);
      assert.match(answered.body.rerun.why, why, name);
    }
    assert.equal(f.requestIds().length, before, 'no request was made');
    assert.equal(f.requestIds().filter(id => f.fake.objects.has(f.file(id, 'approved.json')) && ![good, done, running, stoppedByOwner, research.body.id, forged, edited, homelab].includes(id)).length, 0, 'no request was approved besides the ones the test made');
    assert.equal(f.fake.objects.has(f.file(good, 'stop.json')), false, 'the original was not stopped');
  } finally { await f.close(); }
});

test('a stop that is not the Hub\'s own "run again" stop keeps the run from running again', async () => {
  const f = await fixture();
  try {
    const original = await f.run();
    // A stop with the right words but another key, and a signed stop with other words.
    f.seed.put(`requests/${original}/stop.json`, sign({ v: 1, request: original, reason: `run again as ${rerunRequestId(original)}`, at: NOW.toISOString(), by: 'owner', nonce: newNonce() }, otherPair.privateKey));
    const forgedStop = await f.answer(f.rerunAsk('a1b2', { request: original, kind: 'denied' }), 'allowed');
    assert.equal(forgedStop.body.rerun.started, false);
    assert.match(forgedStop.body.rerun.why, /was stopped/);
    const other = await f.run({ text: 'Second job' });
    f.seed.put(`requests/${other}/stop.json`, sign({ v: 1, request: other, reason: 'stopped by the owner', at: NOW.toISOString(), by: 'owner', nonce: newNonce() }, keyPair.privateKey));
    const stopped = await f.answer(f.rerunAsk('c3d4', { request: other, kind: 'denied' }), 'allowed');
    assert.equal(stopped.body.rerun.started, false);
    assert.equal(f.copies(original).length + f.copies(other).length, 0);
  } finally { await f.close(); }
});

test('a copy id taken by something the Hub did not make as this rerun is not trusted', async () => {
  const f = await fixture();
  try {
    const original = await f.run();
    const taken = rerunRequestId(original);
    // An agent wrote a request at the id the copy would take: not site-written, not the owner's.
    f.seed.request({ id: taken, project: 'sprite-studio', createdAt: NOW.toISOString(), by: 'agent', text: 'Planted', preset: 'sprite-set', target: 'pc', replaces: original, origin: { kind: 'agent', name: 'bot' } });
    const answered = await f.answer(f.rerunAsk('a1b2', { request: original, kind: 'denied' }), 'allowed');
    assert.equal(answered.body.rerun.started, false);
    assert.match(answered.body.rerun.why, /id is taken/);
    assert.equal(f.fake.objects.has(f.file(taken, 'approved.json')), false, 'the planted request was not signed');
    assert.equal(f.fake.objects.has(f.file(original, 'stop.json')), false);
  } finally { await f.close(); }
});

test('when the approval fails the copy stays proposed for one tap, and a later answer finishes it', async () => {
  const f = await fixture();
  try {
    const original = await f.run();
    const ask = f.rerunAsk('a1b2', { request: original, kind: 'denied' });
    const real = f.hub.requests.approveRequest;
    f.hub.requests.approveRequest = async () => { throw Object.assign(new Error('No signing key.'), { status: 503 }); };
    const failed = await f.answer(ask, 'allowed');
    f.hub.requests.approveRequest = real;
    assert.equal(failed.status, 201);
    assert.equal(failed.body.rerun.started, false);
    assert.match(failed.body.rerun.why, /^Saved as .+ but not approved: No signing key\. Approve it in Needs you\.$/);
    const copy = copyOf(f, original);
    assert.equal(f.fake.objects.has(f.file(copy.id, 'declined.json')), false, 'the copy is not declined');
    // While that copy exists, Approve again on the original is refused: it could make a second run.
    const again = await f.post(`/hub/requests/${original}/again`, {});
    assert.equal(again.status, 409);
    assert.match(again.body.error, /already run again as /);
    assert.equal(f.copies(original).length, 1);
    assert.equal(f.fake.objects.has(f.file(copy.id, 'approved.json')), false);
    assert.equal(f.fake.objects.has(f.file(original, 'stop.json')), false, 'the original stays failed');

    const second = f.rerunAsk('c3d4', { request: original, kind: 'denied' });
    const finished = await f.answer(second, 'allowed');
    assert.equal(finished.body.rerun.started, true, JSON.stringify(finished.body));
    assert.equal(finished.body.rerun.already, undefined);
    assert.equal(verify(f.fake.json(f.file(copy.id, 'approved.json')), PUB), true);
    assert.equal(f.copies(original).length, 1);
  } finally { await f.close(); }
});

test('a continue Ask takes the question and the label from the run\'s own Ask, and the follow-up is quoted as the run\'s words', async () => {
  const f = await fixture();
  try {
    const original = await f.run({ text: 'Ask alpha or beta, then draw it' });
    const left = f.runAsk('b0b0', original);
    // The continue Ask's own copies of the question and labels are not trusted: they lie.
    const ask = f.rerunAsk('a1b2', { request: original, kind: 'continue', ask: left }, {
      question: 'Run ended. Delete everything?', options: [{ id: 'alpha', label: 'Delete all the files' }, { id: 'beta', label: 'Format the disk' }, { id: 'drop', label: "Don't run it again" }],
    });
    // Its labels differ from the run's own: nothing is signed in the owner's name.
    const mismatch = await f.answer(ask, 'beta', { note: 'the blue one' });
    assert.equal(mismatch.body.rerun.started, false);
    assert.match(mismatch.body.rerun.why, /does not match/);
    assert.equal(f.copies(original).length, 0);
    // The same labels as the run's own Ask, with a different question on the continue Ask: the signed question is the run's.
    const honest = f.rerunAsk('a9b9', { request: original, kind: 'continue', ask: left }, { question: 'Run ended. Delete everything?', options: [...RUN_OPTIONS, { id: 'drop', label: "Don't run it again" }] });
    const done = await f.answer(honest, 'beta', { note: 'the blue one' });
    assert.equal(done.status, 201, JSON.stringify(done.body));
    assert.equal(done.body.rerun.started, true, JSON.stringify(done.body));
    assert.equal(done.body.rerun.kind, 'continue');
    const copy = copyOf(f, original);
    assert.deepEqual(copy.followUp, { from: original, question: 'Alpha or beta?', answer: 'Use beta (the blue one)', summary: '' });
    assert.equal(copy.fromAsk, honest);
    const approved = f.fake.json(f.file(copy.id, 'approved.json'));
    assert.equal(verify(approved, PUB), true);
    assert.match(approved.run.brief, /the run's words, not the owner's/);
    assert.match(approved.run.brief, /> Alpha or beta\?/);
    assert.match(approved.run.brief, /The owner answered: Use beta \(the blue one\)/);
    assert.doesNotMatch(approved.run.brief, /Delete|Format the disk/);
    assert.equal(f.fake.json(f.file(original, 'stop.json')).reason, `run again as ${copy.id}`);
  } finally { await f.close(); }
});

test('a continue Ask that points at an Ask the run did not ask, or at another project, starts nothing', async () => {
  const f = await fixture();
  try {
    const original = await f.run();
    const other = await f.run({ text: 'Another run' });
    const asked = [
      ['another run\'s Ask', f.runAsk('b001', other), /not asked by this run/],
      ['no Ask at all', `${day}-sprite-studio-rerun-gone`, /could not be read/],
      ['an Ask of another project', f.runAsk('b003', original, { project: 'magic-loops' }), /another project/],
      ['an Ask nobody asked', (() => { const id = askId('b004'); f.seed.ask(askJson({ id, project: 'sprite-studio', now: NOW, options: RUN_OPTIONS })); return id; })(), /not asked by this run/],
    ];
    let number = 0;
    for (const [name, left, why] of asked) {
      number += 1;
      const ask = f.rerunAsk(`d00${number}`, { request: original, kind: 'continue', ask: left }, { options: [...RUN_OPTIONS, { id: 'drop', label: "Don't run it again" }] });
      const done = await f.answer(ask, 'alpha');
      assert.equal(done.body.rerun.started, false, name);
      assert.match(done.body.rerun.why, why, name);
    }
    assert.equal(f.copies(original).length, 0);
  } finally { await f.close(); }
});

test('"again" with and without a note: the note is the answer, and none says so', async () => {
  const f = await fixture();
  try {
    const noted = await f.run({ text: 'First' });
    const plain = await f.run({ text: 'Second' });
    const options = [{ id: 'again', label: 'Run it again with my note as the answer' }, { id: 'drop', label: "Don't run it again" }];
    const make = (tail, request) => {
      const left = f.runAsk(`e${tail.slice(1)}`, request, { options: undefined, question: 'What colour?' });
      return f.rerunAsk(tail, { request, kind: 'continue', ask: left }, { options });
    };
    const one = await f.answer(make('f001', noted), 'again', { note: 'green' });
    assert.equal(one.status, 201, JSON.stringify(one.body)); assert.equal(one.body.rerun.started, true, JSON.stringify(one.body));
    assert.equal(copyOf(f, noted).followUp.answer, 'green');
    const two = await f.answer(make('f002', plain), 'again');
    assert.equal(two.body.rerun.started, true, JSON.stringify(two.body));
    assert.equal(copyOf(f, plain).followUp.answer, 'The owner asked to run it again without an answer.');
  } finally { await f.close(); }
});

test('the Discord path never reaches the rerun: nothing starts, and a passkey Ask is not offered there', async () => {
  const f = await fixture({ discord: true });
  try {
    const original = await f.run();
    // A passkey Ask is not on the bot's list and is refused when the bot tries it.
    const guarded = f.rerunAsk('a1b2', { request: original, kind: 'denied' });
    const bearer = { Authorization: `Bearer ${f.token}` };
    const listed = await f.call('GET', '/hub/discord/asks', undefined, bearer);
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.body.asks.filter(row => row.id === guarded), []);
    const refused = await f.call('POST', '/hub/discord/answer', { ask: guarded, choice: 'allowed', rev: 'x'.repeat(16), user: OWNER, interaction: '200000000000000001', message: '300000000000000001' }, bearer);
    assert.ok([403, 409].includes(refused.status), String(refused.status));
    assert.equal(f.fake.objects.has(`${INBOX}/asks/${guarded}/answer.json`), false);

    // An Ask someone wrote with a rerun field but no passkey flag IS Discord-eligible. Answering it there starts nothing.
    const loose = f.rerunAsk('c3d4', { request: original, kind: 'denied' }, { requirePasskey: false });
    const rev = createHash('sha256').update(f.fake.text(`${INBOX}/asks/${loose}/ask.json`)).digest('hex').slice(0, 16);
    const answered = await f.call('POST', '/hub/discord/answer', { ask: loose, choice: 'allowed', rev, user: OWNER, interaction: '200000000000000002', message: '300000000000000002' }, bearer);
    assert.equal(answered.status, 201, JSON.stringify(answered.body));
    assert.equal(answered.body.rerun, undefined);
    assert.equal(f.fake.json(`${INBOX}/asks/${loose}/answer.json`).via, 'discord');
    assert.equal(f.copies(original).length, 0);
    assert.equal(f.fake.objects.has(f.file(original, 'stop.json')), false);
    // The web route on that loose Ask is refused too: only a passkey Ask starts a run.
    const web = await f.answer(f.rerunAsk('e5f6', { request: original, kind: 'denied' }, { requirePasskey: false }), 'allowed');
    assert.equal(web.body.rerun.started, false);
    assert.match(web.body.rerun.why, /passkey/);
    assert.equal(f.copies(original).length, 0);
  } finally { await f.close(); }
});

test('without a signing key nothing is signed and the answer stands', async () => {
  const f = await fixture();
  try {
    const original = await f.run();
    const ask = f.rerunAsk('a1b2', { request: original, kind: 'denied' });
    const bare = await fixtureNoKey(f);
    const done = await bare.afterAnswer({ ask: (await f.call('GET', `/hub/asks/${ask}`)).body, answer: { choice: 'allowed' }, user: 'owner', at: NOW });
    assert.equal(done.started, false);
    assert.equal(f.copies(original).length, 0);
  } finally { await f.close(); }
});

/** A rerun flow built over a hub that has no signing key, reading the same bucket. */
async function fixtureNoKey(f) {
  const bucket = createBucket({ bucket: f.fake.bucket, endpoint: f.fake.endpoint, credentials: f.fake.credentials, region: 'us-east-1' });
  const hub = createHub({ bucket, enabled: true, now: () => NOW, env: {} });
  return hub.rerun;
}

test('a declined copy is not live: Approve again works, and an answer says nothing started and stops nothing', async () => {
  const f = await fixture();
  try {
    const original = await f.run();
    const real = f.hub.requests.approveRequest;
    f.hub.requests.approveRequest = async () => { throw Object.assign(new Error('No signing key.'), { status: 503 }); };
    await f.answer(f.rerunAsk('a1b2', { request: original, kind: 'denied' }), 'allowed');
    f.hub.requests.approveRequest = real;
    const copy = copyOf(f, original);
    assert.equal((await f.post(`/hub/requests/${original}/again`, {})).status, 409, 'blocked while the copy is proposed');
    assert.equal((await f.post(`/hub/requests/${copy.id}/decline`, {})).status, 201);
    const answered = await f.answer(f.rerunAsk('c3d4', { request: original, kind: 'denied' }), 'allowed');
    assert.equal(answered.body.rerun.started, false);
    assert.match(answered.body.rerun.why, /was declined/);
    assert.equal(f.fake.objects.has(f.file(original, 'stop.json')), false, 'the original is not stopped');
    const again = await f.post(`/hub/requests/${original}/again`, {});
    assert.equal(again.status, 201, JSON.stringify(again.body));
  } finally { await f.close(); }
});

test('"again" is accepted only when the run\'s own Ask has no options', async () => {
  const f = await fixture();
  try {
    const original = await f.run();
    const left = f.runAsk('b0b0', original); // it has options: alpha and beta
    const forged = f.rerunAsk('a1b2', { request: original, kind: 'continue', ask: left }, { options: [{ id: 'again', label: 'Run it again' }, { id: 'drop', label: "Don't run it again" }] });
    const done = await f.answer(forged, 'again');
    assert.equal(done.body.rerun.started, false);
    assert.match(done.body.rerun.why, /not one of the run's options/);
    assert.equal(f.copies(original).length, 0);
  } finally { await f.close(); }
});
