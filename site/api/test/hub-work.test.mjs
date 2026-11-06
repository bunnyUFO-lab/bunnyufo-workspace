// Work's lanes: every cell of the lane table, groups left out, live sessions, and the route.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSiteApi } from '../server.mjs';
import { createBucket } from '../s3.mjs';
import { createHub } from '../hub.mjs';
import { buildWork, reasonOf, unaskedOf, workPage } from '../hub-work.mjs';
import { applyMarks, markEntry } from '../hub-marks.mjs';
import { searchRows } from '../hub-beads.mjs';
import { rowMatches, snippetOf, words } from '../../../src/hub/beadSearch.ts';
import { DEFAULT_WORK_FILTER, cardPasses, isDefaultWork, parseWorkFilter, workFilterCount } from '../../../src/hub/workFilter.ts';
import { validStatus } from '../hub-pc.mjs';
import { startFakeS3 } from './fake-s3.mjs';
import { beadsIssue, eventJson, iso, jsonl, minutesAgo, pcStatusJson, requestJson, seedPcStatus, seeder, workFixture } from './hub-fixtures.mjs';
import { listenOnGoodPort } from '../../../server/listen.mjs';

const NOW = new Date();
const laneOf = (work, key) => Object.entries(work.lanes).find(([, cards]) => cards.some(card => card.key === key))?.[0];
const card = (work, key) => Object.values(work.lanes).flat().find(item => item.key === key);

test('each Beads cell lands in its lane; groups and milestones are left out', () => {
  const work = buildWork({ ...workFixture({ now: NOW }), now: NOW });
  const expected = {
    'ws-defer': 'backlog', 'ws-ready': 'ready', 'ws-doing': 'running', 'ws-stuck': 'blocked', 'ws-wait': 'blocked',
    'ws-ask': 'blocked', 'ws-owner': 'blocked', 'ws-pr': 'review', 'ws-fresh': 'done', 'ws-child': 'ready',
  };
  for (const [id, lane] of Object.entries(expected)) assert.equal(laneOf(work, `bead:${id}`), lane, id);
  assert.equal(laneOf(work, 'bead:ws-grp'), undefined, 'A group has children: the map shows it.');
  assert.equal(laneOf(work, 'bead:ws-ms'), undefined, 'A milestone is left out.');
  assert.equal(laneOf(work, 'bead:ws-old'), undefined, 'Done keeps the last 14 days.');
  assert.equal(card(work, 'bead:ws-wait').why, 'blocked by ws-doing In progress');
  assert.equal(card(work, 'bead:ws-ask').why, 'needs you');
  assert.equal(card(work, 'bead:ws-owner').why, 'needs you · nothing asked yet');
  assert.equal(card(work, 'bead:ws-owner').nothingAsked, true);
  assert.deepEqual(card(work, 'bead:ws-pr').signs, ['pr']);
  assert.equal(card(work, 'bead:ws-pr').href, '#/~hub/map/ws/ws-pr');
  assert.equal(work.counts.blocked, 4);
  assert.equal(work.lanes.blocked.length, 4);
});

test('a checklist, a snoozed Ask or another Needs you item counts as asked; the label alone is nothing asked yet', () => {
  const issues = ['a-chk', 'a-snz', 'a-rev', 'a-lab', 'a-both'].map(id => ({ ...beadsIssue({ id, labels: id === 'a-chk' || id === 'a-snz' ? [] : ['needs-owner'] }), project: 'a' }));
  const asks = [{ id: 'ask1', bead: 'a-snz', state: 'snoozed' }, { id: 'ask2', bead: 'a-both', state: 'open' }, { id: 'ask3', bead: 'a-lab', state: 'answered' }];
  const checklists = [{ id: 'chk1', bead: 'a-chk', state: 'open' }, { id: 'chk2', bead: 'a-both', state: 'open' }, { id: 'chk3', bead: 'a-lab', state: 'submitted' }];
  const needs = [{ bead: 'a-rev', kind: 'review', id: 'rev1' }];
  const work = buildWork({ issues, asks, checklists, needs, now: NOW });
  for (const id of issues.map(issue => issue.id)) assert.equal(laneOf(work, `bead:${id}`), 'blocked', id);
  assert.deepEqual(card(work, 'bead:a-chk').asked, { kind: 'checklist', id: 'chk1', href: '#/~hub/checklist/chk1' });
  assert.equal(card(work, 'bead:a-chk').why, 'needs you');
  assert.equal(card(work, 'bead:a-snz').asked.kind, 'ask');
  assert.deepEqual(card(work, 'bead:a-rev').asked, { kind: 'review', id: 'rev1', href: '#/~hub/needs' });
  assert.equal(card(work, 'bead:a-both').asked.kind, 'ask', 'An Ask comes before a checklist.');
  assert.deepEqual([card(work, 'bead:a-lab').nothingAsked, card(work, 'bead:a-lab').why, 'asked' in card(work, 'bead:a-lab')], [true, 'needs you · nothing asked yet', false]);
  assert.deepEqual(unaskedOf(work.lanes.blocked).map(item => item.id), ['a-lab']);
});

