// The fake Hermes run API: the shapes the Hermes tasks rely on (S4, Hermes 0.22.5).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startFakeHermes } from './fake-hermes.mjs';

const auth = { Authorization: 'Bearer k', 'Content-Type': 'application/json' };
const start = async (hermes, body = { input: 'go' }, headers = {}) => {
  const response = await fetch(`${hermes.url}/v1/runs`, { method: 'POST', headers: { ...auth, ...headers }, body: JSON.stringify(body) });
  return { response, body: await response.json() };
};
const status = async (hermes, id) => (await fetch(`${hermes.url}/v1/runs/${id}`, { headers: auth })).json();
const post = (hermes, id, action, body) => fetch(`${hermes.url}/v1/runs/${id}/${action}`, { method: 'POST', headers: auth, body: JSON.stringify(body) });
// Reads an events response to its end; returns the raw text, the parsed events and the comment lines.
const readEvents = async (hermes, id, { lastId, query = '' } = {}) => {
  const response = await fetch(`${hermes.url}/v1/runs/${id}/events${query}`, { headers: { ...auth, ...(lastId === undefined ? {} : { 'Last-Event-ID': String(lastId) }) } });
  if (response.status !== 200) return { response };
  // A stream the server destroys throws on the last read: keep what arrived before it.
  let text = '';
  const reader = response.body.getReader();
  try { for (;;) { const { done, value } = await reader.read(); if (done) break; text += new TextDecoder().decode(value); } } catch { /* dropped */ }
  return {
    response, text,
    events: [...text.matchAll(/^id: (\d+)\ndata: (.*)$/gm)].map(match => ({ id: Number(match[1]), ...JSON.parse(match[2]) })),
    comments: text.split('\n').filter(line => line.startsWith(':')),
  };
};
const until = async check => { for (let i = 0; i < 200; i++) { const value = await check(); if (value) return value; await new Promise(r => setTimeout(r, 10)); } throw new Error('timed out'); };
const fake = async (options, run) => { const hermes = await startFakeHermes({ key: 'k', delayMs: 2, ...options }); try { await run(hermes); } finally { await hermes.close(); } };

test('a run starts, streams numbered events and resumes from Last-Event-ID', () => fake({}, async hermes => {
  const { response, body } = await start(hermes, { input: 'go' }, { 'Idempotency-Key': 'req-1' });
  assert.equal(response.status, 202);
  assert.match(body.run_id, /^run_/);
  assert.deepEqual({ ...body, run_id: undefined }, { run_id: undefined, status: 'started', replayed: false });
  const all = await readEvents(hermes, body.run_id);
  assert.equal(all.text.split('\n')[0], ': open');
  assert.deepEqual(all.events.map(event => event.event), ['message.delta', 'message.delta', 'message.delta', 'run.completed']);
  assert.deepEqual(all.events.map(event => event.id), [0, 1, 2, 3]);
  assert.equal(all.events.at(-1).output, 'Hello there');
  assert.ok(all.comments.includes(': stream closed'));
  const resumed = await readEvents(hermes, body.run_id, { lastId: 1 });
  assert.deepEqual(resumed.events.map(event => event.id), [2, 3]);
  assert.deepEqual((await readEvents(hermes, body.run_id, { query: '?last_seq=2' })).events.map(event => event.id), [3]);
  const done = await status(hermes, body.run_id);
  assert.equal(done.status, 'completed');
  assert.equal(done.output, 'Hello there');
  assert.equal(done.run_id, body.run_id);
  assert.deepEqual(hermes.runs[0].body, { input: 'go' });
  const again = await start(hermes, { input: 'go' }, { 'Idempotency-Key': 'req-1' });
  assert.deepEqual(again.body, { run_id: body.run_id, status: 'running', replayed: true });
  assert.equal(hermes.runs.length, 1);
}));

