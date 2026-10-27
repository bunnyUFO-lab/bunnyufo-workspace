// The picture helpers on their own: sizes, metadata stripping and the checks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkChatImages, jpegSize, pngSize, stripJpeg, stripPng } from '../chat-images.mjs';
import { jpeg, solidPng, textPng } from './png.mjs';

const fail = (message, status = 400) => Object.assign(new Error(message), { status });

test('sizes come from the PNG header and the first JPEG frame marker', () => {
  assert.deepEqual(pngSize(solidPng(7, 9)), [7, 9]);
  assert.deepEqual(jpegSize(jpeg(321, 123)), [321, 123]);
  assert.equal(jpegSize(Buffer.from([0xff, 0xd8, 0xff, 0xd9])), null);
});

test('stripJpeg drops EXIF and comments, keeps JFIF and the scan; stripPng drops text chunks', () => {
  const stripped = stripJpeg(jpeg(20, 10));
  assert.ok(!stripped.includes('Exif') && !stripped.includes('GPS') && !stripped.includes('a comment'));
  assert.ok(stripped.includes('JFIF'));
  assert.deepEqual(jpegSize(stripped), [20, 10]);
  assert.equal(stripped.at(-2), 0xff);
  assert.equal(stripJpeg(jpeg(20, 10).subarray(0, 30)), null, 'A cut-off file is damaged.');
  const png = stripPng(textPng(12, 6));
  assert.ok(!png.includes('tEXt'));
  assert.deepEqual(pngSize(png), [12, 6]);
  assert.ok(png.length < textPng(12, 6).length);
  assert.equal(stripPng(solidPng(2, 2).subarray(0, 40)), null);
});

test('checkChatImages returns stripped buffers and refuses what it should', () => {
  const [one] = checkChatImages([{ type: 'image/jpeg', data: jpeg(8, 8).toString('base64') }], fail);
  assert.deepEqual([one.type, one.ext, one.width, one.height], ['image/jpeg', 'jpg', 8, 8]);
  assert.deepEqual(checkChatImages(undefined, fail), []);
  assert.throws(() => checkChatImages('x', fail), { status: 400 });
  assert.throws(() => checkChatImages([{ type: 'image/webp', data: 'AAAA' }], fail), { status: 415 });
  assert.throws(() => checkChatImages([{ type: 'image/png', data: 'AAAA' }], fail), { status: 415 });
});

test('stripJpeg cuts a second picture appended after the first end-of-image marker, and keeps stuffed FF 00 bytes', () => {
  const first = jpeg(20, 10, { exif: false });
  const appended = Buffer.concat([first, jpeg(20, 10, { exif: true })]);
  assert.ok(appended.includes('GPS'));
  const stripped = stripJpeg(appended);
  assert.ok(!stripped.includes('Exif') && !stripped.includes('GPS'));
  assert.equal(stripped.length, first.length);
  const stuffed = Buffer.concat([first.subarray(0, -2), Buffer.from([0xff, 0x00, 0xd9, 0xff, 0xd9]), Buffer.from('Exif GPS')]);
  const kept = stripJpeg(stuffed);
  assert.equal(kept.length, stuffed.length - 'Exif GPS'.length, 'Only what follows the real end marker is cut.');
});
