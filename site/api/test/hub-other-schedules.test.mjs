// The Schedules page's other three lists (ws-eh2 E): the PC's tasks and GitHub's schedules, the site host's timers, and what each says while its data
// is missing. Made-up names only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSiteApi } from '../server.mjs';
import { createBucket } from '../s3.mjs';
import { createHub } from '../hub.mjs';
import { validExport } from '../hub-agent-config.mjs';
import { validStatus } from '../hub-pc.mjs';
import { cleanHostSchedules, cleanPcSchedules, HOST_SCHEDULES_FILE, MAX_TASKS, zonedIso } from '../hub-other-schedules.mjs';
import { GITHUB_NOTE, NOT_REPORTING, schedulesView } from '../hub-schedules.mjs';
import { startFakeS3 } from './fake-s3.mjs';
import { agentConfigJson, hostSchedulesJson, pcSchedules, pcStatusJson, seedAgentConfig, seedPcStatus } from './hub-fixtures.mjs';
import { listenOnGoodPort } from '../../../server/listen.mjs';

const NOW = new Date('2026-11-01T12:00:00Z');
const sourceOf = (view, id) => view.sources.find(source => source.id === id);
const statusWith = (schedules, extra = {}) => validStatus(pcStatusJson({ now: NOW, minutesOld: 1, extra: { schedules, ...extra } }));
const hostText = (extra = {}) => JSON.stringify({ ...hostSchedulesJson({ now: NOW }), ...extra });

test('a PC status with the field: tasks and GitHub schedules are cleaned and listed, with the repo\'s own marked', () => {
  const status = statusWith(pcSchedules({ now: NOW }));
  const view = schedulesView({ exported: null, status, hostFile: null, at: NOW });
  const tasks = sourceOf(view, 'pc-tasks');
  assert.deepEqual([tasks.state, tasks.total, tasks.items.map(task => task.name)], ['live', 7, ['Sample Report', 'Sample Nightly', 'Example Updater', 'Example Helper']]);
  assert.deepEqual(tasks.items.filter(task => task.ours).map(task => task.name), ['Sample Report', 'Sample Nightly']);
  assert.deepEqual([tasks.items[2].lastResult, tasks.items[3].state, tasks.items[3].nextRun], ['error 0x80070002', 'disabled', undefined]);
  const github = sourceOf(view, 'github');
  assert.deepEqual([github.state, github.note, github.items.map(item => [item.workflow, item.cron, item.state])], ['live', GITHUB_NOTE, [['ci.yml', '17 3 * * *', 'active'], ['nightly.yml', '23 */6 * * *', 'disabled']]]);
});

test('a PC list past its refresh is marked old and keeps its rows; the PC being off is an old list, not an error', () => {
  const view = schedulesView({ exported: null, status: statusWith(pcSchedules({ now: NOW, minutesOld: 4 * 60 })), hostFile: null, at: NOW });
  assert.deepEqual([sourceOf(view, 'pc-tasks').state, sourceOf(view, 'pc-tasks').items.length, sourceOf(view, 'github').state], ['old', 4, 'old']);
  assert.equal(sourceOf(view, 'pc-tasks').as_of, '2026-11-01T08:00:00.000Z');
});

test('no status, a status with no field, or one half missing: each list says why it is empty', () => {
  const none = schedulesView({ exported: null, status: null, hostFile: null, at: NOW });
  for (const id of ['site-timers', 'pc-tasks', 'github']) assert.deepEqual([sourceOf(none, id).state, sourceOf(none, id).text, sourceOf(none, id).items], ['not-reporting', NOT_REPORTING, []]);
  const bare = schedulesView({ exported: null, status: statusWith(undefined), hostFile: null, at: NOW });
  assert.deepEqual([sourceOf(bare, 'pc-tasks').state, sourceOf(bare, 'pc-tasks').text, sourceOf(bare, 'github').text], ['not-reporting', NOT_REPORTING, NOT_REPORTING]);
  assert.ok(!('schedules' in statusWith(undefined)), 'no key is no key');
  const half = pcSchedules({ now: NOW });
  delete half.githubAt; delete half.github;
  const only = schedulesView({ exported: null, status: statusWith(half), hostFile: null, at: NOW });
  assert.deepEqual([sourceOf(only, 'pc-tasks').state, sourceOf(only, 'github').state, sourceOf(only, 'github').text], ['live', 'not-reporting', NOT_REPORTING]);
  const empty = schedulesView({ exported: null, status: statusWith({ tasksAt: NOW.toISOString(), tasks: [], tasksTotal: 0 }), hostFile: null, at: NOW });
  assert.deepEqual([sourceOf(empty, 'pc-tasks').state, sourceOf(empty, 'pc-tasks').text], ['live', 'The PC lists no task.']);
});