test('an approval round trip: the body needs execution_generation, deny and once both finish the run', () => fake({ askApproval: true }, async hermes => {
  for (const choice of ['deny', 'once']) {
    const { body } = await start(hermes);
    const waiting = await until(async () => { const view = await status(hermes, body.run_id); return view.status === 'waiting_for_approval' && view; });
    const prompt = waiting.pending_controls[0];
    assert.deepEqual([prompt.kind, prompt.execution_generation, prompt.choices], ['approval', 1, ['once', 'deny']]);
    const missing = await post(hermes, body.run_id, 'approval', { request_id: prompt.prompt_id, choice });
    assert.equal(missing.status, 400);
    assert.equal((await missing.json()).error.code, 'invalid_params');
    const ok = await post(hermes, body.run_id, 'approval', { request_id: prompt.prompt_id, execution_generation: 1, choice });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { run_id: body.run_id, status: 'resolved', prompt_id: prompt.prompt_id });
    const { events } = await readEvents(hermes, body.run_id);
    const names = events.map(event => event.event);
    assert.ok(names.indexOf('approval.request') < names.indexOf('approval.settled'));
    assert.equal(events.find(event => event.event === 'approval.settled').choice, undefined);
    assert.equal(events.find(event => event.event === 'tool.completed').error, choice === 'deny');
    assert.equal(names.at(-1), 'run.completed');
    assert.equal((await status(hermes, body.run_id)).status, 'completed');
    assert.equal((await post(hermes, body.run_id, 'approval', { request_id: prompt.prompt_id, execution_generation: 1, choice })).status, 409);
  }
}));

test('an unanswered approval auto-denies and the run still completes', () => fake({ askApproval: true, approvalTimeoutMs: 40 }, async hermes => {
  const { body } = await start(hermes);
  const { events } = await readEvents(hermes, body.run_id);
  assert.deepEqual(events.map(event => event.event).filter(name => name.startsWith('approval') || name === 'tool.completed'), ['approval.request', 'approval.settled', 'tool.completed']);
  assert.equal(events.find(event => event.event === 'tool.completed').error, true);
  assert.equal((await status(hermes, body.run_id)).status, 'completed');
}));

test('stop answers stopping, ends the run cancelled with partial output, and works while waiting for approval', () => fake({ runScript: ['one ', { hold: true }] }, async hermes => {
  const { body } = await start(hermes);
  await until(async () => (await status(hermes, body.run_id)).status === 'running' && hermes.runs[0].events.length > 0);
  const stop = await post(hermes, body.run_id, 'stop', {});
  assert.equal((await stop.json()).status, 'stopping');
  const { events } = await readEvents(hermes, body.run_id);
  assert.equal(events.at(-1).event, 'run.cancelled');
  const view = await status(hermes, body.run_id);
  assert.deepEqual([view.status, view.output], ['cancelled', 'one ']);
  assert.equal((await post(hermes, body.run_id, 'stop', {})).status, 409);
}));

test('stop while waiting for approval cancels the run', () => fake({ askApproval: true }, async hermes => {
  const { body } = await start(hermes);
  await until(async () => (await status(hermes, body.run_id)).status === 'waiting_for_approval');
  await post(hermes, body.run_id, 'stop', {});
  const { events } = await readEvents(hermes, body.run_id);
  assert.equal(events.at(-1).event, 'run.cancelled');
  assert.equal((await status(hermes, body.run_id)).status, 'cancelled');
}));

test('a held run stays running until released (the 120-minute cap is the caller\'s)', () => fake({ runScript: ['x', { hold: true }] }, async hermes => {
  const { body } = await start(hermes);
  await new Promise(r => setTimeout(r, 80));
  assert.equal((await status(hermes, body.run_id)).status, 'running');
  hermes.release(body.run_id, 'done late');
  const { events } = await readEvents(hermes, body.run_id);
  assert.equal(events.at(-1).output, 'done late');
}));

test('a run that ends in a question completes with that output', () => fake({ endWith: 'Which repo should I use?' }, async hermes => {
  const { body } = await start(hermes);
  const { events } = await readEvents(hermes, body.run_id);
  assert.equal(events.at(-1).output, 'Which repo should I use?');
  assert.equal((await status(hermes, body.run_id)).output, 'Which repo should I use?');
}));