test('unaskedOf keeps a needs-owner item only when every blocker is closed (ten blocked shapes: none listed)', () => {
  const blocked = Array.from({ length: 10 }, (_, n) => ({ ...beadsIssue({ id: `a-b${n}`, labels: ['needs-owner'], blocks: [`a-later${n}`] }), project: 'a' }));
  const later = Array.from({ length: 10 }, (_, n) => ({ ...beadsIssue({ id: `a-later${n}`, status: n % 2 ? 'in_progress' : 'open' }), project: 'a' }));
  const ready = { ...beadsIssue({ id: 'a-ready', labels: ['needs-owner'], blocks: ['a-done'] }), project: 'a' };
  const done = { ...beadsIssue({ id: 'a-done', status: 'closed', closed: iso(NOW) }), project: 'a' };
  const work = buildWork({ issues: [...blocked, ...later, ready, done], now: NOW });
  assert.deepEqual(unaskedOf(Object.values(work.lanes).flat()).map(item => item.id), ['a-ready'], 'Only the one whose blocker is closed.');
  for (let n = 0; n < 10; n += 1) {
    const item = card(work, `bead:a-b${n}`);
    assert.equal(laneOf(work, `bead:a-b${n}`), 'blocked', 'A blocked one stays on the board.');
    assert.equal(item.nothingAsked, undefined, 'No warning on it.');
    assert.match(item.why, new RegExp(`^blocked by a-later${n}`));
  }
});

test('the reason line: the needs-owner note, else the first sentence of the description, clipped to 120 characters', () => {
  assert.equal(reasonOf({ notes: 'Checked 2026-10-30.\nneeds-owner: Pay the invoice before the launch.', description: 'Ignored text here.' }), 'Pay the invoice before the launch.');
  assert.equal(reasonOf({ description: 'Register the example domain at the registrar. Then point it at the site.' }), 'Register the example domain at the registrar.');
  const long = `Write the terms and privacy page for the launch, ${'covering every detail '.repeat(10)}end.`;
  const clipped = reasonOf({ description: long });
  assert.ok(clipped.length <= 120 && clipped.endsWith('…'), clipped);
  assert.equal(reasonOf({}), '');
  const work = buildWork({ issues: [{ ...beadsIssue({ id: 'a-r', labels: ['needs-owner'], description: 'Sign the example agreement. It has two pages.' }), project: 'a' }], now: NOW });
  assert.equal(card(work, 'bead:a-r').reason, 'Sign the example agreement.');
});

test('a done or not-needed mark keeps the unasked row, marked, until it is applied; an Ask or a blocker never does', () => {
  const mark = (id, verdict) => markEntry(`a/${id}/20261030T100000000Z-${verdict}-ab12.json`, { v: 1, project: 'a', bead: id, verdict, at: '2026-10-30T10:00:00.000Z', by: 'owner' });
  const issues = [
    { ...beadsIssue({ id: 'a-one', labels: ['needs-owner'] }), project: 'a' },
    { ...beadsIssue({ id: 'a-two', labels: ['needs-owner'] }), project: 'a' },
    { ...beadsIssue({ id: 'a-blk', labels: ['needs-owner'], blocks: ['a-doing'] }), project: 'a' },
    { ...beadsIssue({ id: 'a-doing', status: 'in_progress' }), project: 'a' },
  ];
  const marks = new Map([['a/a-one', [mark('a-one', 'done')]], ['a/a-two', [mark('a-two', 'not-needed')]], ['a/a-blk', [mark('a-blk', 'done')]]]);
  const work = buildWork({ issues: applyMarks(issues, marks), now: NOW });
  const rows = unaskedOf(Object.values(work.lanes).flat());
  assert.deepEqual(rows.map(item => [item.id, item.mark.verdict]).sort(), [['a-one', 'done'], ['a-two', 'not-needed']]);
});

