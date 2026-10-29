// Cloud routines: firing a repo's routine when a cloud request is approved, the fire-<stamp>.json record of
// every attempt, Retry, the daily cap in the owner's time zone, and the dry run.
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
import { route } from '../presets.mjs';
import { dayIn, fireFileTime, loadRoutines, nextMidnight, repoKey } from '../routines.mjs';
import { sign } from '../signing.mjs';
import { startFakeS3 } from './fake-s3.mjs';
import { createFakeRoutine } from './fake-routine.mjs';
import { requestJson } from './hub-fixtures.mjs';

const SITE = 'https://site.example';
const MIN = 60000;
const keyPair = generateKeyPairSync('ed25519');
const otherPair = generateKeyPairSync('ed25519');
const SECRET_URL = 'https://routine.example.test/v1/fire/SECRETURL123';
const SECRET_TOKEN = 'tok-SECRETTOKEN456';
const ENV = {
  HUB_SIGNING_KEY: keyPair.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
  CLAUDE_ROUTINE_PROBE_URL: SECRET_URL,
  CLAUDE_ROUTINE_PROBE_TOKEN: SECRET_TOKEN,
};
// 23:30 UTC on 29 Oct 2026 is 16:30 in Los Angeles (PDT).
const START = Date.UTC(2026, 9, 29, 23, 30);

async function fixture({ env = {}, routine = createFakeRoutine() } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'buw-routines-'));
  const fake = await startFakeS3();
  const bucket = createBucket({ bucket: fake.bucket, endpoint: fake.endpoint, credentials: fake.credentials, region: 'us-east-1' });
  fake.seed('sections/inbox/workspace.json', '{"name":"Inbox","hidden":true,"entities":[]}\n', 'application/json');
  fake.seed('state.json', '{"version":1,"cards":{}}', 'application/json');
  const clock = { time: START };
  const now = () => new Date(clock.time);
  const logs = [];
  const hub = createHub({ bucket, enabled: true, now, env: { ...ENV, ...env }, fetchImpl: routine.fetchImpl, log: line => logs.push(String(line)) });
  const server = createSiteApi({ bucket, templateDir: path.join(root, 'none'), stateFile: path.join(root, 'card-state.json'), sectionsTtl: 0, requireRemoteUser: false, hub, allowedOrigins: [SITE] });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, data, headers = {}) => {
    const answer = await fetch(`${origin}/api${url}`, {
      method, headers: { ...(method === 'GET' ? {} : { Origin: SITE, 'Content-Type': 'application/json' }), ...headers },
      body: method === 'GET' ? undefined : JSON.stringify(data ?? {}),
    });
    const text = await answer.text();
    let body = null;
    try { body = JSON.parse(text); } catch { /* not JSON */ }
    return { status: answer.status, body, text };
  };
  const post = (url, data, headers = { 'Remote-User': 'owner' }) => call('POST', url, data, headers);
  let n = 0;
  /** A cloud code task for `example/probe`, proposed and not yet approved. */
  const proposeCloud = (extra = {}) => {
    n += 1;
    const id = `20261029-probe-job${n}-c${String(n).padStart(3, '0')}`;
    const request = { ...requestJson({ id, now: new Date(clock.time) }), preset: 'code-task', target: 'cloud', repo: 'example/probe', origin: { kind: 'owner', name: 'owner' }, ...extra };
    fake.seed(`sections/inbox/requests/${id}/request.json`, `${JSON.stringify(request, null, 2)}\n`, 'application/json');
    return request;
  };
  const fires = id => [...fake.objects.keys()].filter(name => name.startsWith(`sections/inbox/requests/${id}/fire-`)).sort().map(name => ({ name, ...fake.json(name) }));
  const seedFire = (id, at, body = {}, rand = 'f001') => fake.seed(
    `sections/inbox/requests/${id}/fire-${markStamp(new Date(at))}-${rand}.json`,
    JSON.stringify({ v: 1, at: new Date(at).toISOString(), routine: 'PROBE', ok: true, status: 200, by: 'hub', ...body }), 'application/json',
  );
  return { fake, hub, post, call, clock, logs, routine, proposeCloud, fires, seedFire, close: async () => { await hub.close(); server.close(); await fake.close(); } };
}

