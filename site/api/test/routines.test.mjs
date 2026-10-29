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
import { dayIn, fireFileTime, loadRoutines, nextMidnight, repoKey, retryPlan } from '../routines.mjs';
import { sha256Hex, sign } from '../signing.mjs';
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
  CLAUDE_ROUTINE_PROBE_REPO: 'example/probe',
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
  await hub.routines.sweep(); // the sweep at start is over before a test seeds anything
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
  /** An approved.json as a policy signer would leave it: signed here and written straight to the bucket, no route call. */
  const writeApproval = (request, { privateKey = keyPair.privateKey, at = clock.time, expiresIn = 72 * 60 * MIN, target = 'cloud' } = {}) => {
    const bytes = fake.text(`sections/inbox/requests/${request.id}/request.json`);
    const approved = sign({
      v: 1, request: request.id, project: request.project, repo: request.repo ?? null, target, requestSha256: sha256Hex(Buffer.from(bytes)), limits: { minutes: 120 },
      expires: new Date(at + expiresIn).toISOString(), nonce: 'n'.repeat(22), at: new Date(at).toISOString(), by: 'policy', run: { preset: 'code-task', brief: 'Do the job.' },
    }, privateKey);
    fake.seed(`sections/inbox/requests/${request.id}/approved.json`, `${JSON.stringify(approved, null, 2)}\n`, 'application/json');
    return approved;
  };
  const detail = async id => (await call('GET', `/hub/requests/${id}`)).body;
  return { fake, hub, post, call, clock, logs, routine, proposeCloud, fires, seedFire, writeApproval, detail, close: async () => { await hub.close(); server.close(); await fake.close(); } };
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

