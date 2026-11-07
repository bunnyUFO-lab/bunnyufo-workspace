// Editing a Hermes job from the Schedules page (ws-eh2 G): the signed format and its pinned vector, the owner's press and its guard, the refusals, the
// states a change goes through, the way back, the events, and the raw channel targets that only a signed-in reply may carry. Fixtures only: made-up
// jobs, made-up channel ids, a fake bucket, a throwaway key. Nothing here touches a real host, bucket or job.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { createSiteApi } from '../server.mjs';
import { createBucket } from '../s3.mjs';
import { createHub } from '../hub.mjs';
import { validChange, validExport, validResult } from '../hub-agent-config.mjs';
import { failWords, jobChangeState, jobChangeView, JOB_ID_RE, promptProblem, refusedWords, sha256Text, validJobChange, validSchedule } from '../hub-job-change.mjs';
import { canonical, parsePublicKey, publicKeyPem, verify } from '../signing.mjs';
import { schedulesView } from '../hub-schedules.mjs';
import { startFakeS3 } from './fake-s3.mjs';
import { agentConfigJson, JOB_TARGETS, scheduleJobs, seedAgentConfig, seeder } from './hub-fixtures.mjs';
import { listenOnGoodPort } from '../../../server/listen.mjs';

const SITE = 'https://site.example';
const CONTENT = 'https://content.example';
const NOW = new Date();
const SONNET = { provider: 'anthropic', model: 'claude-sonnet-5-5' };
const HAIKU = { provider: 'anthropic', model: 'claude-haiku-5-5' };
const OPTIONS = { main: [SONNET, HAIKU], briefs: [SONNET, HAIKU, { provider: 'deepseek', model: 'deepseek-flash' }] };
const keyPair = generateKeyPairSync('ed25519');
const SIGNING = { HUB_SIGNING_KEY: keyPair.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64') };
const publicKey = parsePublicKey(publicKeyPem(keyPair.privateKey));
const PAGE = { Origin: SITE, 'Content-Type': 'application/json', 'Remote-User': 'owner' };
const changeKey = (id, file) => `sections/inbox/agent-config/changes/${id}/${file}`;
const vector = JSON.parse(readFileSync(new URL('./fixtures/job-change-vector.json', import.meta.url), 'utf8'));

async function fixture({ contentOrigin = '' } = {}) {
  const clock = { time: NOW.getTime() };
  const root = await mkdtemp(path.join(tmpdir(), 'buw-jobedit-'));
  const fake = await startFakeS3();
  const bucket = createBucket({ bucket: fake.bucket, endpoint: fake.endpoint, credentials: fake.credentials, region: 'us-east-1' });
  fake.seed('sections/inbox/workspace.json', '{"name":"Inbox","hidden":true,"entities":[]}\n', 'application/json');
  fake.seed('state.json', '{"version":1,"cards":{}}', 'application/json');
  const hub = createHub({ bucket, enabled: true, now: () => new Date(clock.time), env: SIGNING });
  const server = createSiteApi({ bucket, templateDir: path.join(root, 'none'), stateFile: path.join(root, 'c.json'), sectionsTtl: 0, requireRemoteUser: true, hub, allowedOrigins: [SITE], contentOrigin });
  await listenOnGoodPort(server, '127.0.0.1');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const raw = async (method, route, { headers = {}, body } = {}) => {
    const answered = await fetch(`${origin}/api${route}`, { method, headers, body });
    const text = await answered.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* not JSON */ }
    return { status: answered.status, body: parsed, text };
  };
  const call = (method, route, data, user = 'owner') => raw(method, route, { headers: { ...(method === 'GET' ? {} : { Origin: SITE, 'Content-Type': 'application/json' }), ...(user ? { 'Remote-User': user } : {}) }, body: method === 'GET' ? undefined : JSON.stringify(data ?? {}) });
  return { clock, fake, raw, call, seed: seeder(fake), close: async () => { server.closeAllConnections?.(); server.close(); await fake.close(); } };
}

let seq = 0;
/** A settings export `minutes` before the clock, with the fixture jobs. `mutate(cron)` changes the jobs first; `jobEdits: false` leaves the flag out. */
function putExport(f, { minutes = 1, jobEdits = true, mutate, hooks } = {}) {
  seq += 1;
  const raw = agentConfigJson({ now: new Date(f.clock.time + seq * 1000), exportedMinutesAgo: minutes, schedules: true, jobEdits, modelOptions: OPTIONS });
  mutate?.(raw.profiles.briefs.cron);
  hooks?.(raw);
  seedAgentConfig(f.fake, raw);
  return raw;
}
const jobsOf = async f => (await f.call('GET', '/hub/schedules')).body.sources.find(source => source.id === 'hermes-jobs').items;
const jobOf = async (f, name) => (await jobsOf(f)).find(job => job.name === name);
const press = async (f, body, headers = PAGE) => f.raw('POST', '/hub/team/briefs/job-change', { headers, body: JSON.stringify(body) });
/** The owner's press, `base` taken from the job as the page shows it. */
const edit = async (f, name, to, extra = {}) => press(f, { op: 'edit', job: name, base: (await jobOf(f, name)).rev, to, ...extra });
const approvals = f => [...f.fake.objects.keys()].filter(name => name.includes('/agent-config/changes/') && name.endsWith('/approved.json'));
const eventsOf = f => [...f.fake.objects.keys()].filter(name => /\/events\/[^/]+\/[^/]*-hub-[^/]*\.json$/.test(name)).map(name => f.fake.json(name));
const sentEvents = f => eventsOf(f).filter(event => event.kind === 'job-change-sent');
const hostResult = (f, id, outcome, code) => f.fake.seed(changeKey(id, 'result.json'), JSON.stringify({ v: 1, change: id, outcome, code, rolledBack: false, at: new Date(f.clock.time).toISOString() }), 'application/json', { writer: 'hermes-config' }, new Date(f.clock.time));
const nothingHappened = (f, label = '') => {
  assert.deepEqual(approvals(f), [], `no approved.json ${label}`);
  assert.deepEqual(sentEvents(f), [], `no event ${label}`);
};
const asJob = (f, name, change) => putExport(f, { minutes: 0, mutate: cron => Object.assign(cron.find(job => job.name === name), change) });

