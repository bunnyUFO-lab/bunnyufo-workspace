// The Progress map's model: milestones, features, tasks, states, signs and sprint bands.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMap, orderSiblings, roll } from '../hub-map.mjs';
import { beadsIssue as issue, cujTwo, eventJson, iso, minutesAgo } from './hub-fixtures.mjs';

const NOW = new Date('2026-10-26T12:00:00Z');
const build = (issues, extra = {}) => buildMap({ project: 'p', issues, now: NOW, ...extra });
const tasksOf = map => map.milestones.flatMap(milestone => milestone.features.flatMap(feature => feature.tasks));
const task = (map, id) => tasksOf(map).find(item => item.id === id);

test('a milestone is found by type and by each label; its epics are features and their children tasks', () => {
  const map = build([
    issue({ id: 'a', type: 'milestone' }),
    issue({ id: 'b', labels: ['milestone'] }),
    issue({ id: 'c', labels: ['wayfinder:map'] }),
    issue({ id: 'a-f', type: 'epic', parent: 'a' }),
    issue({ id: 'a-f-t', parent: 'a-f' }),
    issue({ id: 'a-feat', type: 'feature', parent: 'a' }),
  ]);
  assert.deepEqual(map.milestones.map(item => item.id), ['a', 'b', 'c']);
  assert.deepEqual(map.milestones[0].features.map(item => item.id), ['a-f', 'a-feat']);
  assert.deepEqual(map.milestones[0].features[0].tasks.map(item => item.id), ['a-f-t']);
});

test('a label a child inherited from its milestone does not make it a milestone', () => {
  const map = build([issue({ id: 'm', type: 'milestone' }), issue({ id: 'f', type: 'epic', parent: 'm', labels: ['milestone'] }), issue({ id: 't', parent: 'f' })]);
  assert.deepEqual(map.milestones.map(item => item.id), ['m']);
  assert.equal(map.milestones[0].features[0].tasks[0].id, 't');
});

test('a task straight under a milestone goes into "<milestone> · other tasks"; strays go into "Not in a milestone"', () => {
  const map = build([
    issue({ id: 'm', title: 'Alpha', type: 'milestone' }),
    issue({ id: 'direct', parent: 'm' }),
    issue({ id: 'stray' }),
    issue({ id: 'lonely-epic', type: 'epic' }),
    issue({ id: 'loose-epic', type: 'epic' }),
    issue({ id: 'loose-child', parent: 'loose-epic' }),
  ]);
  assert.equal(map.milestones[0].features[0].id, 'm~other');
  assert.equal(map.milestones[0].features[0].title, 'Alpha · other tasks');
  const none = map.milestones.at(-1);
  assert.equal(none.id, '~none');
  assert.equal(none.title, 'Not in a milestone');
  assert.deepEqual(none.features.map(item => item.id).sort(), ['loose-epic', '~none~other']);
  assert.ok(!tasksOf(map).some(item => item.id === 'lonely-epic'), 'An epic with no children is not a task.');
  assert.equal(build([issue({ id: 'm', type: 'milestone' })]).milestones.at(-1).id, 'm', 'No synthetic milestone when nothing is outside.');
});

test('siblings are ordered by blocks, then created_at, then id; a cycle falls back to dates', () => {
  const items = [
    { id: 'c', created_at: '2026-10-01' }, { id: 'b', created_at: '2026-10-02' }, { id: 'a', created_at: '2026-10-03' },
  ];
  const blockers = { a: ['b'], b: ['c'] };
  assert.deepEqual(orderSiblings(items, item => blockers[item.id] ?? []).map(item => item.id), ['c', 'b', 'a']);
  const dated = [{ id: 'x', created_at: '2026-10-03' }, { id: 'y', created_at: '2026-10-01' }, { id: 'z', created_at: '2026-10-01' }];
  assert.deepEqual(orderSiblings(dated, () => []).map(item => item.id), ['y', 'z', 'x']);
  const cycle = { a: ['b'], b: ['a'] };
  assert.deepEqual(orderSiblings([{ id: 'a', created_at: '2026-10-02' }, { id: 'b', created_at: '2026-10-01' }], item => cycle[item.id] ?? []).map(item => item.id), ['b', 'a']);
  // Through the model: the blocked milestone comes after the one that blocks it, whatever the dates.
  const map = build([issue({ id: 'late', type: 'milestone', created: '2026-01-01T00:00:00Z', blocks: ['early'] }), issue({ id: 'early', type: 'milestone', created: '2026-02-01T00:00:00Z' })]);
  assert.deepEqual(map.milestones.map(item => item.id), ['early', 'late']);
});

