// Move to the cloud: a request approved for the PC that has waited 6 hours is offered on Today, and the owner's tap makes a new
// request with a cloud approval (fired through the same queue, so the cap and a pause apply) and stops the old one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { createSiteApi } from '../server.mjs';
import { createBucket } from '../s3.mjs';
import { createHub } from '../hub.mjs';
import { markStamp } from '../hub-model.mjs';
import { startFakeS3 } from './fake-s3.mjs';
import { createFakeRoutine } from './fake-routine.mjs';
import { requestJson } from './hub-fixtures.mjs';
import { sha256Hex, sign } from '../signing.mjs';
import { listenOnGoodPort } from '../../../server/listen.mjs';

const SITE = 'https://site.example';
const MIN = 60000;
const HOUR = 60 * MIN;
const keyPair = generateKeyPairSync('ed25519');
const ENV = {
  HUB_SIGNING_KEY: keyPair.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
  CLAUDE_ROUTINE_PROBE_URL: 'https://routine.example.test/v1/fire/SECRET',
  CLAUDE_ROUTINE_PROBE_TOKEN: 'tok-SECRET',
  CLAUDE_ROUTINE_PROBE_REPO: 'example/probe',
};
const otherPair = generateKeyPairSync('ed25519');
const START = Date.UTC(2026, 9, 29, 12, 0);

async function fixture({ env = {} } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'buw-move-'));
  const fake = await startFakeS3();
  const bucket = createBucket({ bucket: fake.bucket, endpoint: fake.endpoint, credentials: fake.credentials, region: 'us-east-1' });
  fake.seed('sections/inbox/workspace.json', '{"name":"Inbox","hidden":true,"entities":[]}\n', 'application/json');
  fake.seed('state.json', '{"version":1,"cards":{}}', 'application/json');
  const clock = { time: START };
  const routine = createFakeRoutine();
  const hub = createHub({ bucket, enabled: true, now: () => new Date(clock.time), env: { ...ENV, ...env }, fetchImpl: routine.fetchImpl, log: () => {} });
  const server = createSiteApi({ bucket, templateDir: path.join(root, 'none'), stateFile: path.join(root, 'card-state.json'), sectionsTtl: 0, requireRemoteUser: false, hub, allowedOrigins: [SITE] });
  await listenOnGoodPort(server, '127.0.0.1');
  await hub.routines.sweep();
  const origin = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, data, headers = {}) => {
    const answer = await fetch(`${origin}/api${url}`, {
      method, headers: { ...(method === 'GET' ? {} : { Origin: SITE, 'Content-Type': 'application/json' }), ...headers },
      body: method === 'GET' ? undefined : JSON.stringify(data ?? {}),
    });
    return { status: answer.status, body: await answer.json().catch(() => null) };
  };
  const post = (url, data, headers = { 'Remote-User': 'owner' }) => call('POST', url, data, headers);
  let n = 0;
  /** A code task for the PC, proposed and approved at the start of the test clock. */
  const pcRequest = async (extra = {}, { sign: signed = true } = {}) => {
    n += 1;
    const id = `20261029-probe-job${n}-c${String(n).padStart(3, '0')}`;
    const request = { ...requestJson({ id, now: new Date(clock.time) }), preset: 'code-task', target: 'pc', repo: 'example/probe', title: `Job ${n}`, origin: { kind: 'owner', name: 'owner' }, ...extra };
    fake.seed(`sections/inbox/requests/${id}/request.json`, `${JSON.stringify(request, null, 2)}\n`, 'application/json');
    if (!signed) return request;
    const approved = await post(`/hub/requests/${id}/approve`, { target: 'pc' });
    assert.equal(approved.status, 201, JSON.stringify(approved.body));
    return request;
  };
  const files = id => [...fake.objects.keys()].filter(name => name.startsWith(`sections/inbox/requests/${id}/`)).map(name => name.split('/').pop());
  const offers = async () => (await call('GET', '/hub/today')).body.offers ?? [];
  const detail = async id => (await call('GET', `/hub/requests/${id}`)).body;
  const extra = [];
  /** A second site API on the same bucket and clock, with its own routine: another process of the same service. */
  const second = async () => {
    const routine2 = createFakeRoutine();
    const hub2 = createHub({ bucket, enabled: true, now: () => new Date(clock.time), env: { ...ENV, ...env }, fetchImpl: routine2.fetchImpl, log: () => {} });
    const server2 = createSiteApi({ bucket, templateDir: path.join(root, 'none'), stateFile: path.join(root, 'card-state2.json'), sectionsTtl: 0, requireRemoteUser: false, hub: hub2, allowedOrigins: [SITE] });
    await listenOnGoodPort(server2, '127.0.0.1');
    extra.push(async () => { await hub2.close(); server2.close(); });
    const origin2 = `http://127.0.0.1:${server2.address().port}`;
    const post2 = async url => {
      const answer = await fetch(`${origin2}/api${url}`, { method: 'POST', headers: { Origin: SITE, 'Content-Type': 'application/json', 'Remote-User': 'owner' }, body: '{}' });
      return { status: answer.status, body: await answer.json().catch(() => null) };
    };
    return { post: post2, routine: routine2 };
  };
  /** Replace a request's approval with one signed by `privateKey` (the PC wrote it, or a stranger did). */
  const reapprove = (request, { privateKey = otherPair.privateKey, sha = null } = {}) => {
    const bytes = fake.text(`sections/inbox/requests/${request.id}/request.json`);
    const approved = sign({
      v: 1, request: request.id, project: request.project, repo: request.repo ?? null, target: 'pc', requestSha256: sha ?? sha256Hex(Buffer.from(bytes)), limits: { minutes: 120 },
      expires: new Date(START + 72 * HOUR).toISOString(), nonce: 'n'.repeat(22), at: new Date(START).toISOString(), by: 'owner', run: { preset: 'code-task', brief: 'Do the job.' },
    }, privateKey);
    fake.seed(`sections/inbox/requests/${request.id}/approved.json`, `${JSON.stringify(approved, null, 2)}\n`, 'application/json');
  };
  return { fake, hub, call, post, clock, routine, pcRequest, files, offers, detail, second, reapprove, close: async () => { await hub.close(); server.close(); for (const stop of extra) await stop(); await fake.close(); } };
}

