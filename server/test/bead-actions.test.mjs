// The Roadmap sheet's "Do it" block (ws-im1.2.1): its three rows, when it shows and what a run on the bead reads as.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BEAD_ROWS, runWord, seedPath, visible } from '../../src/hub/beadActions.ts';

test('the block has three rows in order, each with who does it and what comes back', () => {
  assert.deepEqual(BEAD_ROWS.map(row => [row.kind, row.label, row.note]), [
    ['build', 'Build it', 'Claude · opens a PR'],
    ['mockup', 'Mock it up', 'Codex · a page and pictures'],
    ['research', 'Research it', 'Codex · a card with sources'],
  ]);
});

test('visible: an open task of a writer, never a done task, a read-only host or a Wayfinder question', () => {
  const question = { id: 'q', title: 'Q', type: 'grilling', blockedBy: [], unlocks: [] };
  for (const state of ['next', 'doing', 'you', 'later']) assert.equal(visible({ state }, undefined, true), true, state);
  assert.equal(visible({ state: 'done' }, undefined, true), false, 'A done task (or one the owner marked) has nothing to do.');
  assert.equal(visible({ state: 'next' }, undefined, false), false, 'No write access, no block.');
  assert.equal(visible({ state: 'next' }, question, true), false, 'A question has its own main button.');
});

test('runWord names each live state; seedPath encodes the project and bead', () => {
  for (const state of ['proposed', 'approved', 'taken', 'running', 'stopping', 'asking', 'lost']) assert.notEqual(runWord(state), state, state);
  assert.equal(runWord('running'), 'Running');
  assert.equal(runWord('odd'), 'odd');
  assert.equal(seedPath('ws app', 'ws-1.2', 'mockup'), '/map/ws%20app/beads/ws-1.2/seed?kind=mockup');
});
