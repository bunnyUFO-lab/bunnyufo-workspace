// An approved PC job that no runner can take (ws-3o5): the verdict from the PC report, the warning at Approve, the one Needs you item
// after 10 minutes, and the waits that are not alerts. Fake S3 only; nothing here touches the real inbox.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { createSiteApi } from '../server.mjs';
import { createBucket } from '../s3.mjs';
import { createHub } from '../hub.mjs';
import { ADD_REPO_COMMAND, LAUNCH_ON_COMMAND, LOGIN_COMMAND, NOT_STARTED_MS, pcStartVerdict, pcWaitOf } from '../hub-pc-wait.mjs';
import { cleanRunner, validStatus } from '../hub-pc.mjs';
import { startFakeS3 } from './fake-s3.mjs';
import { createFakeRoutine } from './fake-routine.mjs';
import { pcStatusJson, requestJson, seedPcStatus } from './hub-fixtures.mjs';
import { sha256Hex, sign } from '../signing.mjs';
import { listenOnGoodPort } from '../../../server/listen.mjs';

const SITE = 'https://site.example';
const MIN = 60000;
const keyPair = generateKeyPairSync('ed25519');
const ENV = {
  HUB_SIGNING_KEY: keyPair.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
  CLAUDE_ROUTINE_PROBE_URL: 'https://routine.example.test/v1/fire/SECRET',
  CLAUDE_ROUTINE_PROBE_TOKEN: 'tok-SECRET',
  CLAUDE_ROUTINE_PROBE_REPO: 'example/probe',
};
const START = Date.UTC(2026, 10, 6, 12, 0);
const RUNNER = { projects: ['probe'], launch: true, busy: [], full: null };

// --- the verdict, one case per cause ---

const NOW = new Date(START);
const status = (runner, extra = {}) => validStatus({ ...pcStatusJson({ now: NOW, inUse: false, extra: { ...(runner ? { runner } : {}), ...extra } }) });
const verdict = (input, { runner = RUNNER, waited = 0, ...rest } = {}) => pcStartVerdict({
  project: 'probe', status: input === undefined ? status(runner) : input, at: NOW, approvedAt: waited ? new Date(START - waited).toISOString() : null, ...rest,
});

test('verdict: a runner that serves the project and launches has nothing to say', () => {
  assert.deepEqual(verdict(), { known: true, blocked: false });
  assert.equal(pcWaitOf(verdict()), null);
});

test('verdict: not on the runner names the install command and the cloud, and is not stuck until 10 minutes', () => {
  const early = verdict(undefined, { runner: { ...RUNNER, projects: ['other'] }, waited: 9 * MIN });
  assert.deepEqual([early.blocked, early.stuck, early.cause, early.command], [true, false, 'not-on-runner', ADD_REPO_COMMAND]);
  assert.equal(ADD_REPO_COMMAND, 'install.ps1 -AddRepo <path> -Yes');
  assert.match(early.text, /does not have probe/);
  assert.match(early.text, /switch the job to the cloud/);
  assert.equal(verdict(undefined, { runner: { ...RUNNER, projects: ['other'] }, waited: NOT_STARTED_MS }).stuck, true);
});

test('verdict: launching off gives the -Launch on command', () => {
  const v = verdict(undefined, { runner: { ...RUNNER, launch: false }, waited: 11 * MIN });
  assert.deepEqual([v.cause, v.stuck, v.command], ['launch-off', true, LAUNCH_ON_COMMAND]);
  assert.equal(LAUNCH_ON_COMMAND, 'install.ps1 -Runs -Launch on');
});

test('verdict: the project not being served wins over launching being off', () => {
  assert.equal(verdict(undefined, { runner: { ...RUNNER, projects: [], launch: false } }).cause, 'not-on-runner');
});