test('offered at 6 hours and not before; moving makes a cloud request, fires it and stops the old one', async () => {
  const f = await fixture();
  try {
    const request = await f.pcRequest();
    f.clock.time = START + 6 * HOUR - MIN;
    assert.deepEqual(await f.offers(), []);
    const early = await f.post(`/hub/requests/${request.id}/move-to-cloud`);
    assert.equal(early.status, 409);
    assert.match(early.body.error, /6 hours/);
    f.clock.time = START + 6 * HOUR;
    const [offer] = await f.offers();
    assert.equal(offer.kind, 'move-to-cloud');
    assert.equal(offer.request, request.id);
    assert.equal(offer.title, 'Job 1');
    const moved = await f.post(`/hub/requests/${request.id}/move-to-cloud`);
    assert.equal(moved.status, 201, JSON.stringify(moved.body));
    const fresh = f.fake.json(`sections/inbox/requests/${moved.body.id}/request.json`);
    assert.equal(fresh.replaces, request.id);
    assert.equal(fresh.target, 'cloud');
    assert.equal(fresh.origin.name, 'owner');
    assert.equal(f.fake.json(`sections/inbox/requests/${moved.body.id}/approved.json`).target, 'cloud');
    assert.ok(f.files(moved.body.id).some(name => /^fire-.*\.json$/.test(name)), 'The new request was fired.');
    assert.equal(f.routine.calls.length, 1);
    assert.equal(f.fake.json(`sections/inbox/requests/${request.id}/stop.json`).reason, `moved to the cloud: ${moved.body.id}`);
    assert.equal((await f.detail(request.id)).state, 'stopped');
    assert.deepEqual(await f.offers(), [], 'The old request is no longer offered.');
    const twice = await f.post(`/hub/requests/${request.id}/move-to-cloud`);
    assert.equal(twice.status, 409);
    assert.equal(f.routine.calls.length, 1, 'No second run.');
  } finally { await f.close(); }
});

test('not offered, and not moved, when it needs the PC, has no repo or routine, or its project is excluded', async () => {
  const f = await fixture({ env: { HUB_CLOUD_NEVER: 'secret, other' } });
  try {
    const wants = await f.pcRequest({ needs: ['unity'] });
    const noRepo = await f.pcRequest({ repo: undefined });
    const noRoutine = await f.pcRequest({ repo: 'example/elsewhere' });
    const never = await f.pcRequest({ project: 'secret' });
    const good = await f.pcRequest();
    f.clock.time = START + 7 * HOUR;
    assert.deepEqual((await f.offers()).map(offer => offer.request), [good.id]);
    for (const request of [wants, noRepo, noRoutine, never]) {
      const answer = await f.post(`/hub/requests/${request.id}/move-to-cloud`);
      assert.equal(answer.status, 409, request.id);
      assert.equal((await f.detail(request.id)).state, 'approved', 'Nothing was stopped.');
    }
    assert.equal(f.routine.calls.length, 0);
  } finally { await f.close(); }
});