test('every task state rule, first match winning', () => {
  const issues = [
    issue({ id: 'm', type: 'milestone' }), issue({ id: 'f', type: 'epic', parent: 'm' }),
    issue({ id: 'closed', parent: 'f', status: 'closed', labels: ['needs-owner'] }),
    issue({ id: 'asked', parent: 'f', status: 'in_progress' }),
    issue({ id: 'owner', parent: 'f', labels: ['needs-owner'] }),
    issue({ id: 'doing', parent: 'f', status: 'in_progress' }),
    issue({ id: 'next', parent: 'f' }),
    issue({ id: 'waits', parent: 'f', blocks: ['doing'] }),
    issue({ id: 'after-closed', parent: 'f', blocks: ['closed'] }),
    issue({ id: 'blocked', parent: 'f', status: 'blocked' }),
    issue({ id: 'deferred', parent: 'f', status: 'deferred' }),
  ];
  const map = build(issues, { asks: [{ id: 'ask-1', bead: 'asked', state: 'open' }, { id: 'ask-2', bead: 'next', state: 'answered' }] });
  const states = Object.fromEntries(tasksOf(map).map(item => [item.id, item.state]));
  assert.deepEqual(states, { closed: 'done', asked: 'you', owner: 'you', doing: 'doing', next: 'next', waits: 'later', 'after-closed': 'next', blocked: 'later', deferred: 'later' });
  assert.equal(task(map, 'asked').ask, 'ask-1');
  assert.deepEqual(task(map, 'waits').deps, ['doing']);
});

test('the rollup', () => {
  assert.equal(roll(['done', 'done']), 'done');
  assert.equal(roll(['done', 'you', 'doing']), 'you');
  assert.equal(roll(['later', 'doing', 'next']), 'doing');
  assert.equal(roll(['later', 'next']), 'next');
  assert.equal(roll(['done', 'later']), 'doing');
  assert.equal(roll(['later', 'later']), 'later');
  assert.equal(roll([]), 'later');
  const map = build([issue({ id: 'm', type: 'milestone' }), issue({ id: 'f', type: 'epic', parent: 'm' }), issue({ id: 'a', parent: 'f', status: 'closed' }), issue({ id: 'b', parent: 'f', status: 'blocked' })]);
  assert.equal(map.milestones[0].features[0].state, 'doing');
  assert.equal(map.milestones[0].state, 'doing');
});