test('an active unblock moves a label-only card to ready, and a real blocker still shows', () => {
  const mark = id => markEntry(`a/${id}/20261030T100000000Z-unblock-ab12.json`, { v: 1, project: 'a', bead: id, verdict: 'unblock', at: '2026-10-30T10:00:00.000Z', by: 'owner' });
  const issues = [
    { ...beadsIssue({ id: 'a-lab', labels: ['needs-owner'] }), project: 'a' },
    { ...beadsIssue({ id: 'a-blk', status: 'blocked', labels: ['needs-owner'], blocks: ['a-doing'] }), project: 'a' },
    { ...beadsIssue({ id: 'a-doing', status: 'in_progress' }), project: 'a' },
  ];
  const marks = new Map([['a/a-lab', [mark('a-lab')]], ['a/a-blk', [mark('a-blk')]]]);
  const work = buildWork({ issues: applyMarks(issues, marks), now: NOW });
  assert.equal(laneOf(work, 'bead:a-lab'), 'ready');
  assert.equal(laneOf(work, 'bead:a-blk'), 'blocked');
  assert.match(card(work, 'bead:a-blk').why, /^blocked by a-doing/);
  assert.equal(card(work, 'bead:a-blk').nothingAsked, undefined);
});

test('a blocker that is closed leaves the issue ready', () => {
  const work = buildWork({ issues: [beadsIssue({ id: 'a-1', status: 'closed', closed: iso(NOW) }), beadsIssue({ id: 'a-2', blocks: ['a-1'] })], now: NOW });
  assert.equal(laneOf(work, 'bead:a-2'), 'ready');
});

test('requests map by state; unknown states go to Backlog; declined and stopped are hidden', () => {
  const item = (id, state, extra = {}) => ({ kind: 'request', id, project: 'ws', title: `Request ${id}`, at: iso(NOW), state, ...extra });
  const work = buildWork({
    requests: [
      item('r-open', 'open'), item('r-prop', 'proposed'), item('r-appr', 'approved'), item('r-take', 'taken'), item('r-run', 'running'),
      item('r-lost', 'lost'), item('r-fail', 'failed'), item('r-pc', 'at-pc'), item('r-done', 'done'),
      item('r-dec', 'declined'), item('r-stop', 'stopped'), item('r-new', 'from-the-future'),
      item('r-pr', 'done', { bead: 'ws-pr' }), item('r-ask', 'asking'), item('r-exp', 'expired'), item('r-halt', 'stopping'),
    ],
    events: [eventJson({ kind: 'pr-opened', ts: minutesAgo(NOW, 5), bead: 'ws-pr' })], now: NOW,
  });
  const expected = {
    'r-open': 'backlog', 'r-prop': 'backlog', 'r-new': 'backlog', 'r-appr': 'ready', 'r-take': 'ready', 'r-run': 'running',
    'r-lost': 'blocked', 'r-fail': 'blocked', 'r-pc': 'blocked', 'r-done': 'done', 'r-pr': 'review',
    'r-ask': 'blocked', 'r-exp': 'blocked', 'r-halt': 'running',
  };
  for (const [id, lane] of Object.entries(expected)) assert.equal(laneOf(work, `request:${id}`), lane, id);
  assert.equal(laneOf(work, 'request:r-dec'), undefined);
  assert.equal(laneOf(work, 'request:r-stop'), undefined);
  assert.equal(card(work, 'request:r-open').state, 'proposed');
  assert.equal(card(work, 'request:r-lost').why, 'lost: no word from the run for 20 minutes');
  assert.equal(card(work, 'request:r-open').href, '#/~hub/request/r-open');
  assert.equal(card(work, 'request:r-ask').why, 'asked you a question');
  assert.equal(card(work, 'request:r-exp').why, 'the approval ran out');
  assert.equal(card(work, 'request:r-halt').why, 'stopping');
});

