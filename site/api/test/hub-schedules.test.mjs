// The Schedules page's data (ws-eh2): the export's job fields cleaned on the site, the page's sources, the route, and the alert for a prompt that changed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSiteApi } from '../server.mjs';
import { createBucket } from '../s3.mjs';
import { createHub } from '../hub.mjs';
import { CRON_PROMPT_MAX_BYTES, validExport } from '../hub-agent-config.mjs';
import { COPY_NOTE, jobPromptChanges, NO_TIMERS, NOT_REPORTING, schedulesView, SEEN_FILE, seenText, validSeen } from '../hub-schedules.mjs';
import { startFakeS3 } from './fake-s3.mjs';
import { agentConfigJson, scheduleJobs, seedAgentConfig } from './hub-fixtures.mjs';
import { listenOnGoodPort } from '../../../server/listen.mjs';

const NOW = new Date('2026-11-01T12:00:00Z');
const exportOf = (extra = {}, minutes = 12) => validExport(agentConfigJson({ now: NOW, exportedMinutesAgo: minutes, schedules: true, ...extra }));
const sourceOf = (view, id) => view.sources.find(source => source.id === id);

test('no export: every list says it is not reporting, and the page still carries the words on which copy is real', () => {
  const view = schedulesView({ exported: null, at: NOW });
  assert.deepEqual(view.sources.map(source => [source.id, source.state, source.items.length]), [['hermes-jobs', 'not-reporting', 0], ['hermes-timers', 'not-reporting', 0], ['site-timers', 'not-reporting', 0], ['pc-tasks', 'not-reporting', 0], ['github', 'not-reporting', 0]]);
  assert.equal(view.note, COPY_NOTE);
  assert.match(COPY_NOTE, /only adds a job that is missing, so changing it does not change a job that already exists/);
});

test('a fresh export gives the four jobs with every field, the timers, the zone and the model the profile follows', () => {
  const view = schedulesView({ exported: exportOf(), at: NOW });
  const jobs = sourceOf(view, 'hermes-jobs');
  assert.deepEqual([jobs.state, jobs.as_of, jobs.host, jobs.timezone], ['live', '2026-11-01T11:48:00.000Z', 'Hermes host', 'America/Chicago']);
  assert.deepEqual(jobs.profileModels, { main: 'gpt-6-sol', briefs: 'claude-haiku-5-5' });
  assert.deepEqual(jobs.items.map(job => job.name), ['brief-morning-digest', 'brief-weekly-report', 'brief-trends-watch', 'brief-spend-summary']);
  assert.ok(jobs.items.every(job => job.profile === 'briefs'));
  const trends = jobs.items.find(job => job.name === 'brief-trends-watch');
  assert.deepEqual([trends.lastStatus, trends.failureStreak, trends.lastError, trends.lastDeliveryError], ['error', 3, 'The fixture feed did not answer in time.', 'Channel was archived.']);
  assert.deepEqual(trends.postsTo, { platform: 'discord', label: '#fixture-trends' });
  const weekly = jobs.items.find(job => job.name === 'brief-weekly-report');
  assert.deepEqual([weekly.script, weekly.failuresTo, weekly.model], ['collect-week.sh', null, undefined], 'a null target stays null; an unpinned model is absent');
  const spend = jobs.items.find(job => job.name === 'brief-spend-summary');
  assert.deepEqual([spend.enabled, spend.state, spend.model, spend.provider], [false, 'paused', 'claude-sonnet-5-5', 'anthropic']);
  const timers = sourceOf(view, 'hermes-timers');
  assert.deepEqual([timers.state, timers.items.map(timer => timer.name)], ['live', ['fixture-export', 'fixture-history']]);
  for (const id of ['site-timers', 'pc-tasks', 'github']) {
    assert.deepEqual([sourceOf(view, id).state, sourceOf(view, id).text, sourceOf(view, id).items], ['not-reporting', NOT_REPORTING, []]);
  }
});