test('signs: working, idle, new, PR, CI, review and deployed, from the events that name the bead', () => {
  const issues = [
    issue({ id: 'm', type: 'milestone' }), issue({ id: 'f', type: 'epic', parent: 'm' }),
    ...['working', 'idle', 'fresh', 'pr', 'merged', 'ci', 'ci-ok', 'review', 'deployed', 'done-idle'].map(id => issue({ id, parent: 'f', status: id === 'done-idle' ? 'closed' : 'open' })),
  ];
  const at = minutes => minutesAgo(NOW, minutes);
  const events = [
    eventJson({ kind: 'session-started', ts: at(50), bead: 'idle' }), eventJson({ kind: 'session-ended', ts: at(40), bead: 'idle' }),
    eventJson({ kind: 'session-ended', ts: at(60), bead: 'working' }), eventJson({ kind: 'session-started', ts: at(5), bead: 'working' }),
    eventJson({ kind: 'pr-opened', ts: at(30), bead: 'pr', url: 'https://example.test/pr/1' }),
    eventJson({ kind: 'pr-opened', ts: at(30), bead: 'merged' }), eventJson({ kind: 'pr-merged', ts: at(20), bead: 'merged' }),
    eventJson({ kind: 'ci-passed', ts: at(30), bead: 'ci' }), eventJson({ kind: 'ci-failed', ts: at(20), bead: 'ci' }),
    eventJson({ kind: 'ci-failed', ts: at(30), bead: 'ci-ok' }), eventJson({ kind: 'ci-passed', ts: at(20), bead: 'ci-ok' }),
    eventJson({ kind: 'ready-for-review', ts: at(10), bead: 'review' }),
    eventJson({ kind: 'deployed', ts: at(10), bead: 'deployed' }),
    eventJson({ kind: 'session-started', ts: at(10), bead: 'done-idle' }),
  ];
  const map = build(issues, { events });
  const signs = id => task(map, id).signs;
  assert.deepEqual(signs('working'), ['working']);
  assert.deepEqual(signs('idle'), ['idle']);
  assert.deepEqual(signs('fresh'), ['new']);
  assert.deepEqual(signs('pr'), ['pr']);
  assert.equal(task(map, 'pr').prUrl, 'https://example.test/pr/1');
  assert.deepEqual(signs('merged'), []);
  assert.deepEqual(signs('ci'), ['ci-failed']);
  assert.deepEqual(signs('ci-ok'), []);
  assert.deepEqual(signs('review'), ['review']);
  assert.deepEqual(signs('deployed'), ['deployed']);
  assert.deepEqual(signs('done-idle'), [], 'A closed task gets no session sign.');
});

test('prs: every pull request a task had, open or merged, and none when there is none', () => {
  const issues = [
    issue({ id: 'm', type: 'milestone' }), issue({ id: 'f', type: 'epic', parent: 'm' }),
    ...['open', 'same', 'bare', 'none', 'closed'].map(id => issue({ id, parent: 'f', status: id === 'closed' ? 'closed' : 'open' })),
  ];
  const at = minutes => minutesAgo(NOW, minutes);
  const events = [
    eventJson({ kind: 'pr-opened', ts: at(30), bead: 'open', url: 'https://example.test/pr/1' }),
    eventJson({ kind: 'pr-opened', ts: at(50), bead: 'same', url: 'https://example.test/pr/2' }), eventJson({ kind: 'pr-merged', ts: at(40), bead: 'same', url: 'https://example.test/pr/2' }),
    eventJson({ kind: 'pr-opened', ts: at(30), bead: 'bare' }), eventJson({ kind: 'pr-merged', ts: at(20), bead: 'bare' }),
    eventJson({ kind: 'pr-opened', ts: at(60), bead: 'closed', url: 'https://example.test/pr/3' }), eventJson({ kind: 'pr-merged', ts: at(55), bead: 'closed', url: 'https://example.test/pr/3' }),
  ];
  const map = build(issues, { events });
  const prs = id => task(map, id).prs;
  assert.deepEqual(prs('open')?.map(({ url, state }) => ({ url, state })), [{ url: 'https://example.test/pr/1', state: 'open' }]);
  assert.equal(task(map, 'open').prUrl, 'https://example.test/pr/1', 'prUrl still means the open one.');
  assert.deepEqual(prs('same')?.map(({ url, state }) => ({ url, state })), [{ url: 'https://example.test/pr/2', state: 'merged' }]);
  assert.equal(prs('same')[0].at, iso(at(40)), 'The entry carries the latest event.');
  assert.equal(prs('bare').length, 1);
  assert.equal(prs('bare')[0].state, 'merged');
  assert.equal('url' in prs('bare')[0], false);
  assert.equal('prs' in task(map, 'none'), false);
  assert.equal(task(map, 'closed').prs[0].state, 'merged', 'A closed task keeps its PRs.');
});