test('verdict: a stale status or none means the PC is asleep or off, and can be woken', () => {
  const old = validStatus(pcStatusJson({ now: NOW, minutesOld: 30, extra: { runner: RUNNER } }));
  const v = pcStartVerdict({ project: 'probe', status: old, at: NOW, approvedAt: new Date(START - 12 * MIN).toISOString() });
  assert.deepEqual([v.cause, v.stuck, v.canWake], ['pc-silent', true, true]);
  assert.match(v.text, /not reported for about 30 minutes/);
  assert.deepEqual(pcStartVerdict({ project: 'probe', status: null, at: NOW }), { known: false }, 'No reporter ever: unknown, not silent.');
  const lately = pcStartVerdict({ project: 'probe', status: null, silent: true, at: NOW });
  assert.deepEqual([lately.cause, lately.canWake], ['pc-silent', true]);
  assert.match(lately.text, /^This PC hasn't reported lately\./);
});

test('verdict: a full cap or a usage pause that ends soon is a wait with its time, never an alert', () => {
  const ends = [new Date(START + 40 * MIN).toISOString(), new Date(START + 90 * MIN).toISOString()];
  const concurrent = verdict(undefined, { runner: { ...RUNNER, full: 'concurrent' }, endsAt: ends, waited: 30 * MIN });
  assert.equal(concurrent.blocked, false);
  assert.equal(concurrent.wait.kind, 'cap');
  assert.match(concurrent.wait.text, /in about 40 minutes at the latest/);
  const soon = verdict(undefined, { runner: { ...RUNNER, pausedUntil: new Date(START + 2 * 60 * MIN).toISOString(), pausedReason: 'usage-limit' }, waited: 30 * MIN });
  assert.equal(soon.blocked, false);
  assert.equal(soon.wait.kind, 'usage-limit');
  assert.match(soon.wait.text, /in about 2 hours, when the pause ends/);
  const over = verdict(undefined, { runner: { ...RUNNER, pausedUntil: new Date(START - MIN).toISOString(), pausedReason: 'login-expired' } });
  assert.equal(over.blocked, false, 'A pause that has ended blocks nothing.');
});

test('verdict: a cap with no known end, a daily cap or a pause of many hours is an alert', () => {
  const unknown = verdict(undefined, { runner: { ...RUNNER, full: 'concurrent' }, waited: 11 * MIN });
  assert.deepEqual([unknown.cause, unknown.stuck], ['cap', true]);
  assert.match(unknown.text, /when the run now going ends/);
  const far = verdict(undefined, { runner: { ...RUNNER, full: 'concurrent' }, endsAt: [new Date(START + 9 * 60 * MIN).toISOString()], waited: 11 * MIN });
  assert.equal(far.cause, 'cap');
  assert.match(verdict(undefined, { runner: { ...RUNNER, full: 'day' } }).text, /tomorrow/);
  const long = verdict(undefined, { runner: { ...RUNNER, pausedUntil: new Date(START + 6 * 60 * MIN).toISOString(), pausedReason: 'usage-limit' } });
  assert.equal(long.cause, 'cap');
  assert.match(long.text, /in about 6 hours, when the pause ends/);
  assert.equal(long.until, new Date(START + 6 * 60 * MIN).toISOString());
});

test('verdict: a login that expired has its own title, text and the two commands', () => {
  const v = verdict(undefined, { runner: { ...RUNNER, pausedUntil: new Date(START + 7 * 24 * 60 * MIN).toISOString(), pausedReason: 'login-expired' }, waited: 11 * MIN });
  assert.deepEqual([v.cause, v.stuck, v.title, v.command], ['login-expired', true, 'The PC needs you to sign in again', LOGIN_COMMAND]);
  assert.equal(LOGIN_COMMAND, 'claude auth login\nnode $HOME\\.config\\pc-dispatch\\dispatch.mjs resume');
  assert.ok(!/week|7 days|wait/i.test(v.text), 'It never tells the owner to wait a week.');
});

test('verdict: a resumed session at the PC and an install are short waits', () => {
  const until = new Date(START + 60 * MIN).toISOString();
  const open = verdict(undefined, { runner: { ...RUNNER, pausedUntil: until, pausedReason: 'open-run' }, waited: 30 * MIN });
  assert.deepEqual([open.blocked, open.wait.kind], [false, 'open-run']);
  assert.match(open.wait.text, /resumed session/);
  const add = verdict(undefined, { runner: { ...RUNNER, pausedUntil: until, pausedReason: 'add-repo' }, waited: 30 * MIN });
  assert.deepEqual([add.blocked, add.wait.kind], [false, 'add-repo']);
  assert.match(add.wait.text, /installing a project/);
});

test('verdict: a run of the project is a wait even when one run is all the runner allows', () => {
  const v = verdict(undefined, { runner: { ...RUNNER, busy: ['probe'], full: 'concurrent' }, waited: 30 * MIN });
  assert.deepEqual([v.blocked, v.wait.kind], [false, 'busy']);
  assert.equal(verdict(undefined, { runner: { ...RUNNER, busy: ['other'], full: 'concurrent' }, endsAt: [new Date(START + 30 * MIN).toISOString()] }).wait.kind, 'cap', 'Another project is the full cap.');
});

test('verdict: waiting for the owner to be away, or for a run of the project, is a wait and never blocked', () => {
  const home = validStatus(pcStatusJson({ now: NOW, inUse: true, extra: { runner: RUNNER } }));
  const away = pcStartVerdict({ project: 'probe', status: home, at: NOW, approvedAt: new Date(START - 3 * 60 * MIN).toISOString(), opensWindows: true });
  assert.deepEqual([away.blocked, away.wait.kind], [false, 'away']);
  assert.match(away.wait.text, /away from the PC/);
  assert.equal(pcStartVerdict({ project: 'probe', status: home, at: NOW, opensWindows: false }).wait, undefined, 'A job that opens no windows does not wait for the owner.');
  const busy = verdict(undefined, { runner: { ...RUNNER, busy: ['probe'] } });
  assert.deepEqual([busy.blocked, busy.wait.kind], [false, 'busy']);
  assert.deepEqual(pcWaitOf(away), { state: 'wait', kind: 'away', text: away.wait.text });
});

test('verdict: a report with no runner block (an old reporter) makes no claim', () => {
  assert.deepEqual(verdict(status(null)), { known: false });
  assert.equal(pcWaitOf(verdict(status(null))), null);
});

test('status: the runner block keeps ids, booleans and one time, and drops anything else', () => {
  assert.equal(cleanRunner(undefined), undefined);
  assert.equal(cleanRunner('x'), undefined);
  const clean = cleanRunner({ projects: ['probe', 'C:\\work\\runs\\app', '/Users/x/app', 'a'.repeat(50), 'probe', 7], launch: 'yes', busy: ['probe'], full: 'everything', pausedUntil: 'not a time', extra: 'C:\\x' });
  assert.deepEqual(clean, { projects: ['probe'], launch: false, busy: ['probe'], full: null });
  const until = '2026-11-06T13:00:00.000Z';
  assert.equal(cleanRunner({ ...RUNNER, pausedUntil: until, pausedReason: 'open-run' }).pausedReason, 'open-run');
  assert.equal(cleanRunner({ ...RUNNER, pausedUntil: until, pausedReason: 'C:\\secret' }).pausedReason, undefined, 'An enum only.');
  assert.equal(cleanRunner({ ...RUNNER, pausedReason: 'open-run' }).pausedReason, undefined, 'No reason without a time.');
  assert.deepEqual(validStatus(pcStatusJson({ now: NOW, extra: { runner: RUNNER } })).runner, RUNNER);
  assert.equal(validStatus(pcStatusJson({ now: NOW })).runner, undefined);
});

// --- through the API ---

async function fixture({ env = {} } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'buw-pcwait-'));
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
  const post = (url, data) => call('POST', url, data, { 'Remote-User': 'owner' });
  /** The PC reports `minutesOld` ago, with this runner block (none: an old reporter). */
  const report = (runner, { minutesOld = 0, inUse = false } = {}) => seedPcStatus(fake, pcStatusJson({ now: new Date(clock.time), minutesOld, inUse, extra: runner ? { runner } : {} }));
  let n = 0;
  /** A code task for the PC, proposed and approved through the route at the current clock. */
  const pcJob = async (extra = {}) => {
    n += 1;
    const id = `20261106-probe-job${n}-c${String(n).padStart(3, '0')}`;
    const request = { ...requestJson({ id, now: new Date(clock.time) }), preset: 'code-task', target: 'pc', repo: 'example/probe', title: `Job ${n}`, origin: { kind: 'owner', name: 'owner' }, ...extra };
    fake.seed(`sections/inbox/requests/${id}/request.json`, `${JSON.stringify(request, null, 2)}\n`, 'application/json');
    const approved = await post(`/hub/requests/${id}/approve`, { target: 'pc' });
    assert.equal(approved.status, 201, JSON.stringify(approved.body));
    return { request, approved: approved.body };
  };
  /** A job whose signed run block opens windows (a playtest brief): written with the server's key, as the route would sign it. */
  const windowsJob = async () => {
    n += 1;
    const id = `20261106-probe-win${n}-d${String(n).padStart(3, '0')}`;
    const request = { ...requestJson({ id, now: new Date(clock.time) }), preset: 'code-task', target: 'pc', repo: 'example/probe', title: `Windows job ${n}`, origin: { kind: 'owner', name: 'owner' } };
    const text = `${JSON.stringify(request, null, 2)}\n`;
    fake.seed(`sections/inbox/requests/${id}/request.json`, text, 'application/json');
    const signed = sign({
      v: 1, request: id, project: request.project, repo: request.repo, target: 'pc', requestSha256: sha256Hex(Buffer.from(text)), limits: { minutes: 60 },
      expires: new Date(clock.time + 72 * 60 * MIN).toISOString(), nonce: 'w'.repeat(22), at: new Date(clock.time).toISOString(), by: 'owner', run: { preset: 'code-task', opensWindows: true, brief: 'Do it.' },
    }, keyPair.privateKey);
    fake.seed(`sections/inbox/requests/${id}/approved.json`, `${JSON.stringify(signed, null, 2)}\n`, 'application/json');
    return request;
  };
  const stuck = async () => ((await call('GET', '/hub/today')).body.needsYou ?? []).filter(item => item.kind === 'pc-stuck');
  const alerts = async () => (await call('GET', '/hub/today')).body.alerts ?? [];
  const detail = async id => (await call('GET', `/hub/requests/${id}`)).body;
  return { fake, hub, call, post, clock, routine, report, pcJob, windowsJob, stuck, alerts, detail, close: async () => { await hub.close(); server.close(); await fake.close(); } };
}