test('an approved cloud request that waits says what it waits on: the usage pause, or the daily limit', () => {
  const item = (id, cloud) => ({ kind: 'request', id, project: 'ws', title: `Request ${id}`, at: iso(NOW), state: 'approved', ...(cloud ? { cloud } : {}) });
  const work = buildWork({
    requests: [item('c-pause', { status: 'waiting', reason: 'usage-limit' }), item('c-cap', { status: 'waiting', reason: 'daily-cap' }), item('c-fired', { status: 'fired' }), item('c-plain')],
    now: NOW,
  });
  assert.equal(card(work, 'request:c-pause').why, 'waiting on the cloud usage pause');
  assert.equal(card(work, 'request:c-cap').why, 'waiting: the daily cloud limit is used');
  assert.equal(card(work, 'request:c-fired').why, undefined);
  assert.equal(card(work, 'request:c-plain').why, undefined);
});

test('a task that inherited the milestone label is a task; the milestone itself stays out', () => {
  const work = buildWork({
    issues: [
      beadsIssue({ id: 'ws-mile', type: 'milestone', labels: ['milestone'] }),
      beadsIssue({ id: 'ws-kid1', parent: 'ws-mile', labels: ['milestone'] }),
      beadsIssue({ id: 'ws-kid2', parent: 'ws-mile', labels: ['milestone'], status: 'closed', closed: iso(NOW) }),
    ].map(issue => ({ ...issue, project: 'ws' })), now: NOW,
  });
  assert.equal(laneOf(work, 'bead:ws-kid1'), 'ready');
  assert.equal(laneOf(work, 'bead:ws-kid2'), 'done');
  assert.equal(laneOf(work, 'bead:ws-mile'), undefined);
});

test('Hermes runs map as the table says', () => {
  const work = buildWork({
    hermesRuns: [
      { id: 'h1', state: 'running', title: 'Digest', updatedAt: iso(NOW) },
      { id: 'h2', state: 'waiting', title: 'Wants a go', updatedAt: iso(NOW) },
      { id: 'h3', state: 'completed', title: 'Done run', updatedAt: iso(NOW) },
      { id: 'h4', state: 'completed', title: 'Old run', updatedAt: iso(minutesAgo(NOW, 60 * 24 * 20)) },
      { id: 'h5', state: 'mystery', updatedAt: iso(NOW) },
    ], now: NOW,
  });
  assert.equal(laneOf(work, 'run:h1'), 'running');
  assert.equal(laneOf(work, 'run:h2'), 'blocked');
  assert.equal(card(work, 'run:h2').why, 'needs you');
  assert.equal(laneOf(work, 'run:h3'), 'done');
  assert.equal(laneOf(work, 'run:h4'), undefined);
  assert.equal(laneOf(work, 'run:h5'), undefined);
});

test('a session on a branch that names a bead marks it live; a stale status marks nothing', () => {
  const issues = [beadsIssue({ id: 'ws-abcd', status: 'in_progress' }), beadsIssue({ id: 'ws-zzzz', status: 'in_progress' })].map(issue => ({ ...issue, project: 'ws' }));
  const sessions = [{ id: 's1', name: 'x', status: 'busy', kind: 'interactive', folder: 'f', repo: 'r', branch: 'sprint/ws-abcd-x' }];
  const fresh = validStatus(pcStatusJson({ now: NOW, sessions }));
  const work = buildWork({ issues, status: fresh, now: NOW });
  assert.deepEqual(card(work, 'bead:ws-abcd').live, { host: 'test-pc', session: 's1', state: 'working' });
  assert.equal(card(work, 'bead:ws-zzzz').live, undefined);
  const stale = validStatus(pcStatusJson({ now: NOW, minutesOld: 30, sessions }));
  assert.equal(card(buildWork({ issues, status: stale, now: NOW }), 'bead:ws-abcd').live, undefined);
});