test('the CUJ 2 copy: Milestone 2 has seven tasks, four on sprint-3, and the signs from its events', () => {
  const { issues, events } = cujTwo({ now: NOW });
  const meta = { pushedAt: minutesAgo(NOW, 20).toISOString(), host: 'pc.example.test', count: issues.length, repo: 'example/magic-loops' };
  const map = buildMap({ project: 'magic-loops', meta, issues, events, now: NOW });
  assert.equal(map.ageMinutes, 20);
  assert.deepEqual(map.milestones.map(item => item.id), ['ml-m1', 'ml-m2', 'ml-m3']);
  assert.equal(map.milestones[1].features[0].title, 'Wall-jump');
  assert.equal(map.milestones[1].features[0].tasks.length, 7);
  assert.deepEqual(map.sprints, [{ name: 'sprint-3', milestones: [{ id: 'ml-m2', count: 4, total: 7 }] }]);
  assert.deepEqual(task(map, 'ml-wj-t3').signs, ['working']);
  assert.deepEqual(task(map, 'ml-wj-t5').signs, ['pr']);
  assert.equal(map.milestones[0].state, 'done');
  assert.equal(buildMap({ project: 'x', now: NOW }).ageMinutes, null);
});

test('sprint bands span the milestones they touch, ordered by their earliest task', () => {
  const map = build([
    issue({ id: 'm1', type: 'milestone' }), issue({ id: 'm2', type: 'milestone', created: '2026-10-02T00:00:00Z' }),
    issue({ id: 'a', parent: 'm1', labels: ['sprint:two'], created: '2026-10-05T00:00:00Z' }),
    issue({ id: 'b', parent: 'm2', labels: ['sprint:two', 'sprint:one'], created: '2026-10-04T00:00:00Z' }),
    issue({ id: 'c', parent: 'm2', labels: ['sprint:one'], created: '2026-10-03T00:00:00Z' }),
    issue({ id: 'd', parent: 'm2', created: '2026-10-06T00:00:00Z' }),
  ]);
  assert.deepEqual(map.sprints, [
    { name: 'one', milestones: [{ id: 'm2', count: 2, total: 3 }] },
    { name: 'two', milestones: [{ id: 'm1', count: 1, total: 1 }, { id: 'm2', count: 1, total: 3 }] },
  ]);
});

const MAP_BODY = 'Intro.\n\n## Destination\n\nA **calm**, `fast` [Roadmap](https://example.test/x) that\nreads in _one_ line.\n\nSecond paragraph.\n\n## Other\n\nNot this.';
const wayMap = (extra = {}) => issue({ id: 'wf', type: 'epic', labels: ['wayfinder:map'], description: MAP_BODY, updated: '2026-10-20T10:00:00Z', ...extra });

test('wayfinder: the destination is the first paragraph under the heading, as plain text', () => {
  const map = build([wayMap()]);
  assert.equal(map.wayfinder.destination, 'A calm, fast Roadmap that reads in one line.');
});

test('wayfinder: a long destination is clipped to 280 characters with an ellipsis', () => {
  const map = build([wayMap({ description: `## Destination\n\n${'word '.repeat(100)}` })]);
  assert.equal(map.wayfinder.destination.length, 280);
  assert.ok(map.wayfinder.destination.endsWith('…'));
});

test('wayfinder: closed children are the decisions; open wayfinder children are the questions, oldest first, at most 8', () => {
  const kids = [
    issue({ id: 'd1', parent: 'wf', status: 'closed', closed: '2026-10-05T10:00:00Z', labels: ['wayfinder:decision'], created: '2026-10-02T10:00:00Z' }),
    issue({ id: 'd2', parent: 'wf', status: 'closed', closed: '2026-10-06T10:00:00Z', created: '2026-10-02T11:00:00Z' }),
    issue({ id: 'plain', parent: 'wf', created: '2026-10-02T12:00:00Z' }),
    ...Array.from({ length: 10 }, (_, index) => issue({ id: `q${String(index).padStart(2, '0')}`, title: `Question ${index}`, parent: 'wf', labels: ['wayfinder:question'], created: `2026-10-03T10:${String(59 - index).padStart(2, '0')}:00Z` })),
  ];
  const way = build([wayMap(), ...kids]).wayfinder;
  assert.equal(way.decisions, 2);
  assert.equal(way.open.length, 8);
  assert.deepEqual(way.open.slice(0, 2).map(item => [item.id, item.title, item.type]), [['q09', 'Question 9', 'question'], ['q08', 'Question 8', 'question']]);
  assert.ok(!way.open.some(item => item.id === 'plain'), 'An open child without a wayfinder label is not a question.');
});