test('Bunnylink work is never offered for the cloud', async () => {
  const f = await fixture();
  try {
    // The site no longer signs Bunnylink work for the PC. This is an approval from before that wall, signed with the server's key.
    const request = await f.pcRequest({ project: 'bunnylink' }, { sign: false });
    f.reapprove(request, { privateKey: keyPair.privateKey });
    f.clock.time = START + 7 * HOUR;
    assert.deepEqual(await f.offers(), []);
    assert.equal((await f.post(`/hub/requests/${request.id}/move-to-cloud`)).status, 409);
  } finally { await f.close(); }
});

test('a taken request is not offered, and Move needs a signed-in user', async () => {
  const f = await fixture();
  try {
    const taken = await f.pcRequest();
    const first = await f.pcRequest();
    const quiet = await f.pcRequest();
    f.fake.seed(`sections/inbox/requests/${taken.id}/taken.json`, JSON.stringify({ v: 1, runner: 'pc', host: 'pc', at: new Date(START + HOUR).toISOString() }), 'application/json');
    f.clock.time = START + 8 * HOUR;
    assert.deepEqual((await f.offers()).map(offer => offer.request).sort(), [first.id, quiet.id].sort());
    assert.equal((await f.post(`/hub/requests/${quiet.id}/move-to-cloud`, {}, {})).status, 401);
    assert.equal((await f.post(`/hub/requests/${taken.id}/move-to-cloud`)).status, 409);
    await f.post(`/hub/requests/${first.id}/move-to-cloud`);
    assert.deepEqual((await f.offers()).map(offer => offer.request), [quiet.id]);
  } finally { await f.close(); }
});

test('a move made at the cap makes the new approval and leaves it waiting', async () => {
  const f = await fixture({ env: { HUB_CLOUD_DAILY: '1' } });
  try {
    const request = await f.pcRequest();
    f.clock.time = START + 6 * HOUR;
    const at = new Date(START + 5 * HOUR);
    f.fake.seed(`sections/inbox/requests/20261029-probe-old-o001/fire-${markStamp(at)}-f001.json`, JSON.stringify({ v: 1, at: at.toISOString(), routine: 'PROBE', ok: true, status: 200, by: 'hub' }), 'application/json');
    const moved = await f.post(`/hub/requests/${request.id}/move-to-cloud`);
    assert.equal(moved.status, 201, JSON.stringify(moved.body));
    assert.equal(moved.body.cloud.fired, false);
    assert.equal(moved.body.cloud.reason, 'daily-cap');
    assert.ok(f.fake.objects.has(`sections/inbox/requests/${moved.body.id}/approved.json`));
    assert.ok(!f.files(moved.body.id).some(name => name.startsWith('fire-')), 'Nothing fired.');
    const waiting = (await f.detail(moved.body.id)).cloud;
    assert.equal(waiting.status, 'waiting');
    assert.equal(waiting.reason, 'daily-cap');
    assert.equal(f.routine.calls.length, 0);
    assert.ok(f.fake.objects.has(`sections/inbox/requests/${request.id}/stop.json`));
  } finally { await f.close(); }
});

test('two moves at once make one new request', async () => {
  const f = await fixture();
  try {
    const request = await f.pcRequest();
    f.clock.time = START + 6 * HOUR;
    const [a, b] = await Promise.all([f.post(`/hub/requests/${request.id}/move-to-cloud`), f.post(`/hub/requests/${request.id}/move-to-cloud`)]);
    assert.deepEqual([a.status, b.status].sort(), [201, 409]);
    assert.equal(f.routine.calls.length, 1);
    const copies = [...f.fake.objects.keys()].filter(name => /requests\/[^/]+\/request\.json$/.test(name) && JSON.parse(f.fake.text(name)).replaces === request.id);
    assert.equal(copies.length, 1);
  } finally { await f.close(); }
});

