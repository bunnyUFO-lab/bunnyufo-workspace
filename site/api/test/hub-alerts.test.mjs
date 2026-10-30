// ws-9xg: dismissing alerts is kept on the server (create-only events), undo restores, and a run that found nothing to
// change is done, not an alert. Data is in `inbox-dev` on the stand-in S3.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSiteApi } from '../server.mjs';
import { createBucket } from '../s3.mjs';
import { createHub } from '../hub.mjs';
import { dismissedAlerts, requestState } from '../hub-model.mjs';
import { NOTHING_TO_DO_REASONS, nothingToDo } from '../nothing-to-do.mjs';
import { startFakeS3 } from './fake-s3.mjs';
import { eventJson, iso, minutesAgo, seeder } from './hub-fixtures.mjs';

const SITE = 'https://site.example.test';
const NOW = new Date();
const day = NOW.toISOString().slice(0, 10).replace(/-/g, '');

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'buw-hub-alerts-'));
  const fake = await startFakeS3();
  const bucket = createBucket({ bucket: fake.bucket, endpoint: fake.endpoint, credentials: fake.credentials, region: 'us-east-1' });
  fake.seed('state.json', '{"version":1,"cards":{}}', 'application/json');
  const hub = createHub({ bucket, enabled: true, inbox: 'inbox-dev' });
  const server = createSiteApi({ bucket, templateDir: path.join(root, 'none'), stateFile: path.join(root, 'card-state.json'), sectionsTtl: 0, requireRemoteUser: false, hub, allowedOrigins: [SITE] });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, route, body) => {
    const answer = await fetch(`${origin}/api${route}`, { method, ...(body ? { headers: { Origin: SITE, 'Content-Type': 'application/json', 'Remote-User': 'owner' }, body: JSON.stringify(body) } : {}) });
    return { status: answer.status, body: await answer.json().catch(() => null) };
  };
  const put = seeder(fake, 'sections/inbox-dev');
  const run = (id, { runner = 'cloud', title = id, result } = {}) => {
    put.request({ id, project: 'probe', title, text: `Do ${title}`, preset: 'code-task', target: runner, createdAt: iso(minutesAgo(NOW, 40)) });
    put.put(`requests/${id}/approved.json`, { target: runner, expires: iso(new Date(NOW.getTime() + 3600000)), at: iso(minutesAgo(NOW, 39)) });
    put.put(`requests/${id}/taken.json`, { runner, at: iso(minutesAgo(NOW, 30)) });
    if (result) put.put(`requests/${id}/result.json`, { at: iso(minutesAgo(NOW, 5)), ...result });
  };
  return { fake, put, run, get: route => call('GET', route), post: (route, body) => call('POST', route, body), close: async () => { server.close(); await fake.close(); } };
}

test('only a listed reason reads as nothing to change; no-access and no-push-access stay failed', () => {
  for (const reason of NOTHING_TO_DO_REASONS) assert.equal(nothingToDo({ outcome: 'failed', reason }), true, reason);
  for (const reason of ['no-access', 'no-push-access', 'no-repo', 'no-network', 'no-permission', 'no-tests']) assert.equal(nothingToDo({ outcome: 'failed', reason }), false, reason);
  assert.equal(nothingToDo({ outcome: 'failed', reason: 'no-typo-found' }), true);
  assert.equal(nothingToDo({ outcome: 'failed', reason: 'budget' }), false);
  assert.equal(nothingToDo({ outcome: 'failed' }), false);
  assert.equal(nothingToDo({ outcome: 'pr', reason: 'no-typo-found' }), false);
  const base = { names: ['request.json', 'approved.json', 'taken.json', 'result.json'], request: { preset: 'code-task' }, approved: { expires: iso(new Date(NOW.getTime() + 1000)) }, taken: { at: iso(minutesAgo(NOW, 30)) }, now: NOW };
  assert.equal(requestState({ ...base, result: { outcome: 'failed', reason: 'no-typo-found' } }), 'done');
  assert.equal(requestState({ ...base, result: { outcome: 'failed', reason: 'crashed' } }), 'failed');
});

test('dismissedAlerts: the newest mark for a key wins', () => {
  const marks = [
    { ts: '2026-10-30T10:00:00Z', kind: 'alert-dismissed', alert: 'a', file: '1.json' },
    { ts: '2026-10-30T10:01:00Z', kind: 'alert-dismissed', alert: 'b', file: '2.json' },
    { ts: '2026-10-30T10:02:00Z', kind: 'alert-restored', alert: 'a', file: '3.json' },
  ];
  assert.deepEqual([...dismissedAlerts(marks)], ['b']);
});