test('Approve warns when the project is not on the runner, and says what to run', async () => {
  const f = await fixture();
  try {
    f.report({ ...RUNNER, projects: ['other'] });
    const { approved } = await f.pcJob();
    assert.equal(approved.state, 'approved');
    assert.match(approved.waiting, /does not have probe/);
    assert.equal(approved.pcWait.cause, 'not-on-runner');
    assert.equal(approved.pcWait.command, ADD_REPO_COMMAND);
    const ask = await f.call('GET', '/hub/pc/start?project=probe');
    assert.equal(ask.body.pcWait.state, 'blocked');
    assert.equal((await f.call('GET', '/hub/pc/start?project=Bad%20Name')).status, 400);
    f.report(RUNNER);
    assert.equal((await f.call('GET', '/hub/pc/start?project=probe')).body.pcWait, null, 'A runner that serves it promises the start.');
    const ok = await f.pcJob();
    assert.equal(ok.approved.waiting, undefined);
    assert.equal(ok.approved.pcWait, undefined);
  } finally { await f.close(); }
});

test('one Needs you item per stuck job after 10 minutes, with the cause, a plain title and the command', async () => {
  const f = await fixture();
  try {
    f.report({ ...RUNNER, projects: ['other'] });
    const first = await f.pcJob();
    const second = await f.pcJob();
    f.clock.time = START + 9 * MIN;
    f.report({ ...RUNNER, projects: ['other'] });
    assert.deepEqual(await f.stuck(), [], 'Nothing before 10 minutes.');
    f.clock.time = START + 11 * MIN;
    f.report({ ...RUNNER, projects: ['other'] });
    const items = await f.stuck();
    assert.deepEqual(items.map(item => item.id).sort(), [first.request.id, second.request.id].sort(), 'One item per job.');
    const [item] = items;
    assert.equal(item.title, 'The PC does not run probe yet');
    assert.equal(item.cause, 'not-on-runner');
    assert.equal(item.command, ADD_REPO_COMMAND);
    assert.match(item.summary, /switch the job to the cloud/);
    assert.equal(item.summary.split(/(?<=\.)\s/).length, 3, '3 sentences.');
    assert.ok(!/\u2014/.test(JSON.stringify(item)), 'No em dash.');
    for (let again = 0; again < 3; again += 1) assert.equal((await f.stuck()).length, 2, 'Reading again files nothing new.');
    assert.equal((await f.call('GET', '/hub/today')).body.counts.needsYou, 2);
    assert.deepEqual((await f.alerts()).filter(alert => /not start|Not started/i.test(alert.title)), [], 'It is a Needs you item, not an alert.');
    const inbox = (await f.call('GET', '/hub/inbox?filter=unstick')).body;
    const rows = (inbox.items ?? []).filter(row => row.kind === 'pc-stuck');
    assert.equal(rows.length, 2);
    assert.equal(rows[0].describe.what, 'An approved job that has not started');
  } finally { await f.close(); }
});