test('an export older than 7 hours keeps its rows and is marked old', () => {
  const view = schedulesView({ exported: exportOf({}, 9 * 60), at: NOW });
  assert.deepEqual([sourceOf(view, 'hermes-jobs').state, sourceOf(view, 'hermes-jobs').items.length, sourceOf(view, 'hermes-timers').state], ['old', 4, 'old']);
  assert.equal(sourceOf(view, 'hermes-jobs').as_of, '2026-11-01T03:00:00.000Z');
});

test('an export from before the new fields: jobs show what they have, with no invented keys, and the timers say they are not listed', () => {
  const view = schedulesView({ exported: exportOf({ schedules: false }), at: NOW });
  const jobs = sourceOf(view, 'hermes-jobs');
  assert.deepEqual(Object.keys(jobs.items[0]).sort(), ['enabled', 'name', 'profile', 'prompt', 'schedule']);
  assert.ok(!('timezone' in jobs));
  const timers = sourceOf(view, 'hermes-timers');
  assert.deepEqual([timers.state, timers.text, timers.items], ['not-reporting', NO_TIMERS, []]);
});

test('the site cleans the new job fields again: ids, times, secrets, long text and the prompt cut', () => {
  const raw = agentConfigJson({ now: NOW, schedules: true });
  const long = 'x'.repeat(300);
  raw.profiles.briefs.cron = [{
    name: 'j1', schedule: '0 8 * * *', enabled: true, prompt: 'ab '.repeat(CRON_PROMPT_MAX_BYTES / 2),
    scheduleKind: 'cron', state: 'scheduled bad', model: 'sk-abcdefghijklmnop12345', provider: 'anthropic', script: 'a/b.sh',
    postsTo: { platform: 'discord', label: '#chan', id: '1234567890' }, failuresTo: 'discord:1234567890',
    nextRunAt: 'not a time', lastRunAt: '2026-11-01T10:00:00Z', lastStatus: 'ok',
    lastError: `boom sk-abcdefghijklmnop12345 ${long}`, lastDeliveryError: 7, failureStreak: -1, runsDone: 5.5,
    promptSha256: 'ABC', promptBytes: 9000, promptCut: false, promptRedacted: 1, rev: 'f'.repeat(64), deliver: 'discord:1234567890', secretKey: 'nope',
  }];
  const [job] = validExport(raw).profiles.briefs.cron;
  assert.equal(Buffer.byteLength(job.prompt), CRON_PROMPT_MAX_BYTES);
  assert.equal(job.promptCut, true, 'the site cut it, so it says so');
  assert.deepEqual([job.scheduleKind, job.state, job.model, job.provider, job.script], ['cron', undefined, undefined, 'anthropic', 'a/b.sh']);
  assert.deepEqual(job.postsTo, { platform: 'discord', label: '#chan' }, 'only the platform and label of a target');
  assert.equal(job.failuresTo, null, 'a raw target string is not a label');
  assert.deepEqual([job.nextRunAt, job.lastRunAt, job.lastStatus], [undefined, '2026-11-01T10:00:00.000Z', 'ok']);
  assert.ok(job.lastError.length <= 200 && job.lastError.startsWith('boom [redacted]') && !job.lastError.includes('sk-abc'));
  assert.deepEqual([job.lastDeliveryError, job.failureStreak, job.runsDone, job.promptSha256], [undefined, undefined, undefined, undefined]);
  assert.deepEqual([job.promptBytes, job.promptRedacted, job.rev], [9000, 1, 'f'.repeat(64)]);
  assert.ok(!('deliver' in job) && !('secretKey' in job), 'nothing outside the list passes');
});