// --- the format and the vector ---

test('the pinned vector from the host: the app reads the same bytes, accepts the shape, and a profile change is not a job change', () => {
  const { signature, ...rest } = vector.approved;
  assert.equal(canonical(rest), vector.canonical, 'the app builds the host\'s canonical bytes for this document');
  const pub = parsePublicKey(vector.publicKeyPem);
  assert.equal(verify(vector.approved, pub), true);
  assert.equal(signature.length > 80, true);
  assert.match(vector.approved.to.prompt, /\n\t/);
  assert.match(vector.approved.to.prompt, /[^\x00-\x7f]/, 'a non-ASCII letter and a tab in a multi-line prompt');
  assert.equal(vector.approved.from.provider, null);
  const read = validJobChange(vector.approved);
  assert.deepEqual([read.op, read.job, read.profile, read.fromRev], ['edit', 'brief-example-job', 'briefs', '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef']);
  assert.equal(validChange(vector.approved), null, 'validChange ignores a job change');
  const profile = JSON.parse(readFileSync(new URL('./fixtures/profile-change-vector.json', import.meta.url), 'utf8')).approved;
  assert.equal(validJobChange(profile), null, 'and validJobChange ignores a profile change');
  assert.doesNotMatch(readFileSync(new URL('./fixtures/job-change-vector.json', import.meta.url), 'utf8'), /BEGIN [A-Z ]*PRIVATE KEY/, 'only public material');
  // Extra or missing keys, a job id in the file, another profile or a bad op are not a job change.
  for (const change of [d => { d.extra = 1; }, d => { delete d.nonce; }, d => { d.profile = 'main'; }, d => { d.op = 'run'; }, d => { d.job = 'Bad Name'; }, d => { d.to.deliver = 'x'; }, d => { d.to = { schedule: '0 9 * * 2', provider: 'a' }; },
    d => { d.op = 'pause'; }, d => { d.fromRev = ''; }, d => { d.change = '20261106-profile-main-ab12'; }]) {
    const copy = structuredClone(vector.approved);
    change(copy);
    assert.equal(validJobChange(copy), null, change.toString());
  }
  assert.match('20261106-job-briefs-ab12', JOB_ID_RE);
});

test('the schedule and prompt rules are the host\'s: at most four runs a day, one minute, no secret, no control character', () => {
  for (const good of ['0 8 * * 1', '30 6,18 * * 1-5', '15 10 1 * *', '0 0,6,12,18 * * *', '0 08 * * 1']) assert.equal(validSchedule(good), true, good);
  for (const bad of ['* * * * *', '0 * * * *', '*/5 * * * *', '0 8 * * 1 *', '0 8 * *', '0 1,2,3,4,5 * * *', '0,30 8 * * *', '0 8 * * x', '-x 8 * * *', 'every 2h', '0 24 * * *', '60 8 * * *', '0 8,8 * * *', '', 5, null]) assert.equal(validSchedule(bad), false, String(bad));
  assert.equal(promptProblem('Line one.\n\tLine two. é'), '');
  for (const bad of ['', '   ', 'x'.repeat(8001), 'bell\u0007', 'null\u0000', 'nel\u007f', `key sk-ant-${'a'.repeat(30)}`, 'broken \ud800']) assert.notEqual(promptProblem(bad), '', JSON.stringify(bad).slice(0, 30));
  assert.equal(promptProblem('é'.repeat(4000)), '', '8000 bytes is the limit, not 8000 characters');
  assert.notEqual(promptProblem('é'.repeat(4001)), '');
});

// --- the words and the states ---

