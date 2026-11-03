// The Roadmap filter (src/hub/mapFilter.ts) and what the layout does with what it hides: pure TypeScript, imported straight by Node.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ALL_FILTER, DOING_FILTER, OPEN_FILTER, filterLabel, filterMap, isOpenFilter, parseFilter, presetOf } from '../../../src/hub/mapFilter.ts';
import { layoutMap } from '../../../src/hub/mapLayout.ts';
import { everythingOpen, snapshotModel } from './snapshots/hub-map-layout-model.mjs';

const NOW = Date.parse('2026-11-01T12:00:00Z');
const daysAgo = days => new Date(NOW - days * 86_400_000).toISOString();
const task = (id, state, age) => ({ id, title: id, state, status: state, signs: [], deps: [], sprints: [], prs: [], ...(age === undefined ? {} : { updatedAt: daysAgo(age) }) });
const feature = (id, tasks) => ({ id, title: id, state: 'doing', tasks });
const milestone = (id, features) => ({ id, title: id, state: 'doing', features });
const model = milestones => ({ project: 'p', meta: null, ageMinutes: null, milestones, sprints: [] });
const ids = map => map.milestones.flatMap(m => m.features.flatMap(f => f.tasks.map(t => t.id)));
const sample = () => model([
  milestone('m1', [feature('f1', [task('a', 'done', 100), task('b', 'done', 2)])]),
  milestone('m2', [feature('f2', [task('c', 'doing', 1), task('d', 'next', 20), task('e', 'done', 3)]), feature('f3', [task('f', 'later', 60), task('g', 'you', 5)])]),
  milestone('m3', [feature('f4', [task('h', 'later', 200)])]),
]);

test('Open (the default) hides done tasks and keeps every other state', () => {
  const { model: shown } = filterMap(sample(), OPEN_FILTER, NOW);
  assert.deepEqual(ids(shown), ['c', 'd', 'f', 'g', 'h']);
  assert.ok(isOpenFilter(OPEN_FILTER) && !isOpenFilter(ALL_FILTER));
  assert.equal(presetOf(OPEN_FILTER), 'open');
  assert.equal(presetOf(DOING_FILTER), 'doing');
  assert.equal(presetOf(ALL_FILTER), 'all');
});

test('All returns the very same model and hides nothing', () => {
  const full = sample();
  const { model: shown, hidden } = filterMap(full, ALL_FILTER, NOW);
  assert.equal(shown, full);
  assert.equal(hidden.size, 0);
});

test('In progress only shows the doing tasks', () => {
  assert.deepEqual(ids(filterMap(sample(), DOING_FILTER, NOW).model), ['c']);
});

test('a custom choice of states', () => {
  const filter = { ...OPEN_FILTER, states: ['you', 'done'] };
  assert.deepEqual(ids(filterMap(sample(), filter, NOW).model), ['a', 'b', 'e', 'g']);
  assert.equal(presetOf(filter), null);
});

test('updated within N days', () => {
  assert.deepEqual(ids(filterMap(sample(), { ...ALL_FILTER, within: 7 }, NOW).model), ['b', 'c', 'e', 'g']);
  assert.deepEqual(ids(filterMap(sample(), { ...OPEN_FILTER, within: 30 }, NOW).model), ['c', 'd', 'g']);
  assert.deepEqual(ids(filterMap(sample(), { ...ALL_FILTER, within: 90 }, NOW).model), ['b', 'c', 'd', 'e', 'f', 'g']);
});

test('the date falls back to closed, then created; a task with no date fails a date filter', () => {
  const closed = { ...task('x', 'done'), closedAt: daysAgo(3) };
  const created = { ...task('y', 'next'), createdAt: daysAgo(4) };
  const undated = task('z', 'next');
  const map = model([milestone('m', [feature('f', [closed, created, undated])])]);
  assert.deepEqual(ids(filterMap(map, { ...ALL_FILTER, within: 7 }, NOW).model), ['x', 'y']);
  assert.deepEqual(ids(filterMap(map, ALL_FILTER, NOW).model), ['x', 'y', 'z']);
});

test('a custom from-to range includes both end days', () => {
  const at = (id, day) => ({ ...task(id, 'next'), updatedAt: new Date(`${day}T12:00:00`).toISOString() });
  const map = model([milestone('m', [feature('f', [at('a', '2026-10-09'), at('b', '2026-10-10'), at('c', '2026-10-12'), at('d', '2026-10-13')])])]);
  assert.deepEqual(ids(filterMap(map, { ...ALL_FILTER, from: '2026-10-10', to: '2026-10-12' }, NOW).model), ['b', 'c']);
  assert.deepEqual(ids(filterMap(map, { ...ALL_FILTER, from: '2026-10-12' }, NOW).model), ['c', 'd']);
  assert.deepEqual(ids(filterMap(map, { ...ALL_FILTER, to: '2026-10-10' }, NOW).model), ['a', 'b']);
});