test('wayfinder: a map without the heading has no destination and still counts', () => {
  const way = build([wayMap({ description: 'Just notes.' }), issue({ id: 'd', parent: 'wf', status: 'closed', closed: '2026-10-05T10:00:00Z' })]).wayfinder;
  assert.deepEqual(way, { destination: null, decisions: 1, open: [] });
});

test('wayfinder: the newest updated map wins, a closed map is ignored, and no map gives null', () => {
  const older = wayMap({ id: 'old', description: '## Destination\n\nOld.', updated: '2026-10-01T10:00:00Z' });
  const newer = wayMap({ id: 'new', description: '## Destination\n\nNew.', updated: '2026-10-25T10:00:00Z' });
  const closed = wayMap({ id: 'shut', description: '## Destination\n\nShut.', updated: '2026-10-26T10:00:00Z', status: 'closed', closed: '2026-10-26T10:00:00Z' });
  assert.equal(build([older, newer, closed]).wayfinder.destination, 'New.');
  assert.equal(build([closed]).wayfinder, null);
  assert.equal(build([issue({ id: 'm', type: 'milestone' })]).wayfinder, null);
});

// The sheet's notes: summary, Beads PRs, the reason a task is yellow, close info and Library cards.
const withExtra = (base, extra) => ({ ...base, ...extra });
const LIBRARY = {
  'agent-plans/2026-10-27_plan': { title: 'Mission control', href: '/agent-plans#/mission-control' },
  'agent-plans#mission-control': { title: 'Mission control', href: '/agent-plans#/mission-control' },
  'magic-loops/own': { title: 'Own card', href: '/magic-loops#/own' },
  'magic-loops/from-event': { title: 'Event card', href: '/magic-loops#/from-event' },
};
const lookup = ref => LIBRARY[ref] ?? null;

test('notes: a task carries its summary, and none for a hash-only description', () => {
  const map = build([
    issue({ id: 'm', type: 'milestone' }), issue({ id: 'f', type: 'epic', parent: 'm' }),
    issue({ id: 'said', parent: 'f', description: 'Copy the weekly backups off the host so one dead disk loses nothing.\n\nBackfilled 2026-10-26 from git, PRs and cards.' }),
    issue({ id: 'hash', parent: 'f', description: 'a62a2bb4\n\nBackfilled 2026-10-26 from git, PRs and cards.' }),
  ]);
  assert.equal(task(map, 'said').summary, 'Copy the weekly backups off the host so one dead disk loses nothing.');
  assert.equal('summary' in task(map, 'hash'), false);
  assert.deepEqual(task(map, 'hash').commits, [{ sha: 'a62a2bb4' }], 'The commit is listed, without a link when no repo is known.');
});

test('notes: Beads PRs merge with event rows; the event keeps its state, a closed task defaults to merged', () => {
  const issues = [
    issue({ id: 'm', type: 'milestone' }), issue({ id: 'f', type: 'epic', parent: 'm' }),
    withExtra(issue({ id: 'both', parent: 'f' }), { external_ref: 'gh-5', description: 'Do it.\n\nPR: #5 open' }),
    withExtra(issue({ id: 'old', parent: 'f', status: 'closed', closed: '2026-10-01T10:00:00Z' }), { external_ref: 'gh-138', description: 'PR: #138 merged' }),
    withExtra(issue({ id: 'bare', parent: 'f', status: 'closed', closed: '2026-10-01T10:00:00Z' }), { external_ref: 'gh-9' }),
    withExtra(issue({ id: 'openbare', parent: 'f' }), { external_ref: 'gh-10' }),
  ];
  const events = [
    eventJson({ kind: 'pr-opened', ts: minutesAgo(NOW, 30), bead: 'both', url: 'https://github.com/someone/some_repo/pull/5' }),
    eventJson({ kind: 'pr-merged', ts: minutesAgo(NOW, 10), bead: 'both', url: 'https://github.com/someone/some_repo/pull/5' }),
  ];
  const map = build(issues, { events, repo: 'git@github.com:someone/some_repo.git' });
  assert.deepEqual(task(map, 'both').prs.map(({ number, url, state }) => ({ number, url, state })), [{ number: 5, url: 'https://github.com/someone/some_repo/pull/5', state: 'merged' }], 'The event row wins the state and is not doubled.');
  assert.deepEqual(task(map, 'old').prs, [{ number: 138, url: 'https://github.com/someone/some_repo/pull/138', state: 'merged' }]);
  assert.equal(task(map, 'bare').prs[0].state, 'merged', 'A closed task with no stated state is merged.');
  assert.equal('state' in task(map, 'openbare').prs[0], false, 'An open one with no stated state has none.');
  const noRepo = build(issues);
  assert.equal('url' in task(noRepo, 'old').prs[0], false);
});

