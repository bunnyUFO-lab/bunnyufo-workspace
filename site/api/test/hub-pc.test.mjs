// The PC status file: validation, the summary, Working now, and the routes over the stand-in S3.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSiteApi } from '../server.mjs';
import { createBucket } from '../s3.mjs';
import { createHub, inboxKey } from '../hub.mjs';
import { beadOfBranch, isActive, pcSummary, validStatus, workingNow } from '../hub-pc.mjs';
import { PROJECT_DEFAULTS } from '../project-defaults.mjs';
import { startFakeS3 } from './fake-s3.mjs';
import { eventJson, minutesAgo, pcStatusJson, seedPcStatus, seeder } from './hub-fixtures.mjs';

const NOW = new Date();
const withFile = (events, extra = {}) => events.map((event, index) => ({ ...event, file: `${String(index).padStart(3, '0')}.json`, ...extra }));

async function fixture({ inbox = 'inbox' } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'buw-hub-pc-'));
  const fake = await startFakeS3();
  const bucket = createBucket({ bucket: fake.bucket, endpoint: fake.endpoint, credentials: fake.credentials, region: 'us-east-1' });
  fake.seed('state.json', '{"version":1,"cards":{}}', 'application/json');
  const hub = createHub({ bucket, enabled: true, inbox });
  const server = createSiteApi({ bucket, templateDir: path.join(root, 'none'), stateFile: path.join(root, 'card-state.json'), sectionsTtl: 0, requireRemoteUser: true, hub });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const get = async route => { const answer = await fetch(`${origin}/api${route}`); return { status: answer.status, body: await answer.json().catch(() => null) }; };
  return { fake, get, seed: seeder(fake, `sections/${inbox}`), prefix: `sections/${inbox}`, close: async () => { server.close(); await fake.close(); } };
}

test('beadOfBranch finds the Beads id after the prefix', () => {
  assert.equal(beadOfBranch('sprint/ws-b1z.11-map-feel', 'ws'), 'ws-b1z.11');
  assert.equal(beadOfBranch('ws-46d.3.2-m2-pc-api', 'ws'), 'ws-46d.3.2');
  assert.equal(beadOfBranch('sprint/ws-b1z', 'ws'), 'ws-b1z');
  assert.equal(beadOfBranch('sprint/ml-wj-t2-wall-jump', 'ws'), null, 'Another project prefix is no match.');
  assert.equal(beadOfBranch('sprint/news-b1z-x', 'ws'), null, 'The prefix must start a path segment.');
  assert.equal(beadOfBranch('main', 'ws'), null);
  assert.equal(beadOfBranch('sprint/ws-b1z', undefined), null);
});

test('validStatus cleans a full path, a bad link and a bad project; refuses 40 sessions, a bad host and a wrong version', () => {
  const clean = validStatus(pcStatusJson({ now: NOW, sessions: [{
    id: 's1', name: 'x'.repeat(300), status: 'busy', folder: 'C:\\Users\\someone\\work\\probe', repo: '/home/someone/probe', project: 'Bad Project!',
    branch: 'b'.repeat(300), url: 'http://example.test/not-https', appUrl: 'claude://evil', startedAt: 1_700_000_000_000, extra: 'dropped',
  }] }));
  const [row] = clean.sessions;
  assert.equal(row.folder, 'probe');
  assert.equal(row.repo, 'probe');
  assert.equal(row.name.length, 120);
  assert.equal(row.branch.length, 120);
  assert.equal('project' in row, false);
  assert.equal('url' in row, false);
  assert.equal('appUrl' in row, false);
  assert.equal('extra' in row, false);
  assert.equal(row.startedAt, '2023-11-14T22:13:20.000Z', 'An epoch number becomes an ISO time.');
  assert.deepEqual(clean.runs, []);

  const many = Array.from({ length: 40 }, (_, index) => ({ id: `s${index}`, status: 'busy' }));
  assert.equal(validStatus(pcStatusJson({ now: NOW, sessions: many })), null);
  assert.equal(validStatus({ ...pcStatusJson({ now: NOW }), host: 'Bad Host' }), null);
  assert.equal(validStatus({ ...pcStatusJson({ now: NOW }), v: 2 }), null);
  assert.equal(validStatus({ ...pcStatusJson({ now: NOW }), at: 'yesterday' }), null);
  assert.equal(validStatus('nope'), null);
  assert.equal(validStatus(pcStatusJson({ now: NOW, sessions: null, extra: { sessions: null } })).sessions, null, 'null means the PC could not list its sessions.');
  const good = validStatus(pcStatusJson({ now: NOW, sessions: [{ id: 's1', status: 'idle', url: 'https://claude.ai/code/session_Abc', appUrl: 'claude://claude.ai/epitaxy/local_00000000-0000-0000-0000-000000000001', project: 'workspace-app' }] })).sessions[0];
  assert.equal(good.url, 'https://claude.ai/code/session_Abc');
  assert.equal(good.project, 'workspace-app');
  assert.ok(good.appUrl);
});