test('a milestone stays while a child matches; features without a match go; counts say what was hidden', () => {
  const { model: shown, hidden } = filterMap(sample(), OPEN_FILTER, NOW);
  assert.deepEqual(shown.milestones.map(m => m.id), ['m1', 'm2', 'm3'], 'every milestone stays');
  assert.deepEqual(shown.milestones[1].features.map(f => f.id), ['f2', 'f3']);
  assert.deepEqual(shown.milestones[0].features, [], 'm1 has nothing left');
  assert.deepEqual(hidden.get('m1'), { n: 2, done: 2, later: 0 });
  assert.deepEqual(hidden.get('m2'), { n: 1, done: 1, later: 0 });
  assert.deepEqual(hidden.get('f2'), { n: 1, done: 1, later: 0 });
  assert.equal(hidden.has('f3'), false, 'a feature that lost nothing');
  assert.equal(hidden.has('m3'), false);
  const doing = filterMap(sample(), DOING_FILTER, NOW);
  assert.deepEqual(doing.model.milestones[1].features.map(f => f.id), ['f2'], 'f3 had no match');
  assert.deepEqual(doing.hidden.get('m2'), { n: 4, done: 1, later: 0 });
  assert.deepEqual(doing.hidden.get('m3'), { n: 1, done: 0, later: 0 });
});

test('the layout: a milestone the filter leaves no task keeps its ring and its count; nothing reads "hidden"', () => {
  const { model: shown, hidden } = filterMap(sample(), OPEN_FILTER, NOW);
  const layout = layoutMap(shown, new Set(['m1', 'm2']), false, 'x', hidden);
  const m1 = layout.nodes.find(n => n.id === 'm1');
  assert.equal(m1.bare, true);
  assert.equal(m1.open, false, 'a milestone with nothing shown does not open');
  assert.equal(m1.radius, 26, 'it keeps its ring');
  assert.equal(m1.label.count, '2 of 2 done');
  assert.deepEqual([m1.done, m1.total], [2, 2], 'the ring counts what the milestone holds, not what the filter shows');
  const m2 = layout.nodes.find(n => n.id === 'm2');
  assert.equal(m2.bare, false);
  assert.equal(m2.hidden, 1);
  assert.equal(m2.label.count, '1 of 5 done');
  const f2 = layout.nodes.find(n => n.id === 'f2');
  assert.equal(f2.hidden, 1);
  assert.equal(f2.words, '1 of 3 done');
  const vertical = layoutMap(shown, new Set(['m2']), false, 'y', hidden);
  assert.equal(vertical.nodes.find(n => n.id === 'm1').label.sub, '2 of 2 done');
  for (const node of [...layout.nodes, ...vertical.nodes]) assert.ok(!JSON.stringify(node.label).includes('hidden'), `${node.id} says nothing is hidden`);
});

test('"now" counts what the filter hid: done work behind it still moves it along', () => {
  const full = layoutMap(sample(), new Set(), false);
  const { model: shown, hidden } = filterMap(sample(), OPEN_FILTER, NOW);
  const filtered = layoutMap(shown, new Set(), false, 'x', hidden);
  assert.ok(filtered.now.x > filtered.nodes.find(n => n.id === 'm2').x, 'now is past the start of the first unfinished milestone');
  assert.ok(Math.abs(filtered.now.x - full.now.x) < 120, 'close to where the unfiltered map puts it');
});

test('a layout with no filter is the layout it was', () => {
  const m = snapshotModel();
  const all = filterMap(m, ALL_FILTER);
  assert.deepEqual(layoutMap(all.model, everythingOpen(m), true, 'x', all.hidden), layoutMap(m, everythingOpen(m), true));
});

test('the Open layout is recorded', () => {
  const recorded = JSON.parse(readFileSync(new URL('./snapshots/hub-map-layout-open.json', import.meta.url), 'utf8'));
  const m = snapshotModel();
  const { model: shown, hidden } = filterMap(m, OPEN_FILTER, NOW);
  const spelled = value => JSON.parse(JSON.stringify(value, (key, item) => (item === Infinity ? 'Infinity' : item === -Infinity ? '-Infinity' : item)));
  assert.deepEqual(spelled(layoutMap(shown, everythingOpen(shown), true, 'x', hidden)), recorded.open);
  assert.deepEqual(spelled(layoutMap(shown, new Set(), false, 'x', hidden)), recorded.closed);
});

test('a stored filter that is bad or missing falls back to Open', () => {
  assert.equal(parseFilter(null), OPEN_FILTER);
  assert.equal(parseFilter('x'), OPEN_FILTER);
  assert.equal(parseFilter({ states: [] }), OPEN_FILTER);
  assert.equal(parseFilter({ states: 'doing' }), OPEN_FILTER);
  assert.deepEqual(parseFilter({ states: ['done', 'bogus', 'doing'], within: 30, from: 'nope', to: '2026-10-12' }), { states: ['doing', 'done'], within: 30, from: '', to: '2026-10-12' });
  assert.equal(parseFilter({ states: ['doing'], within: 12 }).within, null);
  assert.deepEqual(parseFilter({ states: ['doing'], within: 7, from: '2026-10-12', to: '2026-10-03' }), { states: ['doing'], within: null, from: '', to: '' }, 'a range that ends before it starts is dropped');
  assert.deepEqual(parseFilter({ states: ['doing'], from: '2026-10-03', to: '2026-10-03' }).from, '2026-10-03', 'one day is a range');
});

test('the chip says what is on', () => {
  assert.equal(filterLabel(OPEN_FILTER), 'Open');
  assert.equal(filterLabel({ ...OPEN_FILTER, within: 30 }), 'Open · 30 d');
  assert.equal(filterLabel(ALL_FILTER), 'All');
  assert.equal(filterLabel({ ...DOING_FILTER, from: '2026-10-03', to: '2026-10-09' }), 'In progress only · 3 Oct to 9 Oct');
  assert.equal(filterLabel({ ...OPEN_FILTER, states: ['you', 'done'] }), 'Needs you, Done');
});