test('Backlog keeps 50 and counts the rest; Done keeps the newest 30', () => {
  const issues = [
    ...Array.from({ length: 60 }, (_, index) => beadsIssue({ id: `ws-b${index}`, status: 'deferred' })),
    ...Array.from({ length: 40 }, (_, index) => beadsIssue({ id: `ws-d${index}`, status: 'closed', closed: iso(minutesAgo(NOW, index + 1)) })),
  ];
  const work = buildWork({ issues, now: NOW });
  assert.equal(work.lanes.backlog.length, 50);
  assert.equal(work.counts.backlog, 60);
  assert.equal(work.lanes.done.length, 30);
  assert.equal(work.lanes.done[0].id, 'ws-d0', 'Newest first.');
});

test('workPage returns the cards a lane cut, from the offset, in the same order', () => {
  const issues = [
    ...Array.from({ length: 120 }, (_, index) => beadsIssue({ id: `ws-b${index}`, status: 'deferred', updated: iso(new Date(NOW.getTime() - index * 60000)) })),
    ...Array.from({ length: 70 }, (_, index) => beadsIssue({ id: `ws-d${index}`, status: 'closed', closed: iso(new Date(NOW.getTime() - index * 60000)), updated: iso(new Date(NOW.getTime() - index * 60000)) })),
  ];
  const input = { issues, now: NOW };
  const first = buildWork(input);
  assert.equal(first.lanes.backlog.length, 50);
  assert.deepEqual(first.totals, first.counts);
  const next = workPage(input, 'backlog', 50);
  assert.equal(next.cards.length, 50);
  assert.equal(next.total, 120);
  assert.equal(next.totals.done, 70);
  assert.equal(next.cards[0].id, 'ws-b50', 'It starts where the first answer ended.');
  assert.deepEqual(workPage(input, 'backlog', 100).cards.map(item => item.id).slice(0, 2), ['ws-b100', 'ws-b101']);
  assert.equal(workPage(input, 'backlog', 100).cards.length, 20, 'The last page is short.');
  assert.equal(workPage(input, 'done', 30).cards[0].id, 'ws-d30');
  assert.deepEqual(workPage(input, 'done', 500).cards, []);
});

test('GET /hub/work reads every project with a Beads copy, or one', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'buw-hub-work-'));
  const fake = await startFakeS3();
  const bucket = createBucket({ bucket: fake.bucket, endpoint: fake.endpoint, credentials: fake.credentials, region: 'us-east-1' });
  fake.seed('state.json', '{"version":1,"cards":{}}', 'application/json');
  const hub = createHub({ bucket, enabled: true });
  const server = createSiteApi({ bucket, templateDir: path.join(root, 'none'), stateFile: path.join(root, 'card-state.json'), sectionsTtl: 0, requireRemoteUser: true, hub });
  await listenOnGoodPort(server, '127.0.0.1');
  const get = async route => { const answer = await fetch(`http://127.0.0.1:${server.address().port}/api${route}`); return { status: answer.status, body: await answer.json().catch(() => null) }; };
  try {
    const seed = seeder(fake);
    seed.put('beads/magic-loops.jsonl', jsonl([beadsIssue({ id: 'ml-abcd', status: 'in_progress' })]), 'application/x-ndjson');
    seed.put('beads/magic-loops.meta.json', { pushedAt: iso(NOW) });
    seed.put('beads/bunnylink.jsonl', jsonl([beadsIssue({ id: 'bl-abcd' })]), 'application/x-ndjson');
    seed.put('beads/bunnylink.meta.json', { pushedAt: iso(NOW) });
    seed.request(requestJson({ id: '20261029-bunnylink-add-x-aaaa', project: 'bunnylink', now: NOW }));
    seed.request(requestJson({ id: '20261029-magic-loops-add-y-bbbb', project: 'magic-loops', now: NOW }));
    seedPcStatus(fake, pcStatusJson({ now: NOW, sessions: [{ id: 'pc1', name: 'x', status: 'idle', kind: 'interactive', folder: 'f', repo: 'r', branch: 'sprint/ml-abcd-x' }] }));

    const all = (await get('/hub/work')).body;
    assert.deepEqual(Object.keys(all), ['lanes', 'counts', 'totals', 'at']);
    assert.deepEqual(all.totals, all.counts);
    assert.deepEqual(all.lanes.running.map(item => item.key), ['bead:ml-abcd']);
    assert.equal(all.lanes.running[0].live.state, 'idle');
    assert.equal(all.lanes.ready.some(item => item.key === 'bead:bl-abcd'), true);
    assert.equal(all.counts.backlog, 2, 'Both requests are proposed.');

    const one = (await get('/hub/work?project=bunnylink')).body;
    assert.deepEqual(one.lanes.running, []);
    assert.deepEqual(one.lanes.backlog.map(item => item.project), ['bunnylink']);
    assert.equal((await get('/hub/work?project=Bad_Id')).status, 404);
    assert.equal((await get('/hub/work?project=probe')).body.counts.ready, 0);

    const page = (await get('/hub/work?project=bunnylink&lane=backlog&offset=0')).body;
    assert.deepEqual(Object.keys(page), ['lane', 'offset', 'cards', 'total', 'totals', 'at']);
    assert.equal(page.total, one.counts.backlog);
    assert.equal((await get('/hub/work?lane=running')).status, 400, 'Only the lanes that are cut have pages.');
    assert.equal((await get('/hub/work?lane=done&offset=-1')).status, 400);
    assert.equal((await get('/hub/work?lane=done&offset=x')).status, 400);
  } finally { server.close(); await fake.close(); }
});

