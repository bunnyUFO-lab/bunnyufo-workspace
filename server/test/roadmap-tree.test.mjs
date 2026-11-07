// The Roadmap accordion's tree (src/hub/roadmapTree.ts): nesting, order, what starts open, search, Hide completed, links to a row and what is stored.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTree, keepFor, keysOf, msKey, pageSize, pruneOpen, resolveTarget, rmKey, startOpen, storeKey, subLine, walk } from '../../src/hub/roadmapTree.ts';
import { mapMatches } from '../../src/hub/mapSearch.ts';
import { foldOpen, readOpen } from '../../src/ui/foldState.ts';
import { sprintModel } from '../../src/hub/sprintScope.ts';

const task = (id, state = 'next', extra = {}) => ({ id, title: `Task ${id}`, state, status: state === 'done' ? 'closed' : 'open', signs: [], sprints: [], deps: [], ...extra });
const feature = (id, tasks) => ({ id, title: `Feature ${id}`, state: 'next', tasks });
const milestone = (id, features, extra = {}) => {
  const states = features.flatMap(item => item.tasks.map(t => t.state));
  const state = states.length && states.every(s => s === 'done') ? 'done' : states.some(s => s === 'doing') ? 'doing' : 'next';
  return { id, title: `Milestone ${id}`, state, features, ...extra };
};
const model = (milestones, roadmaps = [], sprints = []) => ({ project: 'p', milestones, roadmaps, sprints, meta: {} });
const ids = nodes => nodes.map(node => node.id);
const flat = tree => { const out = []; walk(tree.roots, node => out.push(node.key)); return out; };

const nested = () => model([
  milestone('m-old', [feature('f0', [task('t0', 'done')])], { roadmap: 'r-a' }),
  milestone('m-now', [feature('f1', [task('t1', 'doing'), task('t2', 'done'), task('t3', 'next')])], { roadmap: 'r-b' }),
  milestone('m-loose', [feature('f2', [task('t4', 'next')])]),
], [
  { id: 'r-a', title: 'Alpha', state: 'done' },
  { id: 'r-top', title: 'Top', state: 'doing' },
  { id: 'r-b', title: 'Inside', state: 'doing', parent: 'r-top' },
]);

test('roadmaps nest and open rows come before finished ones; the unfiled row is one of the open rows', () => {
  const tree = buildTree(nested(), { hideDone: false });
  assert.deepEqual(ids(tree.roots), ['r-top', '~unfiled', 'r-a']);
  const top = tree.roots[0];
  assert.deepEqual(ids(top.children), ['r-b']);
  assert.deepEqual(ids(top.children[0].children), ['m-now']);
  assert.equal(top.tally.total, 3, 'A roadmap counts everything below it.');
});

test('a project with no roadmaps starts at milestones; a cycle in parents ends', () => {
  const plain = buildTree(model([milestone('a', [feature('f', [task('x', 'done')])]), milestone('b', [feature('g', [task('y')])])]), { hideDone: false });
  assert.deepEqual(ids(plain.roots), ['b', 'a'], 'Open first.');
  const cycle = model([milestone('m', [feature('f', [task('x')])], { roadmap: 'a' })], [{ id: 'a', title: 'A', state: 'next', parent: 'b' }, { id: 'b', title: 'B', state: 'next', parent: 'a' }]);
  assert.ok(flat(buildTree(cycle, { hideDone: false })).length < 10, 'The walk ends.');
});

test('tasks are listed open first, then finished', () => {
  const now = buildTree(nested(), { hideDone: false }).roots[0].children[0].children[0];
  assert.deepEqual(ids(now.tasks), ['t1', 't3', 't2']);
  assert.equal(now.all, 3);
});

