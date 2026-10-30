// The owner's Roadmap marks: the log's state, the overlay on Beads, and POST /hub/map/:project/marks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSiteApi } from '../server.mjs';
import { createBucket } from '../s3.mjs';
import { createHub } from '../hub.mjs';
import { applyMarks, checkMarkRequest, markEntry, markState } from '../hub-marks.mjs';
import { startFakeS3 } from './fake-s3.mjs';
import { askJson, beadsIssue, eventJson, jsonl, minutesAgo, seeder, threeOptions } from './hub-fixtures.mjs';

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

test('checkMarkRequest: a bead id, a verdict, and a reason of at most 200 characters for not-needed only', () => {
  assert.deepEqual(checkMarkRequest({ bead: 'ws-7nz.2.2', verdict: 'not-needed', reason: ' Not   any more ' }), { bead: 'ws-7nz.2.2', verdict: 'not-needed', reason: 'Not any more' });
  assert.equal(checkMarkRequest({ bead: 'p-1', verdict: 'done', reason: 'ignored' }).reason, '');
  for (const bad of [{}, { bead: 'P-1', verdict: 'done' }, { bead: '../x', verdict: 'done' }, { bead: 'p-1', verdict: 'maybe' }, { bead: 'p-1', verdict: 'not-needed', reason: 'x'.repeat(201) }, { bead: 'p-1', verdict: 'not-needed', reason: 5 }]) {
    assert.throws(() => checkMarkRequest(bad), undefined, JSON.stringify(bad));
  }
});

async function fixture({ requireRemoteUser = true } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'buw-hub-marks-'));
  const fake = await startFakeS3();
  const bucket = createBucket({ bucket: fake.bucket, endpoint: fake.endpoint, credentials: fake.credentials, region: 'us-east-1' });
  fake.seed('sections/inbox/workspace.json', '{"name":"Inbox","hidden":true,"entities":[]}\n', 'application/json');
  fake.seed('state.json', '{"version":1,"cards":{}}', 'application/json');
  const hub = createHub({ bucket, enabled: true });
  const server = createSiteApi({ bucket, templateDir: path.join(root, 'none'), stateFile: path.join(root, 'card-state.json'), sectionsTtl: 0, requireRemoteUser, hub, allowedOrigins: [SITE] });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const get = async route => { const answer = await fetch(`${origin}/api${route}`); return { status: answer.status, body: await answer.json().catch(() => null) }; };
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
    beadsIssue({ id: 'mk-plain', title: 'Just work', parent: 'mk-f', created: '2026-10-01T15:00:00Z' }),
    beadsIssue({ id: 'mk-shut', title: 'Done already', parent: 'mk-f', labels: ['needs-owner'], status: 'closed', closed: '2026-10-02T10:00:00Z', created: '2026-10-01T16:00:00Z' }),
  ];
  seed.beads('mk', issues, { pushedAt: minutesAgo(NOW, 5).toISOString(), host: 'pc.example.test', count: issues.length, repo: 'example/mk' });
  seed.ask(askJson({ id: `${day}-mk-pick-the-arc-a1b2`, project: 'mk', bead: 'mk-ask', now: minutesAgo(NOW, 10), options: threeOptions() }));
  seed.event(eventJson({ kind: 'ready-for-review', ts: minutesAgo(NOW, 20), project: 'mk', bead: 'mk-inbox', title: 'PR ready for review: review it', url: 'https://example.test/pr/9' }));
  const marks = () => [...fake.objects.keys()].filter(key => key.startsWith('sections/inbox/bead-marks/')).sort();
  const taskOf = async id => (await get('/hub/map/mk')).body.milestones.flatMap(m => m.features.flatMap(f => f.tasks)).find(task => task.id === id);
  return { fake, seed, get, post, marks, taskOf, close: async () => { server.close(); await fake.close(); } };
}

test('the route: who may mark, what is refused and why', async () => {
  const { post, marks, close } = await fixture({ requireRemoteUser: false });
  try {
    assert.deepEqual([(await post('/hub/map/mk/marks', { bead: 'mk-label', verdict: 'done' }, {})).status, (await post('/hub/map/mk/marks', { bead: 'mk-label', verdict: 'done' }, {})).body.error], [401, 'Sign in to mark this.']);
    assert.equal((await post('/hub/map/nowhere/marks', { bead: 'nw-1', verdict: 'done' })).status, 404, 'An unknown project.');
    assert.equal((await post('/hub/map/Bad_Id/marks', { bead: 'mk-label', verdict: 'done' })).status, 404);
    assert.equal((await post('/hub/map/mk/marks', { bead: 'mk-ghost', verdict: 'done' })).status, 404, 'A bead that is not in that project.');
    assert.equal((await post('/hub/map/mk/marks', { bead: 'mk-label', verdict: 'maybe' })).status, 400);
    const refusals = [
      ['mk-ask', 'This has an Ask; answer it in Needs you.'], ['mk-inbox', 'This has an item in Needs you; finish it there.'],
      ['mk-plain', 'This is not waiting on you.'], ['mk-shut', 'Already closed in Beads.'], ['mk-f', 'This is not waiting on you.'],
    ];
    for (const [bead, message] of refusals) {
      const answer = await post('/hub/map/mk/marks', { bead, verdict: 'done' });
      assert.deepEqual([answer.status, answer.body.error], [409, message], bead);
    }
    assert.deepEqual(marks(), [], 'Nothing was written.');
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
