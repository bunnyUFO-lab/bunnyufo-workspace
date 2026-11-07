// The map's pan and zoom rules (src/hub/panZoom.ts) and where "now" sits (src/hub/mapLayout.ts):
// pure TypeScript, imported straight by Node.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { clampView, fitScale, fitView, keepPoint, limitsFor, viewAt, zoomAround } from '../../../src/hub/panZoom.ts';
import { LABEL_MAX, layoutMap } from '../../../src/hub/mapLayout.ts';
import { FOLD_F, FOLD_M, OPEN_F, OPEN_M, slotAt, stableOf, zoomStep } from '../../../src/hub/semanticZoom.ts';
import { everythingOpen, snapshotModel } from './snapshots/hub-map-layout-model.mjs';
import { PROJECT_TABS, TASK_PAGE, currentMilestone, listed, orderedTasks, tabCounts, tabOf } from '../../../src/hub/projectPage.ts';
import { parseProjectId, projectHash, projectNodeHash } from '../../../src/lib/route.ts';
import { buildMap } from '../hub-map.mjs';
import { sprintModel, sprintsOf } from '../../../src/hub/sprintScope.ts';
import { beadsIssue } from './hub-fixtures.mjs';
import { FULL, UNFILED, branchModel, branchTarget, childrenOf, crumbs, milestoneDots, parseSaved, resolveBranch, rowsOf, visibleRows } from '../../../src/hub/mapBranch.ts';

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

// --- The horizontal layout is pinned ---------------------------------------------------------------

/** What `layoutMap` returns for the snapshot model, recorded when branches stopped crossing labels (ws-8x1: higher levels leave the spine further left, one-line labels, the chevron at the elbow). Infinity is spelled out. */
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