test('what starts open: the current milestone and the roadmaps above it; nothing when everything is done; every fold with a sprint on', () => {
  const tree = buildTree(nested(), { hideDone: false });
  assert.equal(tree.current, msKey('m-now'));
  assert.deepEqual([...startOpen(tree, false)].sort(), [msKey('m-now'), rmKey('r-b'), rmKey('r-top')].sort());
  const done = buildTree(model([milestone('a', [feature('f', [task('x', 'done')])])]), { hideDone: false });
  assert.equal(startOpen(done, false).size, 0, 'Nothing is open when everything is done.');
  assert.deepEqual([...startOpen(tree, true)].sort(), [...keysOf(tree.roots)].sort());
});

test('with no work in hand the first milestone that is not done leads', () => {
  const later = task('d', 'later', { status: 'deferred' });
  const tree = buildTree(model([milestone('a', [feature('f', [task('x', 'done')])]), milestone('b', [feature('g', [later])])]), { hideDone: false });
  assert.equal(tree.current, msKey('b'));
});

test('the sprint view is flat and its folds start open', () => {
  const m = nested();
  m.milestones[1].features[0].tasks[0].sprints = ['s1'];
  const scoped = sprintModel({ ...m, sprints: [{ name: 's1', milestones: [{ id: 'm-now', count: 1, total: 3 }] }] }, 's1');
  const tree = buildTree(scoped, { hideDone: false });
  assert.deepEqual(ids(tree.roots), ['m-now']);
  assert.deepEqual([...startOpen(tree, true)], [msKey('m-now')]);
});

test('Hide completed drops finished roadmaps, milestones and done tasks; the tally still counts them', () => {
  const tree = buildTree(nested(), { hideDone: true });
  assert.deepEqual(ids(tree.roots), ['r-top', '~unfiled'], 'The finished roadmap is gone.');
  const now = tree.roots[0].children[0].children[0];
  assert.deepEqual(ids(now.tasks), ['t1', 't3']);
  assert.equal(now.tally.total, 3, 'The tally counts the done one.');
  assert.equal(now.all, 3);
});

test('a roadmap that is done stays while something open is inside it', () => {
  const m = model([milestone('m1', [feature('f', [task('x', 'done')])], { roadmap: 'p' }), milestone('m2', [feature('g', [task('y')])], { roadmap: 'c' })], [
    { id: 'p', title: 'Parent', state: 'done' }, { id: 'c', title: 'Child', state: 'next', parent: 'p' },
  ]);
  const tree = buildTree(m, { hideDone: true });
  assert.deepEqual(ids(tree.roots), ['p']);
  assert.deepEqual(ids(tree.roots[0].children), ['c'], 'The finished milestone is hidden, the open child stays.');
});

test('search: only matches and what holds them; a feature match shows all its tasks; a milestone that matches by name shows its details row; Hide completed does not apply', () => {
  const m = nested();
  const byFeature = buildTree(m, { hideDone: true, matches: mapMatches(m, 'Feature f1') });
  const now = byFeature.roots[0].children[0].children[0];
  assert.deepEqual(ids(now.tasks), ['t1', 't3', 't2'], 'All three, the done one too.');
  assert.equal(now.details, false);
  assert.equal(byFeature.current, undefined);
  const byMilestone = buildTree(m, { hideDone: false, matches: mapMatches(m, 'Milestone m-loose') });
  assert.deepEqual(ids(byMilestone.roots), ['~unfiled']);
  const loose = byMilestone.roots[0].children[0];
  assert.equal(loose.details, true);
  assert.deepEqual(loose.tasks, []);
  assert.deepEqual(ids(buildTree(m, { hideDone: false, matches: mapMatches(m, 't0') }).roots), ['r-a'], 'A hit in a finished roadmap shows.');
  assert.deepEqual(buildTree(m, { hideDone: false, matches: mapMatches(m, 'nothing at all') }).roots, []);
});

