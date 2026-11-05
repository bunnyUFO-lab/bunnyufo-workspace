// When the chat reads its saved lines: a reply due after a cut stream, a delegate with no result yet.
import test from 'node:test';
import assert from 'node:assert/strict';
import { FAST_FOR_MS, hasRunningDelegate, nextLookMs, replySaved, sameLines } from '../../src/hub/chatWatch.ts';

const sent = '2026-11-05T04:56:10.000Z';
const user = (text, at = sent) => ({ role: 'user', text, at });
const assistant = text => ({ role: 'assistant', text, at: '2026-11-05T04:56:52.000Z' });

test('the saved lines hold this turn only when they end with its question and an answer', () => {
  assert.equal(replySaved([user('Go'), assistant('Done')], 'Go', sent), true);
  assert.equal(replySaved([], 'Go', sent), false);
  assert.equal(replySaved([user('Go')], 'Go', sent), false, 'Saved without a reply.');
  assert.equal(replySaved([user('Other'), assistant('Done')], 'Go', sent), false, 'The newest turn is another one.');
});

test('the same words asked earlier are not this turn, though the clocks may differ by a little', () => {
  const earlier = new Date(new Date(sent).getTime() - FAST_FOR_MS - 1000).toISOString();
  assert.equal(replySaved([user('Go', earlier), assistant('Old')], 'Go', sent), false);
  const skewed = new Date(new Date(sent).getTime() - 30_000).toISOString();
  assert.equal(replySaved([user('Go', skewed), assistant('Done')], 'Go', sent), true);
});

test('a due reply is looked for soon, then less often; a delegate slowly', () => {
  assert.equal(nextLookMs(true, 0), 4000);
  assert.equal(nextLookMs(true, FAST_FOR_MS + 1), 15000);
  assert.equal(nextLookMs(false, 0), 20000);
});

test('only a running delegate keeps the page reading', () => {
  assert.equal(hasRunningDelegate([assistant('No delegates')]), false);
  assert.equal(hasRunningDelegate([{ ...assistant('A'), delegates: [{ id: 'd1', goal: 'x', state: 'done' }, { id: 'd2', goal: 'y', state: 'unknown' }] }]), false);
  assert.equal(hasRunningDelegate([{ ...assistant('A'), delegates: [{ id: 'd1', goal: 'x', state: 'running' }] }]), true);
});

test('unchanged lines are not redrawn', () => {
  assert.equal(sameLines([user('Go')], [user('Go')]), true);
  assert.equal(sameLines([user('Go')], [user('Go'), assistant('Done')]), false);
});