test('host timers and the label: cleaned, capped and kept only when sent', () => {
  const raw = agentConfigJson({ now: NOW, schedules: true });
  raw.hostLabel = 'A host';
  raw.hostTimers = [{ name: 't1', description: 'd', schedule: 's', enabled: true, lastResult: 'success', nextRun: '2026-11-01T12:00:30Z', secret: 'x' }, { name: '' }, 'text', ...Array.from({ length: 40 }, (_, n) => ({ name: `t${n + 2}` }))];
  const clean = validExport(raw);
  assert.equal(clean.hostLabel, 'A host');
  assert.equal(clean.hostTimers.length, 30);
  assert.deepEqual(clean.hostTimers[0], { name: 't1', description: 'd', schedule: 's', enabled: true, lastResult: 'success' }, 'no run times: the export leaves them out on purpose');
  const none = validExport(agentConfigJson({ now: NOW }));
  assert.ok(!('hostLabel' in none) && !('hostTimers' in none));
});

// --- the prompt alert ---

const jobsWith = (hashes, extra = {}) => {
  const exported = exportOf(extra);
  exported.profiles.briefs.cron = scheduleJobs(NOW).slice(0, hashes.length).map((job, index) => ({ ...job, promptSha256: hashes[index] }));
  return exported;
};
const H = (char) => char.repeat(64);

test('first run stores the baseline and says nothing; an unchanged export is no news', () => {
  const first = jobPromptChanges({ seen: null, exported: jobsWith([H('a'), H('b')]) });
  assert.deepEqual(first.alerts, []);
  assert.equal(first.changed, true);
  assert.deepEqual(first.jobs, { 'briefs/brief-morning-digest': H('a'), 'briefs/brief-weekly-report': H('b') });
  const again = jobPromptChanges({ seen: first.jobs, exported: jobsWith([H('a'), H('b')]) });
  assert.deepEqual([again.alerts, again.changed], [[], false]);
});

test('a changed hash is one alert with fixed words and no prompt text, and the baseline moves', () => {
  const seen = { 'briefs/brief-morning-digest': H('a'), 'briefs/brief-weekly-report': H('b') };
  const got = jobPromptChanges({ seen, exported: jobsWith([H('a'), H('c')]) });
  assert.deepEqual(got.alerts, [{ job: 'brief-weekly-report', profile: 'briefs', hash: H('c'), kind: 'changed', title: 'The prompt of brief-weekly-report changed on the Hermes host, not from Schedules. Check it.' }]);
  assert.equal(got.jobs['briefs/brief-weekly-report'], H('c'));
  assert.ok(!JSON.stringify(got.alerts).includes('Summarise'), 'no prompt text');
});

test('a new job and a missing job each raise an alert; a hash a signed change names does not', () => {
  const seen = { 'briefs/brief-morning-digest': H('a'), 'briefs/gone-job': H('9') };
  const got = jobPromptChanges({ seen, exported: jobsWith([H('a'), H('b')]) });
  assert.deepEqual(got.alerts.map(alert => [alert.kind, alert.job]), [['new', 'brief-weekly-report'], ['gone', 'gone-job']]);
  assert.match(got.alerts[0].title, /^A new job, brief-weekly-report, appeared on the Hermes host, not from Schedules\. Check it\.$/);
  assert.match(got.alerts[1].title, /^The job gone-job is gone from the Hermes host, not removed from Schedules\. Check it\.$/);
  assert.ok(!('briefs/gone-job' in got.jobs));
  const signed = jobPromptChanges({ seen: { 'briefs/brief-morning-digest': H('a') }, exported: jobsWith([H('e')]), signed: new Set([H('e')]) });
  assert.deepEqual([signed.alerts, signed.jobs['briefs/brief-morning-digest']], [[], H('e')], 'the baseline still moves');
});

test('an older exporter (no hashes) or a profile with no job list is not read as "everything changed or went"', () => {
  const seen = { 'briefs/brief-morning-digest': H('a') };
  assert.deepEqual(jobPromptChanges({ seen, exported: exportOf({ schedules: false }) }), { jobs: seen, alerts: [], changed: false });
  const noList = exportOf();
  delete noList.profiles.briefs.cron;
  assert.deepEqual(jobPromptChanges({ seen, exported: noList }), { jobs: seen, alerts: [], changed: false });
  assert.deepEqual(jobPromptChanges({ seen, exported: null }), { jobs: seen, alerts: [], changed: false });
});

