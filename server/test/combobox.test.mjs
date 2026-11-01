// The Combobox's matching and keyboard movement (src/hub/comboboxLogic.ts).
import test from 'node:test';
import assert from 'node:assert/strict';
import { filterOptions, fold, matches, moveActive } from '../../src/hub/comboboxLogic.ts';

const options = [
  { value: 'magic-loops', label: 'Magic Loops', keywords: ['magic-loops'] },
  { value: 'cafe', label: 'Café Tycoon' },
  { value: 'sprite-studio', label: 'Sprite Studio', keywords: ['example/sprite-studio'] },
  { value: '__other', label: 'Another repo…', always: true },
];

test('fold lowercases and strips accents', () => {
  assert.equal(fold('  Café ÉCOLE '), 'cafe ecole');
  assert.equal(fold('café'), 'cafe');
});

test('a match is a case-insensitive substring of the label', () => {
  assert.equal(matches(options[0], 'LOOP'), true);
  assert.equal(matches(options[0], 'ic lo'), true);
  assert.equal(matches(options[0], 'studio'), false);
});

test('accents match both ways', () => {
  assert.equal(matches(options[1], 'cafe'), true);
  assert.equal(matches(options[1], 'CAFÉ'), true);
  assert.equal(matches({ value: 'x', label: 'Cafe' }, 'café'), true);
});

test('keywords match too', () => {
  assert.equal(matches(options[2], 'example/'), true);
  assert.equal(matches(options[2], 'nothing'), false);
});

test('an empty or blank query matches everything', () => {
  assert.equal(filterOptions(options, '').length, 4);
  assert.equal(filterOptions(options, '   ').length, 4);
});

test('filterOptions keeps order and keeps the always-row', () => {
  assert.deepEqual(filterOptions(options, 'sprite').map(option => option.value), ['sprite-studio', '__other']);
  assert.deepEqual(filterOptions(options, 'zzz').map(option => option.value), ['__other']);
  assert.deepEqual(filterOptions(options.slice(0, 3), 'zzz'), []);
});

test('moveActive steps, clamps and handles none', () => {
  assert.equal(moveActive(-1, 3, 'ArrowDown'), 0);
  assert.equal(moveActive(-1, 3, 'ArrowUp'), 2);
  assert.equal(moveActive(0, 3, 'ArrowDown'), 1);
  assert.equal(moveActive(2, 3, 'ArrowDown'), 2, 'No wrap at the end.');
  assert.equal(moveActive(0, 3, 'ArrowUp'), 0, 'No wrap at the start.');
  assert.equal(moveActive(1, 3, 'Home'), 0);
  assert.equal(moveActive(1, 3, 'End'), 2);
  assert.equal(moveActive(0, 0, 'ArrowDown'), -1, 'An empty list has no highlight.');
});