test('the item clears itself when the job is taken, stopped or the runner gets the project', async () => {
  const f = await fixture();
  try {
    f.report({ ...RUNNER, projects: [] });
    const a = await f.pcJob();
    const b = await f.pcJob();
    const c = await f.pcJob();
    f.clock.time = START + 12 * MIN;
    f.report({ ...RUNNER, projects: [] });
    assert.equal((await f.stuck()).length, 3);
    f.fake.seed(`sections/inbox/requests/${a.request.id}/taken.json`, JSON.stringify({ v: 1, runner: 'pc', host: 'pc', at: new Date(f.clock.time).toISOString() }), 'application/json');
    assert.deepEqual((await f.stuck()).map(item => item.id).sort(), [b.request.id, c.request.id].sort(), 'Taken: gone.');
    const stop = await f.post(`/hub/requests/${b.request.id}/stop`, { reason: 'Cancelled' });
    assert.equal(stop.status, 201, JSON.stringify(stop.body));
    assert.deepEqual((await f.stuck()).map(item => item.id), [c.request.id], 'Cancelled: gone.');
    f.report(RUNNER);
    assert.deepEqual(await f.stuck(), [], 'The runner has the project: gone.');
  } finally { await f.close(); }
});

test('each cause files the right item: launching off, the PC silent, a full cap', async () => {
  // A fresh bucket for each: the newest status file wins, so one story per fixture.
  const story = async (runner, minutesOld = 0, env = {}) => {
    const f = await fixture({ env });
    try {
      f.report(runner, { minutesOld });
      const made = await f.pcJob();
      f.clock.time = START + 15 * MIN;
      f.report(runner, { minutesOld: minutesOld ? minutesOld + 15 : 0 });
      return (await f.stuck()).filter(item => item.id === made.request.id);
    } finally { await f.close(); }
  };
  const off = await story({ ...RUNNER, launch: false });
  assert.deepEqual([off.length, off[0].cause, off[0].command, off[0].title], [1, 'launch-off', LAUNCH_ON_COMMAND, 'Starting jobs is off on the PC']);

  const silent = await story(RUNNER, 30, { HUB_WAKE_URL: 'http://127.0.0.1:9/never-called' });
  assert.deepEqual([silent.length, silent[0].cause, silent[0].canWake], [1, 'pc-silent', true]);
  assert.equal(silent[0].command, undefined);
  const noWake = await story(RUNNER, 30);
  assert.deepEqual([noWake.length, noWake[0].cause, noWake[0].canWake], [1, 'pc-silent', undefined], 'Retry only when a wake is set up.');

  const login = await story({ ...RUNNER, pausedUntil: new Date(START + 7 * 24 * 60 * MIN).toISOString(), pausedReason: 'login-expired' });
  assert.deepEqual([login.length, login[0].cause, login[0].command], [1, 'login-expired', LOGIN_COMMAND]);
  const queue = await story({ ...RUNNER, pausedUntil: new Date(START + 2 * 60 * MIN).toISOString(), pausedReason: 'usage-limit' });
  assert.deepEqual(queue, [], 'A 2-hour usage pause is a queue.');
  for (const pausedReason of ['open-run', 'add-repo']) {
    assert.deepEqual(await story({ ...RUNNER, pausedUntil: new Date(START + 60 * MIN).toISOString(), pausedReason }), [], pausedReason);
  }

  const cap = await story({ ...RUNNER, full: 'day' });
  assert.deepEqual([cap.length, cap[0].cause], [1, 'cap']);
  assert.match(cap[0].summary, /tomorrow/);
  assert.equal(cap[0].canWake, undefined);
});