test('a lost baseline does not flood Today: at most eight alerts', () => {
  const exported = exportOf();
  exported.profiles.briefs.cron = Array.from({ length: 12 }, (_, n) => ({ name: `job-${n}`, schedule: '0 8 * * *', enabled: true, prompt: 'p', promptSha256: H(n.toString(16)[0]) }));
  const got = jobPromptChanges({ seen: { 'briefs/other': H('0') }, exported });
  assert.equal(got.alerts.length, 8);
});

test('the baseline file reads only in its own shape', () => {
  assert.deepEqual(validSeen(JSON.parse(seenText({ 'briefs/x': H('a') }, NOW))), { 'briefs/x': H('a') });
  assert.equal(validSeen(null), null);
  assert.equal(validSeen({ v: 2, jobs: {} }), null);
  assert.equal(validSeen({ v: 1, jobs: [] }), null);
  assert.deepEqual(validSeen({ v: 1, jobs: { a: 'short', b: H('b') } }), { b: H('b') });
});

// --- the route and the sweep ---

async function fixture({ requireRemoteUser = true, clock = { at: new Date() } } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'buw-schedules-'));
  const fake = await startFakeS3();
  const bucket = createBucket({ bucket: fake.bucket, endpoint: fake.endpoint, credentials: fake.credentials, region: 'us-east-1' });
  fake.seed('sections/inbox/workspace.json', '{"name":"Inbox","hidden":true,"entities":[]}\n', 'application/json');
  fake.seed('state.json', '{"version":1,"cards":{}}', 'application/json');
  const logs = [];
  const server = createSiteApi({ bucket, templateDir: path.join(root, 'none'), stateFile: path.join(root, 'card-state.json'), sectionsTtl: 0, requireRemoteUser, hub: createHub({ bucket, enabled: true, now: () => clock.at, log: line => logs.push(line) }), allowedOrigins: ['https://site.example'] });
  await listenOnGoodPort(server, '127.0.0.1');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const call = (method, route, headers = {}) => fetch(`${origin}/api${route}`, { method, headers, body: method === 'POST' ? '{}' : undefined });
  return { fake, call, clock, logs, close: async () => { server.close(); await fake.close(); } };
}
const owner = { 'Remote-User': 'owner' };
const eventsOf = fake => [...fake.objects.keys()].filter(name => name.includes('/events/')).map(name => fake.json(name));

test('GET /hub/schedules: signed-in answer, 401 without a user, no write path', async () => {
  const { fake, call, clock, close } = await fixture();
  try {
    const none = await (await call('GET', '/hub/schedules', owner)).json();
    assert.equal(none.sources[0].state, 'not-reporting');
    seedAgentConfig(fake, agentConfigJson({ now: clock.at, exportedMinutesAgo: 5, schedules: true }));
    const got = await call('GET', '/hub/schedules', owner);
    assert.equal(got.status, 200);
    const body = await got.json();
    assert.deepEqual([body.sources[0].state, body.sources[0].items.length, body.sources[1].items.length], ['live', 4, 2]);
    assert.equal((await call('GET', '/hub/schedules')).status, 401);
    assert.equal((await call('POST', '/hub/schedules', { ...owner, Origin: 'https://site.example', 'Content-Type': 'application/json' })).status, 404, 'view only');
    assert.equal((await call('GET', '/hub/schedules/extra', owner)).status, 404);
  } finally { await close(); }
  const open = await fixture({ requireRemoteUser: false });
  try { assert.equal((await open.call('GET', '/hub/schedules')).status, 200); } finally { await open.close(); }
});

