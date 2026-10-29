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
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
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
  const pcRequest = async (extra = {}) => {
    n += 1;
    const id = `20261029-probe-job${n}-c${String(n).padStart(3, '0')}`;
    const request = { ...requestJson({ id, now: new Date(clock.time) }), preset: 'code-task', target: 'pc', repo: 'example/probe', title: `Job ${n}`, origin: { kind: 'owner', name: 'owner' }, ...extra };
    fake.seed(`sections/inbox/requests/${id}/request.json`, `${JSON.stringify(request, null, 2)}\n`, 'application/json');
    const approved = await post(`/hub/requests/${id}/approve`, { target: 'pc' });
    assert.equal(approved.status, 201, JSON.stringify(approved.body));
    return request;
  };
  const files = id => [...fake.objects.keys()].filter(name => name.startsWith(`sections/inbox/requests/${id}/`)).map(name => name.split('/').pop());
  const offers = async () => (await call('GET', '/hub/today')).body.offers ?? [];
  const detail = async id => (await call('GET', `/hub/requests/${id}`)).body;
  return { fake, hub, call, post, clock, routine, pcRequest, files, offers, detail, close: async () => { await hub.close(); server.close(); await fake.close(); } };
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
    // Bunnylink work is approved for the PC by hand here: its own routing sends it to the owner at the PC.
    const request = await f.pcRequest({ project: 'bunnylink' });
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