test('loadRoutines: a pair loads, a half pair names the missing key and no value, other keys are ignored', () => {
  const { routines, incomplete } = loadRoutines({
    CLAUDE_ROUTINE_BUNNYUFO_WORKSPACE_URL: 'https://x.example/a', CLAUDE_ROUTINE_BUNNYUFO_WORKSPACE_TOKEN: 'tok-a',
    CLAUDE_ROUTINE_ONLYURL_URL: 'https://x.example/secret-b', CLAUDE_ROUTINE_ONLYTOKEN_TOKEN: 'tok-secret-c',
    CLAUDE_ROUTINE_BAD_NAME: 'x', HUB_SIGNING_KEY: 'k', OTHER_URL: 'https://x.example',
  });
  assert.deepEqual([...routines.keys()], ['BUNNYUFO_WORKSPACE']);
  assert.deepEqual(routines.get('BUNNYUFO_WORKSPACE'), { url: 'https://x.example/a', token: 'tok-a' });
  assert.deepEqual(incomplete.sort(), ['CLAUDE_ROUTINE_ONLYTOKEN_URL', 'CLAUDE_ROUTINE_ONLYURL_TOKEN']);
  assert.ok(!JSON.stringify(incomplete).includes('secret'));
  assert.equal(repoKey('bunnyUFO-lab/bunnyufo-workspace'), 'BUNNYUFO_WORKSPACE');
});

test('a routine that names its repo serves only that owner/name', async () => {
  const f = await fixture({ env: { CLAUDE_ROUTINE_PROBE_REPO: 'example/probe' } });
  try {
    const own = f.proposeCloud();
    assert.equal((await f.post(`/hub/requests/${own.id}/approve`, {})).body.cloud.fired, true);
    const other = f.proposeCloud({ repo: 'attacker/probe' });
    const refused = await f.post(`/hub/requests/${other.id}/approve`, {});
    assert.equal(refused.status, 400);
    assert.match(refused.body.error, /No cloud routine for attacker\/probe/);
    assert.equal(f.routine.calls.length, 1);
    assert.equal(await f.hub.routines.fire({ repo: 'attacker/probe', requestId: 'x' }).then(result => result.reason), 'no-routine');
    assert.equal(route({ preset: 'code-task', project: 'workspace-app', repo: 'attacker/probe', cloudRepos: repo => f.hub.routines.hasRoutine(repo) }).target, 'pc');
  } finally { await f.close(); }
});

test('a half pair is logged once by key name, never by value', async () => {
  const f = await fixture({ env: { CLAUDE_ROUTINE_HALF_URL: 'https://half.example/SECRETHALF' } });
  try {
    assert.equal(f.logs.filter(line => line.includes('CLAUDE_ROUTINE_HALF_TOKEN')).length, 1);
    assert.ok(!f.logs.join('\n').includes('SECRETHALF'));
  } finally { await f.close(); }
});

test("day helpers: the owner's day, its next midnight and the stamp of a fire file", () => {
  const evening = new Date(START);
  assert.equal(dayIn(evening, 'America/Los_Angeles'), '2026-10-29');
  assert.equal(dayIn(new Date(Date.UTC(2026, 9, 30, 7, 5)), 'America/Los_Angeles'), '2026-10-30');
  assert.equal(nextMidnight(evening, 'America/Los_Angeles').toISOString(), '2026-10-30T07:00:00.000Z');
  assert.equal(nextMidnight(evening, 'UTC').toISOString(), '2026-10-30T00:00:00.000Z');
  assert.equal(fireFileTime(`fire-${markStamp(evening)}-ab12.json`), START);
  assert.equal(fireFileTime('run-20261029T233000000Z-ab12.json'), null);
});