test('the PC\'s field is cleaned again: states, text, times without a zone, the cap, and nothing outside the list', () => {
  const rows = Array.from({ length: MAX_TASKS + 5 }, (_, index) => ({ name: `task ${index}`, folder: '\\', state: 'ready', schedule: 'daily', lastResult: 'ok' }));
  const got = cleanPcSchedules({
    tasksAt: NOW.toISOString(), tasksTotal: 300, githubAt: 'not a time',
    tasks: [
      { name: 'Odd\u0007Task', folder: 'x'.repeat(500), state: 'melting', schedule: 'a\nb', nextRun: '2026-11-02T08:00:00', lastRun: '2026-11-01T08:00:00+02:00', lastResult: 'ok', ours: 'yes', action: 'C:\\secret\\run.exe', arguments: '-x' },
      { name: '', state: 'ready' }, 'junk', null,
      ...rows,
    ],
    github: [{ repo: 'a/b', workflow: 'ci.yml', cron: '1 2 * * *', state: 'active' }],
  });
  assert.equal(got.github, undefined, 'a half whose time does not read is left out');
  assert.equal(got.tasks.rows.length, MAX_TASKS);
  assert.equal(got.tasks.total, 300);
  assert.deepEqual(got.tasks.rows[0], { name: 'Odd Task', folder: 'x'.repeat(120), state: 'unknown', schedule: 'a b', lastRun: '2026-11-01T06:00:00.000Z', lastResult: 'ok' });
  assert.ok(!JSON.stringify(got).includes('secret'));
  assert.equal(cleanPcSchedules(null), null);
  assert.equal(cleanPcSchedules([]), null);
  assert.equal(cleanPcSchedules({ tasksAt: NOW.toISOString() }), null, 'a time with no list is nothing');
  assert.equal(cleanPcSchedules({ tasksAt: NOW.toISOString(), tasks: [], tasksTotal: -3 }).tasks.total, 0);
  assert.equal(zonedIso('2026-11-02T08:00:00'), '');
  assert.equal(zonedIso('2026-11-02T08:00:00Z'), '2026-11-02T08:00:00.000Z');
  assert.equal(zonedIso('2026-11-02T08:00:00-0600'), '2026-11-02T14:00:00.000Z');
});

test('the site host\'s file: timers listed, old past an hour, and a bad or missing file is the empty state', () => {
  const file = cleanHostSchedules(hostText());
  assert.deepEqual([file.hostLabel, file.timers.map(timer => timer.name)], ['Site host', ['fixture-publish.timer', 'fixture-backup.timer', 'fixture-idle.timer']]);
  assert.deepEqual([file.timers[1].lastResult, file.timers[2].enabled, file.timers[2].nextRun], ['exit-code', false, undefined]);
  const live = sourceOf(schedulesView({ exported: null, status: null, hostFile: file, at: NOW }), 'site-timers');
  assert.deepEqual([live.state, live.host, live.items.length], ['live', 'Site host', 3]);
  const old = sourceOf(schedulesView({ exported: null, status: null, hostFile: cleanHostSchedules(hostText({ exportedAt: '2026-11-01T09:00:00Z' })), at: NOW }), 'site-timers');
  assert.deepEqual([old.state, old.items.length], ['old', 3]);
  assert.equal(sourceOf(schedulesView({ exported: null, status: null, hostFile: cleanHostSchedules(hostText({ timers: [] })), at: NOW }), 'site-timers').text, 'The host lists no timer.');
  for (const bad of [null, undefined, '', 'not json', '[]', hostText({ v: 2 }), hostText({ timers: 'no' }), hostText({ exportedAt: 'never' }), ' '.repeat(70_000)]) assert.equal(cleanHostSchedules(bad), null, String(bad).slice(0, 20));
  assert.equal(sourceOf(schedulesView({ exported: null, status: null, hostFile: null, at: NOW }), 'site-timers').text, NOT_REPORTING);
  assert.equal(cleanHostSchedules(hostText({ hostLabel: '' })).hostLabel, 'Site host');
});

