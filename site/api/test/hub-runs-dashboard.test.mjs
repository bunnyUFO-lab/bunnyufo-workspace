// ws-ttz: spawned runs on the dashboard. Working now lists every taken request that has not finished, the event
// window carries run-started and run-finished, and a finished Hermes run's card link resolves. Data is in `inbox-dev`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSiteApi } from '../server.mjs';
import { createBucket } from '../s3.mjs';
import { createHub } from '../hub.mjs';
import { workingNow } from '../hub-pc.mjs';
import { validStatus } from '../hub-pc.mjs';
import { withRunEvents } from '../hub-run-events.mjs';
import { startFakeS3 } from './fake-s3.mjs';
import { iso, minutesAgo, pcStatusJson, seeder } from './hub-fixtures.mjs';

const NOW = new Date();
const day = NOW.toISOString().slice(0, 10).replace(/-/g, '');

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'buw-hub-runs-'));
  const fake = await startFakeS3();
  const bucket = createBucket({ bucket: fake.bucket, endpoint: fake.endpoint, credentials: fake.credentials, region: 'us-east-1' });
  fake.seed('state.json', '{"version":1,"cards":{}}', 'application/json');
  const hub = createHub({ bucket, enabled: true, inbox: 'inbox-dev' });
  const server = createSiteApi({ bucket, templateDir: path.join(root, 'none'), stateFile: path.join(root, 'card-state.json'), sectionsTtl: 0, requireRemoteUser: true, hub });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const get = async route => { const answer = await fetch(`${origin}/api${route}`); return { status: answer.status, body: await answer.json().catch(() => null) }; };
  const put = seeder(fake, 'sections/inbox-dev');
  /** A request with its approval, and the files of the stage it is in. */
  const run = (id, { runner = 'hermes', preset = 'research', title = id, minutes = 10, taken = true, result, session, project = 'probe' } = {}) => {
    put.request({ id, project, title, text: `Do ${title}`, preset, target: runner, createdAt: iso(minutesAgo(NOW, minutes + 5)) });
    put.put(`requests/${id}/approved.json`, { target: runner, expires: iso(new Date(NOW.getTime() + 3600000)), at: iso(minutesAgo(NOW, minutes + 4)) });
    if (taken) put.put(`requests/${id}/taken.json`, { runner, at: iso(minutesAgo(NOW, minutes)), ...(session ? { session } : {}) });
    if (result) put.put(`requests/${id}/result.json`, { at: iso(minutesAgo(NOW, 1)), ...result });
  };
  return { fake, get, put, run, close: async () => { server.close(); await fake.close(); } };
}

const row = (overrides = {}) => ({ id: `${day}-a-b1b1`, state: 'taken', title: 'A run', project: 'probe', preset: 'research', run: { runner: 'hermes', at: iso(minutesAgo(NOW, 5)) }, ...overrides });

test('workingNow lists taken, unfinished requests whatever the runner, and skips a PC run that is also a session', () => {
  const status = validStatus(pcStatusJson({ now: NOW, sessions: [{ id: 'pc-s1', name: 'Run session', status: 'busy', startedAt: iso(minutesAgo(NOW, 20)) }] }));
  const requests = [
    row({ id: `${day}-h-aaaa`, title: 'Hermes research', state: 'running' }),
    row({ id: `${day}-c-bbbb`, title: 'Cloud fix', run: { runner: 'cloud', at: iso(minutesAgo(NOW, 7)) } }),
    row({ id: `${day}-p-cccc`, title: 'PC task', run: { runner: 'pc', at: iso(minutesAgo(NOW, 9)), session: 'pc-s1' } }),
    row({ id: `${day}-s-dddd`, title: 'Stopping one', state: 'stopping' }),
    row({ id: `${day}-q-eeee`, title: 'Asked', state: 'asking' }),
    row({ id: `${day}-d-ffff`, title: 'Done one', state: 'done' }),
    row({ id: `${day}-l-gggg`, title: 'Lost one', state: 'lost' }),
    row({ id: `${day}-n-hhhh`, title: 'Never taken', state: 'approved', run: undefined }),
  ];
  const list = workingNow({ status, events: [], requests, at: NOW });
  const runs = list.filter(item => item.source === 'run');
  assert.deepEqual(runs.map(item => item.title).sort(), ['Asked', 'Cloud fix', 'Hermes research', 'Stopping one']);
  assert.equal(runs.find(item => item.title === 'Asked').state, 'needs-you');
  assert.equal(runs.find(item => item.title === 'Stopping one').state, 'stopping');
  assert.equal(runs.find(item => item.title === 'Hermes research').runner, 'hermes');
  assert.equal(runs.find(item => item.title === 'Cloud fix').preset, 'research');
  const pc = list.find(item => item.id === 'pc-s1');
  assert.equal(pc.request, `${day}-p-cccc`, 'The PC session carries the request that started it.');
  assert.equal(list.filter(item => item.title === 'PC task').length, 0, 'It is counted once.');
});