const change = (over = {}) => validJobChange({ ...vector.approved, ...over });
const exportWith = (cron, exportedAt) => validExport({ v: 1, exportedAt, profiles: { briefs: { cron } } });
const LATER = new Date('2026-11-06T12:00:00.000Z');
const baseJob = { name: 'brief-example-job', schedule: '0 8 * * 1', enabled: true, prompt: 'p', provider: 'anthropic', model: 'claude-sonnet-5-5' };
test('a change is waiting, then applied, then live; live wins over failed and over late, and each failure has its words', () => {
  const c = change();
  const result = (outcome, code) => ({ change: c.change, outcome, code, rolledBack: false, at: '2026-11-06T10:01:00.000Z' });
  const moved = { ...baseJob, schedule: '0 9 * * 2', promptSha256: sha256Text(c.to.prompt), provider: 'anthropic', model: 'claude-sonnet-5-5' };
  const old = { ...baseJob, promptSha256: sha256Text('p') };
  const state = (res, job, exportedAt = '2026-11-06T10:05:00.000Z', at = new Date('2026-11-06T10:06:00.000Z')) => jobChangeState({ change: c, result: res, exported: job ? exportWith([job], exportedAt) : null, at });
  assert.equal(state(null, old), 'waiting');
  assert.equal(state(null, old, undefined, new Date('2026-11-06T11:11:00.000Z')), 'late');
  assert.equal(state(result('applied', 'ok'), old), 'applied', 'the host says so, the export does not show it yet');
  assert.equal(state(result('applied', 'ok'), moved), 'live');
  assert.equal(state(result('applied', 'ok'), moved, '2026-11-06T10:00:30.000Z'), 'applied', 'an export made before the result does not count');
  assert.equal(state(result('failed', 'job-check'), moved), 'live', 'live wins over a failed code');
  assert.equal(state(result('failed', 'expired'), moved), 'live');
  assert.equal(state(null, moved, undefined, new Date('2026-11-06T11:30:00.000Z')), 'live', 'and over late');
  assert.equal(state(result('failed', 'stale'), old), 'failed');
  assert.equal(state(result('failed', 'job-refused'), old), 'failed');
  // The words: refused names the prompt, job-check and expired never say nothing changed, stale says the job changed.
  assert.equal(refusedWords(change({ to: { prompt: 'x' } })), 'Hermes refused this prompt.');
  assert.equal(refusedWords(change({ to: { schedule: '0 9 * * 2' } })), 'Hermes refused this schedule.');
  assert.equal(refusedWords(change({ to: { schedule: '0 9 * * 2', prompt: 'x' } })), 'Hermes refused this change.');
  assert.equal(failWords(change({ to: { prompt: 'x' } }), 'job-refused'), 'Hermes refused this prompt.');
  assert.equal(failWords(c, 'stale'), 'The job changed on the host since you opened this.');
  for (const code of ['job-check', 'expired']) assert.doesNotMatch(failWords(c, code), /nothing (has )?changed|is as it was/i, code);
  assert.match(failWords(c, 'job-check'), /may have gone through/);
  const view = jobChangeView({ change: c, result: result('failed', 'stale'), exported: exportWith([old], '2026-11-06T10:05:00.000Z'), at: new Date('2026-11-06T10:06:00.000Z') });
  assert.deepEqual([view.state, view.code, view.reason, view.to.promptChanged], ['failed', 'stale', 'The job changed on the host since you opened this.', true]);
  assert.equal(JSON.stringify(view).includes(c.to.prompt), false, 'no prompt text goes to the page');
  assert.equal(validResult({ v: 1, change: 'x', outcome: 'failed', code: 'job-refused', rolledBack: false, at: '2026-11-06T10:01:00.000Z' }).code, 'job-refused', 'the new result codes read');
});

test('removal is live when the job is gone, a pause when it is paused, and an add when the job is listed and on', () => {
  const time = '2026-11-06T10:05:00.000Z';
  const at = new Date('2026-11-06T10:06:00.000Z');
  const live = (c, jobs) => jobChangeState({ change: c, result: { change: c.change, outcome: 'applied', code: 'ok', rolledBack: false, at: '2026-11-06T10:01:00.000Z' }, exported: exportWith(jobs, time), at });
  assert.equal(live(change({ op: 'remove', to: null }), [baseJob]), 'applied');
  assert.equal(live(change({ op: 'remove', to: null }), []), 'live');
  assert.equal(live(change({ op: 'pause', to: null }), [{ ...baseJob, enabled: false, state: 'paused' }]), 'live');
  assert.equal(live(change({ op: 'pause', to: null }), [baseJob]), 'applied');
  assert.equal(live(change({ op: 'resume', to: null }), [baseJob]), 'live');
});

// --- the route ---