test('a routine with no _REPO is refused: nothing is sent, the fire record and the log say why', async () => {
  const f = await fixture({ env: { CLAUDE_ROUTINE_PROBE_REPO: '' } });
  try {
    assert.ok(f.logs.some(line => line.includes('CLAUDE_ROUTINE_PROBE_REPO is not set')));
    const request = f.proposeCloud();
    const approved = await f.post(`/hub/requests/${request.id}/approve`, {});
    assert.equal(approved.status, 201, 'The approval stands.');
    assert.equal(approved.body.cloud.fired, false);
    assert.equal(approved.body.cloud.reason, 'routine-repo-unset');
    assert.equal(f.routine.calls.length, 0);
    const [record] = f.fires(request.id);
    assert.equal(record.ok, false);
    assert.equal(record.reason, 'routine-repo-unset');
    assert.ok(f.logs.some(line => line.includes('not fired: CLAUDE_ROUTINE_PROBE_REPO is not set')));
    assert.equal((await f.post(`/hub/requests/${request.id}/fire`, {})).body.reason, 'routine-repo-unset');
    assert.equal(f.routine.calls.length, 0);
  } finally { await f.close(); }
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

// --- the fire queue ---

test('retryPlan: 429 costs no retry, failures retry at 5, 15 and 45 minutes, a 4xx stops at once', () => {
  const at = new Date(START);
  const fail = (minutesAgo, extra = {}) => ({ ok: false, status: 500, reason: 'http-500', at: new Date(START - minutesAgo * MIN).toISOString(), ...extra });
  assert.deepEqual(retryPlan([], at), { go: true });
  assert.deepEqual(retryPlan([fail(1, { status: 429, reason: 'http-429' })], at), { go: true });
  assert.equal(retryPlan([fail(4)], at).wait, true);
  assert.deepEqual(retryPlan([fail(5)], at), { go: true });
  assert.equal(retryPlan([fail(14), fail(19)], at).wait, true);
  assert.deepEqual(retryPlan([fail(15), fail(20)], at), { go: true });
  assert.equal(retryPlan([fail(44), fail(60), fail(70)], at).wait, true);
  assert.deepEqual(retryPlan([fail(45), fail(60), fail(70)], at), { go: true });
  assert.equal(retryPlan([fail(500), fail(600), fail(700), fail(800)], at).stop, true);
  assert.deepEqual(retryPlan([fail(1, { status: 401, reason: 'http-401' })], at), { stop: true, reason: 'http-401' });
});

test('a policy-style approved.json written straight to the bucket is fired by the next sweep', async () => {
  const f = await fixture();
  try {
    const request = f.proposeCloud();
    f.writeApproval(request);
    assert.equal(f.routine.calls.length, 0);
    assert.equal((await f.detail(request.id)).cloud.status, 'queued');
    const done = await f.hub.routines.sweep();
    assert.deepEqual(done.fired, [request.id]);
    assert.equal(f.routine.calls.length, 1);
    assert.equal(f.routine.calls[0].body, JSON.stringify({ text: request.id }));
    const [record] = f.fires(request.id);
    assert.equal(record.by, 'sweep');
    assert.equal(record.ok, true);
    assert.equal((await f.detail(request.id)).cloud.status, 'fired');
    assert.deepEqual((await f.hub.routines.sweep()).fired, [], 'A fired request is not fired again.');
    assert.equal(f.routine.calls.length, 1);
  } finally { await f.close(); }
});

test('a forged approved.json is never fired and raises an alert in Today', async () => {
  const f = await fixture();
  try {
    const request = f.proposeCloud({ title: 'Forged job' });
    f.writeApproval(request, { privateKey: otherPair.privateKey });
    const done = await f.hub.routines.sweep();
    assert.deepEqual(done.refused, [request.id]);
    assert.equal(f.routine.calls.length, 0);
    assert.equal(f.fires(request.id).length, 0, 'Nothing is written.');
    assert.ok(f.logs.some(line => line.includes(`skip ${request.id}: bad signature`)));
    const today = (await f.call('GET', '/hub/today')).body;
    assert.ok(today.alerts.some(alert => alert.title === "Approval for Forged job failed the server's check" && alert.request === request.id), JSON.stringify(today.alerts));
    // A request.json changed after signing fails too.
    const changed = f.proposeCloud({ title: 'Changed job' });
    f.writeApproval(changed);
    f.fake.seed(`sections/inbox/requests/${changed.id}/request.json`, `${JSON.stringify({ ...changed, text: 'Something else entirely' }, null, 2)}\n`, 'application/json');
    assert.deepEqual((await f.hub.routines.sweep()).refused.sort(), [request.id, changed.id].sort());
    assert.equal(f.routine.calls.length, 0);
    // Once the forged requests are stopped, the alert goes.
    f.fake.seed(`sections/inbox/requests/${request.id}/stop.json`, '{}', 'application/json');
    f.fake.seed(`sections/inbox/requests/${changed.id}/stop.json`, '{}', 'application/json');
    await f.hub.routines.sweep();
    assert.deepEqual(f.hub.routines.alerts(), []);
  } finally { await f.close(); }
});

test("at the cap the 11th candidate waits with next at the owner's midnight; past it the oldest approvals fire first", async () => {
  const f = await fixture({ env: { HUB_TIME_ZONE: 'America/Los_Angeles', HUB_CLOUD_DAILY: '10' } });
  try {
    for (let i = 0; i < 10; i += 1) f.seedFire(`20261029-probe-old${i}-o${String(i).padStart(3, '0')}`, Date.UTC(2026, 9, 29, 15, i));
    const newer = f.proposeCloud();
    const older = f.proposeCloud();
    f.writeApproval(newer, { at: START - 10 * MIN });
    f.writeApproval(older, { at: START - 30 * MIN });
    const done = await f.hub.routines.sweep();
    assert.deepEqual(done.fired, []);
    assert.deepEqual(done.waiting.map(row => row.reason), ['daily-cap', 'daily-cap']);
    const waiting = await f.detail(older.id);
    assert.equal(waiting.cloud.status, 'waiting');
    assert.equal(waiting.cloud.reason, 'daily-cap');
    assert.equal(waiting.cloud.next, '2026-10-30T07:00:00.000Z');
    f.clock.time = Date.UTC(2026, 9, 30, 7, 5);
    const after = await f.hub.routines.sweep();
    assert.deepEqual(after.fired, [older.id, newer.id]);
    assert.equal(f.routine.calls.length, 2);
  } finally { await f.close(); }
});

test('the oldest approval goes first when only one fits', async () => {
  const f = await fixture({ env: { HUB_CLOUD_DAILY: '1' } });
  try {
    const newer = f.proposeCloud();
    const older = f.proposeCloud();
    f.writeApproval(newer, { at: START - 10 * MIN });
    f.writeApproval(older, { at: START - 30 * MIN });
    const done = await f.hub.routines.sweep();
    assert.deepEqual(done.fired, [older.id]);
    assert.deepEqual(done.waiting, [{ id: newer.id, reason: 'daily-cap' }]);
  } finally { await f.close(); }
});

test('a 429 pauses every cloud fire for 60 minutes, then the waiting request fires', async () => {
  const f = await fixture();
  try {
    f.routine.set({ status: 429 });
    const request = f.proposeCloud();
    const approved = await f.post(`/hub/requests/${request.id}/approve`, {});
    assert.equal(approved.status, 201);
    assert.equal(approved.body.cloud.fired, false);
    assert.equal(approved.body.cloud.reason, 'usage-limit');
    assert.equal(f.routine.calls.length, 1);
    const waiting = await f.detail(request.id);
    assert.equal(waiting.cloud.status, 'waiting');
    assert.equal(waiting.cloud.reason, 'usage-limit');
    assert.equal(waiting.cloud.next, new Date(START + 60 * MIN).toISOString());
    // Other approvals wait too, and nothing is sent while paused.
    f.routine.set({ status: 200 });
    const other = f.proposeCloud();
    f.writeApproval(other);
    f.clock.time = START + 30 * MIN;
    const during = await f.hub.routines.sweep();
    assert.deepEqual(during.fired, []);
    assert.equal(f.routine.calls.length, 1, 'Nothing is sent during the pause.');
    f.clock.time = START + 61 * MIN;
    const after = await f.hub.routines.sweep();
    assert.deepEqual(after.fired.sort(), [request.id, other.id].sort());
    assert.equal(f.routine.calls.length, 3);
  } finally { await f.close(); }
});

test('a run that ended on a usage limit pauses the queue', async () => {
  const f = await fixture();
  try {
    const ended = f.proposeCloud();
    f.writeApproval(ended, { at: START - 90 * MIN });
    f.fake.seed(`sections/inbox/requests/${ended.id}/result.json`, JSON.stringify({ v: 1, outcome: 'failed', reason: 'usage-limit', at: new Date(START - 10 * MIN).toISOString(), by: 'run' }), 'application/json');
    const waiting = f.proposeCloud();
    f.writeApproval(waiting);
    assert.deepEqual((await f.hub.routines.sweep()).fired, []);
    assert.equal(f.routine.calls.length, 0);
    f.clock.time = START + 51 * MIN;
    assert.deepEqual((await f.hub.routines.sweep()).fired, [waiting.id]);
  } finally { await f.close(); }
});

test('a failed fire retries at 5, 15 and 45 minutes, then stops and shows Retry', async () => {
  const f = await fixture();
  try {
    f.routine.set({ status: 500 });
    const request = f.proposeCloud();
    await f.post(`/hub/requests/${request.id}/approve`, {});
    assert.equal(f.routine.calls.length, 1);
    const at = minutes => { f.clock.time = START + minutes * MIN; };
    at(4);
    assert.deepEqual((await f.hub.routines.sweep()).fired, []);
    assert.equal((await f.detail(request.id)).cloud.status, 'waiting');
    assert.equal((await f.detail(request.id)).cloud.reason, 'retry');
    at(5);
    await f.hub.routines.sweep();
    assert.equal(f.routine.calls.length, 2);
    at(19);
    await f.hub.routines.sweep();
    assert.equal(f.routine.calls.length, 2);
    at(20);
    await f.hub.routines.sweep();
    assert.equal(f.routine.calls.length, 3);
    at(64);
    await f.hub.routines.sweep();
    assert.equal(f.routine.calls.length, 3);
    at(65);
    await f.hub.routines.sweep();
    assert.equal(f.routine.calls.length, 4);
    at(600);
    await f.hub.routines.sweep();
    assert.equal(f.routine.calls.length, 4, 'It stops after the third retry.');
    const stopped = await f.detail(request.id);
    assert.equal(stopped.cloud.status, 'fire-failed');
    assert.equal(stopped.fires.length, 4);
    assert.ok(f.fires(request.id).every(fire => fire.ok === false));
    const today = (await f.call('GET', '/hub/today')).body;
    assert.ok(today.alerts.some(alert => alert.request === request.id && /could not be fired/.test(alert.title) && alert.retry === true));
    // Retry by hand still works.
    f.routine.set({ status: 200 });
    assert.equal((await f.post(`/hub/requests/${request.id}/fire`, {})).body.fired, true);
  } finally { await f.close(); }
});

test('a routine with no _REPO is not retried by the queue', async () => {
  const f = await fixture({ env: { CLAUDE_ROUTINE_PROBE_REPO: '' } });
  try {
    const request = f.proposeCloud();
    await f.post(`/hub/requests/${request.id}/approve`, {});
    f.clock.time = START + 100 * MIN;
    await f.hub.routines.sweep();
    assert.equal(f.fires(request.id).length, 1);
    assert.equal((await f.detail(request.id)).cloud.reason, 'routine-repo-unset');
  } finally { await f.close(); }
});

test('a 401 from the Fire URL does not retry', async () => {
  const f = await fixture();
  try {
    f.routine.set({ status: 401 });
    const request = f.proposeCloud();
    await f.post(`/hub/requests/${request.id}/approve`, {});
    f.clock.time = START + 100 * MIN;
    await f.hub.routines.sweep();
    assert.equal(f.routine.calls.length, 1);
    const stopped = await f.detail(request.id);
    assert.equal(stopped.cloud.status, 'fire-failed');
    assert.equal(stopped.cloud.reason, 'http-401');
  } finally { await f.close(); }
});

test('an ok fire with no taken.json: fired at 19 minutes, not-started at 21, never fired again by itself', async () => {
  const f = await fixture();
  try {
    const request = f.proposeCloud({ title: 'Quiet job' });
    await f.post(`/hub/requests/${request.id}/approve`, {});
    f.clock.time = START + 19 * MIN;
    assert.equal((await f.detail(request.id)).cloud.status, 'fired');
    f.clock.time = START + 21 * MIN;
    assert.equal((await f.detail(request.id)).cloud.status, 'not-started');
    await f.hub.routines.sweep();
    f.clock.time = START + 300 * MIN;
    await f.hub.routines.sweep();
    assert.equal(f.routine.calls.length, 1, 'No second fire.');
    const today = (await f.call('GET', '/hub/today')).body;
    assert.ok(today.alerts.some(alert => alert.request === request.id && alert.title === 'Cloud run did not start: Quiet job' && alert.retry === true), JSON.stringify(today.alerts));
    // Once the run takes it, there is nothing to flag.
    f.fake.seed(`sections/inbox/requests/${request.id}/taken.json`, JSON.stringify({ runner: 'cloud', host: 'cloud', nonce: 'n'.repeat(22), at: new Date(f.clock.time).toISOString() }), 'application/json');
    assert.equal((await f.detail(request.id)).cloud, undefined);
  } finally { await f.close(); }
});

test('two sweeps at once fire once', async () => {
  const f = await fixture();
  try {
    const request = f.proposeCloud();
    f.writeApproval(request);
    const [one, two] = await Promise.all([f.hub.routines.sweep(), f.hub.routines.sweep()]);
    assert.equal(one, two);
    assert.equal(f.routine.calls.length, 1);
    assert.equal(f.fires(request.id).length, 1);
  } finally { await f.close(); }
});

test('taken, stopped, declined, finished and expired requests are never fired', async () => {
  const f = await fixture();
  try {
    const put = (request, file, body = {}) => f.fake.seed(`sections/inbox/requests/${request.id}/${file}`, JSON.stringify(body), 'application/json');
    const taken = f.proposeCloud(); f.writeApproval(taken); put(taken, 'taken.json', { runner: 'cloud', at: new Date(START).toISOString() });
    const stopped = f.proposeCloud(); f.writeApproval(stopped); put(stopped, 'stop.json');
    const declined = f.proposeCloud(); f.writeApproval(declined); put(declined, 'declined.json');
    const finished = f.proposeCloud(); f.writeApproval(finished); put(finished, 'result.json', { v: 1, outcome: 'pr', at: new Date(START).toISOString() });
    const expired = f.proposeCloud(); f.writeApproval(expired, { at: START - 80 * 60 * MIN, expiresIn: 72 * 60 * MIN });
    const onPc = f.proposeCloud({ target: 'pc' }); f.writeApproval(onPc, { target: 'pc' });
    const done = await f.hub.routines.sweep();
    assert.deepEqual(done, { fired: [], waiting: [], refused: [] });
    assert.equal(f.routine.calls.length, 0);
    assert.equal(f.hub.routines.alerts().length, 0, 'An expired approval is not a forged one.');
  } finally { await f.close(); }
});

test('the queue stays idle without a routine key or a dry run', async () => {
  const f = await fixture({ env: { CLAUDE_ROUTINE_PROBE_URL: '', CLAUDE_ROUTINE_PROBE_TOKEN: '' } });
  try {
    f.hub.routines.start();
    assert.equal(f.logs.filter(line => line.includes('sweep')).length, 0);
    const request = f.proposeCloud({ repo: 'example/none' });
    f.writeApproval(request);
    assert.equal((await f.detail(request.id)).cloud.status, 'queued', 'The status still reads from the files.');
    assert.equal(f.routine.calls.length, 0);
  } finally { await f.close(); }
});

// --- review fixes ---

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

test('an approve and a sweep at once fire the request once', async () => {
  const f = await fixture({ routine: createFakeRoutine({ delayMs: 400 }) });
  try {
    const request = f.proposeCloud();
    const approving = f.post(`/hub/requests/${request.id}/approve`, {});
    await pause(150);
    const [approved, swept] = await Promise.all([approving, f.hub.routines.sweep()]);
    assert.equal(approved.status, 201);
    assert.equal(approved.body.cloud.fired, true);
    assert.deepEqual(swept.fired, []);
    assert.equal(f.routine.calls.length, 1);
    assert.equal(f.fires(request.id).length, 1);
  } finally { await f.close(); }
});

test('a Retry and a sweep at once fire the request once', async () => {
  const f = await fixture({ routine: createFakeRoutine({ delayMs: 400 }) });
  try {
    const request = f.proposeCloud();
    f.writeApproval(request);
    const retrying = f.post(`/hub/requests/${request.id}/fire`, {});
    await pause(100);
    const [retried, swept] = await Promise.all([retrying, f.hub.routines.sweep()]);
    assert.equal(retried.status, 200);
    assert.deepEqual(swept.fired, []);
    assert.equal(f.routine.calls.length, 1);
    assert.equal(f.fires(request.id).length, 1);
  } finally { await f.close(); }
});

test('a sweep that began before a stop or a take does not fire the request', async () => {
  const f = await fixture({ routine: createFakeRoutine({ delayMs: 300 }) });
  try {
    const first = f.proposeCloud();
    const second = f.proposeCloud();
    f.writeApproval(first, { at: START - 20 * MIN });
    f.writeApproval(second, { at: START - 10 * MIN });
    const sweeping = f.hub.routines.sweep();
    await pause(100); // the first fire is in flight; the second waits for the lock
    f.fake.seed(`sections/inbox/requests/${second.id}/stop.json`, '{}', 'application/json');
    const done = await sweeping;
    assert.deepEqual(done.fired, [first.id]);
    assert.equal(f.routine.calls.length, 1);
  } finally { await f.close(); }
});

test("a run's own result.json cannot pause the queue from the future or for longer than 60 minutes", async () => {
  const f = await fixture();
  try {
    const liar = f.proposeCloud();
    f.writeApproval(liar, { at: START - 90 * MIN });
    f.fake.seed(`sections/inbox/requests/${liar.id}/result.json`, JSON.stringify({ v: 1, outcome: 'failed', reason: 'usage-limit', at: '2099-01-01T00:00:00Z', by: 'run' }), 'application/json');
    const waiting = f.proposeCloud();
    f.writeApproval(waiting);
    assert.deepEqual((await f.hub.routines.sweep()).fired, [waiting.id], 'A date in the future is ignored.');
  } finally { await f.close(); }
  const g = await fixture();
  try {
    const skewed = g.proposeCloud();
    g.writeApproval(skewed, { at: START - 90 * MIN });
    g.fake.seed(`sections/inbox/requests/${skewed.id}/result.json`, JSON.stringify({ v: 1, outcome: 'failed', reason: 'usage-limit', at: new Date(START + 30_000).toISOString(), by: 'run' }), 'application/json');
    const waiting = g.proposeCloud();
    g.writeApproval(waiting);
    assert.deepEqual((await g.hub.routines.sweep()).fired, [], 'A little skew still pauses.');
    g.clock.time = START + 61 * MIN;
    assert.deepEqual((await g.hub.routines.sweep()).fired, [waiting.id], 'The pause never outlasts 60 minutes from now.');
  } finally { await g.close(); }
});

test('Today counts the cloud runs of the owner\'s day against the cap; the status carries the cap and the dry flag', async () => {
  const f = await fixture({ env: { HUB_TIME_ZONE: 'America/Los_Angeles', HUB_CLOUD_DAILY: '2' } });
  try {
    assert.deepEqual((await f.call('GET', '/hub/today')).body.cloud, { used: 0, cap: 2, next: '2026-10-30T07:00:00.000Z' });
    const first = f.proposeCloud();
    await f.post(`/hub/requests/${first.id}/approve`, {});
    f.seedFire('20261029-probe-old-o001', START - 5 * MIN);
    const second = f.proposeCloud();
    await f.post(`/hub/requests/${second.id}/approve`, {});
    const today = (await f.call('GET', '/hub/today')).body;
    assert.equal(today.cloud.used, 2);
    assert.equal(today.cloud.cap, 2);
    const waiting = (await f.detail(second.id)).cloud;
    assert.equal(waiting.status, 'waiting');
    assert.equal(waiting.cap, 2);
    assert.equal(waiting.dryRun, undefined, 'A real routine is not a dry run.');
  } finally { await f.close(); }
  const none = await fixture({ env: { CLAUDE_ROUTINE_PROBE_URL: '', CLAUDE_ROUTINE_PROBE_TOKEN: '' } });
  try {
    assert.equal((await none.call('GET', '/hub/today')).body.cloud, undefined, 'No routine, no count.');
  } finally { await none.close(); }
  const dry = await fixture({ env: { HUB_ROUTINE_DRY_RUN: '1' } });
  try {
    const request = dry.proposeCloud();
    await dry.post(`/hub/requests/${request.id}/approve`, {});
    const detail = await dry.detail(request.id);
    assert.equal(detail.cloud.dryRun, true);
    assert.equal(detail.fires[0].dryRun, true);
    assert.equal((await dry.call('GET', '/hub/today')).body.cloud.used, 1);
  } finally { await dry.close(); }
});

test('a run that refused its approval is a Today alert that names the refusal and offers no Retry', async () => {
  const f = await fixture();
  try {
    const request = f.proposeCloud({ title: 'Forged job' });
    f.writeApproval(request);
    const base = `sections/inbox/requests/${request.id}`;
    f.fake.seed(`${base}/taken.json`, JSON.stringify({ v: 1, runner: 'cloud', host: 'cloud', at: new Date(START).toISOString() }), 'application/json');
    f.fake.seed(`${base}/result.json`, JSON.stringify({ v: 1, outcome: 'failed', reason: 'approval-refused', summary: 'approval refused: bad signature', by: 'cloud', at: new Date(START + MIN).toISOString() }), 'application/json');
    const alert = (await f.call('GET', '/hub/today')).body.alerts.find(row => row.request === request.id);
    assert.equal(alert.title, 'Cloud run refused the approval: Forged job');
    assert.equal(alert.retry, undefined);
    // A run that failed for another reason keeps the plain title.
    const other = f.proposeCloud({ title: 'Broke' });
    f.writeApproval(other);
    f.fake.seed(`sections/inbox/requests/${other.id}/taken.json`, JSON.stringify({ v: 1, runner: 'cloud', host: 'cloud', at: new Date(START).toISOString() }), 'application/json');
    f.fake.seed(`sections/inbox/requests/${other.id}/result.json`, JSON.stringify({ v: 1, outcome: 'failed', reason: 'tests-failed', by: 'cloud', at: new Date(START + MIN).toISOString() }), 'application/json');
    const plain = (await f.call('GET', '/hub/today')).body.alerts.find(row => row.request === other.id);
    assert.equal(plain.title, 'Request failed: Broke');
  } finally { await f.close(); }
});

test('the request detail never carries the routine key: neither on a fire record nor in the cloud status', async () => {
  const f = await fixture();
  try {
    const request = f.proposeCloud();
    await f.post(`/hub/requests/${request.id}/approve`, {});
    assert.ok(f.fires(request.id)[0].routine, 'The stored record names the routine.');
    const answer = await f.call('GET', `/hub/requests/${request.id}`);
    assert.equal(answer.status, 200);
    assert.ok(answer.body.fires.length >= 1 && answer.body.cloud.fires.length >= 1);
    assert.ok(!JSON.stringify(answer.body).includes('PROBE'), JSON.stringify(answer.body));
    assert.ok(!JSON.stringify(answer.body).includes('"routine"'));
    assert.equal(answer.body.fires[0].ok, true);
    assert.match(answer.body.fires[0].session, /^https:\/\/claude\.ai\//);
  } finally { await f.close(); }
});
