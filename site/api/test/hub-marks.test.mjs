// The owner's Roadmap marks: the log's state, the overlay on Beads, and POST /hub/map/:project/marks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSiteApi } from '../server.mjs';
import { createBucket } from '../s3.mjs';
import { createHub } from '../hub.mjs';
import { applyMarks, checkMarkRequest, markEntry, markState, MARK_FILE } from '../hub-marks.mjs';
import { startFakeS3 } from './fake-s3.mjs';
import { askJson, beadsIssue, checklistJson, eventJson, jsonl, minutesAgo, seeder, threeOptions } from './hub-fixtures.mjs';
import { listenOnGoodPort } from '../../../server/listen.mjs';

const NOW = new Date();
const SITE = 'https://site.example';
const day = NOW.toISOString().slice(0, 10).replace(/-/g, '');

/** A mark entry as `markEntry` makes it, from a file name and a body. */
const entry = (project, bead, stamp, verdict, extra = {}, writer = null) => {
  const file = `${stamp}-${verdict}-ab12.json`;
  return markEntry(`${project}/${bead}/${file}`, { v: 1, project, bead, verdict, at: '2026-10-30T10:00:00.000Z', by: 'owner', ...extra }, writer);
};

test('markEntry: a file whose name and body agree; anything else is nothing', () => {
  const good = entry('p', 'p-1', '20261030T100000000Z', 'not-needed', { reason: '  Superseded by the new plan  ' });
  assert.deepEqual([good.verdict, good.reason, good.file], ['not-needed', 'Superseded by the new plan', '20261030T100000000Z-not-needed-ab12.json']);
  assert.equal(entry('p', 'p-1', '20261030T100000000Z', 'done', { verdict: 'undo' }), null, 'The body must name the verdict of the file.');
  assert.equal(entry('p', 'p-1', '20261030T100000000Z', 'done', { v: 2 }), null);
  assert.equal(entry('p', 'p-1', '20261030T100000000Z', 'done', { at: 'later' }), null);
  assert.equal(markEntry('p/p-1/readme.json', {}), null);
  assert.equal(markEntry('p/Bad Id/20261030T100000000Z-done-ab12.json', { v: 1 }), null);
  assert.equal(entry('q', 'p-1', '20261030T100000000Z', 'done', { project: 'p' }), null, 'The body must name the folder it is in.');
});

test('markState: the newest owner verdict, applied, closed, and a verdict put through the card API', () => {
  const done = entry('p', 'p-1', '20261030T100000000Z', 'done');
  const undo = entry('p', 'p-1', '20261030T110000000Z', 'undo');
  const notNeeded = entry('p', 'p-1', '20261030T120000000Z', 'not-needed', { reason: 'Gone' });
  assert.equal(markState([]), null);
  assert.equal(markState([done]).active, true);
  assert.equal(markState([done, undo]).active, false, 'Undo is the newest.');
  const later = markState([notNeeded, done, undo]);
  assert.deepEqual([later.verdict, later.active, later.reason], ['not-needed', true, 'Gone'], 'done, undo, not-needed: the last one counts, whatever the order read.');
  const applied = entry('p', 'p-1', '20261030T130000000Z', 'applied', { mark: done.file, by: 'pc' });
  assert.deepEqual([markState([done, applied]).active, markState([done, applied]).applied], [false, true]);
  assert.equal(markState([done, applied, notNeeded]).active, true, 'A newer mark is not the one that was applied.');
  assert.equal(markState([done], { closed: true }).active, false, 'Beads closed it.');
  assert.equal(markState([entry('p', 'p-1', '20261030T100000000Z', 'done', {}, 'card-api')]), null, 'A verdict with a card API writer is ignored.');
});

test('unblock: its file parses, and it is active only while the issue still waits on the owner', () => {
  assert.ok(MARK_FILE.test('20261030T100000000Z-unblock-ab12.json'));
  const unblock = entry('p', 'p-1', '20261030T100000000Z', 'unblock', { reason: 'dropped' });
  assert.equal(unblock.verdict, 'unblock');
  assert.equal(markState([unblock]).active, true, 'Waiting is the default.');
  assert.equal(markState([unblock], { waiting: true }).active, true);
  assert.equal(markState([unblock], { waiting: false }).active, false, 'The label is gone and the issue is not blocked: Beads caught up.');
  assert.equal(markState([unblock], { closed: true, waiting: true }).active, false, 'Closed.');
  const applied = entry('p', 'p-1', '20261030T130000000Z', 'applied', { mark: unblock.file, by: 'pc' });
  const after = markState([unblock, applied], { waiting: true });
  assert.deepEqual([after.active, after.applied], [false, true]);
  assert.equal(markState([entry('p', 'p-1', '20261030T100000000Z', 'done')], { waiting: false }).active, true, 'done ignores waiting.');
  assert.equal(markState([entry('p', 'p-1', '20261030T100000000Z', 'not-needed')], { waiting: false }).active, true, 'not-needed ignores waiting.');
});