test('notes: you says why a task is yellow, an Ask first', () => {
  const map = build([
    issue({ id: 'm', type: 'milestone' }), issue({ id: 'f', type: 'epic', parent: 'm' }),
    issue({ id: 'label', parent: 'f', labels: ['needs-owner'] }), issue({ id: 'ask', parent: 'f', labels: ['needs-owner'] }), issue({ id: 'plain', parent: 'f' }),
  ], { asks: [{ id: 'a1', bead: 'ask', state: 'open' }] });
  assert.equal(task(map, 'label').you, 'label');
  assert.equal(task(map, 'ask').you, 'ask');
  assert.equal('you' in task(map, 'plain'), false);
});

test('notes: features and milestones that are issues carry summary, close info and cards; the made-up ones do not', () => {
  const map = build([
    withExtra(issue({ id: 'm', type: 'milestone', status: 'closed', closed: '2026-10-18T09:00:00Z', description: 'Everything needed to ship the first level.' }), { close_reason: 'Shipped' }),
    issue({ id: 'f', type: 'epic', parent: 'm', description: 'Movement kit for the hero with jumps and slides.' }),
    issue({ id: 'direct', parent: 'm' }),
  ]);
  const milestone = map.milestones[0];
  assert.deepEqual([milestone.summary, milestone.closedAt, milestone.closeReason], ['Everything needed to ship the first level.', '2026-10-18T09:00:00Z', 'Shipped']);
  assert.equal(milestone.features[0].summary, 'Movement kit for the hero with jumps and slides.');
  const other = milestone.features.find(feature => feature.id === 'm~other');
  assert.deepEqual(Object.keys(other).sort(), ['id', 'state', 'tasks', 'title']);
});

test('notes: cards resolve through the Library, own before events, unresolved dropped, five at most', () => {
  const issues = [
    issue({ id: 'm', type: 'milestone' }), issue({ id: 'f', type: 'epic', parent: 'm' }),
    withExtra(issue({ id: 't', parent: 'f' }), { metadata: { cards: 'magic-loops/own,nowhere/missing' }, description: 'https://site.example/agent-plans#/mission-control' }),
    withExtra(issue({ id: 'many', parent: 'f' }), { metadata: { cards: ['a/1', 'a/2', 'a/3', 'a/4', 'a/5', 'a/6', 'a/7'] } }),
  ];
  const events = [eventJson({ kind: 'pr-opened', bead: 't', extra: { cardDir: 'magic-loops/from-event' } }), eventJson({ kind: 'pr-opened', bead: 't', extra: { cardDir: 'magic-loops/own' } })];
  const map = build(issues, { events, cards: lookup });
  assert.deepEqual(task(map, 't').cards.map(card => card.title), ['Own card', 'Mission control', 'Event card']);
  assert.equal(task(map, 't').cards[1].href, '/agent-plans#/mission-control');
  const crowded = build(issues, { cards: ref => ({ title: ref, href: `/${ref}` }) });
  assert.equal(task(crowded, 'many').cards.length, 5);
  assert.equal('cards' in task(build(issues), 't'), false, 'Without a resolver nothing is linked.');
});
