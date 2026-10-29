// The map's pan and zoom rules (src/hub/panZoom.ts) and where "now" sits (src/hub/mapLayout.ts):
// pure TypeScript, imported straight by Node.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { clampView, fitScale, fitView, keepPoint, limitsFor, viewAt, zoomAround } from '../../../src/hub/panZoom.ts';
import { layoutMap } from '../../../src/hub/mapLayout.ts';
import { FOLD_F, FOLD_M, OPEN_F, OPEN_M, slotAt, stableOf, zoomStep } from '../../../src/hub/semanticZoom.ts';
import { everythingOpen, snapshotModel } from './snapshots/hub-map-layout-model.mjs';

const box = { w: 390, h: 300 };
const near = (a, b, message) => assert.ok(Math.abs(a - b) < 1e-6, `${message ?? ''} ${a} != ${b}`);

test('fit never enlarges past 1 unless told, and centres the content', () => {
  assert.equal(fitScale({ w: 200, h: 100 }, box), 1);
  assert.equal(fitScale({ w: 150, h: 100 }, box, 2), 2, 'a small content may be enlarged to the maximum');
  assert.ok(fitScale({ w: 780, h: 150 }, box, 2) <= 0.5 + 1e-9 && fitScale({ w: 380, h: 150 }, box, 2) < 2, 'a wide one stays below it');
  assert.deepEqual(fitView({ w: 100, h: 100 }, box, 2), { k: 2, x: 95, y: 50 });
  assert.equal(fitScale({ w: 780, h: 150 }, box), 0.5);
  const view = fitView({ w: 780, h: 150 }, box);
  assert.deepEqual(view, { k: 0.5, x: 0, y: 112.5 });
  assert.deepEqual(fitView({ w: 100, h: 100 }, box), { k: 1, x: 145, y: 100 });
});

test('zoom limits: out a little past fit but never to a speck, in to 4', () => {
  assert.deepEqual(limitsFor({ w: 390, h: 100 }, box), { kMin: 0.5, kMax: 4 });
  const wide = limitsFor({ w: 3900, h: 100 }, box);
  near(wide.kMin, 0.09, 'a long map may zoom out to a bit past fit');
  assert.equal(limitsFor({ w: 3900, h: 100 }, box).kMax, 4);
});

test('zooming around a point keeps the content under it where it is', () => {
  const limits = { kMin: 0.5, kMax: 4 };
  const start = { x: 30, y: 20, k: 1 };
  const point = { x: 200, y: 150 };
  const before = { x: (point.x - start.x) / start.k, y: (point.y - start.y) / start.k };
  const next = zoomAround(start, point, 1.5, limits);
  assert.equal(next.k, 1.5);
  near((point.x - next.x) / next.k, before.x);
  near((point.y - next.y) / next.k, before.y);
  assert.equal(zoomAround(start, point, 100, limits).k, 4);
  assert.equal(zoomAround(start, point, 0.001, limits).k, 0.5);
});

test('the pan keeps at least 80 px of the content in the box on each axis', () => {
  const content = { w: 1000, h: 400 };
  const limits = { kMin: 0.5, kMax: 4 };
  const far = clampView({ x: 5000, y: -5000, k: 1 }, content, box, limits);
  assert.equal(far.x, 390 - 80);
  assert.equal(far.y, 80 - 400);
  const gone = clampView({ x: -5000, y: 5000, k: 1 }, content, box, limits);
  assert.equal(gone.x, 80 - 1000);
  assert.equal(gone.y, 300 - 80);
  assert.equal(clampView({ x: 0, y: 0, k: 9 }, content, box, limits).k, 4);
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
  assert.ok(none.now.x - first.x > 26, `closed: ${none.now.x - first.x}`);
  const opened = layoutMap(model([milestone('m1', [task('a', 'next')])]), new Set(['m1']), false);
  assert.ok(opened.now.x - opened.nodes.find(node => node.id === 'm1').x >= 15 + 8);
  const some = layoutMap(model([milestone('m1', [task('a', 'done'), task('b', 'done'), task('c', 'next')]), milestone('m2', [task('d', 'later')])]), new Set(), false);
  assert.ok(some.now.x > some.nodes.find(node => node.id === 'm1').x + 38, 'two of three done puts it well along the line');
});