test('applyMarks with an unblock drops needs-owner and opens a blocked issue, and never closes it', () => {
  const labelled = beadsIssue({ id: 'p-lab', labels: ['needs-owner', 'sprint:x'] });
  const blocked = beadsIssue({ id: 'p-blk', status: 'blocked', labels: ['needs-owner'] });
  const gone = beadsIssue({ id: 'p-gone', labels: ['sprint:x'] });
  const marks = new Map(['p-lab', 'p-blk', 'p-gone'].map(id => [`p/${id}`, [entry('p', id, '20261030T100000000Z', 'unblock')]]));
  const byId = Object.fromEntries(applyMarks([labelled, blocked, gone], marks, 'p').map(issue => [issue.id, issue]));
  assert.deepEqual(byId['p-lab'].labels, ['sprint:x']);
  assert.deepEqual([byId['p-lab'].status, byId['p-lab'].closed_at, byId['p-lab'].close_reason, byId['p-lab']._mark.verdict], ['open', undefined, undefined, 'unblock']);
  assert.deepEqual([byId['p-blk'].status, byId['p-blk'].labels], ['open', []]);
  assert.equal(byId['p-gone'], gone, 'Nothing waits any more: the mark has ended.');
  assert.deepEqual(labelled.labels, ['needs-owner', 'sprint:x'], 'The input is not changed.');
});

test('applyMarks closes only issues with an active mark, and leaves the rest as they were', () => {
  const issues = [
    beadsIssue({ id: 'p-open', labels: ['needs-owner'] }), beadsIssue({ id: 'p-undone' }), beadsIssue({ id: 'p-applied' }),
    beadsIssue({ id: 'p-shut', status: 'closed', closed: '2026-10-01T10:00:00Z' }), beadsIssue({ id: 'p-none' }),
  ];
  const marks = new Map();
  const put = (bead, ...entries) => marks.set(`p/${bead}`, entries);
  const done = entry('p', 'p-open', '20261030T100000000Z', 'not-needed', { reason: 'x' });
  put('p-open', done);
  put('p-undone', entry('p', 'p-undone', '20261030T100000000Z', 'done'), entry('p', 'p-undone', '20261030T110000000Z', 'undo'));
  const first = entry('p', 'p-applied', '20261030T100000000Z', 'done');
  put('p-applied', first, entry('p', 'p-applied', '20261030T120000000Z', 'applied', { mark: first.file }));
  put('p-shut', entry('p', 'p-shut', '20261030T100000000Z', 'done'));
  const out = applyMarks(issues, marks, 'p');
  const byId = Object.fromEntries(out.map(issue => [issue.id, issue]));
  assert.deepEqual([byId['p-open'].status, byId['p-open'].closed_at, byId['p-open'].close_reason, byId['p-open']._mark.verdict], ['closed', '2026-10-30T10:00:00.000Z', 'Not needed (you, on the Roadmap)', 'not-needed']);
  for (const id of ['p-undone', 'p-applied', 'p-none']) assert.equal(byId[id], issues.find(issue => issue.id === id), `${id} is the same issue.`);
  assert.equal(byId['p-shut'].closed_at, '2026-10-01T10:00:00Z', 'An issue Beads closed keeps its own close.');
  assert.equal(issues[0].status, 'open', 'The input is not changed.');
});

test('checkMarkRequest: a bead id, a verdict, and a reason of at most 500 characters for done and not-needed only', () => {
  assert.deepEqual(checkMarkRequest({ bead: 'ws-7nz.2.2', verdict: 'not-needed', reason: ' Not   any more ' }), { bead: 'ws-7nz.2.2', verdict: 'not-needed', reason: 'Not any more' });
  assert.equal(checkMarkRequest({ bead: 'p-1', verdict: 'done', reason: ' Ship  it ' }).reason, 'Ship it', 'A done mark keeps its reason: it is the owner\'s decision.');
  assert.equal(checkMarkRequest({ bead: 'p-1', verdict: 'done', reason: 'x'.repeat(500) }).reason.length, 500);
  assert.equal(checkMarkRequest({ bead: 'p-1', verdict: 'undo', reason: 'ignored' }).reason, '');
  assert.deepEqual(checkMarkRequest({ bead: 'p-1', verdict: 'unblock', reason: 'ignored' }), { bead: 'p-1', verdict: 'unblock', reason: '' });
  for (const bad of [{}, { bead: 'P-1', verdict: 'done' }, { bead: '../x', verdict: 'done' }, { bead: 'p-1', verdict: 'maybe' }, { bead: 'p-1', verdict: 'not-needed', reason: 'x'.repeat(501) }, { bead: 'p-1', verdict: 'done', reason: 'x'.repeat(501) }, { bead: 'p-1', verdict: 'not-needed', reason: 5 }]) {
    assert.throws(() => checkMarkRequest(bad), undefined, JSON.stringify(bad));
  }
});

