import assert from 'node:assert/strict';
import test from 'node:test';
import { duration, pcHeadline, pcLines, seen } from '../../../src/hub/working.ts';

const NOW = Date.parse('2026-10-29T12:00:00Z');
const ago = minutes => new Date(NOW - minutes * 60000).toISOString();
const pc = (extra = {}) => ({
  host: 'test-pc', at: ago(1), ageSeconds: 40, state: 'on', inUse: true, keepAwake: true,
  gpu: { util: 7, memMB: 3971, memTotalMB: 24564, band: 'idle' }, comfy: { up: true, running: 0, pending: 0 },
  unity: { open: true, projects: ['asset_library'] }, sessions: { busy: 1, idle: 4 }, ...extra,
});

test('duration reads in minutes, then hours, then days', () => {
  assert.equal(duration(ago(0), NOW), 'just now');
  assert.equal(duration(ago(12), NOW), 'for 12 min');
  assert.equal(duration(ago(185), NOW), 'for 3 h 5 min');
  assert.equal(duration(ago(180), NOW), 'for 3 h');
  assert.equal(duration(ago(60 * 72), NOW), 'for 3 days');
  assert.equal(duration('nonsense', NOW), '');
});

test('seen reads seconds, minutes and hours', () => {
  assert.equal(seen(40), '40 s ago');
  assert.equal(seen(300), '5 min ago');
  assert.equal(seen(7200), '2 h ago');
});

test('the tile headline and lines for an awake PC match the mockup', () => {
  assert.equal(pcHeadline(pc()), 'On · in use');
  assert.equal(pcHeadline(pc({ inUse: false })), 'On · idle');
  const lines = Object.fromEntries(pcLines(pc()).map(line => [line.key, line.value]));
  assert.equal(lines.gpu, '7 % · 3.9 / 24 GB');
  assert.equal(lines.comfy, 'idle');
  assert.equal(lines.unity, 'asset_library open');
  assert.equal(lines.sessions, '1 busy, 4 idle');
});

test('ComfyUI and Unity states', () => {
  const by = value => Object.fromEntries(pcLines(value).map(line => [line.key, line.value]));
  assert.equal(by(pc({ comfy: { up: true, running: 1, pending: 2 } })).comfy, '1 running, 2 queued');
  assert.equal(by(pc({ comfy: { up: false, running: 0, pending: 0 } })).comfy, 'down');
  assert.equal(by(pc({ unity: { open: false, projects: [] } })).unity, 'closed');
  assert.equal(by(pc({ gpu: null, comfy: null, unity: null })).gpu, undefined);
});

test('a stale PC says when it was last seen and shows no numbers', () => {
  const old = pc({ state: 'asleep-or-off', ageSeconds: 7200 });
  assert.equal(pcHeadline(old), 'Asleep or off · last seen 2 h ago');
  assert.deepEqual(pcLines(old), []);
});