test('press: an edit is signed in the host\'s format, with the rev read from the export, and the page gets the job\'s change', async () => {
  const f = await fixture();
  try {
    putExport(f);
    const before = await jobOf(f, 'brief-morning-digest');
    assert.equal(before.editable, true);
    const made = await edit(f, 'brief-morning-digest', { schedule: '0 9 * * 2' });
    assert.equal(made.status, 201, made.text);
    assert.deepEqual([made.body.state, made.body.op, made.body.job, made.body.to, made.body.nextRunAt], ['waiting', 'edit', 'brief-morning-digest', { schedule: '0 9 * * 2' }, before.nextRunAt]);
    assert.match(made.body.change, /^\d{8}-job-briefs-[a-z0-9]{4}$/);
    const doc = f.fake.json(changeKey(made.body.change, 'approved.json'));
    assert.deepEqual(Object.keys(doc).sort(), ['ask', 'at', 'by', 'change', 'expires', 'from', 'fromRev', 'job', 'kind', 'nonce', 'op', 'profile', 'signature', 'to', 'v']);
    assert.equal(verify(doc, publicKey), true);
    assert.deepEqual([doc.v, doc.kind, doc.profile, doc.op, doc.job, doc.by, doc.ask === doc.change], [1, 'job-change', 'briefs', 'edit', 'brief-morning-digest', 'owner', true]);
    assert.equal(doc.fromRev, before.rev, 'fromRev is the export\'s rev');
    assert.deepEqual(doc.from, { schedule: '0 8 * * *', prompt: before.prompt, provider: null, model: null });
    assert.deepEqual(doc.to, { schedule: '0 9 * * 2' }, 'only what changed');
    assert.equal(Date.parse(doc.expires) - Date.parse(doc.at), 70 * 60 * 1000);
    assert.notEqual(validJobChange(doc), null);
    assert.equal(validChange(doc), null);
    assert.equal(sentEvents(f).length, 1);
    assert.deepEqual([sentEvents(f)[0].change, sentEvents(f)[0].job, sentEvents(f)[0].by], [made.body.change, 'brief-morning-digest', 'owner']);
    const asked = [...f.fake.objects.keys()].filter(name => /\/asks\/[^/]+\/ask\.json$/.test(name));
    assert.deepEqual(asked, [], 'no Ask');
    const after = await jobOf(f, 'brief-morning-digest');
    assert.deepEqual([after.change.state, after.change.id, after.change.to], ['waiting', made.body.change, { schedule: '0 9 * * 2' }]);
    // A second press for the same job waits for the first.
    const again = await edit(f, 'brief-morning-digest', { schedule: '0 10 * * 2' });
    assert.equal(again.status, 409);
    assert.match(again.body.error, /still waiting for the Hermes host/);
    assert.equal(approvals(f).length, 1);
    // Another job is not held up by it.
    assert.equal((await edit(f, 'brief-weekly-report', { schedule: '0 10 * * 1' })).status, 201);
  } finally { await f.close(); }
});

test('press, every op: prompt with newlines and a letter, model pin and follow-the-profile, pause, resume, remove and add are signed with the keys the host takes', async () => {
  const f = await fixture();
  try {
    putExport(f);
    const prompt = 'Summarise.\n\tIndented, Zoë.\nLast line.';
    const one = await edit(f, 'brief-morning-digest', { prompt, provider: 'anthropic', model: 'claude-haiku-5-5' });
    assert.equal(one.status, 201, one.text);
    assert.deepEqual(f.fake.json(changeKey(one.body.change, 'approved.json')).to, { prompt, provider: 'anthropic', model: 'claude-haiku-5-5' });
    const spend = await jobOf(f, 'brief-spend-summary');
    const follow = await edit(f, 'brief-spend-summary', { provider: null, model: null });
    assert.equal(follow.status, 201, follow.text);
    assert.deepEqual(f.fake.json(changeKey(follow.body.change, 'approved.json')).to, { provider: null, model: null });
    assert.deepEqual(f.fake.json(changeKey(follow.body.change, 'approved.json')).from, { schedule: spend.schedule, prompt: spend.prompt, provider: 'anthropic', model: 'claude-sonnet-5-5' });
    const resume = await press(f, { op: 'resume', job: 'brief-spend-summary', base: spend.rev });
    assert.equal(resume.status, 409, 'one change of a job at a time');
    const weekly = await jobOf(f, 'brief-weekly-report');
    const pause = await press(f, { op: 'pause', job: 'brief-weekly-report', base: weekly.rev });
    assert.equal(pause.status, 201, pause.text);
    assert.equal(f.fake.json(changeKey(pause.body.change, 'approved.json')).to, null);
    const trends = await jobOf(f, 'brief-trends-watch');
    const remove = await press(f, { op: 'remove', job: 'brief-trends-watch', base: trends.rev });
    assert.equal(remove.status, 201, remove.text);
    assert.deepEqual([f.fake.json(changeKey(remove.body.change, 'approved.json')).op, f.fake.json(changeKey(remove.body.change, 'approved.json')).to], ['remove', null]);
    const added = await press(f, { op: 'add', job: 'brief-new-one', base: '', to: { schedule: '0 7 * * 1', prompt: 'A new job.', postsTo: JOB_TARGETS[0].id, provider: null, model: null } });
    assert.equal(added.status, 201, added.text);
    const doc = f.fake.json(changeKey(added.body.change, 'approved.json'));
    assert.deepEqual([doc.op, doc.fromRev, doc.from, doc.to.postsTo], ['add', '', null, JOB_TARGETS[0].id]);
    assert.equal(verify(doc, publicKey), true);
    assert.notEqual(validJobChange(doc), null);
  } finally { await f.close(); }
});