test('pcSummary: on when fresh, asleep-or-off after 15 minutes, with session counts', () => {
  const on = pcSummary(validStatus(pcStatusJson({ now: NOW, minutesOld: 2 })), NOW);
  assert.equal(on.state, 'on');
  assert.equal(on.ageSeconds, 120);
  assert.deepEqual(on.sessions, { busy: 1, idle: 1 });
  assert.equal(on.gpu.band, 'idle');
  assert.equal(pcSummary(validStatus(pcStatusJson({ now: NOW, minutesOld: 20 })), NOW).state, 'asleep-or-off');
});

test('workingNow: a blocked event makes one needs-you and one working, ordered', () => {
  const status = validStatus(pcStatusJson({ now: NOW, sessions: [
    { id: 'a', name: 'First', status: 'busy', project: 'magic-loops', branch: 'sprint/ml-wj-t2-wall-jump', startedAt: minutesAgo(NOW, 30).toISOString() },
    { id: 'b', name: 'Second', status: 'busy', project: 'workspace-app', branch: 'sprint/ws-b1z.11-map-feel', startedAt: minutesAgo(NOW, 20).toISOString() },
    { id: 'c', name: 'Third', status: 'idle', startedAt: minutesAgo(NOW, 10).toISOString() },
  ] }));
  const events = withFile([eventJson({ kind: 'blocked', ts: minutesAgo(NOW, 3), session: 'a', host: 'test-pc', title: 'Permission needed', url: 'https://claude.ai/code/session_Blocked' })]);
  const items = workingNow({ status, events, at: NOW, defaults: PROJECT_DEFAULTS });
  assert.deepEqual(items.map(item => [item.id, item.state]), [['a', 'needs-you'], ['b', 'working'], ['c', 'idle']]);
  assert.equal(items[0].url, 'https://claude.ai/code/session_Blocked', 'The blocked event supplies a link the session lacks.');
  assert.equal(items[0].bead, undefined, 'ml-wj-t2 is longer than the id pattern allows after the prefix.');
  assert.equal(items[1].bead, 'ws-b1z.11');
  assert.ok(items.every(item => item.source === 'pc' && item.host === 'test-pc' && item.agent === 'claude'));
});