test('the layout no longer stretches to the box: one milestone is as wide as its content', () => {
  const one = layoutMap(model([milestone('m1', [task('a', 'next')])]), new Set(), false);
  assert.ok(one.width < 400, `${one.width}`);
});

// --- Semantic zoom -------------------------------------------------------------------------------

const feature = (id, tasks) => ({ id, title: id, state: 'doing', tasks });
const multi = (id, features) => ({ id, title: id, state: 'doing', features });
/** Three milestones; m2 holds two features (fa, then fb) of two tasks each. */
const zoomModel = () => model([
  milestone('m1', [task('a', 'next')]),
  multi('m2', [feature('fa', [task('a1', 'next'), task('a2', 'next')]), feature('fb', [task('b1', 'next'), task('b2', 'next')])]),
  milestone('m3', [task('z', 'later')]),
]);
const none = new Set();
const node = (layout, id) => layout.nodes.find(item => item.id === id);
const inSlotOf = (layout, id) => ({ x: node(layout, id).x, y: 230 });

test('the layout hands out slots along the spine, one per milestone, gapless', () => {
  const layout = layoutMap(zoomModel(), none, false);
  assert.equal(layout.axis, 'x');
  assert.deepEqual(layout.slots.map(slot => slot.id), ['m1', 'm2', 'm3']);
  assert.equal(layout.slots[0].from, -Infinity);
  assert.equal(layout.slots[2].to, Infinity);
  assert.equal(layout.slots[0].to, layout.slots[1].from);
  assert.equal(layout.slots[1].to, layout.slots[2].from);
  assert.equal(layout.slots[1].from, node(layout, 'm2').x - 40);
});

test("a feature's stable point is its elbow, the same closed and open", () => {
  const closed = layoutMap(zoomModel(), new Set(['m2']), false);
  const wide = layoutMap(zoomModel(), new Set(['m2', 'fb']), false);
  for (const id of ['fa', 'fb']) {
    assert.deepEqual(stableOf(node(closed, id)), stableOf(node(wide, id)), id);
    const branch = closed.branches.find(item => item.id === id);
    assert.deepEqual(stableOf(node(closed, id)), { x: branch.points[1][0], y: branch.points[1][1] }, "the elbow is the branch's corner");
  }
  assert.deepEqual(stableOf(node(closed, 'm2')), { x: node(closed, 'm2').x, y: 230 });
  assert.notEqual(node(closed, 'fb').x, node(wide, 'fb').x, 'while the circle itself jumps');
});

test('zooming in opens the milestone under the pointer, and only that one', () => {
  const layout = layoutMap(zoomModel(), none, false);
  const step = zoomStep({ layout, open: none, auto: none, k: 1.6, dir: 1, at: inSlotOf(layout, 'm2'), keep: none });
  assert.deepEqual([...step.open], ['m2']);
  assert.deepEqual([...step.auto], ['m2']);
  assert.equal(step.anchor, 'm2');
  assert.equal(zoomStep({ layout, open: none, auto: none, k: 1.4, dir: 1, at: inSlotOf(layout, 'm2'), keep: none }), null, 'below the threshold');
  assert.equal(zoomStep({ layout, open: none, auto: none, k: OPEN_M, dir: 1, at: inSlotOf(layout, 'm2'), keep: none }).anchor, 'm2', 'at the threshold it opens');
  assert.equal(zoomStep({ layout, open: none, auto: none, k: 1.6, dir: 1, at: { x: -500, y: 0 }, keep: none }).anchor, 'm1', 'the first slot is open to the left');
  assert.equal(zoomStep({ layout, open: none, auto: none, k: 1.6, dir: 1, at: { x: 99999, y: 0 }, keep: none }).anchor, 'm3', 'and the last to the right');
});

