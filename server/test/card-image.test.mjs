// The size an SVG is drawn at when it goes to the clipboard as PNG (src/lib/cardImage.ts).
import test from 'node:test';
import assert from 'node:assert/strict';
import { svgSize } from '../../src/lib/cardImage.ts';

test('an SVG with a width and a height keeps them', () => {
  assert.deepEqual(svgSize('<svg width="80" height="40" viewBox="0 0 40 20"></svg>'), { width: 80, height: 40 });
});

test('an SVG with one length gets the other from its viewBox', () => {
  assert.deepEqual(svgSize('<svg width="50" viewBox="0 0 40 20"></svg>'), { width: 50, height: 25 });
  assert.deepEqual(svgSize('<svg height="30" viewBox="0 0 40 20"></svg>'), { width: 60, height: 30 });
});

test('an SVG with a viewBox only is drawn with a long edge of 1024', () => {
  assert.deepEqual(svgSize('<svg viewBox="0 0 40 20"></svg>'), { width: 1024, height: 512 });
  assert.deepEqual(svgSize('<svg viewBox="0 0 20 40"></svg>'), { width: 512, height: 1024 });
});

test('an SVG with no size at all, or only percentages, is a 1024 square', () => {
  assert.deepEqual(svgSize('<svg></svg>'), { width: 1024, height: 1024 });
  assert.deepEqual(svgSize('<svg width="100%" height="100%"></svg>'), { width: 1024, height: 1024 });
});