test('workingNow: a 20-minute-old status falls back to events; a cloud session sits beside PC sessions', () => {
  const events = withFile([
    eventJson({ kind: 'session-started', ts: minutesAgo(NOW, 30), session: 'pc-1', host: 'test-pc', title: 'x', project: 'probe' }),
    eventJson({ kind: 'session-started', ts: minutesAgo(NOW, 10), session: 'cloud-1', host: 'cloud', title: 'x', project: 'probe' }),
  ]);
  const stale = validStatus(pcStatusJson({ now: NOW, minutesOld: 20 }));
  const fallback = workingNow({ status: stale, events, at: NOW, defaults: PROJECT_DEFAULTS });
  assert.deepEqual(fallback.map(item => [item.id, item.source, item.state]).sort(), [['cloud-1', 'events', 'working'], ['pc-1', 'events', 'working']]);

  const fresh = validStatus(pcStatusJson({ now: NOW }));
  const mixed = workingNow({ status: fresh, events, at: NOW, defaults: PROJECT_DEFAULTS });
  assert.deepEqual(mixed.map(item => item.id).sort(), ['cloud-1', 'pc-sess-a', 'pc-sess-b'], 'The status is the truth for its own host: pc-1 is dropped.');
  assert.equal(mixed.find(item => item.id === 'cloud-1').source, 'events');

  const unknown = validStatus(pcStatusJson({ now: NOW, extra: { sessions: null } }));
  assert.deepEqual(workingNow({ status: unknown, events, at: NOW }).map(item => item.id).sort(), ['cloud-1', 'pc-1'], 'No session list: events stand in.');
  assert.deepEqual(workingNow({ status: null, events: [], at: NOW }), []);
});

const HOURS = 60;
const startedAgo = (minutes, session, host = 'cloud') => eventJson({ kind: 'session-started', ts: minutesAgo(NOW, minutes), session, host, title: session, project: 'probe' });

test('workingNow: a fresh PC status is the truth for PC sessions, so old session-started events of its host add nothing', () => {
  const events = withFile([startedAgo(3 * 24 * HOURS, 'old-pc', 'test-pc'), startedAgo(36 * HOURS, 'old-pc-2', 'test-pc'), startedAgo(20, 'cloud-live')]);
  const items = workingNow({ status: validStatus(pcStatusJson({ now: NOW })), events, at: NOW, defaults: PROJECT_DEFAULTS });
  assert.deepEqual(items.map(item => [item.id, item.state]).sort(), [['cloud-live', 'working'], ['pc-sess-a', 'working'], ['pc-sess-b', 'idle']]);
  assert.equal(items.filter(isActive).length, 2);
});

test('workingNow: with no usable PC status, events show, but a session quiet for over 2 hours is stale and counts nowhere', () => {
  const events = withFile([startedAgo(3 * 24 * HOURS, 'days-old', 'test-pc'), startedAgo(36 * HOURS, 'day-old', 'test-pc'), startedAgo(90, 'recent', 'test-pc'), eventJson({ kind: 'resumed', ts: minutesAgo(NOW, 5), session: 'days-old', host: 'test-pc', title: 'x' })]);
  for (const status of [null, validStatus(pcStatusJson({ now: NOW, minutesOld: 40 })), validStatus(pcStatusJson({ now: NOW, extra: { sessions: null } }))]) {
    const items = workingNow({ status, events, at: NOW, defaults: PROJECT_DEFAULTS });
    const state = Object.fromEntries(items.map(item => [item.id, item.state]));
    assert.equal(state.recent, 'working');
    assert.equal(state['day-old'], 'stale');
    assert.equal(state['days-old'], 'working', 'Any later event from the session is word.');
    assert.equal(items.find(item => item.id === 'day-old').since, new Date(Math.floor(minutesAgo(NOW, 36 * HOURS).getTime() / 1000) * 1000).toISOString(), 'Stale shows when the last word was.');
    assert.deepEqual(items.map(item => item.state), ['working', 'working', 'stale'], 'Stale rows sort last.');
    assert.equal(items.filter(isActive).length, 2);
  }
});

test('GET /hub/today: the Running count and Working now agree when old event sessions pile up', async () => {
  const { fake, get, seed, close } = await fixture();
  try {
    seed.event(startedAgo(3 * 24 * HOURS, 'days-old', 'test-pc'));
    seed.event(startedAgo(36 * HOURS, 'day-old', 'elsewhere'));
    const none = (await get('/hub/today')).body;
    assert.deepEqual(none.working.map(item => item.state), ['stale', 'stale']);
    assert.equal(none.counts.running, 0, 'Quiet event sessions are not counted.');
    seedPcStatus(fake, pcStatusJson({ now: NOW, minutesOld: 1 }));
    const today = (await get('/hub/today')).body;
    assert.equal(today.counts.running, 1);
    assert.equal(today.counts.running, today.working.filter(isActive).length);
    assert.deepEqual(today.pc.sessions, { busy: 1, idle: 1 });
  } finally { await close(); }
});

