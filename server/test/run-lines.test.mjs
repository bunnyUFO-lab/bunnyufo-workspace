// The live lines of a run: events fold in order, and nothing grows without a limit.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_LINES, MAX_TEXT, applyRunEvent } from '../../src/hub/runLines.ts';

const fold = events => events.reduce((lines, [event, data]) => applyRunEvent(lines, { event, data }), []);

test('text accumulates, a tool line completes, an approval settles', () => {
  const lines = fold([
    ['message.delta', { delta: 'Hel' }], ['message.delta', { delta: 'lo' }],
    ['tool.started', { tool: 'web_search', preview: 'q', tool_call_id: 't1' }], ['tool.completed', { tool_call_id: 't1', error: false }],
    ['approval.request', { command: 'write x', prompt_id: 'p1' }], ['approval.settled', {}],
  ]);
  assert.deepEqual(lines.map(line => line.kind), ['text', 'tool', 'approval']);
  assert.equal(lines[0].text, 'Hello');
  assert.equal(lines[1].state, 'done');
  assert.equal(lines[2].settled, true);
});

test('live text keeps its tail past the cap', () => {
  const lines = fold(Array.from({ length: 50 }, () => ['message.delta', { delta: 'x'.repeat(1000) }]));
  assert.equal(lines.length, 1);
  assert.ok(lines[0].text.length <= MAX_TEXT + 1);
  assert.ok(lines[0].text.startsWith('…'));
});

test('the oldest lines go past the line cap', () => {
  const lines = fold(Array.from({ length: MAX_LINES + 40 }, (_, index) => ['tool.started', { tool: `t${index}`, preview: '', tool_call_id: `id${index}` }]));
  assert.equal(lines.length, MAX_LINES);
  assert.equal(lines[lines.length - 1].tool, `t${MAX_LINES + 39}`);
});

test('a tool line remembers when it started, and the time reads in seconds then minutes', async () => {
  const { elapsedLabel } = await import('../../src/hub/runLines.ts');
  const lines = applyRunEvent([], { event: 'tool.started', data: { tool: 'cards', preview: 'pull', tool_call_id: 'a' } }, 1_000);
  assert.equal(lines[0].startedAt, 1_000);
  assert.equal(elapsedLabel(54_400), '54 s');
  assert.equal(elapsedLabel(130_000), '2 min 10 s');
  assert.equal(elapsedLabel(-5), '0 s');
});

test('a reply line is sent, turns read on the next tool result, and is queued when Hermes could not take it or the run ended first', () => {
  const sent = fold([['message.delta', { delta: 'Working. ' }], ['reply', { text: 'Also the wooden one', at: '2026-11-01T10:00:00Z', delivery: 'sent' }]]);
  assert.deepEqual(sent.map(line => line.kind), ['text', 'reply']);
  assert.deepEqual([sent[1].text, sent[1].state], ['Also the wooden one', 'sent']);
  const read = fold([['reply', { text: 'A', at: 'x', delivery: 'sent' }], ['run.steered', { accepted: true }], ['tool.started', { tool: 't', tool_call_id: 'a' }], ['tool.completed', { tool_call_id: 'a' }]]);
  assert.equal(read[0].state, 'read', 'run.steered changes nothing; the tool result after it is the read.');
  const refused = fold([['reply', { text: 'B', at: 'x', delivery: 'queued' }], ['tool.started', { tool: 't', tool_call_id: 'a' }], ['tool.completed', { tool_call_id: 'a' }]]);
  assert.equal(refused[0].state, 'queued', 'A queued reply is never read by the run.');
  const ended = fold([['reply', { text: 'C', at: 'x', delivery: 'sent' }], ['run.completed', {}]]);
  assert.equal(ended[0].state, 'queued', 'The run ended before reading it.');
  assert.equal(fold([['reply', { text: '', delivery: 'sent' }]]).length, 0);
});