test('with the milestone open, a feature opens only from 2.2, and only the nearest one', () => {
  const open = new Set(['m2']);
  const layout = layoutMap(zoomModel(), open, false);
  const near = id => { const branch = layout.branches.find(item => item.id === id); return { x: branch.points[1][0] + 6, y: branch.points[1][1] + (branch.points[1][1] < 230 ? 4 : -4) }; };
  assert.ok(OPEN_F > 1.6);
  assert.equal(zoomStep({ layout, open, auto: new Set(['m2']), k: 1.6, dir: 1, at: near('fb'), keep: none }), null, 'no feature below 2.2');
  const step = zoomStep({ layout, open, auto: new Set(['m2']), k: 2.3, dir: 1, at: near('fb'), keep: none });
  assert.deepEqual([...step.open].sort(), ['fb', 'm2']);
  assert.equal(step.anchor, 'fb');
  assert.ok(step.auto.has('fb') && step.auto.has('m2'));
  assert.equal(zoomStep({ layout, open, auto: none, k: 2.3, dir: 1, at: near('fa'), keep: none }).anchor, 'fa');
  const both = new Set(['m2', 'fb']);
  const again = layoutMap(zoomModel(), both, false);
  assert.equal(zoomStep({ layout: again, open: both, auto: new Set(['m2', 'fb']), k: 2.5, dir: 1, at: near('fb'), keep: none }), null, 'nothing cascades once the focus is open');
});

test('a closed milestone at 2.3 opens the milestone, not a feature (one change per step)', () => {
  const layout = layoutMap(zoomModel(), none, false);
  const step = zoomStep({ layout, open: none, auto: none, k: 2.3, dir: 1, at: inSlotOf(layout, 'm2'), keep: none });
  assert.deepEqual([...step.open], ['m2']);
});

test('zooming out never opens, zooming in never folds', () => {
  const open = new Set(['m2', 'fb']);
  const layout = layoutMap(zoomModel(), open, false);
  const at = inSlotOf(layout, 'm2');
  assert.equal(zoomStep({ layout, open, auto: new Set(['m2', 'fb']), k: 0.5, dir: 1, at, keep: none }), null);
  const closed = layoutMap(zoomModel(), none, false);
  assert.equal(zoomStep({ layout: closed, open: none, auto: none, k: 3, dir: -1, at, keep: none }), null);
});

test('zooming out folds the features zoom opened, and keeps the ones the user opened', () => {
  const open = new Set(['m2', 'fa', 'fb']);
  const layout = layoutMap(zoomModel(), open, false);
  const at = inSlotOf(layout, 'm2');
  const step = zoomStep({ layout, open, auto: new Set(['m2', 'fb']), k: 1.7, dir: -1, at, keep: none });
  assert.ok(FOLD_F > 1.7);
  assert.deepEqual([...step.open].sort(), ['fa', 'm2'], 'fb folded, the manual fa and the milestone stay');
  assert.deepEqual([...step.auto], ['m2']);
  assert.ok(step.anchor === 'fa' || step.anchor === 'fb', 'a feature holds still');
  assert.equal(zoomStep({ layout, open, auto: new Set(['m2', 'fb']), k: FOLD_F, dir: -1, at, keep: none }), null, 'at the threshold it stays open');
});

test('below 1.2 zoom folds the milestones it opened, with their features', () => {
  const open = new Set(['m2', 'fa', 'fb', 'm3']);
  const layout = layoutMap(zoomModel(), open, false);
  const at = inSlotOf(layout, 'm2');
  const step = zoomStep({ layout, open, auto: new Set(['m2', 'fb']), k: 1.1, dir: -1, at, keep: none });
  assert.ok(FOLD_M > 1.1);
  assert.deepEqual([...step.open].sort(), ['fa', 'm3'], 'the manual fa stays in the set (hidden with its milestone), as does the manual m3');
  assert.equal(step.auto.size, 0);
  assert.equal(step.anchor, 'm2', 'a milestone holds still');
});

test('hysteresis: a milestone opened at 1.5 is not folded by a wobble to 1.3', () => {
  const open = new Set(['m2']);
  const layout = layoutMap(zoomModel(), open, false);
  assert.ok(FOLD_M < OPEN_M && FOLD_F < OPEN_F);
  assert.equal(zoomStep({ layout, open, auto: new Set(['m2']), k: 1.3, dir: -1, at: inSlotOf(layout, 'm2'), keep: none }), null);
});

test('the ancestors of the open panel are never folded', () => {
  const open = new Set(['m2', 'fb']);
  const layout = layoutMap(zoomModel(), open, false);
  const auto = new Set(['m2', 'fb']);
  const at = inSlotOf(layout, 'm2');
  assert.equal(zoomStep({ layout, open, auto, k: 0.9, dir: -1, at, keep: new Set(['m2', 'fb']) }), null, 'both kept');
  const step = zoomStep({ layout, open, auto, k: 0.9, dir: -1, at, keep: new Set(['m2']) });
  assert.deepEqual([...step.open], ['m2'], 'only the unkept feature folds');
});