test('a run time with no zone is not read in the server\'s zone: the Hermes export drops it too', () => {
  const raw = agentConfigJson({ now: NOW, schedules: true });
  raw.profiles.briefs.cron = [{ name: 'j', schedule: '0 8 * * *', enabled: true, prompt: 'p', nextRunAt: '2026-11-02T08:00:00', lastRunAt: '2026-11-01T08:00:00-06:00' }];
  const [job] = validExport(raw).profiles.briefs.cron;
  assert.deepEqual([job.nextRunAt, job.lastRunAt], [undefined, '2026-11-01T14:00:00.000Z']);
});

// --- the route, with the host file beside the env file ---

async function fixture({ envFile = true, file } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'buw-other-schedules-'));
  if (file !== undefined) await writeFile(path.join(root, HOST_SCHEDULES_FILE), file);
  const fake = await startFakeS3();
  const bucket = createBucket({ bucket: fake.bucket, endpoint: fake.endpoint, credentials: fake.credentials, region: 'us-east-1' });
  fake.seed('sections/inbox/workspace.json', '{"name":"Inbox","hidden":true,"entities":[]}\n', 'application/json');
  fake.seed('state.json', '{"version":1,"cards":{}}', 'application/json');
  const env = envFile ? { BUW_ENV_FILE: path.join(root, 'api.env') } : {};
  const server = createSiteApi({ bucket, templateDir: path.join(root, 'none'), stateFile: path.join(root, 'card-state.json'), sectionsTtl: 0, requireRemoteUser: true, hub: createHub({ bucket, enabled: true, env, now: () => NOW, log: () => {} }), allowedOrigins: ['https://site.example'] });
  await listenOnGoodPort(server, '127.0.0.1');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const get = async () => (await fetch(`${origin}/api/hub/schedules`, { headers: { 'Remote-User': 'owner' } })).json();
  return { fake, get, close: async () => { server.close(); await fake.close(); } };
}

test('GET /hub/schedules reads the PC status and the file beside the env file, and works when either is missing', async () => {
  const full = await fixture({ file: hostText() });
  try {
    seedPcStatus(full.fake, pcStatusJson({ now: NOW, minutesOld: 1, extra: { schedules: pcSchedules({ now: NOW }) } }));
    seedAgentConfig(full.fake, agentConfigJson({ now: NOW, exportedMinutesAgo: 5, schedules: true }));
    const body = await full.get();
    assert.deepEqual(body.sources.map(source => [source.id, source.state]), [['hermes-jobs', 'live'], ['hermes-timers', 'live'], ['site-timers', 'live'], ['pc-tasks', 'live'], ['github', 'live']]);
    assert.equal(body.sources[2].items.length, 3);
  } finally { await full.close(); }
  for (const options of [{ envFile: false }, { file: undefined }, { file: 'not json' }]) {
    const lone = await fixture(options);
    try {
      const body = await lone.get();
      assert.deepEqual(body.sources.slice(2).map(source => [source.id, source.state, source.text]), [['site-timers', 'not-reporting', NOT_REPORTING], ['pc-tasks', 'not-reporting', NOT_REPORTING], ['github', 'not-reporting', NOT_REPORTING]], JSON.stringify(options));
    } finally { await lone.close(); }
  }
});

test('the files of this part name nothing of the owner\'s machines', () => {
  const files = ['site/api/hub-other-schedules.mjs', 'site/api/test/hub-other-schedules.test.mjs'];
  for (const file of files) {
    const text = readFileSync(new URL(`../../../${file}`, import.meta.url), 'utf8');
    for (const word of ['CT ' + '10', 'jobs' + '.json', 'briefs' + '-jobs', '192' + '.168', 'bunnyufo' + '.net']) assert.ok(!text.includes(word), `${file} names ${word}`);
  }
});