test('a full concurrent cap says when the run now going must end', async () => {
  const f = await fixture();
  try {
    f.report({ ...RUNNER, full: 'concurrent', busy: ['other'] });
    const running = await f.pcJob({ project: 'other' });
    f.fake.seed(`sections/inbox/requests/${running.request.id}/taken.json`, JSON.stringify({ v: 1, runner: 'pc', host: 'pc', at: new Date(START).toISOString() }), 'application/json');
    f.fake.seed(`sections/inbox/requests/${running.request.id}/run-20261106T120100000Z-ab12.json`, JSON.stringify({ v: 1, state: 'running', at: new Date(START + MIN).toISOString() }), 'application/json');
    f.clock.time = START + 30 * MIN;
    f.report({ ...RUNNER, full: 'concurrent', busy: ['other'] });
    const waiting = await f.pcJob();
    f.clock.time = START + 50 * MIN;
    f.fake.seed(`sections/inbox/requests/${running.request.id}/run-20261106T124900000Z-ab12.json`, JSON.stringify({ v: 1, state: 'running', at: new Date(START + 49 * MIN).toISOString() }), 'application/json');
    f.report({ ...RUNNER, full: 'concurrent', busy: ['other'] });
    const view = await f.detail(waiting.request.id);
    assert.deepEqual([view.pcWait.state, view.pcWait.kind], ['wait', 'cap'], 'A normal queue is a line on the job page.');
    assert.match(view.pcWait.text, /in about \d+ (minutes|hours?) at the latest, when the run now going ends/);
    assert.deepEqual(await f.stuck(), [], 'No item.');
  } finally { await f.close(); }
});