test('press, the attackers: a card page, a form, another site, a bearer token and an agent\'s card credential sign nothing', async () => {
  const f = await fixture({ contentOrigin: CONTENT });
  try {
    putExport(f);
    const job = await jobOf(f, 'brief-morning-digest');
    const body = { op: 'edit', job: job.name, base: job.rev, to: { schedule: '0 9 * * 2' } };
    const post = (headers, text = JSON.stringify(body)) => f.raw('POST', '/hub/team/briefs/job-change', { headers, body: text });
    // A card an agent wrote, fetching with the owner's cookie: its Origin is the content origin.
    assert.equal((await post({ ...PAGE, Origin: CONTENT })).status, 403);
    for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x']) assert.equal((await post({ ...PAGE, 'Content-Type': type })).status, 415, type);
    assert.equal((await post({ 'Content-Type': 'application/json', 'Remote-User': 'owner' })).status, 403, 'no Origin');
    for (const origin of ['null', 'https://evil.example', 'http://site.example']) assert.equal((await post({ ...PAGE, Origin: origin })).status, 403, origin);
    // The card API's token or any bearer used here (an agent's credential): no Remote-User, so no owner and no signature. Same with a forged header-less call.
    for (const authorization of ['Bearer x', `Bearer ${'t'.repeat(40)}`, 'Basic Zm9vOmJhcg==']) assert.equal((await post({ Origin: SITE, 'Content-Type': 'application/json', Authorization: authorization })).status, 401, authorization);
    assert.equal((await post({ Origin: SITE, 'Content-Type': 'application/json' })).status, 401);
    for (const site of ['cross-site', 'same-site', 'none']) assert.equal((await post({ ...PAGE, 'Sec-Fetch-Site': site })).status, 403, site);
    // The body: unknown keys, no base, an undo with a model-change body, arrays.
    for (const odd of [{ ...body, why: 'x' }, { ...body, profile: 'main' }, { ...body, deliver: 'x' }, { op: 'edit', job: job.name, to: body.to }, { undo: '20261106-job-briefs-ab12', base: job.rev, to: {} }, [body]]) {
      assert.equal((await post(PAGE, JSON.stringify(odd))).status, 400, JSON.stringify(odd).slice(0, 60));
    }
    nothingHappened(f, 'after every refusal');
    assert.equal((await f.raw('GET', '/hub/team/briefs/job-change', { headers: { 'Remote-User': 'owner' } })).status, 404);
    nothingHappened(f, 'after a GET');
    // The page itself works, with Sec-Fetch-Site same-origin and without it.
    assert.equal((await post({ ...PAGE, 'Sec-Fetch-Site': 'same-origin' })).status, 201);
  } finally { await f.close(); }
});

test('press, every refusal writes no approved.json and no event', async () => {
  const f = await fixture();
  try {
    putExport(f);
    const morning = await jobOf(f, 'brief-morning-digest');
    const trends = await jobOf(f, 'brief-trends-watch');
    const spend = await jobOf(f, 'brief-spend-summary');
    const to = value => ({ op: 'edit', job: morning.name, base: morning.rev, to: value });
    const refused = async (body, status, words) => {
      const answer = await press(f, body);
      assert.equal(answer.status, status, `${JSON.stringify(body).slice(0, 80)}: ${answer.text}`);
      if (words) assert.match(answer.body.error, words);
    };
    await refused(to({ schedule: '* * * * *' }), 400, /not allowed/);
    await refused(to({ schedule: '0 * * * *' }), 400, /not allowed/);
    await refused(to({ schedule: '0 8 * * * *' }), 400);
    await refused(to({ schedule: '-x 8 * * *' }), 400);
    await refused(to({ schedule: 'every 2h' }), 400);
    await refused(to({ prompt: `sk-ant-${'a'.repeat(30)}` }), 400, /secret/);
    await refused(to({ prompt: 'bell\u0007' }), 400, /control/);
    await refused(to({ prompt: '' }), 400);
    await refused(to({ prompt: 'x'.repeat(8001) }), 400);
    await refused(to({ deliver: 'discord:1' }), 400);
    await refused(to({ script: 'x.sh' }), 400);
    await refused(to({ name: 'other-name' }), 400);
    await refused(to({ skills: [] }), 400);
    await refused(to({ provider: 'anthropic' }), 400, /together/);
    await refused(to({ provider: 'x', model: 'nope' }), 409, /not a model the Hermes host offers/);
    await refused(to({}), 400);
    await refused(to({ schedule: morning.schedule }), 409, /already/);
    await refused({ ...to({ schedule: '0 9 * * 2' }), base: 'f'.repeat(64) }, 409, /changed on the host since you opened this/);
    await refused({ ...to({ schedule: '0 9 * * 2' }), base: '' }, 409);
    await refused({ ...to({ schedule: '0 9 * * 2' }), job: 'brief-not-there' }, 409, /does not list that job/);
    await refused({ ...to({ schedule: '0 9 * * 2' }), job: 'Bad Name' }, 400);
    await refused({ ...to({ schedule: '0 9 * * 2' }), job: 'x'.repeat(61) }, 400);
    await refused({ ...to({ schedule: '0 9 * * 2' }), op: 'run' }, 400);
    await refused({ op: 'pause', job: morning.name, base: morning.rev, to: { schedule: '0 9 * * 2' } }, 400);
    await refused({ op: 'resume', job: morning.name, base: morning.rev }, 409, /on already/);
    await refused({ op: 'pause', job: spend.name, base: spend.rev }, 409, /paused already/);
    await refused({ op: 'add', job: morning.name, base: '', to: { schedule: '0 7 * * 1', prompt: 'x', postsTo: JOB_TARGETS[0].id, provider: null, model: null } }, 409, /exists already/);
    await refused({ op: 'add', job: 'brief-new-one', base: '', to: { schedule: '0 7 * * 1', prompt: 'x', postsTo: 'discord:999', provider: null, model: null } }, 409, /place to post/);
    await refused({ op: 'add', job: 'brief-new-one', base: '', to: { schedule: '0 7 * * 1', prompt: '-rf x', postsTo: JOB_TARGETS[0].id, provider: null, model: null } }, 400);
    await refused({ op: 'add', job: 'brief-new-one', base: '', to: { schedule: '0 7 * * 1', prompt: 'x', postsTo: JOB_TARGETS[0].id, provider: null } }, 400);
    await refused({ op: 'add', job: 'brief-new-one', base: trends.rev, to: { schedule: '0 7 * * 1', prompt: 'x', postsTo: JOB_TARGETS[0].id, provider: null, model: null } }, 400);
    nothingHappened(f, 'after every refusal');
  } finally { await f.close(); }
});