async function fixture({ requireRemoteUser = true } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'buw-hub-marks-'));
  const fake = await startFakeS3();
  const bucket = createBucket({ bucket: fake.bucket, endpoint: fake.endpoint, credentials: fake.credentials, region: 'us-east-1' });
  fake.seed('sections/inbox/workspace.json', '{"name":"Inbox","hidden":true,"entities":[]}\n', 'application/json');
  fake.seed('state.json', '{"version":1,"cards":{}}', 'application/json');
  const logs = [];
  const hub = createHub({ bucket, enabled: true, log: line => logs.push(line) });
  const server = createSiteApi({ bucket, templateDir: path.join(root, 'none'), stateFile: path.join(root, 'card-state.json'), sectionsTtl: 0, requireRemoteUser, hub, allowedOrigins: [SITE] });
  await listenOnGoodPort(server, '127.0.0.1');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const get = async route => { const answer = await fetch(`${origin}/api${route}`, { headers: { 'Remote-User': 'owner' } }); return { status: answer.status, body: await answer.json().catch(() => null) }; };
  const post = async (route, data, headers = { 'Remote-User': 'owner' }) => {
    const answer = await fetch(`${origin}/api${route}`, { method: 'POST', headers: { Origin: SITE, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(data ?? {}) });
    return { status: answer.status, body: await answer.json().catch(() => null) };
  };
  const seed = seeder(fake);
  const issues = [
    beadsIssue({ id: 'mk-m', title: 'Milestone', type: 'milestone', created: '2026-10-01T10:00:00Z' }),
    beadsIssue({ id: 'mk-f', title: 'Feature', type: 'epic', parent: 'mk-m', created: '2026-10-01T11:00:00Z' }),
    beadsIssue({ id: 'mk-label', title: 'Register the domain', parent: 'mk-f', labels: ['needs-owner'], created: '2026-10-01T12:00:00Z' }),
    beadsIssue({ id: 'mk-ask', title: 'Pick the arc', parent: 'mk-f', labels: ['needs-owner'], created: '2026-10-01T13:00:00Z' }),
    beadsIssue({ id: 'mk-inbox', title: 'Review it', parent: 'mk-f', labels: ['needs-owner'], created: '2026-10-01T14:00:00Z' }),
    beadsIssue({ id: 'mk-askonly', title: 'Choose the name', parent: 'mk-f', created: '2026-10-01T14:30:00Z' }),
    beadsIssue({ id: 'mk-plain', title: 'Just work', parent: 'mk-f', created: '2026-10-01T15:00:00Z' }),
    beadsIssue({ id: 'mk-shut', title: 'Done already', parent: 'mk-f', labels: ['needs-owner'], status: 'closed', closed: '2026-10-02T10:00:00Z', created: '2026-10-01T16:00:00Z' }),
  ];
  seed.beads('mk', issues, { pushedAt: minutesAgo(NOW, 5).toISOString(), host: 'pc.example.test', count: issues.length, repo: 'example/mk' });
  // A project with a Wayfinder map: two questions that wait on nobody, one that waits on the first, an ordinary task and a closed question.
  const wayfinder = [
    beadsIssue({ id: 'wk-map', title: 'Wayfinder map', type: 'epic', labels: ['wayfinder:map'], created: '2026-10-01T09:00:00Z', description: '## Destination\n\nA calm, fast Roadmap.' }),
    beadsIssue({ id: 'wk-q1', title: 'What is the goal?', parent: 'wk-map', labels: ['wayfinder:grilling'], created: '2026-10-02T10:00:00Z' }),
    beadsIssue({ id: 'wk-q2', title: 'Which items are open?', parent: 'wk-map', labels: ['wayfinder:research'], created: '2026-10-02T11:00:00Z' }),
    beadsIssue({ id: 'wk-q3', title: 'Is the text in or out?', parent: 'wk-map', labels: ['wayfinder:grilling'], blocks: ['wk-q1'], created: '2026-10-02T12:00:00Z' }),
    beadsIssue({ id: 'wk-task', title: 'Plain task', parent: 'wk-map', created: '2026-10-02T13:00:00Z' }),
    beadsIssue({ id: 'wk-q9', title: 'Old question', parent: 'wk-map', labels: ['wayfinder:grilling'], status: 'closed', closed: '2026-10-03T10:00:00Z', created: '2026-10-02T14:00:00Z' }),
  ];
  seed.beads('wk', wayfinder, { pushedAt: minutesAgo(NOW, 5).toISOString(), host: 'pc.example.test', count: wayfinder.length, repo: 'example/wk' });
  seed.ask(askJson({ id: `${day}-mk-pick-the-arc-a1b2`, project: 'mk', bead: 'mk-ask', now: minutesAgo(NOW, 10), options: threeOptions() }));
  seed.ask(askJson({ id: `${day}-mk-choose-the-name-c3d4`, project: 'mk', bead: 'mk-askonly', now: minutesAgo(NOW, 9), options: threeOptions() }));
  seed.event(eventJson({ kind: 'ready-for-review', ts: minutesAgo(NOW, 20), project: 'mk', bead: 'mk-inbox', title: 'PR ready for review: review it', url: 'https://example.test/pr/9' }));
  const marks = () => [...fake.objects.keys()].filter(key => key.startsWith('sections/inbox/bead-marks/')).sort();
  const taskOf = async id => (await get('/hub/map/mk')).body.milestones.flatMap(m => m.features.flatMap(f => f.tasks)).find(task => task.id === id);
  const answer = (id, body) => post(`/hub/asks/${id}/answer`, body);
  const wayMarks = () => marks().filter(key => key.includes('/bead-marks/wk/'));
  return { fake, seed, get, post, answer, marks, wayMarks, logs, taskOf, close: async () => { server.close(); await fake.close(); } };
}

