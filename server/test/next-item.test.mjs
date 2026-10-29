// Which item comes next after the owner settles one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { NOTE_VERB, itemKey, itemLink, pickNext } from '../../src/lib/nextItem.mjs';

const ask = id => ({ kind: 'ask', id, title: `Ask ${id}` });
const list = id => ({ kind: 'checklist', id, title: `List ${id}` });
const stuck = id => ({ kind: 'blocked', id, title: `Stuck ${id}` });
const keys = items => items.map(itemKey);

test('a middle item: the one that came after it', () => {
  const before = [ask('a'), ask('b'), list('c'), stuck('d')];
  const after = before.filter(item => item.id !== 'b');
  assert.equal(pickNext(after, 'ask-b', keys(before)).id, 'c');
});

test('the last item: the first one left', () => {
  const before = [ask('a'), ask('b'), list('c')];
  const after = before.filter(item => item.id !== 'c');
  assert.equal(pickNext(after, 'checklist-c', keys(before)).id, 'a');
});

test('the only item: nothing is next', () => {
  assert.equal(pickNext([], 'ask-a', ['ask-a']), null);
  assert.equal(pickNext([ask('a')], 'ask-a', ['ask-a']), null, 'Still in the refetch, but it is the settled one.');
});

test('the settled item is skipped even when the refetch still returns it', () => {
  const before = [ask('a'), ask('b'), ask('c')];
  assert.equal(pickNext(before, 'ask-a', keys(before)).id, 'b');
  assert.equal(pickNext(before, 'ask-c', keys(before)).id, 'a', 'As the last one it wraps, and never returns itself.');
});

test('an item that vanished since is passed over', () => {
  const before = [ask('a'), ask('b'), ask('c')];
  const after = [ask('a'), ask('c')];
  assert.equal(pickNext(after, 'ask-a', keys(before)).id, 'c', 'b was answered elsewhere.');
});

test('a filter list: the order is the list the owner was looking at', () => {
  const steps = [list('x'), list('y'), list('z')];
  assert.equal(pickNext(steps.filter(item => item.id !== 'x'), 'checklist-x', keys(steps)).id, 'y');
  assert.equal(pickNext(steps.filter(item => item.id !== 'z'), 'checklist-z', keys(steps)).id, 'x');
});

test('with no order to go by, the first item left is next', () => {
  assert.equal(pickNext([ask('a'), ask('b')], 'ask-gone', []).id, 'a');
  assert.equal(pickNext([ask('a'), null, ask('b')], 'ask-a').id, 'b', 'A null row is ignored.');
});

test('itemLink: each kind opens on its own page; a session goes to Unstick with its card in focus', () => {
  assert.deepEqual(itemLink(ask('20261029-probe-x-a1b2')), { hash: '#/~hub/ask/20261029-probe-x-a1b2' });
  assert.deepEqual(itemLink(list('c1')), { hash: '#/~hub/checklist/c1' });
  assert.deepEqual(itemLink({ kind: 'review', id: '120000-pc-000001.json' }), { hash: '#/~hub/review/120000-pc-000001.json' });
  assert.deepEqual(itemLink(stuck('sess-1')), { hash: '#/~hub/needs/unstick', focus: 'blocked-sess-1' });
});

test('NOTE_VERB: one word per action', () => {
  assert.deepEqual(Object.keys(NOTE_VERB), ['answered', 'snoozed', 'submitted', 'done', 'cancelled', 'reviewed', 'reported']);
  assert.equal(NOTE_VERB.done, 'Marked done');
  assert.equal(NOTE_VERB.reviewed, 'Review sent');
  assert.equal(NOTE_VERB.reported, 'Report sent');
});