// --- The horizontal layout does not move ---------------------------------------------------------

/** What `layoutMap` returned for the snapshot model before the vertical layout was added (recorded from main). Infinity is spelled out. */
const recorded = JSON.parse(readFileSync(new URL('./snapshots/hub-map-layout-x.json', import.meta.url), 'utf8'));
const spelled = value => JSON.parse(JSON.stringify(value, (key, item) => (item === Infinity ? 'Infinity' : item === -Infinity ? '-Infinity' : item)));
/** Keeps, at every level, only the keys the recorded value has: the layout may only add fields. */
const onlyRecorded = (actual, wanted) => {
  if (Array.isArray(wanted)) return wanted.map((item, k) => onlyRecorded(actual[k], item));
  if (wanted && typeof wanted === 'object') return Object.fromEntries(Object.keys(wanted).map(key => [key, onlyRecorded(actual[key], wanted[key])]));
  return actual;
};
/** The recorded value without the fields the layout has dropped since (the old x0…x2, labelX, elbowX, nowX, spineY, and a band's x1, x2, y: positions now live in points, label, elbow, now, spine and rect). */
const dropped = new Set(['x0', 'y0', 'x1', 'y1', 'x2', 'labelX', 'elbowX', 'nowX', 'spineY', 'y']);
const kept = (value, path = '') => {
  if (Array.isArray(value)) return value.map(item => kept(item, path));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !(dropped.has(key) && (path === 'branches' || path === 'bands' || path === 'nodes' || path === ''))).map(([key, item]) => [key, kept(item, key)]));
  return value;
};

test('the horizontal layout keeps every field it had; the new ones are only added', () => {
  const m = snapshotModel();
  const layouts = {
    open: layoutMap(m, everythingOpen(m), true),
    closed: layoutMap(m, new Set(), false),
    partly: layoutMap(m, new Set(['m2', 'm2-a']), true),
  };
  for (const [name, layout] of Object.entries(layouts)) {
    assert.deepEqual(onlyRecorded(spelled(layout), kept(recorded[name])), kept(recorded[name]), name);
    assert.deepEqual(layout.nodes.filter(item => !item.label || !item.center).map(item => item.id), [], `${name}: every node has a label and a centre`);
  }
});

test('the horizontal layout describes what ProgressMap draws today', () => {
  const m = snapshotModel();
  const layout = layoutMap(m, everythingOpen(m), true);
  assert.deepEqual(layout.spine, { from: [16, 230], to: [layout.width - 14, 230] });
  assert.equal(layout.now.y, 230);
  for (const branch of layout.branches) assert.equal(branch.points[0][1], 230, `${branch.id} leaves the spine`);
  for (const band of layout.bands) {
    assert.equal(band.rect.h, 22);
    assert.deepEqual(band.labelAt, { x: band.rect.x + 10, y: band.rect.y + 15, anchor: 'start' });
  }
  const milestoneNode = layout.nodes.find(item => item.id === 'm1');
  assert.deepEqual(milestoneNode.label, { x: milestoneNode.x, y: milestoneNode.y + 34, anchor: 'middle' }, 'an open milestone titles below');
  const featureNode = layout.nodes.find(item => item.id === 'm2-a');
  assert.deepEqual(featureNode.elbow, { x: layout.branches.find(item => item.id === 'm2-a').points[1][0], y: featureNode.y });
  assert.deepEqual(featureNode.center, { x: featureNode.x + 22, y: featureNode.y });
});

// --- The vertical layout -------------------------------------------------------------------------

const vertical = (m, open, sprints = false) => layoutMap(m, open, sprints, 'y');

test('vertical: the busiest model, everything open and Sprints on, fits a phone', () => {
  const m = snapshotModel();
  const layout = vertical(m, everythingOpen(m), true);
  assert.equal(layout.axis, 'y');
  assert.ok(layout.width < 500, `${layout.width}`);
  assert.deepEqual(layout.spine, { from: [0, 16], to: [0, layout.height - 14] });
  assert.equal(layout.bands.length, 2);
  assert.ok(layout.bands[1].rect.x === layout.bands[0].rect.x - 18, 'sprint bars are 18 units apart, further left');
  assert.ok(layout.bands.every(band => band.rect.x < 0 && band.partsAt === null && band.labelAt.anchor === 'end'));
});