test('the route: who may mark, what is refused and why', async () => {
  const { post, marks, close } = await fixture({ requireRemoteUser: false });
  try {
    assert.deepEqual([(await post('/hub/map/mk/marks', { bead: 'mk-label', verdict: 'done' }, {})).status, (await post('/hub/map/mk/marks', { bead: 'mk-label', verdict: 'done' }, {})).body.error], [401, 'Sign in to mark this.']);
    assert.equal((await post('/hub/map/nowhere/marks', { bead: 'nw-1', verdict: 'done' })).status, 404, 'An unknown project.');
    assert.equal((await post('/hub/map/Bad_Id/marks', { bead: 'mk-label', verdict: 'done' })).status, 404);
    assert.equal((await post('/hub/map/mk/marks', { bead: 'mk-ghost', verdict: 'done' })).status, 404, 'A bead that is not in that project.');
    assert.equal((await post('/hub/map/mk/marks', { bead: 'mk-label', verdict: 'maybe' })).status, 400);
    const onlyTasks = 'Only a task can be marked here, not a milestone or a feature.';
    const refusals = [
      ['mk-shut', 'done', 'Already closed in Beads.'], ['mk-shut', 'not-needed', 'Already closed in Beads.'], ['mk-f', 'done', onlyTasks], ['mk-m', 'not-needed', onlyTasks], ['mk-m', 'done', onlyTasks],
      ['mk-plain', 'unblock', 'Unblock changes nothing here: this task has no needs-owner label and is not blocked, it waits only through an Ask or a checklist. Answer or cancel that Ask, or use Mark done or Not needed.'],
    ];
    for (const [bead, verdict, message] of refusals) {
      const answer = await post('/hub/map/mk/marks', { bead, verdict });
      assert.deepEqual([answer.status, answer.body.error], [409, message], `${bead} ${verdict}`);
    }
    assert.deepEqual(marks(), [], 'Nothing was written.');
    // An open task that waits on nobody may be marked done or no longer needed (ws-im1.2.3); the PC applies it.
    assert.equal((await post('/hub/map/mk/marks', { bead: 'mk-plain', verdict: 'done' })).status, 201);
    assert.equal((await post('/hub/map/mk/marks', { bead: 'mk-askonly', verdict: 'not-needed', reason: 'Not wanted' })).status, 201);
    assert.deepEqual(marks().map(key => key.split('/').slice(-2)[0]), ['mk-askonly', 'mk-plain']);
  } finally { await close(); }
});

test('the route: done writes one create-only file, shows at once, repeats as a no-op and undoes', async () => {
  const { post, get, marks, fake, taskOf, close } = await fixture();
  try {
    const before = await taskOf('mk-label');
    assert.deepEqual([before.state, before.you, 'mark' in before], ['you', 'label', false]);
    const done = await post('/hub/map/mk/marks', { bead: 'mk-label', verdict: 'done' });
    assert.equal(done.status, 201, JSON.stringify(done.body));
    assert.equal(done.body.state, 'marked');
    assert.equal(done.body.verdict, 'done');
    const [file] = marks();
    assert.equal(marks().length, 1);
    assert.match(file, /^sections\/inbox\/bead-marks\/mk\/mk-label\/\d{8}T\d{9}Z-done-[a-z0-9]{4}\.json$/);
    const body = fake.json(file);
    assert.deepEqual([body.v, body.project, body.bead, body.verdict, body.by, 'reason' in body], [1, 'mk', 'mk-label', 'done', 'owner', false]);

    const after = await taskOf('mk-label');
    assert.deepEqual([after.state, after.status, after.mark.verdict, after.mark.pending, after.closeReason], ['done', 'closed', 'done', true, 'Done (you, on the Roadmap)']);
    assert.equal((await get('/hub/beads/mk')).body.issues.find(issue => issue.id === 'mk-label').status, 'open', 'The raw export stays as Beads has it.');

    const again = await post('/hub/map/mk/marks', { bead: 'mk-label', verdict: 'done' });
    assert.deepEqual([again.status, again.body.state, again.body.verdict], [200, 'marked', 'done']);
    assert.equal(marks().length, 1, 'A repeat writes nothing.');

    const undone = await post('/hub/map/mk/marks', { bead: 'mk-label', verdict: 'undo' });
    assert.deepEqual([undone.status, undone.body], [201, { state: 'unmarked' }]);
    assert.equal(marks().length, 2);
    assert.equal((await taskOf('mk-label')).state, 'you', 'The task is yellow again.');
    const nothing = await post('/hub/map/mk/marks', { bead: 'mk-label', verdict: 'undo' });
    assert.deepEqual([nothing.status, nothing.body], [200, { state: 'unmarked' }]);
    assert.equal(marks().length, 2, 'Undo with nothing to undo writes nothing.');
  } finally { await close(); }
});