test('no alert, no item while a job waits for the owner to be away: the job page shows it as a wait', async () => {
  const f = await fixture();
  try {
    f.report(RUNNER, { inUse: true });
    const job = await f.windowsJob();
    for (const minutes of [11, 45, 180]) {
      f.clock.time = START + minutes * MIN;
      f.report(RUNNER, { inUse: true });
      assert.deepEqual(await f.stuck(), [], `${minutes} minutes in`);
    }
    assert.equal((await f.call('GET', '/hub/today')).body.counts.needsYou, 0);
    const page = await f.detail(job.id);
    assert.equal(page.state, 'approved');
    assert.equal(page.pcWait.state, 'wait');
    assert.equal(page.pcWait.kind, 'away');
    assert.match(page.pcWait.text, /away from the PC/);
    f.report(RUNNER, { inUse: false });
    assert.equal((await f.detail(job.id)).pcWait, undefined, 'Once the owner is away there is nothing to wait for but the next check.');
  } finally { await f.close(); }
});

test('no alert while the project has a run going, and no claim from an old reporter', async () => {
  const f = await fixture();
  try {
    f.report({ ...RUNNER, busy: ['probe'] });
    const job = await f.pcJob();
    f.clock.time = START + 30 * MIN;
    f.report({ ...RUNNER, busy: ['probe'] });
    assert.deepEqual(await f.stuck(), []);
    assert.equal((await f.detail(job.request.id)).pcWait.kind, 'busy');
    f.report(null);
    assert.deepEqual(await f.stuck(), [], 'A fresh report with no runner block says nothing.');
    assert.equal((await f.detail(job.request.id)).pcWait, undefined);
  } finally { await f.close(); }
});

