// The Hub's in-memory last-answer store: keys, the write stamp, limits.
import test from 'node:test';
import assert from 'node:assert/strict';
import { HUB_CACHE_MAX, HUB_CACHE_MAX_AGE_MS, clearHub, hubCacheStamp, peekHub, putHub } from '../../src/lib/hubCache.mjs';

const put = (path, data) => putHub(path, data, hubCacheStamp(), new Date());

test('peek returns what was put, and a miss is null', () => {
  clearHub();
  assert.equal(peekHub('/team'), null);
  const at = new Date();
  putHub('/team', { agents: [1] }, hubCacheStamp(), at);
  assert.deepEqual(peekHub('/team'), { data: { agents: [1] }, at });
});

test('a different query is a different key', () => {
  clearHub();
  put('/work?project=a', { cards: ['a'] });
  assert.equal(peekHub('/work?project=b'), null);
  assert.equal(peekHub('/work'), null);
  assert.deepEqual(peekHub('/work?project=a').data, { cards: ['a'] });
});

test('an answer that started before a clear is dropped', () => {
  clearHub();
  const started = hubCacheStamp();
  clearHub();
  putHub('/team', { old: true }, started, new Date());
  assert.equal(peekHub('/team'), null);
  put('/team', { fresh: true });
  assert.deepEqual(peekHub('/team').data, { fresh: true });
});

test('a prefix clear leaves other keys and still bumps the stamp', () => {
  clearHub();
  put('/project-cards?project=a', { n: 1 });
  put('/team', { n: 2 });
  const before = hubCacheStamp();
  clearHub('/project-cards');
  assert.equal(hubCacheStamp(), before + 1);
  assert.equal(peekHub('/project-cards?project=a'), null);
  assert.deepEqual(peekHub('/team').data, { n: 2 });
  putHub('/work', { late: true }, before, new Date());
  assert.equal(peekHub('/work'), null);
});

test('null and non-object bodies are not stored', () => {
  clearHub();
  for (const body of [null, undefined, 'html', 5, true]) put('/x', body);
  assert.equal(peekHub('/x'), null);
  put('/x', []);
  assert.deepEqual(peekHub('/x').data, []);
});

test('the oldest entry goes first, and a put moves an entry to newest', () => {
  clearHub();
  for (let i = 0; i < HUB_CACHE_MAX; i += 1) put(`/k${i}`, { i });
  put('/k0', { i: 'again' });
  put('/extra', { extra: true });
  assert.equal(peekHub('/k1'), null);
  assert.deepEqual(peekHub('/k0').data, { i: 'again' });
  assert.deepEqual(peekHub('/extra').data, { extra: true });
});

test('an entry past 30 minutes is absent', () => {
  clearHub();
  const at = new Date(1_000_000);
  putHub('/team', { a: 1 }, hubCacheStamp(), at);
  assert.ok(peekHub('/team', at.getTime() + HUB_CACHE_MAX_AGE_MS));
  assert.equal(peekHub('/team', at.getTime() + HUB_CACHE_MAX_AGE_MS + 1), null);
  assert.equal(peekHub('/team', at.getTime()), null);
});