test('the route: not needed keeps its reason, and replaces a done mark', async () => {
  const { post, marks, fake, taskOf, close } = await fixture();
  try {
    assert.equal((await post('/hub/map/mk/marks', { bead: 'mk-label', verdict: 'done' })).status, 201);
    const changed = await post('/hub/map/mk/marks', { bead: 'mk-label', verdict: 'not-needed', reason: 'The domain is not needed any more' });
    assert.equal(changed.status, 201);
    const last = marks().at(-1);
    assert.match(last, /-not-needed-/);
    assert.equal(fake.json(last).reason, 'The domain is not needed any more');
    const task = await taskOf('mk-label');
    assert.deepEqual([task.mark.verdict, task.closeReason], ['not-needed', 'Not needed (you, on the Roadmap)']);
  } finally { await close(); }
});

test('an agent that applied the mark ends the overlay: Beads wins, and undo is refused', async () => {
  const { post, seed, marks, fake, taskOf, close } = await fixture();
  try {
    await post('/hub/map/mk/marks', { bead: 'mk-label', verdict: 'done' });
    const [file] = marks();
    const name = file.split('/').at(-1);
    seed.put(`bead-marks/mk/mk-label/20991231T000000000Z-applied-zz99.json`, { v: 1, project: 'mk', bead: 'mk-label', verdict: 'applied', at: new Date().toISOString(), by: 'pc', mark: name }, 'application/json', { writer: 'card-api' });
    const task = await taskOf('mk-label');
    assert.deepEqual([task.state, 'mark' in task], ['you', false], 'Beads still has it open and the mark was applied: the issue shows open again.');
    const undo = await post('/hub/map/mk/marks', { bead: 'mk-label', verdict: 'undo' });
    assert.deepEqual([undo.status, undo.body.error], [409, 'Already closed in Beads; reopen it there with bd reopen.']);
    assert.equal(marks().length, 2, 'Only the applied file was added.');
    assert.ok(fake.text(file));
  } finally { await close(); }
});

test('a mark stops once Beads says closed, and a verdict put through the card API is ignored', async () => {
  const { post, seed, fake, taskOf, marks, close } = await fixture();
  try {
    await post('/hub/map/mk/marks', { bead: 'mk-label', verdict: 'done' });
    // The same issue, now closed in a newer Beads copy: Beads wins and the overlay has nothing to add.
    const closedIssue = { ...beadsIssue({ id: 'mk-label', title: 'Register the domain', parent: 'mk-f', labels: ['needs-owner'], status: 'closed', closed: '2026-10-29T10:00:00Z', created: '2026-10-01T12:00:00Z' }), updated_at: new Date(Date.now() + 60000).toISOString(), close_reason: 'Done (owner, Roadmap 29 Oct)' };
    seed.put('beads/mk/newer.jsonl', jsonl([closedIssue]), 'application/x-ndjson');
    seed.put('beads/mk/newer.meta.json', { v: 2, pushedAt: new Date().toISOString(), host: 'pc.example.test', count: 1, repo: 'example/mk', worktree: 'x', main: true });
    const task = await taskOf('mk-label');
    assert.deepEqual([task.state, 'mark' in task, task.closeReason], ['done', false, 'Done (owner, Roadmap 29 Oct)']);

    // A forged verdict for another task, tagged by the card API as it would be.
    seed.put('bead-marks/mk/mk-ask/20991231T000000000Z-done-ab12.json', { v: 1, project: 'mk', bead: 'mk-ask', verdict: 'done', at: new Date().toISOString(), by: 'owner' }, 'application/json', { writer: 'card-api' });
    assert.equal((await taskOf('mk-ask')).state, 'you', 'It did not close anything.');
    assert.equal((await post('/hub/map/mk/marks', { bead: 'mk-label', verdict: 'undo' })).status, 409, 'Closed in Beads.');
    assert.ok(marks().length >= 2 && fake);
  } finally { await close(); }
});

test('Work agrees with the Roadmap: a marked task leaves the blocked lane', async () => {
  const { post, get, close } = await fixture();
  try {
    const laneOf = (work, key) => Object.entries(work.lanes).find(([, cards]) => cards.some(card => card.key === key))?.[0];
    assert.equal(laneOf((await get('/hub/work?project=mk')).body, 'bead:mk-label'), 'blocked');
    await post('/hub/map/mk/marks', { bead: 'mk-label', verdict: 'done' });
    assert.equal(laneOf((await get('/hub/work?project=mk')).body, 'bead:mk-label'), 'done');
    assert.equal(laneOf((await get('/hub/work')).body, 'bead:mk-label'), 'done', 'Without a project too.');
    assert.equal(laneOf((await get('/hub/work')).body, 'bead:mk-ask'), 'blocked', 'Another task is not touched.');
  } finally { await close(); }
});