test('vertical: every node has a label; left-side features and their tasks end at it, right-side ones start from it, milestones start', () => {
  const m = snapshotModel();
  const layout = vertical(m, everythingOpen(m));
  for (const item of layout.nodes) {
    assert.ok(['start', 'middle', 'end'].includes(item.label.anchor), item.id);
    assert.ok(Number.isFinite(item.label.x) && Number.isFinite(item.label.y), item.id);
    if (item.kind === 'm') assert.equal(item.label.anchor, 'start', item.id);
    else {
      assert.equal(item.label.anchor, item.side < 0 ? 'end' : 'start', item.id);
      assert.ok(item.side < 0 ? item.label.x < item.center.x : item.label.x > item.center.x, `${item.id}: text lies outside its run`);
    }
    if (item.kind !== 't') assert.ok(item.label.lines.length <= 2 && item.label.lines.every(line => line.length <= 24), item.id);
  }
  const sides = layout.nodes.filter(item => item.kind === 'f' && item.milestone === 'm2').map(item => item.side);
  assert.deepEqual(sides, [-1, 1, -1, 1, -1], 'features alternate sides');
  assert.ok(layout.nodes.filter(item => item.kind === 'm').every(item => item.x === 0), 'milestones sit on the spine');
});

test('vertical: milestones, features and tasks go down the page without overlapping, tasks 44 units apart', () => {
  const m = snapshotModel();
  const layout = vertical(m, everythingOpen(m));
  const ms = layout.nodes.filter(item => item.kind === 'm').map(item => item.y);
  assert.ok(ms.every((y, k) => k === 0 || y > ms[k - 1] + 90), `${ms}`);
  const features = layout.nodes.filter(item => item.kind === 'f' && item.milestone === 'm2');
  features.forEach((item, k) => {
    if (k) assert.ok(item.y - features[k - 1].y >= 8 + 2 * 22, `${item.id} starts below the previous feature's circle`);
    const branch = layout.branches.find(candidate => candidate.id === item.id);
    assert.deepEqual(branch.points[0], [0, branch.points[0][1]], 'the branch leaves the spine');
    assert.deepEqual(branch.points[1], [item.side * 40, branch.points[0][1] + 40], 'steps out BR');
    assert.equal(branch.points[2][0], branch.points[1][0], 'and runs straight down');
    assert.equal(branch.points[2][1], item.y);
  });
  const tasks = layout.nodes.filter(item => item.kind === 't' && item.feature === 'm2-a');
  assert.deepEqual(tasks.map((item, k) => k && item.y - tasks[k - 1].y).slice(1), [44, 44]);
  assert.ok(tasks.every(item => item.y < features[0].y), 'tasks sit on the run above the circle');
  assert.ok(tasks.every(item => item.x === features[0].x));
});

test('vertical: slots cover y without gaps and increase, and slotAt finds the milestone for a point', () => {
  const layout = vertical(zoomModel(), new Set(['m2']));
  assert.deepEqual(layout.slots.map(slot => slot.id), ['m1', 'm2', 'm3']);
  assert.equal(layout.slots[0].from, -Infinity);
  assert.equal(layout.slots[2].to, Infinity);
  assert.equal(layout.slots[0].to, layout.slots[1].from);
  assert.equal(layout.slots[1].to, layout.slots[2].from);
  assert.ok(layout.slots[1].from > layout.slots[0].to - 1 && layout.slots[2].from > layout.slots[1].from);
  assert.equal(layout.slots[1].from, node(layout, 'm2').y - 40);
  assert.equal(slotAt(layout, { x: 500, y: node(layout, 'm1').y }), 'm1');
  assert.equal(slotAt(layout, { x: -500, y: node(layout, 'm2').y }), 'm2');
  assert.equal(slotAt(layout, { x: 0, y: node(layout, 'fb').y }), 'm2', 'a feature of m2 lies in the slot of m2');
  assert.equal(slotAt(layout, { x: 0, y: node(layout, 'm3').y + 5 }), 'm3');
});

