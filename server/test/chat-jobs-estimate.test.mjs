// The cost line above Approve all: tokens add up, and a repeated money cost is counted, not dropped.
import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateOf } from '../../src/hub/jobStates.ts';

const research = { estimate: { cost: 'Codex plan · 0.7–1.1 M tokens', time: 'about 15 min' }, tokens: { low: 0.7, high: 1.1 } };
const code = { estimate: { cost: 'about $2 API · Sonnet', time: 'about 40 min' } };

test('three code tasks read as 3 x about $2, not about $2', () => {
  assert.match(estimateOf([code, code, code]), /3 × about \$2 API · Sonnet/);
  assert.doesNotMatch(estimateOf([code, code, code]), /^about \$2 API/);
});

test('research rows add their tokens; mixed rows keep tokens and money apart and counted', () => {
  assert.match(estimateOf([research, research, research]), /^2\.1–3\.3 M tokens/);
  const mixed = estimateOf([research, code, code]);
  assert.match(mixed, /0\.7–1\.1 M tokens/);
  assert.match(mixed, /2 × about \$2 API · Sonnet/);
});

test('a Codex plan row says the figure is an estimate that a pause can change', () => {
  assert.match(estimateOf([research, research]), /paused/i);
  assert.doesNotMatch(estimateOf([code]), /paused/i);
});