test('searchRows gives the plain text of the description and acceptance criteria, cut at 4000; notes are left out', () => {
  const rows = searchRows([
    { ...beadsIssue({ id: 'ws-a', title: 'Alpha', description: 'A **bold** [link](http://x.test) here.' }), acceptance_criteria: '- the `quokka` waves', notes: 'commits abc1234', project: 'ws' },
    { ...beadsIssue({ id: 'ws-b', description: 'x'.repeat(5000) }), project: 'ws' },
    { ...beadsIssue({ id: 'ws-c' }), project: 'ws' },
  ]);
  assert.deepEqual(rows[0], { id: 'ws-a', project: 'ws', title: 'Alpha', status: 'open', text: 'A bold link here. - the quokka waves' });
  assert.equal(rows[1].text.length, 4000);
  assert.equal(rows[2].text, '');
  assert.equal(rows[2].title, 'ws-c');
});

test('Beads cards carry type and labels; requests do not', () => {
  const work = buildWork({ issues: [{ ...beadsIssue({ id: 'ws-f', type: 'feature', labels: ['x', 'y'] }), project: 'ws' }, { ...beadsIssue({ id: 'ws-g' }), project: 'ws' }], now: NOW });
  assert.equal(card(work, 'bead:ws-f').type, 'feature');
  assert.deepEqual(card(work, 'bead:ws-f').labels, ['x', 'y']);
  assert.equal(card(work, 'bead:ws-g').type, 'task');
  assert.deepEqual(card(work, 'bead:ws-g').labels, []);
});

test('GET /hub/search-text gives one row per issue for a project or every project, and refuses a bad id', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'buw-hub-search-'));
  const fake = await startFakeS3();
  const bucket = createBucket({ bucket: fake.bucket, endpoint: fake.endpoint, credentials: fake.credentials, region: 'us-east-1' });
  fake.seed('state.json', '{"version":1,"cards":{}}', 'application/json');
  const hub = createHub({ bucket, enabled: true });
  const server = createSiteApi({ bucket, templateDir: path.join(root, 'none'), stateFile: path.join(root, 'card-state.json'), sectionsTtl: 0, requireRemoteUser: true, hub });
  await listenOnGoodPort(server, '127.0.0.1');
  const get = async route => { const answer = await fetch(`http://127.0.0.1:${server.address().port}/api${route}`); return { status: answer.status, body: await answer.json().catch(() => null) }; };
  try {
    const seed = seeder(fake);
    seed.put('beads/magic-loops.jsonl', jsonl([beadsIssue({ id: 'ml-abcd', description: 'Rare quokka word.' })]), 'application/x-ndjson');
    seed.put('beads/magic-loops.meta.json', { pushedAt: iso(NOW) });
    seed.put('beads/bunnylink.jsonl', jsonl([beadsIssue({ id: 'bl-abcd', status: 'closed', closed: iso(minutesAgo(NOW, 60 * 24 * 40)) })]), 'application/x-ndjson');
    seed.put('beads/bunnylink.meta.json', { pushedAt: iso(NOW) });
    const all = (await get('/hub/search-text')).body;
    assert.deepEqual(all.rows.map(row => [row.project, row.id]).sort(), [['bunnylink', 'bl-abcd'], ['magic-loops', 'ml-abcd']]);
    assert.equal(all.rows.find(row => row.id === 'ml-abcd').text, 'Rare quokka word.');
    assert.equal(all.rows.find(row => row.id === 'bl-abcd').status, 'closed', 'Old closed beads are in the text read although Work drops their cards.');
    const one = (await get('/hub/search-text?project=bunnylink')).body;
    assert.deepEqual(one.rows.map(row => row.id), ['bl-abcd']);
    assert.equal((await get('/hub/search-text?project=Bad_Id')).status, 404);
  } finally { server.close(); await fake.close(); }
});