test('press, the export decides: no signing key, no export, an old export, jobEdits false or missing, a cut or secret-like prompt, a half-pinned model', async () => {
  const f = await fixture();
  try {
    const body = { op: 'pause', job: 'brief-morning-digest', base: 'a'.repeat(64) };
    assert.match((await press(f, body)).body.error, /has not published its settings/);
    putExport(f, { minutes: 9 * 60 });
    assert.match((await press(f, body)).body.error, /export from the Hermes host is old/);
    for (const jobEdits of [false]) {
      putExport(f, { jobEdits });
      const job = await jobOf(f, 'brief-morning-digest');
      assert.equal(job.editable, undefined, 'no edit buttons');
      const answer = await press(f, { ...body, base: job.rev });
      assert.deepEqual([answer.status, answer.body.error], [409, 'This needs an update on the Hermes host first.']);
    }
    const view = (await f.call('GET', '/hub/schedules')).body.sources[0];
    assert.deepEqual(view.edits, { available: false }, 'the page says edits are not available yet');
    // jobEdits: "true" (a string) or 1 is not the flag.
    putExport(f, { jobEdits: false, hooks: raw => { raw.profiles.briefs.jobEdits = 'true'; } });
    assert.equal((await f.call('GET', '/hub/schedules')).body.sources[0].edits.available, false);
    putExport(f, { hooks: raw => { raw.profiles.briefs.jobEdits = 1; } });
    assert.equal((await f.call('GET', '/hub/schedules')).body.sources[0].edits.available, false);
    // A prompt that the export cut, or in which secret-like text was replaced, cannot be edited; the job's other settings still can.
    putExport(f, { mutate: cron => { cron[0].promptCut = true; cron[1].promptRedacted = 2; } });
    for (const name of ['brief-morning-digest', 'brief-weekly-report']) {
      const job = await jobOf(f, name);
      assert.equal(job.promptEditable, false, name);
      const refused = await press(f, { op: 'edit', job: name, base: job.rev, to: { prompt: 'New text.' } });
      assert.equal(refused.status, 409);
      assert.match(refused.body.error, /cannot be edited here/);
      nothingHappened(f);
    }
    const job = await jobOf(f, 'brief-morning-digest');
    assert.equal((await press(f, { op: 'edit', job: job.name, base: job.rev, to: { schedule: '0 9 * * 2' } })).status, 201, 'the schedule of a cut-prompt job is still editable');
    // A job with a model and no provider: its other settings change, its model pin does not.
    putExport(f, { minutes: 0, mutate: cron => { delete cron[1].provider; cron[1].model = 'claude-sonnet-5-5'; } });
    const half = await jobOf(f, 'brief-weekly-report');
    const pin = await press(f, { op: 'edit', job: half.name, base: half.rev, to: { provider: 'anthropic', model: 'claude-haiku-5-5' } });
    assert.equal(pin.status, 409);
    assert.match(pin.body.error, /model without a provider/);
    const ok = await press(f, { op: 'edit', job: half.name, base: half.rev, to: { schedule: '0 10 * * 1' } });
    assert.equal(ok.status, 201, ok.text);
    assert.deepEqual(f.fake.json(changeKey(ok.body.change, 'approved.json')).from, { schedule: half.schedule, prompt: half.prompt, provider: null, model: null }, '`from` carries both ids or neither');
  } finally { await f.close(); }
});

test('a model change and a job change do not mix: the model flow ignores job files, the job flow ignores model files, and neither takes the other\'s body', async () => {
  const f = await fixture();
  try {
    putExport(f);
    const made = await edit(f, 'brief-morning-digest', { schedule: '0 9 * * 2' });
    const details = (await f.call('GET', '/hub/team/teardown/details')).body;
    assert.equal(details.change, undefined, 'a job change is not a model change of a profile');
    // The model route refuses a job body, and a job key stays out of it.
    const model = await f.call('POST', '/hub/team/teardown/profile-change', { op: 'edit', job: 'brief-morning-digest', base: 'x', to: { schedule: '0 9 * * 2' } });
    assert.equal(model.status, 400);
    const rawModel = await f.call('POST', '/hub/team/teardown/profile-change', { primary: SONNET, fallbacks: [], base: { ...SONNET, fallbacks: [] }, cron: [] });
    assert.equal(rawModel.status, 403, 'cron stays view-only on the model route');
    const job = await jobOf(f, 'brief-weekly-report');
    const jobRoute = await press(f, { primary: SONNET, fallbacks: [], base: job.rev });
    assert.equal(jobRoute.status, 400);
    assert.equal(approvals(f).length, 1);
    assert.ok(made.status === 201);
  } finally { await f.close(); }
});