test('the route: unblock on a label-only task writes an unblock file and moves the card to ready', async () => {
  const { post, get, marks, fake, taskOf, close } = await fixture();
  try {
    const laneOf = (work, key) => Object.entries(work.lanes).find(([, cards]) => cards.some(card => card.key === key))?.[0];
    const answer = await post('/hub/map/mk/marks', { bead: 'mk-label', verdict: 'unblock' });
    assert.deepEqual([answer.status, answer.body.state, answer.body.verdict], [201, 'marked', 'unblock'], JSON.stringify(answer.body));
    const [file] = marks();
    assert.match(file, /^sections\/inbox\/bead-marks\/mk\/mk-label\/\d{8}T\d{9}Z-unblock-[a-z0-9]{4}\.json$/);
    assert.deepEqual([fake.json(file).verdict, fake.json(file).by], ['unblock', 'owner']);
    const task = await taskOf('mk-label');
    assert.deepEqual([task.state, task.status, task.mark.verdict, task.mark.pending], ['next', 'open', 'unblock', true]);
    assert.equal(laneOf((await get('/hub/work?project=mk')).body, 'bead:mk-label'), 'ready');
    const again = await post('/hub/map/mk/marks', { bead: 'mk-label', verdict: 'unblock' });
    assert.deepEqual([again.status, marks().length], [200, 1], 'A repeat is a no-op.');
    const undo = await post('/hub/map/mk/marks', { bead: 'mk-label', verdict: 'undo' });
    assert.deepEqual([undo.status, undo.body], [201, { state: 'unmarked' }]);
    assert.equal((await taskOf('mk-label')).state, 'you');
  } finally { await close(); }
});

test('the route: undo after an applied unblock says how to put the label back', async () => {
  const { post, seed, marks, close } = await fixture();
  try {
    await post('/hub/map/mk/marks', { bead: 'mk-label', verdict: 'unblock' });
    const name = marks()[0].split('/').at(-1);
    seed.put('bead-marks/mk/mk-label/20991231T000000000Z-applied-zz99.json', { v: 1, project: 'mk', bead: 'mk-label', verdict: 'applied', at: new Date().toISOString(), by: 'pc', mark: name }, 'application/json', { writer: 'card-api' });
    const undo = await post('/hub/map/mk/marks', { bead: 'mk-label', verdict: 'undo' });
    assert.deepEqual([undo.status, undo.body.error], [409, 'Already applied in Beads; add the label back with bd label add mk-label needs-owner.']);
  } finally { await close(); }
});

test('the route: a mark is allowed while an Ask or another Needs you item names the task, and the newest verdict wins', async () => {
  const { post, taskOf, marks, close } = await fixture();
  try {
    const done = await post('/hub/map/mk/marks', { bead: 'mk-ask', verdict: 'done' });
    assert.equal(done.status, 201, JSON.stringify(done.body));
    assert.equal((await post('/hub/map/mk/marks', { bead: 'mk-inbox', verdict: 'unblock' })).status, 201, 'A review item names it.');
    assert.equal((await post('/hub/map/mk/marks', { bead: 'mk-inbox', verdict: 'done' })).status, 201, 'The newest wins (done after unblock).');
    assert.equal((await taskOf('mk-inbox')).mark.verdict, 'done');
    assert.equal(marks().length, 3);
  } finally { await close(); }
});

test('the route: Unblock on a task that waits only through an Ask is refused and writes nothing; Mark done still works', async () => {
  const { post, marks, taskOf, close } = await fixture();
  try {
    assert.equal((await taskOf('mk-askonly')).state, 'you');
    const refused = await post('/hub/map/mk/marks', { bead: 'mk-askonly', verdict: 'unblock' });
    assert.equal(refused.status, 409);
    assert.match(refused.body.error, /Unblock changes nothing here/);
    assert.match(refused.body.error, /Answer or cancel that Ask, or use Mark done or Not needed\./);
    assert.equal(marks().length, 0, 'No file was written.');
    assert.equal((await post('/hub/map/mk/marks', { bead: 'mk-askonly', verdict: 'done' })).status, 201);
  } finally { await close(); }
});