test('beadSearch: all words must match the id, title or text, in any case; the snippet frames the first hit', () => {
  const row = { id: 'ws-Ab12', title: 'Wall slide', text: 'The quokka handshake needs retuning before the release of the long build.' };
  assert.deepEqual(words('  Wall  QUOKKA '), ['wall', 'quokka']);
  assert.equal(rowMatches(row, 'QUOKKA'), true);
  assert.equal(rowMatches(row, 'ab1'), true, 'A partial id.');
  assert.equal(rowMatches(row, 'WS-AB12'), true);
  assert.equal(rowMatches(row, 'wall quokka'), true);
  assert.equal(rowMatches(row, 'wall zebra'), false);
  assert.equal(rowMatches(row, '   '), true, 'An empty query matches everything.');
  assert.equal(snippetOf(row.text, 'zebra'), null);
  assert.equal(snippetOf(row.text, 'HANDSHAKE'), 'The quokka handshake needs retuning before the rel…', 'About thirty characters each side, none cut on the left at the start of the text.');
  assert.equal(snippetOf('short quokka', 'quokka'), 'short quokka', 'No dots when nothing was cut.');
  assert.match(snippetOf(`${'a '.repeat(50)}quokka${' b'.repeat(50)}`, 'quokka'), /^….*quokka.*…$/);
});

test('parseWorkFilter: a bad value is the default; good fields stay; the default is recognised', () => {
  for (const bad of [null, undefined, 'x', 7, [], { type: 'epic', within: 90, needsYou: 'yes', q: 5 }]) assert.deepEqual(parseWorkFilter(bad), DEFAULT_WORK_FILTER);
  assert.equal(isDefaultWork(DEFAULT_WORK_FILTER), true);
  assert.equal(isDefaultWork({ ...DEFAULT_WORK_FILTER, q: '   ' }), true);
  const good = { q: 'quokka', needsYou: true, blocked: false, type: 'question', label: 'wayfinder:grilling', within: 7 };
  assert.deepEqual(parseWorkFilter(good), good);
  assert.deepEqual(parseWorkFilter({ ...good, type: 'epic', within: 90 }), { ...good, type: null, within: null }, 'Each bad field falls back alone.');
});