test('the horizontal layout keeps every field the recording has; new ones are only added', () => {
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
  assert.deepEqual(milestoneNode.label, { x: milestoneNode.x, y: milestoneNode.y + 34, anchor: 'middle', count: '2 of 2 done' }, 'an open milestone titles below, what its ring counts in words after the title');
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
  assert.ok(layout.width < 540, `${layout.width}`);
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
    assert.ok(item.label.lines.length === 1 && item.label.lines[0].length <= (item.kind === 'm' ? 40 : LABEL_MAX), `${item.id}: a label is one line`);
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

// --- Connectors stay off labels; a toggle's anchor does not move (ws-8x1) -------------------------

/** A milestone shaped like "Sprint 2" on the Magic Loops roadmap: four features, long titles, and a sixth feature on another milestone for a third level. */
const sprintTwo = () => {
  const names = [['Combat feel and runes', ['Hit stop and screen shake', 'Rune slot inventory', 'Rune effects pass one', 'Combat tuning playtest']], ['Hex map generator (pure C#)', ['Hex grid coordinates', 'Noise terrain pass', 'Region and biome assignment', 'Map seed save format']], ['Enemy telegraphs', ['Wind-up animation set', 'Audio cue pass']], ['First contact encounter', ['Block out the arena', 'A task with a title far too long to fit on a single line of the map']], ['Telemetry', ['Log hits']], ['Saves', ['Slot format', 'Migration']]];
  return model([
    { id: 'p1', title: 'Sprint 1: moving', state: 'done', features: [{ id: 'p1-f', title: 'Movement', state: 'done', tasks: [{ ...task('p1-t', 'done') }] }] },
    { id: 'p2', title: 'Sprint 2: feel, first contact', state: 'doing', features: names.map(([title, tasks], k) => ({ id: `p2-f${k}`, title, state: 'doing', tasks: tasks.map((name, j) => ({ ...task(`p2-f${k}-t${j}`, j ? 'next' : 'done'), title: name })) })) },
    { id: 'p3', title: 'Sprint 3: depth', state: 'later', features: [{ id: 'p3-f', title: 'Depth', state: 'later', tasks: [{ ...task('p3-t', 'later') }] }] },
  ]);
};
/** Where a node's text is drawn, as the box a reader sees: the label's width is the characters times the drawn size (bold 12 px titles, 10.5 px task labels), a line is 12 px tall. */
const labelBoxes = layout => layout.nodes.flatMap(item => (item.label.lines ?? [item.title]).map((line, k) => {
  const width = line.length * (item.kind === 't' ? 5.6 : 6.8);
  const left = item.label.anchor === 'middle' ? item.label.x - width / 2 : item.label.anchor === 'end' ? item.label.x - width : item.label.x;
  const baseline = item.label.y + k * (item.label.step ?? 14);
  return { id: item.id, line, x0: left, x1: left + width, y0: baseline - 10, y1: baseline + 2 };
}));
/** Whether the segment a-b passes through the box (Liang-Barsky). */
const crosses = (a, b, box) => {
  let t0 = 0;
  let t1 = 1;
  for (const [p, q] of [[-(b[0] - a[0]), a[0] - box.x0], [b[0] - a[0], box.x1 - a[0]], [-(b[1] - a[1]), a[1] - box.y0], [b[1] - a[1], box.y1 - a[1]]]) {
    if (p === 0) { if (q < 0) return false; continue; }
    const r = q / p;
    if (p < 0) { if (r > t1) return false; t0 = Math.max(t0, r); } else { if (r < t0) return false; t1 = Math.min(t1, r); }
  }
  return t0 <= t1;
};
const segmentsOf = layout => [
  ...layout.branches.flatMap(branch => branch.points.slice(1).map((point, k) => ({ id: branch.id, a: branch.points[k], b: point }))),
  { id: 'spine', a: layout.spine.from, b: layout.spine.to },
];

for (const axis of ['x', 'y']) {
  test(`${axis === 'x' ? 'horizontal' : 'vertical'}: a Sprint 2 shaped milestone has no connector through a label, and no label on two lines`, () => {
    const m = sprintTwo();
    for (const [name, open] of [['everything open', everythingOpen(m)], ['milestone only', new Set(['p2'])], ['two features', new Set(['p2', 'p2-f0', 'p2-f1'])], ['the second level', new Set(['p2', 'p2-f2', 'p2-f3'])]]) {
      const layout = layoutMap(m, open, false, axis);
      for (const item of layout.nodes) assert.ok((item.label.lines?.length ?? 1) === 1, `${name}: ${item.id} is one line`);
      const crossings = [];
      for (const box of labelBoxes(layout)) for (const segment of segmentsOf(layout)) if (crosses(segment.a, segment.b, box)) crossings.push(`${segment.id} through "${box.line}"`);
      assert.deepEqual(crossings, [], `${name}: connectors cross labels`);
    }
  });
}

test('a title longer than a label ends in an ellipsis; the full title stays on the node', () => {
  const layout = layoutMap(sprintTwo(), new Set(['p2', 'p2-f3']), false, 'x');
  const long = layout.nodes.find(item => item.id === 'p2-f3-t1');
  assert.equal(long.lines[0].length, LABEL_MAX);
  assert.ok(long.lines[0].endsWith('…'));
  assert.ok(long.title.length > LABEL_MAX, 'the node keeps the whole title for its tooltip');
  assert.equal(layout.nodes.find(item => item.id === 'p2-f1').label.lines[0], 'Hex map generator (pure C#)', 'a title that fits is whole');
});

test("a branch's toggle sits at its elbow, and the elbow is where it was whether the branch is open or closed", () => {
  const m = sprintTwo();
  for (const axis of ['x', 'y']) {
    const closed = layoutMap(m, new Set(['p2']), false, axis);
    const opened = layoutMap(m, new Set(['p2', ...m.milestones[1].features.map(feature => feature.id)]), false, axis);
    for (const item of closed.nodes.filter(node => node.kind === 'f' && node.milestone === 'p2')) {
      assert.deepEqual(item.chevronAt, item.elbow, `${axis}: ${item.id} toggles at its elbow`);
      if (axis === 'x') assert.deepEqual(opened.nodes.find(node => node.id === item.id).elbow, item.elbow, `${item.id}: the elbow does not move when features open`);
    }
    const milestoneAt = layout => layout.nodes.find(node => node.id === 'p2');
    assert.deepEqual(milestoneAt(closed).chevronAt, milestoneAt(layoutMap(m, new Set(), false, axis)).chevronAt, `${axis}: a milestone's toggle does not move when it opens`);
  }
});

// A project's page (ws-im1.3.1): the tab an address names, the milestone a sprint button points at, and the counts.
const pTask = (id, state, status = state === 'done' ? 'closed' : 'open') => ({ id, title: id, state, status, signs: [], deps: [], sprints: [], prs: [] });
const pMilestone = (id, tasks, sprint) => ({ id, title: id, state: tasks.every(task => task.state === 'done') ? 'done' : 'doing', features: [{ id: `${id}-f`, title: 'F', state: 'doing', tasks }], ...(sprint ? { sprint } : {}) });

test('tabOf: work and cards are tabs, the old names read as the tab that took their place; anything else, and none, is the Roadmap', () => {
  assert.deepEqual(PROJECT_TABS, ['roadmap', 'work', 'cards']);
  assert.deepEqual(['work', 'cards', 'running', 'needs', 'library', 'roadmap', 'nope', '', undefined].map(tabOf), ['work', 'cards', 'work', 'work', 'cards', 'roadmap', 'roadmap', 'roadmap', 'roadmap']);
});

test('the project address: no id, an id, and a tab; the Roadmap tab has no segment', () => {
  assert.equal(projectHash(), '#/~hub/project');
  assert.equal(projectHash('magic-loops'), '#/~hub/project/magic-loops');
  assert.equal(projectHash('magic-loops', 'roadmap'), '#/~hub/project/magic-loops');
  assert.equal(projectHash('magic-loops', 'work'), '#/~hub/project/magic-loops/work');
  assert.deepEqual(parseProjectId(undefined), {});
  assert.deepEqual(parseProjectId('magic-loops'), { project: 'magic-loops' });
  assert.deepEqual(parseProjectId('magic-loops/cards'), { project: 'magic-loops', tab: 'cards' });
  assert.deepEqual(parseProjectId('magic-loops/roadmap/ml-m1'), { project: 'magic-loops', tab: 'roadmap', node: 'ml-m1' });
  assert.deepEqual(parseProjectId('magic-loops/cards/ml-m1'), { project: 'magic-loops', tab: 'cards' }, 'Only the Roadmap tab has a node.');
  assert.deepEqual(parseProjectId('magic-loops/roadmap/'), { project: 'magic-loops', tab: 'roadmap' });
  assert.equal(projectNodeHash('magic-loops', 'ml-m1'), '#/~hub/project/magic-loops/roadmap/ml-m1');
  assert.equal(projectNodeHash('a b', '~other'), '#/~hub/project/a%20b/roadmap/~other');
});

test('currentMilestone: a sprint that has not ended wins, else the first milestone with open work that is not later work', () => {
  const done = pMilestone('m1', [pTask('a', 'done')]);
  const later = pMilestone('m2', [pTask('b', 'later', 'deferred')]);
  const open = pMilestone('m3', [pTask('c', 'done'), pTask('d', 'next')]);
  const other = pMilestone('m4', [pTask('e', 'doing')]);
  assert.equal(currentMilestone({ milestones: [done, later, open, other] }).id, 'm3', 'The finished one and the one with only deferred work are passed over.');
  const going = { ...other, sprint: { head: 'h', until: 'u', items: [] } };
  assert.equal(currentMilestone({ milestones: [done, open, going] }).id, 'm4', 'A sprint in progress comes first, wherever it is.');
  const ended = { ...other, sprint: { head: 'h', until: 'u', items: [], ended: { reason: 'done' } } };
  assert.equal(currentMilestone({ milestones: [done, open, ended] }).id, 'm3', 'An ended sprint does not count.');
  assert.equal(currentMilestone({ milestones: [done, later] }), undefined, 'Nothing open: no milestone.');
  assert.equal(currentMilestone({ milestones: [] }), undefined);
  assert.equal(currentMilestone({ milestones: [pMilestone('~none', [pTask('f', 'next')])] }), undefined, 'The milestone the map makes up for loose tasks has no sprint.');
});

test('orderedTasks: open tasks first (doing, you, next, later), done last, each group in its own order', () => {
  const tasks = [pTask('t1', 'done'), pTask('t2', 'done'), pTask('t3', 'next'), pTask('t4', 'doing'), pTask('t5', 'later', 'deferred'), pTask('t6', 'you'), pTask('t7', 'next'), pTask('t8', 'done')];
  assert.deepEqual(orderedTasks(pMilestone('m', tasks)).map(task => task.id), ['t4', 't6', 't3', 't7', 't5', 't1', 't2', 't8']);
  assert.deepEqual(orderedTasks(pMilestone('m', [])), []);
  assert.equal(TASK_PAGE, 20, 'A milestone opens with twenty tasks.');
});

test('listed: projects with a Beads copy, or all of them while none has one', () => {
  const a = { id: 'a', name: 'A', beads: true }, b = { id: 'b', name: 'B', beads: false };
  assert.deepEqual(listed([a, b]), [a]);
  assert.deepEqual(listed([b]), [b]);
  assert.deepEqual(listed([]), []);
});

test('tabCounts: the same filter as Today at the project', () => {
  const at = new Date().toISOString();
  const today = {
    at, counts: { needsYou: 3, running: 2, recent: 0, alerts: 0 }, needsYou: [{ project: 'a' }, { project: 'a' }, { project: 'b' }], recent: [], alerts: [], running: [],
    working: [{ id: '1', project: 'a', state: 'working' }, { id: '2', project: 'a', state: 'idle' }, { id: '3', project: 'b', state: 'working' }],
  };
  assert.deepEqual(tabCounts(today, 'a'), { running: 1, needs: 2 });
  assert.deepEqual(tabCounts(today, 'b'), { running: 1, needs: 1 });
  assert.deepEqual(tabCounts(today, 'c'), { running: 0, needs: 0 });
});

// --- mapBranch: which part of the roadmaps the map shows ---

const ms = (id, roadmap, state = 'later') => ({ id, title: id.toUpperCase(), state, ...(roadmap ? { roadmap } : {}), features: [{ id: `${id}-f`, title: 'F', state, tasks: [{ id: `${id}-t`, title: 'T', state, status: 'open', signs: [], sprints: [], deps: [] }] }] });
const nested = {
  project: 'p', meta: null, ageMinutes: null, wayfinder: null,
  roadmaps: [{ id: 'r1', title: 'Hub', state: 'doing' }, { id: 'r2', title: 'Editing', state: 'later', parent: 'r1' }, { id: 'r3', title: 'Empty', state: 'later', parent: 'r1' }],
  milestones: [ms('a', 'r1', 'done'), ms('b', 'r1', 'doing'), ms('c', 'r2'), ms('m0', undefined, 'done')],
  sprints: [{ name: 's1', milestones: [{ id: 'a', count: 1, total: 1 }, { id: 'c', count: 1, total: 1 }] }, { name: 's2', milestones: [{ id: 'm0', count: 1, total: 1 }] }],
};

test('a branch holds only its own milestones and the sprint bands that touch them', () => {
  const r1 = branchModel(nested, 'r1');
  assert.deepEqual(r1.milestones.map(item => item.id), ['a', 'b'], 'Not the milestones of the roadmaps inside it.');
  assert.deepEqual(r1.sprints, [{ name: 's1', milestones: [{ id: 'a', count: 1, total: 1 }] }], 'A band keeps only its milestones here, and one with none is dropped.');
  assert.deepEqual(branchModel(nested, UNFILED).milestones.map(item => item.id), ['m0']);
  assert.deepEqual(branchModel(nested, 'r3').milestones, []);
  assert.equal(nested.milestones.length, 4, 'The model it was given is not changed.');
});

test('the address names the view: the list, a branch, a bead in a branch, or the saved view when it still exists', () => {
  assert.deepEqual(resolveBranch(nested, FULL, { view: 'branch', branch: 'r1' }), { view: 'full' });
  assert.deepEqual(resolveBranch(nested, 'r2', null), { view: 'branch', branch: 'r2' });
  assert.deepEqual(resolveBranch(nested, UNFILED, null), { view: 'branch', branch: UNFILED });
  assert.deepEqual(resolveBranch(nested, 'c-t', null), { view: 'branch', branch: 'r2', node: 'c-t' }, 'An old link to a task opens its branch with the task.');
  assert.deepEqual(resolveBranch(nested, 'm0-f', null), { view: 'branch', branch: UNFILED, node: 'm0-f' });
  assert.deepEqual(resolveBranch(nested, undefined, { view: 'branch', branch: 'r1' }), { view: 'branch', branch: 'r1' });
  assert.deepEqual(resolveBranch(nested, 'nope', { view: 'branch', branch: 'r1' }), { view: 'branch', branch: 'r1' }, 'A wrong id falls back to the saved view.');
  assert.deepEqual(resolveBranch(nested, undefined, { view: 'branch', branch: 'gone' }), { view: 'full' }, 'A saved id that vanished is the list.');
  assert.deepEqual(resolveBranch(nested, undefined, null), { view: 'full' });
  const bare = { ...nested, milestones: nested.milestones.filter(item => item.roadmap) };
  assert.deepEqual(resolveBranch(bare, UNFILED, null), { view: 'full' }, 'The unfiled row is a branch only while it has milestones.');
});

test('crumbs, children, dots and rows', () => {
  assert.deepEqual(crumbs(nested, 'r2'), [{ id: 'r1', title: 'Hub' }, { id: 'r2', title: 'Editing' }]);
  assert.deepEqual(crumbs(nested, UNFILED).map(item => item.id), [UNFILED]);
  assert.deepEqual(crumbs(nested, FULL), []);
  assert.deepEqual(childrenOf(nested, FULL).map(item => item.id), ['r1']);
  assert.deepEqual(childrenOf(nested, 'r1').map(item => item.id), ['r2', 'r3']);
  assert.deepEqual(milestoneDots(nested, 'r1').map(item => [item.id, item.state]), [['a', 'done'], ['b', 'doing']]);
  assert.deepEqual(rowsOf(nested).map(row => [row.id, row.depth, row.done, row.dots.length]), [['r1', 0, 1, 2], ['r2', 1, 0, 1], ['r3', 1, 0, 0], [UNFILED, 0, 1, 1]]);
  assert.deepEqual(rowsOf(nested, 'r3'), [], 'A roadmap with nothing inside has no rows.');
  assert.deepEqual(rowsOf(nested, 'r1').map(row => [row.id, row.depth]), [['r2', 0], ['r3', 0]]);
});

test('"This branch" goes to the branch last in, else the current milestone, else the first roadmap; a bad stored value is none', () => {
  assert.equal(branchTarget(nested, { view: 'full', branch: 'r2' }), 'r2');
  assert.equal(branchTarget(nested, { view: 'full', branch: 'gone' }), 'r1', 'The current milestone is b, in r1.');
  assert.equal(branchTarget(nested, null), 'r1');
  const quiet = { ...nested, milestones: [ms('x', 'r2', 'done')] };
  assert.equal(branchTarget(quiet, null), 'r1', 'With no current milestone, the first roadmap.');
  assert.deepEqual(parseSaved({ view: 'full', branch: 'r2' }), { view: 'full', branch: 'r2' });
  for (const bad of [null, 5, 'x', {}, { view: 'branch' }, { view: 'side', branch: 'r1' }]) assert.equal(parseSaved(bad), null);
});

test('the map names each sprint after the group issue that carries its label', () => {
  const issues = [
    beadsIssue({ id: 'm-ms', title: 'Milestone', type: 'milestone' }),
    beadsIssue({ id: 'm-epic', title: 'Sprint 5: the big one', type: 'epic', parent: 'm-ms', labels: ['sprint:s5'], created: '2026-10-05T09:00:00Z' }),
    beadsIssue({ id: 'm-sub', title: 'A sub group', type: 'feature', parent: 'm-epic', labels: ['sprint:s5'], created: '2026-10-05T08:00:00Z' }),
    beadsIssue({ id: 'm-t1', title: 'Task one', parent: 'm-sub', labels: ['sprint:s5'] }),
    beadsIssue({ id: 'm-t2', title: 'Task two', parent: 'm-sub', labels: ['sprint:s4'] }),
  ];
  const map = buildMap({ project: 'p', issues, now: new Date('2026-11-03T12:00:00Z') });
  const by = Object.fromEntries(map.sprints.map(row => [row.name, row]));
  assert.equal(by.s5.title, 'Sprint 5: the big one', 'The sub group has a parent with the label, so the epic names it.');
  assert.equal('title' in by.s4, false, 'No group issue carries the label: no title.');
});

// sprintScope.ts: the sprints of a project and its map narrowed to one.
const sTask = (id, state, sprints) => ({ id, title: id, state, status: state === 'done' ? 'closed' : 'open', signs: [], deps: [], sprints, prs: [] });
const sprintMap = () => ({
  project: 'p', meta: null, ageMinutes: null,
  milestones: [
    { id: 'm1', title: 'M1', state: 'doing', roadmap: 'r1', features: [
      { id: 'f1', title: 'F1', state: 'doing', tasks: [sTask('t1', 'done', ['a']), sTask('t2', 'doing', ['a', 'b']), sTask('t3', 'next', [])] },
      { id: 'f2', title: 'F2', state: 'later', tasks: [sTask('t4', 'later', [])] },
    ] },
    { id: 'm2', title: 'M2', state: 'done', features: [{ id: 'f3', title: 'F3', state: 'done', tasks: [sTask('t5', 'done', ['b']), sTask('t6', 'done', ['c'])] }] },
    { id: 'm3', title: 'M3', state: 'later', features: [{ id: 'f4', title: 'F4', state: 'later', tasks: [sTask('t7', 'later', [])] }] },
  ],
  // The map lists its bands oldest first.
  sprints: [{ name: 'c', title: 'Sprint C', milestones: [{ id: 'm2', count: 1, total: 2 }] }, { name: 'b', milestones: [{ id: 'm1', count: 1, total: 3 }, { id: 'm2', count: 1, total: 2 }] }, { name: 'a', title: 'Sprint A', milestones: [{ id: 'm1', count: 2, total: 3 }] }],
  roadmaps: [{ id: 'r1', title: 'R1', state: 'doing' }],
});

test('sprintsOf counts done of all from the tasks: open sprints first, then the newest, the finished last', () => {
  assert.deepEqual(sprintsOf(sprintMap()), [
    { name: 'a', title: 'Sprint A', done: 1, total: 2 },
    { name: 'b', done: 1, total: 2 },
    { name: 'c', title: 'Sprint C', done: 1, total: 1 },
  ]);
  assert.deepEqual(sprintsOf({ milestones: [], sprints: [] }), []);
});

test('sprintModel counts a band by the sprint own tasks, so the map says what the list says', () => {
  const narrowed = sprintModel(sprintMap(), 'a');
  assert.deepEqual(narrowed.sprints[0].milestones, [{ id: 'm1', count: 2, total: 2 }], 'The band said 2 of 3 (the whole milestone) before.');
  assert.deepEqual(sprintModel(sprintMap(), 'b').sprints[0].milestones, [{ id: 'm1', count: 1, total: 1 }, { id: 'm2', count: 1, total: 1 }]);
});

test('sprintModel keeps the milestones, features and tasks of one sprint and drops the roadmaps', () => {
  const full = sprintMap();
  const narrowed = sprintModel(full, 'a');
  assert.deepEqual(narrowed.milestones.map(milestone => milestone.id), ['m1']);
  assert.deepEqual(narrowed.milestones[0].features.map(feature => [feature.id, feature.tasks.map(task => task.id)]), [['f1', ['t1', 't2']]]);
  assert.equal(narrowed.milestones[0].state, 'doing');
  assert.equal('roadmap' in narrowed.milestones[0], false);
  assert.deepEqual(narrowed.roadmaps, []);
  assert.deepEqual(narrowed.sprints.map(band => band.name), ['a']);
  assert.equal(full.milestones[0].features[0].tasks.length, 3, 'The whole map is left as it was.');
  const finished = sprintModel(full, 'c');
  assert.deepEqual(finished.milestones.map(milestone => [milestone.id, milestone.state]), [['m2', 'done']], 'A milestone with only done sprint tasks reads as done.');
  assert.deepEqual(sprintModel(full, 'nothing').milestones, []);
});

// visibleRows: the milestones listed under a row, and Hide completed.
const vDot = (id, state) => ({ id, title: id.toUpperCase(), state });
const vRow = (id, depth, state, dots) => ({ id, title: id, state, depth, dots, done: dots.filter(dot => dot.state === 'done').length, inside: 0 });
const vRows = () => [
  vRow('r1', 0, 'done', [vDot('a', 'done')]),
  vRow('r2', 1, 'doing', [vDot('b', 'done'), vDot('c', 'next')]),
  vRow('r3', 0, 'done', [vDot('x', 'done')]),
  vRow('r4', 0, 'later', [vDot('y', 'later')]),
];

test('visibleRows lists the milestones of a row that is not done; a finished row keeps its dots and lists no names', () => {
  const shown = visibleRows(vRows(), false);
  assert.deepEqual(shown.map(row => row.id), ['r1', 'r2', 'r3', 'r4']);
  assert.deepEqual(shown.map(row => row.names.map(dot => dot.id)), [[], ['b', 'c'], [], ['y']]);
  assert.equal(shown[0].dots.length, 1, 'The dots stay.');
  assert.equal(shown[1].names[0].title, 'B', 'The names are the dots\' titles.');
});

test('visibleRows with Hide completed drops finished rows unless something inside is open, and finished milestones from the names', () => {
  const shown = visibleRows(vRows(), true);
  assert.deepEqual(shown.map(row => row.id), ['r1', 'r2', 'r4'], 'r1 is done but r2 inside it is not; r3 goes.');
  assert.deepEqual(shown.map(row => row.names.map(dot => dot.id)), [[], ['c'], ['y']]);
  assert.deepEqual(visibleRows([vRow('r3', 0, 'done', [vDot('x', 'done')])], true), []);
  assert.deepEqual(visibleRows([], true), []);
  const inputs = vRows();
  visibleRows(inputs, true);
  assert.equal(inputs[1].dots.length, 2, 'The rows given are not changed.');
});