test('a request the PC took meets a 409 with no stop, no copy and no fire', async () => {
  const f = await fixture();
  try {
    const request = await f.pcRequest();
    f.clock.time = START + 7 * HOUR;
    f.fake.seed(`sections/inbox/requests/${request.id}/taken.json`, JSON.stringify({ v: 1, runner: 'pc', host: 'pc', at: new Date(START + 6.5 * HOUR).toISOString() }), 'application/json');
    const answer = await f.post(`/hub/requests/${request.id}/move-to-cloud`);
    assert.equal(answer.status, 409);
    assert.ok(![...f.fake.objects.keys()].some(name => name.includes(`${request.id}/stop.json`)), 'No stop.');
    assert.equal([...f.fake.objects.keys()].filter(name => name.endsWith('/request.json')).length, 1, 'No copy.');
    assert.equal(f.routine.calls.length, 0);
  } finally { await f.close(); }
});

test('the old request is stopped before the copy fires', async () => {
  const f = await fixture();
  try {
    const request = await f.pcRequest();
    f.clock.time = START + 7 * HOUR;
    const seen = [];
    // The routine is called after the copy is signed: look at the bucket at that moment.
    f.routine.calls.push = function push(...items) { seen.push([...f.fake.objects.keys()].some(name => name.includes(`${request.id}/stop.json`))); return Array.prototype.push.apply(this, items); };
    const moved = await f.post(`/hub/requests/${request.id}/move-to-cloud`);
    assert.equal(moved.status, 201, JSON.stringify(moved.body));
    assert.deepEqual(seen, [true], 'The stop was already there when the routine was called.');
    assert.equal(f.fake.json(`sections/inbox/requests/${request.id}/stop.json`).reason, `moved to the cloud: ${moved.body.id}`);
  } finally { await f.close(); }
});

test('two site APIs on one bucket moving at once make one copy and one fire', async () => {
  const f = await fixture();
  try {
    const other = await f.second();
    const request = await f.pcRequest();
    f.clock.time = START + 7 * HOUR;
    const [a, b] = await Promise.all([f.post(`/hub/requests/${request.id}/move-to-cloud`), other.post(`/hub/requests/${request.id}/move-to-cloud`)]);
    assert.deepEqual([a.status, b.status].sort(), [201, 409], JSON.stringify([a.body, b.body]));
    assert.equal(f.routine.calls.length + other.routine.calls.length, 1);
    const copies = [...f.fake.objects.keys()].filter(name => /requests\/[^/]+\/request\.json$/.test(name) && JSON.parse(f.fake.text(name)).replaces === request.id);
    assert.equal(copies.length, 1);
  } finally { await f.close(); }
});

test('an approval signed by another key, or for other bytes, is never offered or re-signed', async () => {
  const f = await fixture();
  try {
    const forged = await f.pcRequest({ origin: { kind: 'agent', name: 'hermes' } }, { sign: false });
    const changed = await f.pcRequest({}, { sign: false });
    const good = await f.pcRequest();
    f.reapprove(forged);
    f.reapprove(changed, { privateKey: keyPair.privateKey, sha: 'a'.repeat(64) });
    f.clock.time = START + 7 * HOUR;
    const offered = (await f.offers()).map(offer => offer.request);
    assert.ok(!offered.includes(forged.id), 'A forged approval is not offered.');
    assert.ok(offered.includes(good.id));
    for (const request of [forged, changed]) {
      const answer = await f.post(`/hub/requests/${request.id}/move-to-cloud`);
      assert.equal(answer.status, 409, request.id);
      assert.match(answer.body.error, /failed the server's check/);
      assert.ok(![...f.fake.objects.keys()].some(name => name.includes(`${request.id}/stop.json`)), 'Nothing was stopped.');
    }
    assert.equal([...f.fake.objects.keys()].filter(name => name.endsWith('/request.json')).length, 3, 'No copy.');
    assert.equal(f.routine.calls.length, 0);
  } finally { await f.close(); }
});

test('the 409 for a request that cannot move names its state; the offer carries the repo', async () => {
  const f = await fixture();
  try {
    const request = await f.pcRequest();
    f.clock.time = START + 7 * HOUR;
    assert.equal((await f.offers())[0].repo, 'example/probe');
    await f.post(`/hub/requests/${request.id}/stop`, {});
    const answer = await f.post(`/hub/requests/${request.id}/move-to-cloud`);
    assert.equal(answer.status, 409);
    assert.match(answer.body.error, /That request is stopped; it cannot move to the cloud\./);
  } finally { await f.close(); }
});