test('approving a cloud code task fires once with exactly the id and the S3 headers, and records fire-*.json with the session link', async () => {
  const f = await fixture();
  try {
    const request = f.proposeCloud();
    const approved = await f.post(`/hub/requests/${request.id}/approve`, {});
    assert.equal(approved.status, 201);
    assert.equal(approved.body.state, 'approved');
    assert.deepEqual(approved.body.cloud, { fired: true });
    assert.equal(f.routine.calls.length, 1);
    const [call] = f.routine.calls;
    assert.equal(call.url, SECRET_URL);
    assert.equal(call.method, 'POST');
    assert.equal(call.body, JSON.stringify({ text: request.id }));
    assert.equal(call.headers.Authorization, `Bearer ${SECRET_TOKEN}`);
    assert.equal(call.headers['anthropic-beta'], 'experimental-cc-routine-2026-04-01');
    assert.equal(call.headers['anthropic-version'], '2023-06-01');
    assert.equal(call.headers['Content-Type'], 'application/json');
    const written = f.fires(request.id);
    assert.equal(written.length, 1);
    assert.match(written[0].name, /\/fire-\d{8}T\d{9}Z-[a-z0-9]{4}\.json$/);
    assert.equal(written[0].ok, true);
    assert.equal(written[0].status, 200);
    assert.equal(written[0].by, 'hub');
    assert.equal(written[0].routine, 'PROBE');
    assert.equal(written[0].session, 'https://claude.ai/code/session_fake1');
    assert.equal(written[0].sessionId, 'session_fake1');
    const detail = await f.call('GET', `/hub/requests/${request.id}`);
    assert.equal(detail.body.fires.length, 1);
    // Neither the URL nor the token is in a log line, a stored file or any answer.
    const everything = [f.logs.join('\n'), approved.text, detail.text, ...f.fires(request.id).map(fire => JSON.stringify(fire))].join('\n');
    assert.ok(!everything.includes('SECRETURL123'), 'The URL never leaves.');
    assert.ok(!everything.includes('SECRETTOKEN456'), 'The token never leaves.');
    assert.ok(f.logs.some(line => line.includes(`fire ${request.id} -> 200`)), f.logs.join('\n'));
  } finally { await f.close(); }
});

test('HUB_ROUTINE_BETA changes the beta header', async () => {
  const f = await fixture({ env: { HUB_ROUTINE_BETA: 'experimental-cc-routine-2027-01-01' } });
  try {
    await f.post(`/hub/requests/${f.proposeCloud().id}/approve`, {});
    assert.equal(f.routine.calls[0].headers['anthropic-beta'], 'experimental-cc-routine-2027-01-01');
  } finally { await f.close(); }
});

test('a failed fire keeps the approval and records ok:false; Retry fires again and writes a second record', async () => {
  const f = await fixture();
  try {
    for (const failure of [{ fail: true }, { status: 500 }]) {
      f.routine.set({ fail: false, status: 200, ...failure });
      const request = f.proposeCloud();
      const approved = await f.post(`/hub/requests/${request.id}/approve`, {});
      assert.equal(approved.status, 201, 'The approval stands.');
      assert.equal(approved.body.cloud.fired, false);
      assert.match(approved.body.waiting, /did not start/);
      assert.ok(f.fake.text(`sections/inbox/requests/${request.id}/approved.json`));
      const [first] = f.fires(request.id);
      assert.equal(first.ok, false);
      assert.equal(first.reason, failure.fail ? 'network' : 'http-500');
      f.routine.set({ fail: false, status: 200 });
      const retried = await f.post(`/hub/requests/${request.id}/fire`, {});
      assert.equal(retried.status, 200);
      assert.equal(retried.body.fired, true);
      assert.equal(f.fires(request.id).length, 2);
      assert.equal(f.fires(request.id).filter(fire => fire.ok).length, 1);
    }
  } finally { await f.close(); }
});

test('a fire that outlasts its timeout is recorded as timeout', async () => {
  const f = await fixture({ routine: createFakeRoutine({ delayMs: 3000 }) });
  try {
    const original = AbortSignal.timeout;
    AbortSignal.timeout = () => original.call(AbortSignal, 20);
    try {
      assert.deepEqual(await f.hub.routines.fire({ repo: 'example/probe', requestId: 'x' }), { ok: false, status: 0, reason: 'timeout' });
    } finally { AbortSignal.timeout = original; }
  } finally { await f.close(); }
});