test('Cancel stops the job, and the cloud is open to a stuck job but not to one that is only waiting', async () => {
  const f = await fixture();
  try {
    f.report({ ...RUNNER, projects: [] });
    const a = await f.pcJob();
    f.clock.time = START + 5 * MIN;
    f.report({ ...RUNNER, projects: [] });
    const early = await f.post(`/hub/requests/${a.request.id}/move-to-cloud`);
    assert.equal(early.status, 409, 'Not stuck yet, and under 6 hours.');
    assert.match(early.body.error, /6 hours/);
    f.clock.time = START + 11 * MIN;
    f.report({ ...RUNNER, projects: [] });
    const [item] = await f.stuck();
    assert.equal(item.cloudOk, true);
    const moved = await f.post(`/hub/requests/${a.request.id}/move-to-cloud`);
    assert.equal(moved.status, 201, JSON.stringify(moved.body));
    assert.equal((await f.detail(a.request.id)).state, 'stopped');
    assert.deepEqual(await f.stuck(), []);
    assert.equal(f.fake.json(`sections/inbox/requests/${moved.body.id}/approved.json`).target, 'cloud');

    // A job that waits for a healthy runner is not stuck and cannot jump the 6 hours.
    f.report(RUNNER);
    const b = await f.pcJob();
    f.clock.time = START + 40 * MIN;
    f.report(RUNNER);
    assert.equal((await f.post(`/hub/requests/${b.request.id}/move-to-cloud`)).status, 409);
    // A job with no cloud routine for its repo has no cloud button, and Cancel still works.
    f.report({ ...RUNNER, projects: [] });
    const c = await f.pcJob({ repo: 'example/elsewhere' });
    f.clock.time += 11 * MIN;
    f.report({ ...RUNNER, projects: [] });
    const noCloud = (await f.stuck()).find(row => row.id === c.request.id);
    assert.equal(noCloud.cloudOk, undefined);
    const cancelled = await f.post(`/hub/requests/${c.request.id}/stop`, { reason: 'Cancelled: the PC could not start it' });
    assert.equal(cancelled.status, 201);
    assert.deepEqual((await f.stuck()).filter(row => row.id === c.request.id), []);
  } finally { await f.close(); }
});

test('the PC status lookback: 3 days old is silent, 8 days old and never are told apart', async () => {
  const days = n => 24 * 60 * n;
  // Reported 3 days ago: the 7-day lookback still finds it.
  const three = await fixture();
  try {
    three.report(RUNNER, { minutesOld: days(3) });
    const job = await three.pcJob();
    assert.equal(job.approved.pcWait.cause, 'pc-silent');
    assert.match(job.approved.pcWait.text, /not reported for about 3 days/);
    assert.match(job.approved.waiting, /asleep or off/);
  } finally { await three.close(); }
  // Reported 8 days ago: nothing recent, but there was a reporter.
  const eight = await fixture();
  try {
    eight.report(RUNNER, { minutesOld: days(8) });
    const job = await eight.pcJob();
    assert.equal(job.approved.pcWait.cause, 'pc-silent');
    assert.match(job.approved.pcWait.text, /^This PC hasn't reported lately\./);
    eight.clock.time = START + 11 * MIN;
    const [item] = await eight.stuck();
    assert.equal(item.cause, 'pc-silent');
    assert.equal((await eight.call('GET', '/hub/pc/start?project=probe')).body.pcWait.state, 'blocked');
  } finally { await eight.close(); }
  // No reporter has ever posted: the Hub says nothing.
  const never = await fixture();
  try {
    const job = await never.pcJob();
    assert.equal(job.approved.pcWait, undefined);
    assert.equal(job.approved.waiting, undefined);
    never.clock.time = START + 60 * MIN;
    assert.deepEqual(await never.stuck(), []);
  } finally { await never.close(); }
});