test('failures: failWith, the fallback chain, a named provider, busy and unknown runs', async () => {
  await fake({ failWith: '429 usage limit reached' }, async hermes => {
    const { body } = await start(hermes);
    const { events } = await readEvents(hermes, body.run_id);
    assert.deepEqual(events.map(event => event.event), ['error', 'run.failed']);
    const view = await status(hermes, body.run_id);
    assert.deepEqual([view.status, view.error], ['failed', '429 usage limit reached']);
  });
  await fake({ providerFailures: { 'openai-codex': '429 quota' } }, async hermes => {
    const { body } = await start(hermes);
    const { events } = await readEvents(hermes, body.run_id);
    assert.equal(events.at(-1).runtime.provider, 'anthropic');
    const named = await start(hermes, { input: 'retry', provider: 'openai-codex', model: 'gpt-6-sol' });
    const failed = await status(hermes, named.body.run_id).then(() => until(async () => { const v = await status(hermes, named.body.run_id); return v.status === 'failed' && v; }));
    assert.equal(failed.error, '429 quota');
    assert.deepEqual(hermes.runs[1].body, { input: 'retry', provider: 'openai-codex', model: 'gpt-6-sol' });
  });
  await fake({ busy: true }, async hermes => {
    const { response, body } = await start(hermes);
    assert.equal(response.status, 429);
    assert.equal(response.headers.get('retry-after'), '1');
    assert.equal(body.error.code, 'rate_limit_exceeded');
  });
  await fake({}, async hermes => {
    assert.equal((await fetch(`${hermes.url}/v1/runs/run_nope`, { headers: auth })).status, 404);
    assert.equal((await fetch(`${hermes.url}/v1/runs`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: '{}' })).status, 400);
    assert.equal((await fetch(`${hermes.url}/v1/runs`, { method: 'POST', body: '{}' })).status, 401);
  });
});

test('forgetRuns, forget() and dropBufferAfterMs give 404 as Hermes does', async () => {
  await fake({ forgetRuns: true }, async hermes => {
    const { body } = await start(hermes);
    assert.equal((await fetch(`${hermes.url}/v1/runs/${body.run_id}`, { headers: auth })).status, 404);
  });
  await fake({ dropBufferAfterMs: 30 }, async hermes => {
    const { body } = await start(hermes);
    await until(async () => (await status(hermes, body.run_id)).status === 'completed');
    await new Promise(r => setTimeout(r, 50));
    const events = await readEvents(hermes, body.run_id);
    assert.equal(events.response.status, 404);
    assert.equal((await status(hermes, body.run_id)).status, 'completed');
    hermes.forget(body.run_id);
    assert.equal((await fetch(`${hermes.url}/v1/runs/${body.run_id}`, { headers: auth })).status, 404);
  });
});

test('dropStreamAfter closes the stream early; a reconnect picks up the rest', () => fake({ dropStreamAfter: 2 }, async hermes => {
  const { body } = await start(hermes);
  const seen = [];
  let last;
  for (let attempt = 0; attempt < 6 && seen.at(-1) !== 3; attempt++) {
    const { events } = await readEvents(hermes, body.run_id, { lastId: last });
    seen.push(...events.map(event => event.id));
    last = seen.at(-1);
  }
  assert.deepEqual(seen, [0, 1, 2, 3]);
}));

test('keepalive comments arrive on a quiet stream', () => fake({ keepaliveMs: 20, runScript: ['x', { hold: true }] }, async hermes => {
  const { body } = await start(hermes);
  const response = await fetch(`${hermes.url}/v1/runs/${body.run_id}/events`, { headers: auth });
  const reader = response.body.getReader();
  let text = '';
  while (!text.includes(': keepalive')) text += new TextDecoder().decode((await reader.read()).value);
  await reader.cancel();
  assert.ok(text.startsWith(': open'));
}));
