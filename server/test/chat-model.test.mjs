// The chat's default model when a plan is paused by its usage limit: it falls down the chain, a hand pick stays, and the note says why.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseModel, nextModel, pauseNote, pauseOf } from '../../src/hub/chatModel.ts';

const now = Date.parse('2026-11-01T13:00:00Z');
const chain = ['codex', 'sonnet', 'deepseek-flash'];
const pause = (model, extra = {}) => ({ model, seen: '2026-11-01T12:40:00.000Z', until: '2026-11-01T14:20:00.000Z', reported: true, ...extra });

test('no pause: the preferred model, or the pick', () => {
  assert.deepEqual(chooseModel({ picked: null, preferred: 'codex', chain, pauses: [], now }), { model: 'codex' });
  assert.deepEqual(chooseModel({ picked: 'haiku', preferred: 'codex', chain, pauses: [], now }), { model: 'haiku', pause: undefined });
  assert.deepEqual(chooseModel({ picked: null, preferred: 'auto', chain, pauses: [pause('codex')], now }), { model: 'auto' }, 'Auto has its own chain');
});

test('the preferred model paused: the default is the next one in the chain', () => {
  const codex = pause('codex');
  assert.deepEqual(chooseModel({ picked: null, preferred: 'codex', chain, pauses: [codex], now }), { model: 'sonnet', pause: codex, using: 'sonnet' });
});

test('the next one paused too: it skips to the one after, and keeps the preferred one when nothing is left', () => {
  const both = [pause('codex'), pause('sonnet')];
  assert.equal(chooseModel({ picked: null, preferred: 'codex', chain, pauses: both, now }).model, 'deepseek-flash');
  const all = [...both, pause('deepseek-flash')];
  assert.deepEqual(chooseModel({ picked: null, preferred: 'codex', chain, pauses: all, now }), { model: 'codex', pause: all[0] });
});

test('a model the owner picked stays picked, with the pause beside it and no "using"', () => {
  const codex = pause('codex');
  assert.deepEqual(chooseModel({ picked: 'codex', preferred: 'codex', chain, pauses: [codex], now }), { model: 'codex', pause: codex });
  assert.deepEqual(chooseModel({ picked: 'codex', preferred: 'sonnet', chain, pauses: [codex], now }), { model: 'codex', pause: codex });
});

test('a pause that has run out is no pause', () => {
  assert.equal(pauseOf([pause('codex')], 'codex', Date.parse('2026-11-01T14:20:00Z')), undefined);
  assert.deepEqual(chooseModel({ picked: null, preferred: 'codex', chain, pauses: [pause('codex')], now: Date.parse('2026-11-01T15:00:00Z') }), { model: 'codex' });
});

test('a model outside the chain falls to the first free one after the start of it', () => {
  assert.equal(nextModel('haiku', chain, [pause('codex')], now), 'sonnet');
  assert.equal(nextModel('deepseek-flash', chain, [], now), null);
});

test('the note: a reported time says until, a guessed one says when it was seen; a hand pick has no "using"', () => {
  const when = iso => iso.slice(11, 16);
  assert.equal(pauseNote('Codex', pause('codex'), when, 'Sonnet'), 'Codex is paused by its usage limit until 14:20 · using Sonnet');
  assert.equal(pauseNote('Codex', pause('codex', { reported: false }), when, 'Sonnet'), 'Codex is paused by its usage limit (seen 12:40) · using Sonnet');
  assert.equal(pauseNote('Codex', pause('codex'), when), 'Codex is paused by its usage limit until 14:20');
});

test('an Opus pick under an Anthropic pause stays Opus, and the chain never moves a default onto it', () => {
  const sonnet = pause('sonnet');
  assert.deepEqual(chooseModel({ picked: 'opus', preferred: 'codex', chain, pauses: [pause('opus'), sonnet], now }), { model: 'opus', pause: pause('opus') });
  for (const paused of [[], [pause('codex')], [pause('codex'), sonnet], [pause('codex'), sonnet, pause('deepseek-flash')]]) {
    assert.notEqual(chooseModel({ picked: null, preferred: 'codex', chain, pauses: paused, now }).model, 'opus');
  }
  assert.equal(nextModel('sonnet', chain, [pause('deepseek-flash')], now), null, 'and a chain with nothing free does not reach for it');
});