test('Retry: 401 without a user, 409 within 10 minutes of an ok fire, 409 on a PC request, allowed after 10 minutes', async () => {
  const f = await fixture();
  try {
    const request = f.proposeCloud();
    await f.post(`/hub/requests/${request.id}/approve`, {});
    assert.equal((await f.post(`/hub/requests/${request.id}/fire`, {}, {})).status, 401);
    f.clock.time += 4 * MIN;
    const early = await f.post(`/hub/requests/${request.id}/fire`, {});
    assert.equal(early.status, 409);
    assert.match(early.body.error, /fired 4 min ago/);
    assert.equal(f.routine.calls.length, 1);
    f.clock.time += 7 * MIN;
    const later = await f.post(`/hub/requests/${request.id}/fire`, {});
    assert.equal(later.status, 200);
    assert.equal(f.routine.calls.length, 2);

    const pc = f.proposeCloud({ preset: 'code-task', target: 'pc' });
    assert.equal((await f.post(`/hub/requests/${pc.id}/approve`, { target: 'pc' })).status, 201);
    assert.equal((await f.post(`/hub/requests/${pc.id}/fire`, {})).status, 409);
    const proposed = f.proposeCloud();
    assert.equal((await f.post(`/hub/requests/${proposed.id}/fire`, {})).status, 409, 'A proposal is not approved.');
    assert.equal((await f.post('/hub/requests/20261029-probe-nothing-zzzz/fire', {})).status, 404);
  } finally { await f.close(); }
});