test('Dismiss removes an alert from Today and the count, Undo brings it back, and it is kept for the next request', async () => {
  const { put, run, get, post, close } = await fixture();
  try {
    put.event(eventJson({ kind: 'alert', ts: minutesAgo(NOW, 20), title: 'Nightly brief failed', summary: 'The upstream answered 529.', project: 'probe' }));
    run(`${day}-probe-crashed-run-aa11`, { title: 'Crashed run', result: { outcome: 'failed', reason: 'crashed', summary: 'It crashed.' } });
    let today = (await get('/hub/today')).body;
    assert.equal(today.counts.alerts, 2);
    assert.ok(today.alerts.every(alert => typeof alert.key === 'string' && alert.key), 'Each alert carries its key.');
    const [first, second] = today.alerts.map(alert => alert.key);

    const one = await post('/hub/alerts/dismiss', { keys: [first] });
    assert.equal(one.status, 201);
    assert.equal((await post('/hub/alerts/dismiss', { keys: [first] })).status, 200, 'A repeat writes nothing.');
    today = (await get('/hub/today')).body;
    assert.deepEqual(today.alerts.map(alert => alert.key), [second]);
    assert.equal(today.counts.alerts, 1);
    assert.equal(today.recent.some(event => event.kind === 'alert-dismissed'), false, 'The marks are not news.');
    assert.equal((await get('/hub/events')).body.events.some(event => event.kind === 'alert-dismissed'), false);

    await post('/hub/alerts/dismiss', { keys: [second] });
    assert.equal((await get('/hub/today')).body.counts.alerts, 0);
    assert.equal((await post('/hub/alerts/restore', { keys: [first, second] })).body.count, 2);
    assert.equal((await get('/hub/today')).body.counts.alerts, 2, 'Undo brings both back.');

    // The run itself stays in the event feed and its request stays readable.
    assert.equal((await get('/hub/events')).body.events.filter(event => event.request === `${day}-probe-crashed-run-aa11`).length, 2);
    assert.equal((await get(`/hub/requests/${day}-probe-crashed-run-aa11`)).status, 200);

    assert.equal((await post('/hub/alerts/dismiss', { keys: [] })).status, 400);
    assert.equal((await post('/hub/alerts/dismiss', { keys: ['bad key!'] })).status, 400);
    assert.equal((await post('/hub/alerts/dismiss', { keys: Array.from({ length: 51 }, (_, index) => `k${index}`) })).status, 400);
  } finally { await close(); }
});

test('a run that failed with no-access is still failed and still an alert', async () => {
  const { put, run, get, close } = await fixture();
  try {
    const id = `${day}-probe-fix-access-zz99`;
    run(id, { title: 'Fix a typo in docs', result: { outcome: 'failed', reason: 'no-access', summary: 'No access to the repo.' } });
    put.event(eventJson({ kind: 'alert', ts: minutesAgo(NOW, 5), title: `Run failed: ${id}`, source: 'cards-finish', project: 'probe' }));
    const today = (await get('/hub/today')).body;
    assert.equal(today.counts.alerts, 2, 'The CLI alert and the failed request both stay.');
    const detail = (await get(`/hub/requests/${id}`)).body;
    assert.equal(detail.state, 'failed');
    assert.equal(detail.nothing, undefined);
  } finally { await close(); }
});

test('a run that found nothing to change is done: no alert, not failed, and its event says so', async () => {
  const { put, run, get, close } = await fixture();
  try {
    const id = `${day}-probe-fix-a-typo-m8nl`;
    run(id, { title: 'Fix a typo in docs', result: { outcome: 'failed', reason: 'no-typo-found', summary: 'Found no typo, opened no PR.' } });
    // `cards request finish` also posts this alert event for any failed outcome.
    put.event(eventJson({ kind: 'alert', ts: minutesAgo(NOW, 5), title: `Run failed: ${id}`, summary: 'Found no typo', source: 'cards-finish', project: 'probe' }));
    const today = (await get('/hub/today')).body;
    assert.equal(today.counts.alerts, 0);
    const detail = (await get(`/hub/requests/${id}`)).body;
    assert.equal(detail.state, 'done');
    assert.equal(detail.nothing, true, 'The drawer is told, it does not guess.');
    const finished = today.recent.find(event => event.kind === 'run-finished' && event.request === id);
    assert.equal(finished.outcome, 'nothing');
    assert.match(finished.title, /^Done, nothing to change: Fix a typo/);
    const work = (await get('/hub/work')).body;
    assert.ok(work.lanes.done.some(card => card.id === id), 'It sits in Done.');
  } finally { await close(); }
});
