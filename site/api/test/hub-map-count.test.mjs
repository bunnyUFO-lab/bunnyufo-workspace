// What a ring on the progress map counts, in words (src/hub/mapCount.ts) and how the layout uses it:
// done means closed, deferred work is counted apart and never open, nested containers count their leaves.
import test from 'node:test';
import assert from 'node:assert/strict';
import { isLaterOnly, tallyFraction, tallyOf, tallyWords, withHidden } from '../../../src/hub/mapCount.ts';
import { layoutMap } from '../../../src/hub/mapLayout.ts';
import { filterMap, OPEN_FILTER } from '../../../src/hub/mapFilter.ts';
import { buildMap } from '../hub-map.mjs';
import { beadsIssue as issue } from './hub-fixtures.mjs';

const task = (id, state, status = state === 'done' ? 'closed' : state === 'later' ? 'blocked' : 'open') => ({ id, title: id, state, status, signs: [], deps: [], sprints: [], prs: [] });
const deferred = id => task(id, 'later', 'deferred');
const many = (count, make) => Array.from({ length: count }, (_, k) => make(`t${k}`));

test('closed tasks are done, deferred ones are later, everything is in the total', () => {
  const tally = tallyOf([task('a', 'done'), task('b', 'doing'), task('c', 'next'), deferred('d'), task('e', 'later')]);
  assert.deepEqual(tally, { done: 1, later: 1, total: 5 });
  assert.equal(tallyWords(tally), '1 of 5 done · 1 later', 'a blocked task is open work, not later');
});

test('the words say done; later is added apart only when there is some', () => {
  assert.equal(tallyWords(tallyOf([...many(24, id => task(id, 'done')), deferred('x')])), '24 of 25 done · 1 later');
  assert.equal(tallyWords(tallyOf(many(25, id => task(id, 'done')))), '25 of 25 done');
  assert.equal(tallyWords(tallyOf([task('a', 'doing'), task('b', 'next')])), '0 of 2 done');
  assert.equal(tallyWords(tallyOf([])), 'no tasks yet');
});

test('a ring holding only deferred work reads "n later", not "0 of n done"', () => {
  const tally = tallyOf(many(9, deferred));
  assert.equal(tallyWords(tally), '9 later');
  assert.ok(isLaterOnly(tally));
  assert.ok(!isLaterOnly(tallyOf([deferred('a'), task('b', 'doing')])));
  assert.ok(!isLaterOnly(tallyOf([])));
});

test('a closed task is done even if Beads kept the deferred status; the fill is the done fraction of everything', () => {
  assert.deepEqual(tallyOf([{ state: 'done', status: 'deferred' }]), { done: 1, later: 0, total: 1 });
  assert.equal(tallyFraction({ done: 24, later: 1, total: 25 }), 0.96);
  assert.equal(tallyFraction({ done: 0, later: 0, total: 0 }), 0);
});

test('what the filter hid is added back', () => {
  assert.deepEqual(withHidden({ done: 1, later: 0, total: 2 }, { n: 3, done: 2, later: 1 }), { done: 3, later: 1, total: 5 });
  assert.deepEqual(withHidden({ done: 1, later: 0, total: 2 }), { done: 1, later: 0, total: 2 });
});

const feature = (id, tasks) => ({ id, title: id, state: 'doing', tasks });
const milestone = (id, features) => ({ id, title: id, state: 'doing', features });
const model = milestones => ({ project: 'p', meta: null, ageMinutes: null, milestones, sprints: [] });
const sample = () => model([
  milestone('shipped', [feature('s1', many(4, id => task(`a${id}`, 'done')))]),
  milestone('mostly', [feature('m1', [...many(3, id => task(`b${id}`, 'done')), deferred('bd'), task('bo', 'doing')])]),
  milestone('later', [feature('l1', many(3, id => deferred(`c${id}`))), feature('l2', many(2, id => deferred(`d${id}`)))]),
]);

test('the layout: every milestone and feature carries its words; a later-only one is muted', () => {
  for (const axis of ['x', 'y']) {
    const layout = layoutMap(sample(), new Set(['shipped', 'mostly', 'later']), false, axis);
    const by = id => layout.nodes.find(node => node.id === id);
    assert.equal(by('shipped').words, '4 of 4 done');
    assert.equal(by('mostly').words, '3 of 5 done · 1 later');
    assert.equal(by('later').words, '5 later');
    assert.deepEqual([by('later').muted, by('mostly').muted, by('shipped').muted], [true, false, false]);
    assert.equal(by('l1').words, '3 later');
    assert.equal(axis === 'x' ? by('mostly').label.count : by('mostly').label.sub, '3 of 5 done · 1 later');
  }
});

test('a fully done milestone under the Open filter keeps its ring and its count, with no "hidden"', () => {
  const full = sample();
  const { model: shown, hidden } = filterMap(full, OPEN_FILTER, Date.now());
  const layout = layoutMap(shown, new Set(), false, 'x', hidden);
  const shipped = layout.nodes.find(node => node.id === 'shipped');
  assert.equal(shipped.radius, 26);
  assert.equal(shipped.words, '4 of 4 done');
  assert.deepEqual(layoutMap(shown, new Set(), false, 'x', hidden).nodes.filter(node => node.kind === 'm').map(node => node.words), layoutMap(full, new Set(), false).nodes.filter(node => node.kind === 'm').map(node => node.words), 'the words do not depend on the filter');
});

test('"now" skips a milestone that holds only deferred work, and deferred tasks are not open work', () => {
  const layout = layoutMap(model([milestone('a', [feature('f', many(2, id => task(id, 'done')))]), milestone('b', [feature('g', many(3, deferred))])]), new Set(), false);
  assert.equal(layout.now.x, layout.width - 40, 'with nothing open, now is at the end');
});

const container = (issues) => buildMap({ project: 'p', issues, now: new Date('2026-11-03T12:00:00Z') });

test('nested containers count their leaves, a deferred bead is counted apart, and a closed container is not a task', () => {
  const map = container([
    issue({ id: 'm', type: 'milestone', status: 'closed' }),
    issue({ id: 'repo', type: 'epic', parent: 'm', status: 'closed' }),
    issue({ id: 'sub', type: 'epic', parent: 'repo', status: 'closed' }),
    issue({ id: 't1', parent: 'sub', status: 'closed' }),
    issue({ id: 't2', parent: 'repo', status: 'closed' }),
    issue({ id: 'later-epic', type: 'epic', labels: ['later'] }),
    issue({ id: 'd1', parent: 'later-epic', status: 'deferred' }),
    issue({ id: 'd2', parent: 'later-epic', status: 'deferred' }),
    issue({ id: 'stray' }),
  ]);
  const nodes = layoutMap(map, new Set(), false).nodes;
  const by = id => nodes.find(node => node.id === id);
  assert.equal(by('m').words, '2 of 2 done', 'the containers are not counted, their two leaves are');
  assert.equal(by('later-epic').words, '2 later', 'a deferred bead is later, never open');
  assert.equal(by('later-epic').muted, true);
  assert.equal(by('~none').words, '0 of 1 done', 'only the bead with no parent epic is outside every milestone');
});