test("Retry refuses an approval that fails the server's own check", async () => {
  const f = await fixture();
  try {
    const request = f.proposeCloud();
    const forged = sign({
      v: 1, request: request.id, project: 'probe', repo: 'example/probe', target: 'cloud', requestSha256: 'a'.repeat(64), limits: { minutes: 120 },
      expires: new Date(f.clock.time + 72 * 60 * MIN).toISOString(), nonce: 'n'.repeat(22), at: new Date(f.clock.time).toISOString(), by: 'owner', run: { preset: 'code-task', brief: 'x' },
    }, otherPair.privateKey);
    f.fake.seed(`sections/inbox/requests/${request.id}/approved.json`, JSON.stringify(forged), 'application/json');
    const retried = await f.post(`/hub/requests/${request.id}/fire`, {});
    assert.equal(retried.status, 409);
    assert.match(retried.body.error, /failed the server's check/);
    assert.equal(f.routine.calls.length, 0);
    assert.equal(f.fires(request.id).length, 0);
  } finally { await f.close(); }
});

test("the daily cap counts the owner's day: the 11th fire waits, and fires after the owner's midnight", async () => {
  const f = await fixture({ env: { HUB_TIME_ZONE: 'America/Los_Angeles' } });
  try {
    // Ten ok fires earlier on the local day (08:00 to 11:00 PDT on 29 Oct), on other requests.
    for (let i = 0; i < 10; i += 1) f.seedFire(`20261029-probe-old${i}-o${String(i).padStart(3, '0')}`, Date.UTC(2026, 9, 29, 15 + (i % 4), i));
    // A failed fire and a fire on the day before do not count.
    f.seedFire('20261029-probe-bad-b001', Date.UTC(2026, 9, 29, 20), { ok: false });
    f.seedFire('20261028-probe-day-d001', Date.UTC(2026, 9, 29, 6, 59));
    const request = f.proposeCloud();
    const approved = await f.post(`/hub/requests/${request.id}/approve`, {});
    assert.equal(approved.status, 201, 'The approval is signed even at the cap.');
    assert.equal(approved.body.cloud.fired, false);
    assert.equal(approved.body.cloud.reason, 'daily-cap');
    assert.equal(approved.body.cloud.next, '2026-10-30T07:00:00.000Z');
    assert.equal(f.routine.calls.length, 0);
    assert.equal(f.fires(request.id).length, 0);
    // Still the owner's 29th at 23:59 PDT.
    f.clock.time = Date.UTC(2026, 9, 30, 6, 59);
    assert.equal((await f.post(`/hub/requests/${request.id}/fire`, {})).status, 409);
    // At 00:05 on the 30th the count starts again.
    f.clock.time = Date.UTC(2026, 9, 30, 7, 5);
    const next = await f.post(`/hub/requests/${request.id}/fire`, {});
    assert.equal(next.status, 200);
    assert.equal(next.body.fired, true);
    assert.equal(f.routine.calls.length, 1);
  } finally { await f.close(); }
});

test('HUB_CLOUD_DAILY lowers the cap', async () => {
  const f = await fixture({ env: { HUB_CLOUD_DAILY: '1' } });
  try {
    assert.equal((await f.post(`/hub/requests/${f.proposeCloud().id}/approve`, {})).body.cloud.fired, true);
    const second = await f.post(`/hub/requests/${f.proposeCloud().id}/approve`, {});
    assert.equal(second.body.cloud.reason, 'daily-cap');
    assert.equal(f.routine.calls.length, 1);
  } finally { await f.close(); }
});

test('no routine for the repo: approve is 400 before anything is signed', async () => {
  const f = await fixture();
  try {
    const request = f.proposeCloud({ repo: 'example/elsewhere' });
    const refused = await f.post(`/hub/requests/${request.id}/approve`, {});
    assert.equal(refused.status, 400);
    assert.match(refused.body.error, /No cloud routine for example\/elsewhere/);
    assert.equal(f.fake.text(`sections/inbox/requests/${request.id}/approved.json`), null);
    assert.equal(f.routine.calls.length, 0);
  } finally { await f.close(); }
});

test('route() sends a repo-only project to the cloud only when the repo has a routine', async () => {
  const input = { preset: 'code-task', project: 'workspace-app', repo: 'example/probe' };
  assert.equal(route({ ...input, cloudRepos: [] }).target, 'pc');
  assert.equal(route({ ...input, cloudRepos: ['example/probe'] }).target, 'cloud');
  const f = await fixture();
  try {
    const has = repo => f.hub.routines.hasRoutine(repo);
    assert.equal(route({ ...input, cloudRepos: has }).target, 'cloud');
    assert.equal(route({ ...input, repo: 'example/other', cloudRepos: has }).target, 'pc');
    const asked = await f.call('GET', '/hub/presets/route?preset=code-task&project=workspace-app&repo=example/probe');
    assert.equal(asked.body.target, 'cloud');
    const capabilities = f.hub.capabilities({ signedIn: true });
    assert.deepEqual(capabilities.cloudRepos, ['PROBE']);
    assert.ok(!JSON.stringify(capabilities).includes('SECRET'));
  } finally { await f.close(); }
});

test('dry run: nothing is sent, every repo has a routine, the record says dryRun', async () => {
  const f = await fixture({ env: { HUB_ROUTINE_DRY_RUN: '1', CLAUDE_ROUTINE_PROBE_URL: '', CLAUDE_ROUTINE_PROBE_TOKEN: '' } });
  try {
    const request = f.proposeCloud({ repo: 'example/anything' });
    const approved = await f.post(`/hub/requests/${request.id}/approve`, {});
    assert.equal(approved.status, 201);
    assert.equal(approved.body.cloud.fired, true);
    assert.equal(f.routine.calls.length, 0);
    const [record] = f.fires(request.id);
    assert.equal(record.ok, true);
    assert.equal(record.status, 0);
    assert.equal(record.dryRun, true);
  } finally { await f.close(); }
});

test('dry run wins over real keys and says so once', async () => {
  const f = await fixture({ env: { HUB_ROUTINE_DRY_RUN: '1' } });
  try {
    assert.equal(f.logs.filter(line => /dry run/i.test(line)).length, 1);
    await f.post(`/hub/requests/${f.proposeCloud().id}/approve`, {});
    assert.equal(f.routine.calls.length, 0);
  } finally { await f.close(); }
});
