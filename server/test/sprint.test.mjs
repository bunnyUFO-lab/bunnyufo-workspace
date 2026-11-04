// The milestone sheet's "Run a sprint" block (ws-im1.2.2): its chips, words, progress line and time left, as plain functions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_TIMEBOX, TIMEBOXES, confirmLine, currentItem, endLine, isLive, itemLine, itemWord, leftWord, stoppable, timeLeft } from '../../src/hub/sprint.ts';

const item = (bead, state, pr) => ({ id: `r-${bead}`, bead, title: bead, state, ...(pr ? { pr } : {}) });

test('three timeboxes, 4h on first, and the longest is eight hours', () => {
  assert.deepEqual(TIMEBOXES.map(chip => [chip.label, chip.minutes]), [['90m', 90], ['4h', 240], ['until done', 480]]);
  assert.equal(DEFAULT_TIMEBOX, 240);
});

test('a left-out bead says why in a few words, and a blocked one names what it waits for', () => {
  assert.equal(leftWord('needs-owner'), 'waits for you');
  assert.equal(leftWord('open-pr'), 'has an open PR');
  assert.equal(leftWord('blocked', 'ml-9'), 'waits for ml-9');
  assert.equal(leftWord('limit'), 'over the limit for one sprint');
  assert.equal(leftWord('something-new'), 'something-new', 'An unknown reason is shown as it is.');
});

test('item n of m is the live item, else the last one that started; the current item is the one that can be stopped', () => {
  const going = { head: 'h', until: 'x', items: [item('a', 'done', 'https://e.test/1'), item('b', 'running'), item('c', 'waiting')] };
  assert.equal(itemLine(going), 'Item 2 of 3');
  assert.equal(currentItem(going)?.bead, 'b');
  assert.equal(itemLine({ ...going, items: [item('a', 'done'), item('b', 'failed'), item('c', 'waiting')] }), 'Item 2 of 3');
  assert.equal(itemLine({ ...going, items: [item('a', 'waiting'), item('b', 'waiting')] }), 'Item 1 of 2');
  assert.equal(currentItem({ ...going, items: [item('a', 'done'), item('c', 'waiting')] }), null);
  assert.deepEqual(['proposed', 'approved', 'taken', 'running', 'stopping', 'done', 'waiting'].map(isLive), [true, true, true, true, true, false, false]);
  assert.deepEqual(['approved', 'taken', 'running'].map(stoppable), [true, true, true]);
  assert.deepEqual(['proposed', 'stopping', 'done', 'waiting', 'failed'].map(stoppable), [false, false, false, false, false]);
  assert.equal(itemWord('running'), 'Running');
  assert.equal(itemWord('waiting'), 'Waiting');
});

test('the time left reads in hours and minutes, and says when it is up', () => {
  const now = Date.parse('2026-11-03T10:00:00Z');
  assert.equal(timeLeft('2026-11-03T11:20:00Z', now), '1 h 20 min left');
  assert.equal(timeLeft('2026-11-03T10:45:00Z', now), '45 min left');
  assert.equal(timeLeft('2026-11-03T10:00:30Z', now), 'less than a minute left');
  assert.equal(timeLeft('2026-11-03T10:00:00Z', now), 'time is up');
  assert.equal(timeLeft('nonsense', now), 'time is up');
});

test('how a sprint ended, in the Hub\'s words', () => {
  const base = { head: 'h', until: 'x', items: [item('a', 'done', 'https://e.test/1'), item('b', 'failed'), item('c', 'waiting')] };
  assert.equal(endLine({ ...base, ended: { reason: 'failed', prs: 1 } }), '1 of 3 PRs open. Stopped: an item failed');
  assert.equal(endLine({ ...base, ended: { reason: 'timebox', prs: 2 } }), '2 of 3 PRs open. Stopped: time ran out');
  assert.equal(endLine({ ...base, ended: { reason: 'finished', prs: 3 } }), '3 of 3 PRs open. All items done');
  assert.equal(endLine({ ...base, ended: { reason: 'stopped' } }), '1 of 3 PRs open. Stopped: you stopped it', 'Without a count it counts the PRs it can see.');
});

test('the confirm says how many beads, for how long, and that nothing merges', () => {
  assert.match(confirmLine(3, 90), /^Run 3 beads one after the other, for 90 minutes\./);
  assert.match(confirmLine(1, 240), /^Run 1 bead one after the other, for 4 hours\./);
  assert.match(confirmLine(8, 480), /for up to 8 hours\./);
  assert.match(confirmLine(2, 90), /nothing merges\.$/);
});
