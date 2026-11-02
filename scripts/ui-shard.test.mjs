import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseShard, pickShard } from './ui-shard.mjs';

test('no flag leaves the arguments and the files alone', () => {
  const { rest, shard } = parseShard(['hub', 'needs']);
  assert.deepEqual(rest, ['hub', 'needs']);
  assert.equal(shard, null);
  assert.deepEqual(pickShard(['a', 'b'], shard), ['a', 'b']);
});

test('--shard i/n is parsed in both spellings and leaves the fragments', () => {
  assert.deepEqual(parseShard(['--shard', '2/4', 'hub']), { rest: ['hub'], shard: { index: 2, count: 4 } });
  assert.deepEqual(parseShard(['--shard=3/3']), { rest: [], shard: { index: 3, count: 3 } });
});

test('a bad shard is refused', () => {
  for (const bad of ['0/4', '5/4', '1', 'a/b', '1/0']) assert.throws(() => parseShard(['--shard', bad]), /--shard wants i\/n/);
  assert.throws(() => parseShard(['--shard']), /--shard wants i\/n/);
});

test('the shards partition the list: every file runs once, in order', () => {
  const files = Array.from({ length: 10 }, (_, at) => `f${at}`);
  const parts = [1, 2, 3].map(index => pickShard(files, { index, count: 3 }));
  assert.deepEqual(parts[0], ['f0', 'f3', 'f6', 'f9']);
  assert.deepEqual(parts[1], ['f1', 'f4', 'f7']);
  assert.deepEqual(parts.flat().sort(), [...files].sort());
});

test('with timings the shards are balanced by time and still partition the list', () => {
  const files = ['a', 'b', 'c', 'd', 'e', 'f'];
  const timings = { a: 100, b: 10, c: 10, d: 10, e: 10, f: 60 }; // g is unknown: counts as the median
  const parts = [1, 2].map(index => pickShard(files, { index, count: 2 }, timings));
  assert.deepEqual(parts[0], ['a']); // 100 against 10+10+10+10+60
  assert.deepEqual(parts[1], ['b', 'c', 'd', 'e', 'f']);
  assert.deepEqual(parts.flat().sort(), files);
});

test('a file missing from the timings counts as the median; empty timings fall back to every n-th', () => {
  const parts = [1, 2].map(index => pickShard(['x', 'y', 'z'], { index, count: 2 }, { x: 5, y: 5 }));
  assert.deepEqual(parts.flat().sort(), ['x', 'y', 'z']);
  assert.deepEqual(pickShard(['x', 'y', 'z'], { index: 1, count: 2 }, {}), ['x', 'z']);
});
