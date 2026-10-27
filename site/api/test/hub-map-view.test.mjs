// The map's pan and zoom rules (src/hub/panZoom.ts) and where "now" sits (src/hub/mapLayout.ts):
// pure TypeScript, imported straight by Node.
import test from 'node:test';
import assert from 'node:assert/strict';
import { clampView, fitScale, fitView, keepPoint, limitsFor, viewAt, zoomAround } from '../../../src/hub/panZoom.ts';
import { layoutMap } from '../../../src/hub/mapLayout.ts';

const box = { w: 390, h: 300 };
const near = (a, b, message) => assert.ok(Math.abs(a - b) < 1e-6, `${message ?? ''} ${a} != ${b}`);

test('fit never enlarges past 1, and centres the content', () => {
  assert.equal(fitScale({ w: 200, h: 100 }, box), 1);
  assert.equal(fitScale({ w: 780, h: 150 }, box), 0.5);
  const view = fitView({ w: 780, h: 150 }, box);
  assert.deepEqual(view, { k: 0.5, x: 0, y: 112.5 });
  assert.deepEqual(fitView({ w: 100, h: 100 }, box), { k: 1, x: 145, y: 100 });
});

test('zoom limits: out a little past fit but never to a speck, in to 2.5', () => {
  assert.deepEqual(limitsFor({ w: 390, h: 100 }, box), { kMin: 0.5, kMax: 2.5 });
  const wide = limitsFor({ w: 3900, h: 100 }, box);
  near(wide.kMin, 0.09, 'a long map may zoom out to a bit past fit');
  assert.equal(limitsFor({ w: 3900, h: 100 }, box).kMax, 2.5);
});

test('zooming around a point keeps the content under it where it is', () => {
  const limits = { kMin: 0.5, kMax: 2.5 };
  const start = { x: 30, y: 20, k: 1 };
  const point = { x: 200, y: 150 };
  const before = { x: (point.x - start.x) / start.k, y: (point.y - start.y) / start.k };
  const next = zoomAround(start, point, 1.5, limits);
  assert.equal(next.k, 1.5);
  near((point.x - next.x) / next.k, before.x);
  near((point.y - next.y) / next.k, before.y);
  assert.equal(zoomAround(start, point, 100, limits).k, 2.5);
  assert.equal(zoomAround(start, point, 0.001, limits).k, 0.5);
});

test('the pan keeps at least 80 px of the content in the box on each axis', () => {
  const content = { w: 1000, h: 400 };
  const limits = { kMin: 0.5, kMax: 2.5 };
  const far = clampView({ x: 5000, y: -5000, k: 1 }, content, box, limits);
  assert.equal(far.x, 390 - 80);
  assert.equal(far.y, 80 - 400);
  const gone = clampView({ x: -5000, y: 5000, k: 1 }, content, box, limits);
  assert.equal(gone.x, 80 - 1000);
  assert.equal(gone.y, 300 - 80);
  assert.equal(clampView({ x: 0, y: 0, k: 9 }, content, box, limits).k, 2.5);
  const small = clampView({ x: -999, y: 0, k: 0.1 }, { w: 40, h: 40 }, box, limits);
  assert.ok(small.x + 40 * small.k >= 20 - 1e-6, 'content smaller than 80 px stays wholly reachable');
});

test('placing a content point, and keeping one where it was', () => {
  assert.deepEqual(viewAt({ x: 100, y: 50 }, { x: 195, y: 150 }, 2), { k: 2, x: -5, y: 50 });
  const before = { x: -40, y: 10, k: 1.5 };
  const after = keepPoint(before, { x: 200, y: 100 }, { x: 260, y: 80 });
  near(after.x + 260 * after.k, before.x + 200 * before.k);
  near(after.y + 80 * after.k, before.y + 100 * before.k);
});

const task = (id, state) => ({ id, title: id, state, signs: [], deps: [], sprints: [], prs: [] });
const milestone = (id, tasks) => ({ id, title: id, state: 'doing', features: [{ id: `${id}-f`, title: 'F', state: 'doing', tasks }] });
const model = milestones => ({ project: 'p', meta: null, ageMinutes: null, milestones, sprints: [] });

test('"now" never sits under the milestone it belongs to', () => {
  const none = layoutMap(model([milestone('m1', [task('a', 'next'), task('b', 'next')]), milestone('m2', [task('c', 'later')])]), new Set(), false);
  const first = none.nodes.find(node => node.id === 'm1');
  assert.ok(none.nowX - first.x > 26, `closed: ${none.nowX - first.x}`);
  const opened = layoutMap(model([milestone('m1', [task('a', 'next')])]), new Set(['m1']), false);
  assert.ok(opened.nowX - opened.nodes.find(node => node.id === 'm1').x >= 15 + 8);
  const some = layoutMap(model([milestone('m1', [task('a', 'done'), task('b', 'done'), task('c', 'next')]), milestone('m2', [task('d', 'later')])]), new Set(), false);
  assert.ok(some.nowX > some.nodes.find(node => node.id === 'm1').x + 38, 'two of three done puts it well along the line');
});

test('the layout no longer stretches to the box: one milestone is as wide as its content', () => {
  const one = layoutMap(model([milestone('m1', [task('a', 'next')])]), new Set(), false);
  assert.ok(one.width < 400, `${one.width}`);
});