test('after the host: Running, then live with the next run moved; Go back signs the old schedule and a second one is refused until it lands', async () => {
  const f = await fixture();
  try {
    putExport(f);
    const before = await jobOf(f, 'brief-morning-digest');
    const made = await edit(f, 'brief-morning-digest', { schedule: '0 9 * * 2' });
    const id = made.body.change;
    f.clock.time += 60_000;
    hostResult(f, id, 'applied', 'ok');
    f.clock.time += 5_000;
    assert.equal((await jobOf(f, 'brief-morning-digest')).change.state, 'applied', 'the host confirmed; the export has not caught up');
    assert.equal((await edit(f, 'brief-morning-digest', { schedule: '0 10 * * 2' })).status, 409, 'the next press waits for the export');
    f.clock.time += 60_000;
    const next = new Date(f.clock.time + 3 * 24 * 3600 * 1000).toISOString();
    asJob(f, 'brief-morning-digest', { schedule: '0 9 * * 2', nextRunAt: next, rev: 'b'.repeat(64) });
    const live = await jobOf(f, 'brief-morning-digest');
    assert.deepEqual([live.change.state, live.change.canUndo, live.nextRunAt, live.rev], ['live', true, next, 'b'.repeat(64)]);
    assert.notEqual(live.nextRunAt, before.nextRunAt);
    // Go back: the target comes from the signed `from`, only for the field that changed; `base` is the rev now.
    const back = await press(f, { undo: id, base: live.rev });
    assert.equal(back.status, 201, back.text);
    const doc = f.fake.json(changeKey(back.body.change, 'approved.json'));
    assert.deepEqual([doc.op, doc.to, doc.fromRev, doc.from.schedule], ['edit', { schedule: '0 8 * * *' }, 'b'.repeat(64), '0 9 * * 2']);
    assert.equal(sentEvents(f).at(-1).undoOf, id);
    // Not twice, not an old one, not someone else's id.
    assert.equal((await press(f, { undo: id, base: live.rev })).status, 409);
    assert.equal((await press(f, { undo: '20261106-job-briefs-zzzz', base: live.rev })).status, 409);
    assert.equal((await press(f, { undo: 'not an id', base: live.rev })).status, 400);
  } finally { await f.close(); }
});

test('Go back is refused when the job was changed since, for a failed change, a removal and a pause that was undone; a pause goes back as a resume', async () => {
  const f = await fixture();
  try {
    putExport(f);
    const made = await edit(f, 'brief-morning-digest', { schedule: '0 9 * * 2' });
    f.clock.time += 60_000;
    hostResult(f, made.body.change, 'failed', 'job-refused');
    f.clock.time += 60_000;
    putExport(f, { minutes: 0 });
    const job = await jobOf(f, 'brief-morning-digest');
    assert.equal(job.change.state, 'failed');
    assert.equal(job.change.reason, 'Hermes refused this schedule.');
    assert.equal(job.change.canUndo, undefined);
    assert.match((await press(f, { undo: made.body.change, base: job.rev })).body.error, /did not finish/);
    // A pause, confirmed and live: the way back is a resume.
    const weekly = await jobOf(f, 'brief-weekly-report');
    const pause = await press(f, { op: 'pause', job: weekly.name, base: weekly.rev });
    f.clock.time += 60_000;
    hostResult(f, pause.body.change, 'applied', 'ok');
    f.clock.time += 60_000;
    asJob(f, 'brief-weekly-report', { enabled: false, state: 'paused', rev: 'c'.repeat(64), nextRunAt: undefined });
    const paused = await jobOf(f, 'brief-weekly-report');
    assert.equal(paused.change.canUndo, true);
    const back = await press(f, { undo: pause.body.change, base: paused.rev });
    assert.equal(back.status, 201, back.text);
    assert.deepEqual([f.fake.json(changeKey(back.body.change, 'approved.json')).op, f.fake.json(changeKey(back.body.change, 'approved.json')).to], ['resume', null]);
    // A removal has no way back.
    const trends = await jobOf(f, 'brief-trends-watch');
    const remove = await press(f, { op: 'remove', job: trends.name, base: trends.rev });
    f.clock.time += 60_000;
    hostResult(f, remove.body.change, 'applied', 'ok');
    assert.match((await press(f, { undo: remove.body.change, base: trends.rev })).body.error, /no way back/);
  } finally { await f.close(); }
});

test('events: a confirmed change writes one job-change event, a failed one one alert; live wins over a failed code; no prompt text reaches an event', async () => {
  const f = await fixture();
  try {
    putExport(f);
    const secret = 'Unique prompt text for the event test.';
    const one = await edit(f, 'brief-morning-digest', { prompt: secret });
    const two = await edit(f, 'brief-weekly-report', { schedule: '0 10 * * 1' });
    const three = await edit(f, 'brief-trends-watch', { schedule: '0 7 * * 1' });
    f.clock.time += 60_000;
    hostResult(f, one.body.change, 'applied', 'ok');
    hostResult(f, two.body.change, 'failed', 'job-refused');
    hostResult(f, three.body.change, 'failed', 'job-check');
    f.clock.time += 60_000;
    asJob(f, 'brief-trends-watch', { schedule: '0 7 * * 1' });
    for (let round = 0; round < 3; round += 1) {
      await f.call('GET', '/hub/schedules');
      await new Promise(resolve => setTimeout(resolve, 80));
      f.clock.time += 31_000;
    }
    const events = eventsOf(f).filter(event => event.change && event.kind !== 'job-change-sent');
    const by = id => events.filter(event => event.change === id);
    assert.deepEqual(by(one.body.change).map(event => [event.kind, event.title]), [['job-change', 'brief-morning-digest: changed']]);
    assert.deepEqual(by(two.body.change).map(event => [event.kind, event.title]), [['alert', 'The change to brief-weekly-report did not go through: Hermes refused this schedule. The job is as it was.']]);
    assert.deepEqual(by(three.body.change).map(event => [event.kind, event.title]), [['job-change', 'brief-trends-watch: changed']], 'job-check with the export showing it is live, not an alert');
    assert.equal(JSON.stringify(eventsOf(f)).includes(secret), false);
  } finally { await f.close(); }
});