test('GET /hub/pc and /hub/today read the newest status file', async () => {
  const { fake, get, seed, close } = await fixture();
  try {
    const before = (await get('/hub/today')).body;
    assert.equal(before.pc, null);
    assert.deepEqual(before.working, []);
    assert.deepEqual((await get('/hub/pc')).body, { pc: null, status: null, wake: { state: 'asleep-or-off', wakeAvailable: false } });

    seed.event(eventJson({ kind: 'session-started', ts: minutesAgo(NOW, 30), session: 'sess-old', host: 'other-host', title: 'Cloud', project: 'probe' }));
    const withEvents = (await get('/hub/today')).body;
    assert.equal(withEvents.pc, null);
    assert.deepEqual(withEvents.working.map(item => item.id), ['sess-old']);
    assert.equal(withEvents.counts.running, withEvents.running.length, 'With no status the count is the event-derived one.');
    assert.deepEqual(Object.keys(withEvents), ['counts', 'needsYou', 'running', 'recent', 'alerts', 'at', 'working', 'pc', 'wake'], 'Only working, pc and wake are new.');

    seedPcStatus(fake, pcStatusJson({ now: NOW, minutesOld: 5, sessions: [{ id: 'old-one', name: 'Older file', status: 'idle' }] }));
    const newest = seedPcStatus(fake, pcStatusJson({ now: NOW, minutesOld: 1 }));
    seed.event(eventJson({ kind: 'blocked', ts: minutesAgo(NOW, 2), session: 'pc-sess-a', host: 'test-pc', title: 'Needs a go' }));
    const today = (await get('/hub/today')).body;
    assert.equal(today.pc.state, 'on');
    assert.equal(today.pc.host, 'test-pc');
    assert.deepEqual(today.working.map(item => [item.id, item.state]), [['pc-sess-a', 'needs-you'], ['sess-old', 'working'], ['pc-sess-b', 'idle']]);
    assert.equal(today.counts.running, 2, 'Working plus needs-you; the idle session does not count.');
    assert.equal(today.running.length, 1, '`running` still carries the event-derived list for old clients.');

    const pc = (await get('/hub/pc')).body;
    assert.equal(pc.pc.state, 'on');
    assert.equal(pc.status.sessions.length, 2, 'The newest file is read, not the older one.');
    assert.ok(newest.startsWith('pc/status-'));
  } finally { await close(); }
});

test('a stale or a bad status gives no live PC; the dev inbox is its own folder', async () => {
  const { fake, get, prefix, close } = await fixture({ inbox: 'inbox-dev' });
  try {
    seedPcStatus(fake, pcStatusJson({ now: NOW, minutesOld: 30 }), prefix);
    const stale = (await get('/hub/today')).body;
    assert.equal(stale.pc.state, 'asleep-or-off');
    assert.deepEqual(stale.working, []);

    fake.seed(`${prefix}/pc/status-${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')}.json`, 'not json', 'application/json');
    assert.equal((await get('/hub/today')).body.pc.state, 'asleep-or-off', 'The newest file is bad: the file before it is read, not no status.');

    const real = await fixture();
    try {
      seedPcStatus(real.fake, pcStatusJson({ now: NOW }));
      assert.equal((await real.get('/hub/pc')).body.pc.state, 'on');
    } finally { await real.close(); }
    assert.equal((await get('/hub/pc')).body.pc.state, 'asleep-or-off', 'The dev hub reads its own folder (the 30-minute file), never the real inbox (on).');
    assert.equal(inboxKey('pc/status-20261028T091503Z.json'), 'sections/inbox/pc/status-20261028T091503Z.json');
    assert.throws(() => inboxKey('pc'), /not in the inbox/);
  } finally { await close(); }
});
