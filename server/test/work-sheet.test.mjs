// Work's item sheet: the route (`work`, `work/<board>`, `work/all/<id>`, `work/<project>/<id>`) and the project the sheet reads.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWorkId, workHash } from '../../src/lib/route.ts';
import { sheetProject } from '../../src/hub/workLanes.ts';

test('the Work route id: a bare screen, a board, an item on All, an item on a project', () => {
  assert.deepEqual(parseWorkId(undefined), {});
  assert.deepEqual(parseWorkId('lanes'), { project: 'lanes' });
  assert.deepEqual(parseWorkId('all'), { project: 'all' });
  assert.deepEqual(parseWorkId('all/ws-1'), { project: 'all', bead: 'ws-1' });
  assert.deepEqual(parseWorkId('lanes/ws-1'), { project: 'lanes', bead: 'ws-1' });
  assert.deepEqual(parseWorkId('lanes/'), { project: 'lanes' }, 'A trailing slash names no item.');
});

test('workHash builds the route parseWorkId reads back', () => {
  assert.equal(workHash('all', 'ws-1'), '#/~hub/work/all/ws-1');
  assert.equal(workHash('lanes', 'ws-1'), '#/~hub/work/lanes/ws-1');
  assert.deepEqual(parseWorkId(workHash('all', 'ws-1').replace('#/~hub/work/', '')), { project: 'all', bead: 'ws-1' });
});

test('the sheet reads the board project, and on All the card project', () => {
  assert.equal(sheetProject({ all: false, project: 'lanes', cardProject: 'lanes' }), 'lanes');
  assert.equal(sheetProject({ all: false, project: 'lanes' }), 'lanes', 'A project board asks its own project for an id it does not list.');
  assert.equal(sheetProject({ all: false, project: 'lanes', cardProject: 'other' }), 'lanes', 'On a project board the board decides.');
  assert.equal(sheetProject({ all: true, cardProject: 'other' }), 'other', 'On All the card decides.');
  assert.equal(sheetProject({ all: true, cardProject: 'other', carried: 'third' }), 'other');
  assert.equal(sheetProject({ all: true, carried: 'third' }), 'third', 'A task opened from inside a sheet keeps that sheet\'s project.');
  assert.equal(sheetProject({ all: true }), undefined, 'On All an id with no card has no project to ask.');
  assert.equal(sheetProject({ all: false }), undefined);
});