test('the prompt alert: a prompt the Hub signed is not news, one that changed behind its back is', async () => {
  const f = await fixture();
  try {
    putExport(f);
    await f.call('GET', '/hub/schedules');
    await new Promise(resolve => setTimeout(resolve, 100));
    f.clock.time += 31_000;
    const prompt = 'A prompt the owner signed from the page.';
    const made = await edit(f, 'brief-morning-digest', { prompt });
    f.clock.time += 31_000;
    hostResult(f, made.body.change, 'applied', 'ok');
    asJob(f, 'brief-morning-digest', { prompt, promptSha256: sha256Text(prompt) });
    asJob(f, 'brief-trends-watch', { promptSha256: 'e'.repeat(64) });
    await f.call('GET', '/hub/schedules');
    await new Promise(resolve => setTimeout(resolve, 150));
    const alerts = eventsOf(f).filter(event => event.kind === 'alert' && event.job);
    assert.deepEqual(alerts.map(event => event.job), ['brief-trends-watch']);
  } finally { await f.close(); }
});

// --- raw channel targets stay signed-in ---

test('a raw channel target reaches only a signed-in schedules reply: guests, /hub/team, /hub/pc, the details and the events never carry it', async () => {
  const f = await fixture();
  try {
    putExport(f);
    const target = JOB_TARGETS[0].id;
    const guestRoutes = ['/hub/schedules', '/hub/team', '/hub/pc', '/hub/team/skills', '/hub/team/teardown/details', '/hub/today', '/hub/inbox', '/hub/work'];
    for (const route of guestRoutes) {
      const answer = await f.call('GET', route, undefined, null);
      assert.equal(answer.text.includes(target), false, `a guest reply of ${route}`);
      assert.equal(answer.text.includes('100000000000000001'), false, `a guest reply of ${route} (the digits)`);
    }
    assert.equal((await f.call('GET', '/hub/schedules', undefined, null)).status, 401);
    assert.equal((await f.raw('GET', '/hub/schedules', { headers: { Authorization: 'Bearer x' } })).status, 401);
    for (const route of ['/hub/team', '/hub/pc', '/hub/team/skills', '/hub/team/teardown/details', '/hub/today']) {
      assert.equal((await f.call('GET', route)).text.includes('100000000000000001'), false, `a signed-in reply of ${route}`);
    }
    const signed = await f.call('GET', '/hub/schedules');
    assert.deepEqual(signed.body.sources[0].edits.targets, JOB_TARGETS, 'a signed-in schedules reply carries them');
    assert.deepEqual(signed.body.sources[0].edits.models, OPTIONS.briefs);
    // An old export (edits off) and a viewer who is not signed in get no target list at all.
    const view = schedulesView({ exported: validExport(agentConfigJson({ now: NOW, schedules: true, jobEdits: true, modelOptions: OPTIONS })), at: NOW, signedIn: false });
    assert.equal(JSON.stringify(view).includes('100000000000000001'), false);
    assert.equal(view.sources[0].items.every(job => job.editable === undefined), true);
    // After a press the event for it holds no target either.
    const made = await edit(f, 'brief-morning-digest', { schedule: '0 9 * * 2' });
    assert.equal(made.status, 201);
    assert.equal(JSON.stringify(eventsOf(f)).includes('100000000000000001'), false);
  } finally { await f.close(); }
});

test('the export\'s deliverOptions are cleaned: only discord targets with a label, at most ten', () => {
  const raw = agentConfigJson({ now: NOW, schedules: true, jobEdits: true });
  raw.profiles.briefs.deliverOptions = [{ id: 'discord:100000000000000009', label: '#ok' }, { id: 'telegram:1', label: 'x' }, { id: 'discord:1 2', label: 'x' }, { id: 'discord:5', label: '' }, { id: 'discord:7', label: `sk-ant-${'a'.repeat(30)}` }, 'discord:8', null];
  const clean = validExport(raw).profiles.briefs;
  assert.deepEqual(clean.deliverOptions, [{ id: 'discord:100000000000000009', label: '#ok' }]);
  assert.equal(clean.jobEdits, true);
  raw.profiles.briefs.deliverOptions = Array.from({ length: 30 }, (_, index) => ({ id: `discord:${index + 1}`, label: `#c${index}` }));
  assert.equal(validExport(raw).profiles.briefs.deliverOptions.length, 10);
  delete raw.profiles.briefs.jobEdits;
  assert.equal(validExport(raw).profiles.briefs.jobEdits, undefined);
  assert.ok(scheduleJobs(NOW).length === 4);
});