test('the sweep: the first look stores the baseline with no event; a changed prompt writes one alert, once, with no prompt text', async () => {
  const clock = { at: new Date('2026-11-01T12:00:00Z') };
  const { fake, call, close } = await fixture({ clock });
  try {
    const stamp = (minutes, jobs) => {
      const doc = agentConfigJson({ now: clock.at, exportedMinutesAgo: 1, schedules: true });
      doc.exportedAt = new Date(clock.at.getTime() - 60_000).toISOString();
      if (jobs) doc.profiles.briefs.cron = jobs;
      return doc;
    };
    seedAgentConfig(fake, stamp());
    await call('GET', '/hub/schedules', owner);
    await new Promise(resolve => setTimeout(resolve, 150));
    const seen = fake.json(`sections/inbox/${SEEN_FILE}`);
    assert.deepEqual(Object.keys(seen.jobs).sort(), ['briefs/brief-morning-digest', 'briefs/brief-spend-summary', 'briefs/brief-trends-watch', 'briefs/brief-weekly-report']);
    assert.deepEqual(eventsOf(fake), [], 'first run: no alert');

    // The same export again, a minute on: nothing.
    clock.at = new Date(clock.at.getTime() + 60_000);
    await call('GET', '/hub/schedules', owner);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.deepEqual(eventsOf(fake), []);

    // An agent edited one prompt on the host.
    clock.at = new Date(clock.at.getTime() + 120_000);
    const changed = scheduleJobs(clock.at).map(job => (job.name === 'brief-weekly-report' ? { ...job, prompt: 'SECRET NEW WORDS', promptSha256: H('f') } : job));
    seedAgentConfig(fake, stamp(1, changed));
    await call('GET', '/hub/schedules', owner);
    await new Promise(resolve => setTimeout(resolve, 150));
    const alerts = eventsOf(fake);
    assert.equal(alerts.length, 1);
    assert.deepEqual([alerts[0].kind, alerts[0].job, alerts[0].title, alerts[0].source], ['alert', 'brief-weekly-report', 'The prompt of brief-weekly-report changed on the Hermes host, not from Schedules. Check it.', 'hub']);
    assert.ok(!JSON.stringify(alerts).includes('SECRET NEW WORDS'));
    assert.equal(fake.json(`sections/inbox/${SEEN_FILE}`).jobs['briefs/brief-weekly-report'], H('f'));

    // Told once: another sweep with the same export writes nothing more.
    clock.at = new Date(clock.at.getTime() + 60_000);
    await call('GET', '/hub/schedules', owner);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(eventsOf(fake).length, 1);
    const today = await (await call('GET', '/hub/today', owner)).json();
    assert.equal(today.alerts.filter(alert => alert.job === 'brief-weekly-report').length, 1, 'it lands on Today\'s alerts, with the job named so the page can link it');
  } finally { await close(); }
});

test('a stale export is never a baseline, and a failing write never fails the request', async () => {
  const { fake, call, close } = await fixture();
  try {
    seedAgentConfig(fake, agentConfigJson({ now: new Date(), exportedMinutesAgo: 9 * 60, schedules: true }));
    assert.equal((await call('GET', '/hub/schedules', owner)).status, 200);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(fake.text(`sections/inbox/${SEEN_FILE}`), null);
  } finally { await close(); }
});

// --- public code ---

test('the files of this feature name nothing of the owner\'s machines', () => {
  const files = ['site/api/hub-schedules.mjs', 'site/api/hub-agent-config.mjs', 'src/hub/team/SchedulesTab.tsx', 'src/hub/team/schedulesModel.ts', 'src/hub/team/schedules.css', 'site/api/test/hub-fixtures.mjs'];
  for (const file of files) {
    const text = readFileSync(new URL(`../../../${file}`, import.meta.url), 'utf8');
    for (const word of ['CT ' + '10', 'jobs' + '.json', 'briefs' + '-jobs', '192' + '.168', 'bunnyufo' + '.net']) assert.ok(!text.includes(word), `${file} names ${word}`);
  }
});
