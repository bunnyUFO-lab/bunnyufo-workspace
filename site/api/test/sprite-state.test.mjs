import test from 'node:test';
import assert from 'node:assert/strict';
import { DONE_MS, SHEET_ROWS, rowOf, rowSpec, sheetSrc, stateOf } from '../../../src/hub/team/spriteState.ts';

const NOW = Date.parse('2026-10-29T12:00:00Z');
const at = ms => new Date(NOW - ms).toISOString();

test('every state maps to the row the pet sheet format names', () => {
  assert.deepEqual(
    Object.fromEntries(['working', 'needs-you', 'failed', 'done', 'review', 'idle', 'offline'].map(state => [state, rowOf(state)])),
    { working: 'running', 'needs-you': 'waiting', failed: 'failed', done: 'jumping', review: 'review', idle: 'idle', offline: 'idle' },
  );
  assert.deepEqual([...SHEET_ROWS], ['idle', 'run-right', 'run-left', 'waving', 'jumping', 'failed', 'waiting', 'running', 'review']);
});

test('status alone gives working, needs-you, failed, idle and offline', () => {
  for (const status of ['working', 'needs-you', 'failed', 'idle', 'offline']) assert.equal(stateOf({ status, now: NOW }), status);
});

test('done holds for 10 minutes after doneAt and is idle at 10:01', () => {
  assert.equal(DONE_MS, 600_000);
  assert.equal(stateOf({ status: 'idle', doneAt: at(0), now: NOW }), 'done');
  assert.equal(stateOf({ status: 'idle', doneAt: at(9 * 60_000 + 59_000), now: NOW }), 'done');
  assert.equal(stateOf({ status: 'idle', doneAt: at(10 * 60_000), now: NOW }), 'idle');
  assert.equal(stateOf({ status: 'idle', doneAt: at(10 * 60_000 + 1_000), now: NOW }), 'idle');
  assert.equal(stateOf({ status: 'idle', doneAt: NOW - 60_000, now: NOW }), 'done', 'epoch ms work too');
  assert.equal(stateOf({ status: 'idle', doneAt: 'not a date', now: NOW }), 'idle');
});

test('needs-you wins over working, and the busy states win over done and review', () => {
  assert.equal(stateOf({ status: 'needs-you', doneAt: at(0), review: true, now: NOW }), 'needs-you');
  assert.equal(stateOf({ status: 'failed', doneAt: at(0), review: true, now: NOW }), 'failed');
  assert.equal(stateOf({ status: 'working', doneAt: at(0), review: true, now: NOW }), 'working');
  assert.equal(stateOf({ status: 'idle', doneAt: at(0), review: true, now: NOW }), 'review');
  assert.equal(stateOf({ status: 'offline', doneAt: at(0), review: true, now: NOW }), 'offline');
});

test('rowSpec finds a row in the fixed order and clamps what the sheet says', () => {
  const sprite = { rows: [{ state: 'idle', frames: 4, fps: 6 }, { state: 'running', frames: 99, fps: 0 }] };
  assert.deepEqual(rowSpec(sprite, 'idle'), { index: 0, frames: 4, fps: 6 });
  assert.deepEqual(rowSpec(sprite, 'running'), { index: 7, frames: 8, fps: 1 });
  assert.deepEqual(rowSpec(sprite, 'review'), { index: 8, frames: 1, fps: 6 }, 'a row the JSON does not list is one still frame');
});

test('sheetSrc puts the hub route under /api and refuses anything that is not a path', () => {
  assert.equal(sheetSrc('/hub/file?path=team%2Fclaude%2Fsheet-x.png'), '/api/hub/file?path=team%2Fclaude%2Fsheet-x.png');
  assert.equal(sheetSrc('/api/hub/file?path=a'), '/api/hub/file?path=a');
  for (const bad of ['https://example.test/a.png', '//example.test/a.png', '/a" onload="x', '/a.png)', 'a.png']) assert.equal(sheetSrc(bad), null, bad);
});