test('vertical: "now" lies between its milestone and the next, and never under the circle', () => {
  for (const opened of [new Set(), new Set(['m1']), new Set(['m1', 'm1-f'])]) {
    const layout = vertical(model([milestone('m1', [task('a', 'next'), task('b', 'next')]), milestone('m2', [task('c', 'later')])]), opened);
    const first = node(layout, 'm1');
    const radius = opened.has('m1') ? 15 : 26;
    assert.equal(layout.now.x, 0);
    assert.ok(layout.now.y - first.y >= radius + 8, `${layout.now.y - first.y}`);
    assert.ok(layout.now.y < node(layout, 'm2').y, 'before the next milestone');
  }
  const some = vertical(model([milestone('m1', [task('a', 'done'), task('b', 'done'), task('c', 'next')]), milestone('m2', [task('d', 'later')])]), new Set());
  assert.ok(some.now.y > node(some, 'm1').y + 38, 'two of three done puts it well along the line');
  const finished = vertical(model([milestone('m1', [task('a', 'done')])]), new Set());
  assert.equal(finished.now.y, finished.height - 40, 'with nothing left, now is at the end');
});

test("vertical: a feature's elbow is the same closed and open, and is the corner of its branch", () => {
  const closed = vertical(zoomModel(), new Set(['m2']));
  const wide = vertical(zoomModel(), new Set(['m2', 'fa', 'fb']));
  for (const id of ['fa']) {
    assert.deepEqual(stableOf(node(closed, id)), stableOf(node(wide, id)), id);
    const branch = closed.branches.find(item => item.id === id);
    assert.deepEqual(stableOf(node(closed, id)), { x: branch.points[1][0], y: branch.points[1][1] });
  }
  assert.notEqual(node(closed, 'fb').elbow.y, node(wide, 'fb').elbow.y, 'fb moves down when fa opens above it');
  const onlyFb = vertical(zoomModel(), new Set(['m2', 'fb']));
  assert.deepEqual(stableOf(node(closed, 'fb')), stableOf(node(onlyFb, 'fb')), 'but not when it opens itself');
  assert.notEqual(node(closed, 'fb').y, node(onlyFb, 'fb').y, 'while its circle moves');
});

test('vertical: zooming in opens the milestone under the pointer, then the nearest feature', () => {
  const layout = vertical(zoomModel(), none);
  const at = { x: 0, y: node(layout, 'm2').y };
  const step = zoomStep({ layout, open: none, auto: none, k: 1.6, dir: 1, at, keep: none });
  assert.deepEqual([...step.open], ['m2']);
  assert.equal(step.anchor, 'm2');
  assert.equal(zoomStep({ layout, open: none, auto: none, k: 1.4, dir: 1, at, keep: none }), null, 'below the threshold');
  assert.equal(zoomStep({ layout, open: none, auto: none, k: 1.6, dir: 1, at: { x: 0, y: -500 }, keep: none }).anchor, 'm1', 'the first slot is open upwards');
  assert.equal(zoomStep({ layout, open: none, auto: none, k: 1.6, dir: 1, at: { x: 0, y: 99999 }, keep: none }).anchor, 'm3', 'and the last downwards');

  const open = new Set(['m2']);
  const opened = vertical(zoomModel(), open);
  const nearBranch = id => { const branch = opened.branches.find(item => item.id === id); return { x: branch.points[1][0] * 1.1, y: branch.points[1][1] + 4 }; };
  assert.equal(zoomStep({ layout: opened, open, auto: new Set(['m2']), k: 1.6, dir: 1, at: nearBranch('fb'), keep: none }), null, 'no feature below 2.2');
  assert.equal(zoomStep({ layout: opened, open, auto: new Set(['m2']), k: 2.3, dir: 1, at: nearBranch('fb'), keep: none }).anchor, 'fb');
  assert.equal(zoomStep({ layout: opened, open, auto: none, k: 2.3, dir: 1, at: nearBranch('fa'), keep: none }).anchor, 'fa');
});

test('vertical: zooming out folds what zoom opened and holds a surviving feature or milestone still', () => {
  const open = new Set(['m2', 'fa', 'fb']);
  const layout = vertical(zoomModel(), open);
  const at = { x: 0, y: node(layout, 'm2').y };
  const step = zoomStep({ layout, open, auto: new Set(['m2', 'fb']), k: 1.7, dir: -1, at, keep: none });
  assert.deepEqual([...step.open].sort(), ['fa', 'm2']);
  assert.ok(step.anchor === 'fa' || step.anchor === 'fb');
  const gone = zoomStep({ layout, open, auto: new Set(['m2', 'fb']), k: 1.1, dir: -1, at, keep: none });
  assert.equal(gone.anchor, 'm2');
});