test('GET /hub/unasked lists label-only beads, matches Work, and leaves out asked, checklist, marked, closed and group issues', async () => {
  const { post, get, seed, close } = await fixture();
  try {
    seed.checklist(checklistJson({ id: `${day}-mk-steps-c1d2`, project: 'mk', bead: 'mk-plain', now: minutesAgo(NOW, 30) }));
    const work = (await get('/hub/work')).body;
    const unasked = (await get('/hub/unasked')).body;
    assert.deepEqual(unasked.items.map(item => item.id), ['mk-label']);
    assert.deepEqual(Object.keys(unasked.items[0]).sort(), ['href', 'id', 'project', 'status', 'title']);
    assert.equal(unasked.items.length, work.lanes.blocked.filter(card => card.nothingAsked).length, 'The same count as Work.');
    const card = work.lanes.blocked.find(item => item.id === 'mk-label');
    assert.deepEqual([card.why, card.nothingAsked, 'asked' in card], ['needs you · nothing asked yet', true, false]);
    const askCard = work.lanes.blocked.find(item => item.id === 'mk-ask');
    assert.deepEqual(askCard.asked, { kind: 'ask', id: `${day}-mk-pick-the-arc-a1b2`, href: `#/~hub/ask/${day}-mk-pick-the-arc-a1b2` });
    assert.equal(askCard.why, 'needs you');
    const review = work.lanes.blocked.find(item => item.id === 'mk-inbox');
    assert.deepEqual([review.asked.kind, review.asked.href], ['review', '#/~hub/needs']);
    const plain = work.lanes.blocked.find(item => item.id === 'mk-plain');
    assert.deepEqual([plain.asked.kind, plain.asked.href], ['checklist', `#/~hub/checklist/${day}-mk-steps-c1d2`], 'An open checklist with a bead and no label.');
    assert.equal(work.lanes.blocked.some(item => item.id === 'mk-f' || item.id === 'mk-m' || item.id === 'mk-shut'), false);
    await post('/hub/map/mk/marks', { bead: 'mk-label', verdict: 'unblock' });
    assert.deepEqual((await get('/hub/unasked')).body.items, [], 'An unblocked one drops out.');
    await post('/hub/map/mk/marks', { bead: 'mk-label', verdict: 'undo' });
    assert.deepEqual((await get('/hub/unasked')).body.items.map(item => item.id), ['mk-label'], 'Undo brings it back.');
    await post('/hub/map/mk/marks', { bead: 'mk-label', verdict: 'done' });
    const marked = (await get('/hub/unasked')).body.items;
    assert.deepEqual(marked.map(item => [item.id, item.mark?.verdict]), [['mk-label', 'done']], 'A done mark keeps the row, with its mark, until a session applies it.');
  } finally { await close(); }
});

test('GET /hub/map/:project gives a task with an open checklist you: checklist', async () => {
  const { get, seed, close } = await fixture();
  try {
    seed.checklist(checklistJson({ id: `${day}-mk-steps-c1d2`, project: 'mk', bead: 'mk-plain', now: minutesAgo(NOW, 30) }));
    const task = (await get('/hub/map/mk')).body.milestones.flatMap(m => m.features.flatMap(f => f.tasks)).find(item => item.id === 'mk-plain');
    assert.deepEqual([task.state, task.you, task.checklist], ['you', 'checklist', `${day}-mk-steps-c1d2`]);
  } finally { await close(); }
});

// --- Wayfinder questions (ws-qdh.1): "Answer here" and an answered decision Ask both write a done mark with the decision as its reason ---

test('the route: an open Wayfinder question is decided without waiting on you, with its reason shown as "Decided: ..."', async () => {
  const { post, wayMarks, fake, get, close } = await fixture();
  try {
    const done = await post('/hub/map/wk/marks', { bead: 'wk-q1', verdict: 'done', reason: '  Ship the   small version  ' });
    assert.deepEqual([done.status, done.body.verdict], [201, 'done'], JSON.stringify(done.body));
    assert.equal(fake.json(wayMarks()[0]).reason, 'Ship the small version');
    const tasks = (await get('/hub/map/wk')).body.milestones.flatMap(m => m.features.flatMap(f => f.tasks));
    const task = tasks.find(item => item.id === 'wk-q1');
    assert.deepEqual([task.state, task.closeReason, task.mark.reason], ['done', 'Decided: Ship the small version', 'Ship the small version']);
    const way = (await get('/hub/map/wk')).body.wayfinder;
    assert.deepEqual([way.decisions, way.open.map(item => item.id)], [2, ['wk-q2', 'wk-q3']], 'The decided question left the open ones and counts as a decision.');
    assert.deepEqual(way.open.find(item => item.id === 'wk-q3').blockedBy, [], 'What it blocked is unlocked at once.');
    const notNeeded = await post('/hub/map/wk/marks', { bead: 'wk-q2', verdict: 'not-needed', reason: 'Out of scope' });
    assert.equal(notNeeded.status, 201);
    assert.equal((await post('/hub/map/wk/marks', { bead: 'wk-q1', verdict: 'undo' })).status, 201, 'Undo works until a session applies it.');
  } finally { await close(); }
});

test('the route: any open task may be marked done or not needed; the map itself, a closed question and unblock on a task that waits on nobody are refused', async () => {
  const { post, wayMarks, close } = await fixture();
  try {
    const map = await post('/hub/map/wk/marks', { bead: 'wk-map', verdict: 'done' });
    assert.deepEqual([map.status, map.body.error], [409, 'Only a task can be marked here, not a milestone or a feature.'], 'The map itself is not a question.');
    const plain = await post('/hub/map/wk/marks', { bead: 'wk-task', verdict: 'done', reason: 'x' });
    assert.deepEqual([plain.status, plain.body.verdict], [201, 'done'], 'An ordinary open task may be marked done.');
    assert.equal(wayMarks().length, 1);
    const closed = await post('/hub/map/wk/marks', { bead: 'wk-q9', verdict: 'done', reason: 'x' });
    assert.deepEqual([closed.status, closed.body.error], [409, 'Already closed in Beads.']);
    const unblock = await post('/hub/map/wk/marks', { bead: 'wk-q1', verdict: 'unblock' });
    assert.equal(unblock.status, 409, 'Unblock is for tasks that wait on you.');
    assert.equal((await post('/hub/map/wk/marks', { bead: 'wk-q1', verdict: 'done', reason: 'x'.repeat(501) })).status, 400);
    assert.equal(wayMarks().length, 1, 'Only the one ordinary task was marked.');
  } finally { await close(); }
});

