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
