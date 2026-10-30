// The update reload waits for a Chat reply and for Hub writes; a cut reply stream is told apart from Stop.
import test from 'node:test';
import assert from 'node:assert/strict';
import { holdReload, reloadWhenIdle, resetReloadGate } from '../../src/lib/reloadGate.ts';
import { StreamCut, readChatStream } from '../../src/hub/chatRead.ts';

test('with nothing held, the reload runs at once', () => {
  resetReloadGate();
  let reloads = 0;
  reloadWhenIdle(() => { reloads += 1; });
  assert.equal(reloads, 1);
});

test('a held reload waits for the last release, then runs once', () => {
  resetReloadGate();
  let reloads = 0;
  const first = holdReload();
  const second = holdReload();
  reloadWhenIdle(() => { reloads += 1; });
  reloadWhenIdle(() => { reloads += 1; });
  assert.equal(reloads, 0);
  first();
  first();   // releasing twice does not free the other hold
  assert.equal(reloads, 0);
  second();
  assert.equal(reloads, 1);
  holdReload()();
  assert.equal(reloads, 1, 'a later hold does not run it again');
});

test('a hold with no update waiting does nothing when released', () => {
  resetReloadGate();
  holdReload()();
});

const streamOf = (chunks, { fail } = {}) => {
  const encoder = new TextEncoder();
  let at = 0;
  return new ReadableStream({
    pull(controller) {
      if (at < chunks.length) controller.enqueue(encoder.encode(chunks[at++]));
      else if (fail) controller.error(new TypeError('network error'));
      else controller.close();
    },
  });
};
const handlers = seen => ({ onDelta: text => seen.push(['delta', text]), onCreated() {}, onDone: name => seen.push(['done', name]), onError: message => seen.push(['error', message]), onStarted: run => seen.push(['started', run]) });
const read = (chunks, seen, options, signal = new AbortController().signal) => readChatStream(streamOf(chunks, options), handlers(seen), signal);

test('a stream that ends with done is not a cut', async () => {
  const seen = [];
  await read(['event: started\ndata: {"run":"r1"}\n\n', 'event: delta\ndata: {"text":"Hi"}\n\n', 'event: done\ndata: {"conversation":"c1"}\n\n'], seen);
  assert.deepEqual(seen, [['started', 'r1'], ['delta', 'Hi'], ['done', 'c1']]);
});

test('a server error event is an ending, not a cut', async () => {
  const seen = [];
  await read(['event: error\ndata: {"error":"Nope"}\n\n'], seen);
  assert.deepEqual(seen, [['error', 'Nope']]);
});

test('a stream cut mid-reply throws StreamCut, after the text that arrived', async () => {
  const seen = [];
  await assert.rejects(read(['event: delta\ndata: {"text":"Part"}\n\n'], seen, { fail: true }), StreamCut);
  assert.deepEqual(seen, [['delta', 'Part']]);
});

test('a stream that closes with no done or error throws StreamCut', async () => {
  await assert.rejects(read(['event: delta\ndata: {"text":"Part"}\n\n'], []), StreamCut);
});

test('the Stop button is not a cut', async () => {
  const controller = new AbortController();
  controller.abort();
  await read(['event: delta\ndata: {"text":"Part"}\n\n'], [], undefined, controller.signal);
});