const decisionAsk = (extra = {}) => askJson({ id: `${day}-wk-decide-a1b2`, project: 'wk', bead: 'wk-q1', kind: 'decision', now: minutesAgo(NOW, 10), options: [{ id: 'a', label: 'Small version (recommended)' }, { id: 'b', label: 'Full version' }], allowDrawing: false, ...extra });

test('answering a decision Ask on an open Wayfinder question of its project writes a done mark with the option and the note', async () => {
  const { seed, answer, wayMarks, fake, get, close } = await fixture();
  try {
    const ask = decisionAsk();
    seed.ask(ask);
    const shown = (await get(`/hub/asks/${ask.id}`)).body;
    assert.equal(shown.beadTitle, 'What is the goal?', 'The title comes from Beads.');
    const made = await answer(ask.id, { choice: 'a', note: 'But keep the ring.' });
    assert.equal(made.status, 201);
    const [file] = wayMarks();
    assert.match(file, /\/bead-marks\/wk\/wk-q1\/\d{8}T\d{9}Z-done-[a-z0-9]{4}\.json$/);
    const body = fake.json(file);
    assert.deepEqual([body.verdict, body.by, body.reason], ['done', 'owner', 'Small version (recommended): But keep the ring.']);
  } finally { await close(); }
});

test('answer to mark: not for another kind, not for another project, not for a bead that is no open question, not without a picked option', async () => {
  const { seed, answer, wayMarks, get, close } = await fixture();
  try {
    const cases = [
      ['verify', { kind: 'verify' }, { choice: 'a' }],
      ['approval', { kind: 'approval' }, { choice: 'a' }],
      ['no kind', { kind: undefined }, { choice: 'a' }],
      ['another project', { project: 'mk' }, { choice: 'a' }],
      ['an ordinary task', { bead: 'wk-task' }, { choice: 'a' }],
      ['a closed question', { bead: 'wk-q9' }, { choice: 'a' }],
      ['the map', { bead: 'wk-map' }, { choice: 'a' }],
      ['a note only', { options: undefined }, { note: 'Later' }],
    ];
    for (const [index, [name, extra, data]] of cases.entries()) {
      const ask = decisionAsk({ id: `${day}-wk-case${index}-b${index}c${index}`, ...extra });
      seed.ask(ask);
      if (extra.kind === undefined && 'kind' in extra) assert.equal((await get(`/hub/asks/${ask.id}`)).body.beadTitle, undefined, `${name}: no title is shown`);
      assert.equal((await answer(ask.id, data)).status, 201, name);
    }
    assert.deepEqual(wayMarks(), [], 'Nothing was marked.');
  } finally { await close(); }
});

test('a failing mark write never fails the answer, and says so in the log', async () => {
  const { seed, answer, wayMarks, fake, logs, close } = await fixture();
  try {
    const ask = decisionAsk();
    seed.ask(ask);
    fake.fail = (key, method) => method === 'PUT' && key.includes('/bead-marks/');
    const made = await answer(ask.id, { choice: 'b' });
    assert.equal(made.status, 201);
    assert.equal(made.body.answer.choice, 'b', 'The session still gets the answer.');
    assert.deepEqual(wayMarks(), []);
    assert.ok(logs.some(line => line.includes(`ask ${ask.id} was answered but its question was not marked decided`)), logs.join('\n'));
  } finally { await close(); }
});

test('the reserved option not-yet records the answer and writes no mark; a real choice on the same Ask still decides the question', async () => {
  const { seed, answer, wayMarks, close } = await fixture();
  try {
    const options = [{ id: 'accept', label: 'Accept: the finding' }, { id: 'not-yet', label: 'Needs more work' }];
    const notYet = decisionAsk({ id: `${day}-wk-notyet-n1n1`, options });
    seed.ask(notYet);
    const first = await answer(notYet.id, { choice: 'not-yet', note: 'Look at the other repo too.' });
    assert.deepEqual([first.status, first.body.answer.choice], [201, 'not-yet']);
    assert.deepEqual(wayMarks(), [], 'The question stays open.');
    const accept = decisionAsk({ id: `${day}-wk-accept-n2n2`, options });
    seed.ask(accept);
    assert.equal((await answer(accept.id, { choice: 'accept' })).status, 201);
    assert.equal(wayMarks().length, 1, 'A real choice still decides it.');
  } finally { await close(); }
});
