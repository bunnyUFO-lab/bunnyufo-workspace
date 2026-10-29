// Picking pictures out of a paste or a drop.
import test from 'node:test';
import assert from 'node:assert/strict';
import { hasFiles, hasText, isTextField, pictureFiles } from '../../src/lib/pastePictures.mjs';

const file = (name, type, size = 10) => ({ name, type, size });
const item = (kind, value) => ({ kind, getAsFile: () => value });

test('pictureFiles reads files alone, items alone, and both without doubles', () => {
  const png = file('a.png', 'image/png');
  assert.deepEqual(pictureFiles({ files: [png] }), [png]);
  assert.deepEqual(pictureFiles({ items: [item('file', png)] }), [png]);
  assert.deepEqual(pictureFiles({ files: [png], items: [item('file', file('a.png', 'image/png'))] }), [png]);
  const jpg = file('b.jpg', 'image/jpeg');
  assert.deepEqual(pictureFiles({ files: [png, jpg], items: [item('file', jpg)] }), [png, jpg], 'Order is kept.');
});

test('pictureFiles skips what is not a picture, and tolerates nothing', () => {
  assert.deepEqual(pictureFiles({ files: [file('n.txt', 'text/plain'), file('d.pdf', 'application/pdf')], items: [item('string', null), item('file', null)] }), []);
  assert.deepEqual(pictureFiles(null), []);
  assert.deepEqual(pictureFiles({}), []);
});

test('hasFiles and hasText read the transfer types', () => {
  assert.equal(hasFiles({ types: ['Files'] }), true);
  assert.equal(hasFiles({ types: ['text/plain'] }), false);
  assert.equal(hasFiles(null), false);
  assert.equal(hasText({ types: ['text/plain', 'Files'] }), true);
  assert.equal(hasText({ types: ['Files'] }), false);
});

test('isTextField: input, textarea and contenteditable take text; a button does not', () => {
  assert.equal(isTextField({ tagName: 'INPUT', type: 'text' }), true);
  assert.equal(isTextField({ tagName: 'TEXTAREA' }), true);
  assert.equal(isTextField({ tagName: 'DIV', isContentEditable: true }), true);
  assert.equal(isTextField({ tagName: 'BUTTON' }), false);
  assert.equal(isTextField({ tagName: 'INPUT', type: 'checkbox' }), false);
  assert.equal(isTextField(null), false);
});