test('search never writes the open state: building with a match leaves what would be stored as it was', () => {
  const tree = buildTree(nested(), { hideDone: false });
  const stored = { [msKey('m-loose')]: true };
  const before = JSON.stringify(pruneOpen(stored, startOpen(tree, false), keysOf(tree.roots)));
  buildTree(nested(), { hideDone: false, matches: mapMatches(nested(), 'Task') });
  assert.equal(JSON.stringify(pruneOpen(stored, startOpen(tree, false), keysOf(tree.roots))), before);
});

test('links to a row: a bead opens its milestone and the roadmaps above; a feature shows on its milestone; roadmaps and ~unfiled are rows; the rest name nothing', () => {
  const m = nested();
  assert.deepEqual(resolveTarget(m, 't1'), { id: 't1', kind: 'task', reveal: [rmKey('r-top'), rmKey('r-b'), msKey('m-now')], task: 't1', milestone: 'm-now' });
  assert.equal(resolveTarget(m, 'f1').id, 'm-now');
  assert.equal(resolveTarget(m, 'f1').kind, 'milestone');
  assert.deepEqual(resolveTarget(m, 'm-now'), { id: 'm-now', kind: 'milestone', reveal: [rmKey('r-top'), rmKey('r-b')] });
  assert.deepEqual(resolveTarget(m, 'r-b'), { id: 'r-b', kind: 'roadmap', reveal: [rmKey('r-top')] });
  assert.deepEqual(resolveTarget(m, '~unfiled'), { id: '~unfiled', kind: 'roadmap', reveal: [] });
  assert.equal(resolveTarget(m, 't4').reveal[0], rmKey('~unfiled'));
  for (const bad of ['~full', undefined, 'nope', '']) assert.equal(resolveTarget(m, bad), null);
  assert.equal(resolveTarget(model([milestone('a', [feature('f', [task('x')])])]), '~unfiled'), null, 'No roadmaps, no unfiled row.');
});

test('the target passes Hide completed, and its page of tasks grows to hold it', () => {
  const m = nested();
  const tree = buildTree(m, { hideDone: true, keep: keepFor(resolveTarget(m, 't0')) });
  const old = tree.roots.find(node => node.id === 'r-a');
  assert.ok(old, 'The finished roadmap stays for the link.');
  assert.deepEqual(ids(old.children[0].tasks), ['t0']);
  const tasks = Array.from({ length: 50 }, (_, index) => task(`x${index}`));
  assert.equal(pageSize(tasks, 20, 20), 20);
  assert.equal(pageSize(tasks, 20, 20, 'x44'), 60, 'The page that holds the 45th task.');
  assert.equal(pageSize(tasks, 40, 20, 'x3'), 40, 'Never smaller than asked.');
});

test('only keys that differ from their start and that the model still has are stored', () => {
  const start = new Set(['m/a']);
  const keys = new Set(['m/a', 'm/b']);
  assert.deepEqual(pruneOpen({ 'm/a': true, 'm/b': false, 'm/gone': true }, start, keys), {});
  assert.deepEqual(pruneOpen({ 'm/a': false, 'm/b': true, 'm/gone': true }, start, keys), { 'm/a': false, 'm/b': true });
});

test('the store: a bad or blocked value reads as nothing, and a sprint has its own key', () => {
  assert.deepEqual(readOpen(null), {});
  assert.deepEqual(readOpen('not json'), {});
  assert.deepEqual(readOpen('[1]'), {});
  assert.deepEqual(readOpen('{"a":true,"b":3}'), { a: true });
  assert.equal(foldOpen('a', { a: false }, true), false);
  assert.equal(storeKey('p'), 'hub.roadmap.open.p');
  assert.equal(storeKey('p', 's5'), 'hub.roadmap.open.p.s5');
});

test('the sub line leaves the state word out when done and says Now only on the current milestone', () => {
  assert.equal(subLine({ now: true, state: 'doing', stateWord: 'in progress', tally: '3 of 8 done' }), 'Now · in progress · 3 of 8 done');
  assert.equal(subLine({ state: 'done', stateWord: 'done', tally: '8 of 8 done' }), '8 of 8 done');
});