test('GET /hub/today: a taken Hermes run shows in Working now and Running; run events reach Since yesterday and /hub/events', async () => {
  const { get, run, close } = await fixture();
  try {
    run(`${day}-research-live-ab12`, { title: 'Help me make a deck', minutes: 4 });
    run(`${day}-research-done-cd34`, { title: 'Game ideas deck', minutes: 30, result: { outcome: 'card', card: 'assistant/2026-10-30_x' } });
    run(`${day}-code-failed-ef56`, { title: 'Broken run', runner: 'cloud', minutes: 50, result: { outcome: 'failed', reason: 'boom' } });
    const today = (await get('/hub/today')).body;
    const mine = today.working.filter(item => item.source === 'run');
    assert.deepEqual(mine.map(item => item.title), ['Help me make a deck']);
    assert.equal(mine[0].runner, 'hermes');
    assert.equal(mine[0].request, `${day}-research-live-ab12`);
    assert.equal(today.counts.running, 1, 'Running counts it.');
    const kinds = today.recent.filter(event => event.request).map(event => `${event.kind}:${event.request.split('-')[2]}`).sort();
    assert.deepEqual(kinds, ['run-finished:done', 'run-finished:failed', 'run-started:done', 'run-started:failed', 'run-started:live']);
    assert.equal(today.counts.recent, today.recent.length);
    const events = (await get('/hub/events?project=probe')).body.events;
    assert.equal(events.filter(event => event.kind === 'run-started').length, 3);
    assert.equal((await get('/hub/events?project=other')).body.events.filter(event => event.kind.startsWith('run-')).length, 0, 'The project filter applies.');
    assert.match(events.find(event => event.kind === 'run-finished' && event.outcome === 'failed').title, /^Failed: Broken run/);
  } finally { await close(); }
});

test('a finished run links to its PR, and its card in the assistant section resolves to the card id', async () => {
  const { fake, get, run, close } = await fixture();
  try {
    fake.seed('sections/assistant/workspace.json', JSON.stringify({ name: 'Assistant', entities: [{ id: 'game-ideas-deck-consultant', title: 'Game ideas deck', folder: '2026-10-30_game-ideas-deck-consultant', created: '2026-10-30' }] }), 'application/json');
    const done = `${day}-research-done-cd34`;
    const pr = `${day}-code-task-pr99-ab99`;
    run(done, { title: 'Game ideas deck', minutes: 30, result: { outcome: 'card', card: 'assistant/2026-10-30_game-ideas-deck-consultant' } });
    run(pr, { title: 'Fix it', runner: 'cloud', minutes: 20, result: { outcome: 'pr', pr: 'https://github.com/example/repo/pull/9' } });
    const detail = (await get(`/hub/requests/${done}`)).body;
    assert.equal(detail.cardHref, '/assistant#/game-ideas-deck-consultant');
    const events = (await get('/hub/events')).body.events;
    assert.equal(events.find(event => event.request === done && event.kind === 'run-finished').cardHref, '/assistant#/game-ideas-deck-consultant');
    assert.equal(events.find(event => event.request === pr && event.kind === 'run-finished').url, 'https://github.com/example/repo/pull/9');
    assert.equal((await get(`/hub/requests/${pr}`)).body.cardHref, undefined);
  } finally { await close(); }
});

test('withRunEvents keeps the window sorted, drops old runs and never doubles an event', () => {
  const old = row({ id: `${day}-o-oooo`, run: { runner: 'pc', at: iso(new Date(NOW.getTime() - 9 * 86400000)) } });
  const fresh = row({ id: `${day}-f-ffff` });
  const merged = withRunEvents([{ ts: iso(minutesAgo(NOW, 60)), kind: 'alert', file: 'a.json' }], [old, fresh], { now: NOW });
  assert.deepEqual(merged.map(event => event.kind), ['run-started', 'alert']);
  assert.equal(withRunEvents(merged, [old, fresh], { now: NOW }).length, 2);
});