test('cardPasses: the search, Needs you, Blocked, Type, Label and Updated', () => {
  const now = Date.parse('2026-11-03T12:00:00Z');
  const ago = days => new Date(now - days * 86400000).toISOString();
  const bead = (id, extra = {}) => ({ key: `bead:${id}`, source: 'beads', id, project: 'ws', title: id, lane: 'ready', state: 'open', type: 'task', labels: [], signs: [], updatedAt: ago(1), href: '#', ...extra });
  const none = () => undefined;
  const f = extra => ({ ...DEFAULT_WORK_FILTER, ...extra });
  const asked = bead('ws-ask', { lane: 'blocked', why: 'needs you', asked: { kind: 'ask', id: 'a', href: '#' } });
  const nothing = bead('ws-nothing', { lane: 'blocked', nothingAsked: true, why: 'needs you · nothing asked yet' });
  const waits = bead('ws-wait', { lane: 'blocked', why: 'blocked by ws-x X' });
  const ready = bead('ws-ready');
  assert.equal(cardPasses(ready, DEFAULT_WORK_FILTER, none, now), true);
  // The search reads the text when it is there, and the id and title when it is not.
  const text = item => (item.id === 'ws-ready' ? { id: 'ws-ready', project: 'ws', title: 'ws-ready', status: 'open', text: 'about a rare quokka' } : undefined);
  assert.equal(cardPasses(ready, f({ q: 'quokka' }), text, now), true);
  assert.equal(cardPasses(ready, f({ q: 'quokka' }), none, now), false);
  assert.equal(cardPasses(ready, f({ q: 'WS-REA quokka' }), text, now), true);
  assert.equal(cardPasses(ready, f({ q: 'ws-rea' }), none, now), true);
  // Needs you: an Ask, nothing asked, or the reason; Blocked: the lane without those; both: either.
  const four = [asked, nothing, waits, ready];
  assert.deepEqual(four.map(item => cardPasses(item, f({ needsYou: true }), none, now)), [true, true, false, false]);
  assert.deepEqual(four.map(item => cardPasses(item, f({ blocked: true }), none, now)), [false, false, true, false]);
  assert.deepEqual(four.map(item => cardPasses(item, f({ needsYou: true, blocked: true }), none, now)), [true, true, true, false]);
  // Type: task is task or bug, feature is feature, question is a wayfinder label other than the map's, whatever the type.
  const bug = bead('ws-bug', { type: 'bug' });
  const feature = bead('ws-feat', { type: 'feature' });
  const question = bead('ws-q', { type: 'epic', labels: ['wayfinder:grilling'] });
  const map = bead('ws-map', { type: 'epic', labels: ['wayfinder:map'] });
  const items = [ready, bug, feature, question, map];
  assert.deepEqual(items.map(item => cardPasses(item, f({ type: 'task' }), none, now)), [true, true, false, false, false]);
  assert.deepEqual(items.map(item => cardPasses(item, f({ type: 'feature' }), none, now)), [false, false, true, false, false]);
  assert.deepEqual(items.map(item => cardPasses(item, f({ type: 'question' }), none, now)), [false, false, false, true, false]);
  // A request or a Hermes run has no type and no labels: a Type or Label choice hides it.
  const request = { key: 'request:r', source: 'request', id: 'r', project: 'ws', title: 'r', lane: 'backlog', state: 'proposed', signs: [], updatedAt: ago(1), href: '#' };
  assert.equal(cardPasses(request, f({ type: 'task' }), none, now), false);
  assert.equal(cardPasses(request, f({ label: 'x' }), none, now), false);
  assert.equal(cardPasses(request, f({ q: 'r' }), none, now), true);
  assert.equal(cardPasses(bead('ws-l', { labels: ['x'] }), f({ label: 'x' }), none, now), true);
  assert.equal(cardPasses(ready, f({ label: 'x' }), none, now), false);
  // Updated within 7 or 30 days.
  const old = bead('ws-old', { updatedAt: ago(10) });
  assert.deepEqual([ready, old].map(item => cardPasses(item, f({ within: 7 }), none, now)), [true, false]);
  assert.deepEqual([ready, old].map(item => cardPasses(item, f({ within: 30 }), none, now)), [true, true]);
  assert.equal(cardPasses(bead('ws-nodate', { updatedAt: '' }), f({ within: 30 }), none, now), false);
});

test('workFilterCount counts each control once and is zero exactly when the filter is the default', () => {
  const on = { q: 'quokka', needsYou: true, blocked: true, type: 'task', label: 'area:feel', within: 7 };
  const cases = [
    [DEFAULT_WORK_FILTER, 0],
    [{ ...DEFAULT_WORK_FILTER, q: '   ' }, 0],
    [{ ...DEFAULT_WORK_FILTER, q: 'two words' }, 1],
    [{ ...DEFAULT_WORK_FILTER, needsYou: true }, 1],
    [{ ...DEFAULT_WORK_FILTER, blocked: true }, 1],
    [{ ...DEFAULT_WORK_FILTER, type: 'feature' }, 1],
    [{ ...DEFAULT_WORK_FILTER, label: 'area:feel' }, 1],
    [{ ...DEFAULT_WORK_FILTER, within: 30 }, 1],
    [on, 6],
    [{ ...on, q: '' }, 5],
  ];
  for (const [filter, expected] of cases) {
    assert.equal(workFilterCount(filter), expected, JSON.stringify(filter));
    assert.equal(workFilterCount(filter) === 0, isDefaultWork(filter), `zero matches isDefaultWork for ${JSON.stringify(filter)}`);
  }
});
