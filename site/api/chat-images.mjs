// Pictures in a Hub Chat message: checks, size reading and metadata stripping, with no dependency.
// Pure functions over Buffers, so they can be tested without a server. `fail(message, status)`
// makes the error the caller throws; the pictures come from a client that is never trusted.

export const MAX_IMAGES = 4;
export const MAX_IMAGE_BYTES = 1.5 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 5 * 1024 * 1024;
export const MAX_SIDE = 2048;
export const IMAGE_FILE = /^[a-z0-9]{10}\.(jpg|png)$/;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const EXTENSION = { 'image/jpeg': 'jpg', 'image/png': 'png' };
const PNG_DROPPED = new Set(['eXIf', 'tEXt', 'zTXt', 'iTXt', 'tIME']);

export const isPng = buffer => buffer.length >= 8 && buffer.subarray(0, 8).equals(PNG_SIGNATURE);
export const isJpeg = buffer => buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
export const typeOfFile = file => (file.endsWith('.png') ? 'image/png' : 'image/jpeg');

/** `[width, height]` from a PNG's IHDR, or null. */
export function pngSize(buffer) {
  if (buffer.length < 24 || buffer.toString('ascii', 12, 16) !== 'IHDR' || buffer.readUInt32BE(8) !== 13) return null;
  return [buffer.readUInt32BE(16), buffer.readUInt32BE(20)];
}

/** `[width, height]` from the first SOF0, SOF1 or SOF2 marker of a JPEG, or null. */
export function jpegSize(buffer) {
  let at = 2;
  while (at + 4 <= buffer.length) {
    if (buffer[at] !== 0xff) return null;
    const marker = buffer[at + 1];
    if (marker === 0xff) { at += 1; continue; }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) { at += 2; continue; }
    if (marker === 0xd9 || marker === 0xda) return null;
    const length = buffer.readUInt16BE(at + 2);
    if (length < 2) return null;
    if (marker >= 0xc0 && marker <= 0xc2) {
      if (at + 9 > buffer.length) return null;
      return [buffer.readUInt16BE(at + 7), buffer.readUInt16BE(at + 5)];
    }
    at += 2 + length;
  }
  return null;
}

/**
 * The index just past the first end-of-image marker in scan data from `from`. A stuffed FF 00 and
 * the restart markers FF D0 to D7 are not it. Everything after it (a second picture, with its own
 * EXIF) is cut. The end of the buffer when there is no marker.
 */
function scanEnd(buffer, from) {
  for (let at = from; at + 1 < buffer.length; at += 1) {
    if (buffer[at] === 0xff && buffer[at + 1] === 0xd9) return at + 2;
  }
  return buffer.length;
}

/**
 * A JPEG without EXIF, XMP, IPTC, other APP segments and comments. Keeps APP0 (JFIF), APP2 (ICC
 * colour) and APP14 (Adobe); the scan is copied unchanged up to its end-of-image marker, and anything after it is dropped. Null when the
 * segments do not add up.
 */
export function stripJpeg(buffer) {
  const parts = [buffer.subarray(0, 2)];
  let at = 2;
  while (at + 2 <= buffer.length) {
    if (buffer[at] !== 0xff) return null;
    const marker = buffer[at + 1];
    if (marker === 0xff) { at += 1; continue; }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) { parts.push(buffer.subarray(at, at + 2)); at += 2; continue; }
    if (marker === 0xd9) { parts.push(buffer.subarray(at)); return Buffer.concat(parts); }
    if (at + 4 > buffer.length) return null;
    const length = buffer.readUInt16BE(at + 2);
    if (length < 2 || at + 2 + length > buffer.length) return null;
    if (marker === 0xda) { parts.push(buffer.subarray(at, scanEnd(buffer, at + 2 + length))); return Buffer.concat(parts); }
    const dropped = marker === 0xe1 || (marker >= 0xe3 && marker <= 0xed) || marker === 0xef || marker === 0xfe;
    if (!dropped) parts.push(buffer.subarray(at, at + 2 + length));
    at += 2 + length;
  }
  return null;
}

/** A PNG without eXIf, text and time chunks, and without anything after IEND. Null when the chunks do not add up. */
export function stripPng(buffer) {
  const parts = [buffer.subarray(0, 8)];
  let at = 8;
  while (at + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(at);
    const end = at + 12 + length;
    if (end > buffer.length) return null;
    const type = buffer.toString('ascii', at + 4, at + 8);
    if (!PNG_DROPPED.has(type)) parts.push(buffer.subarray(at, end));
    at = end;
    if (type === 'IEND') return Buffer.concat(parts);
  }
  return null;
}

/**
 * Validate the `images` of a chat message and return what to store and send:
 * `[{ buffer, type, ext, width, height }]` with the metadata already stripped.
 */
export function checkChatImages(images, fail) {
  if (images === undefined || images === null) return [];
  if (!Array.isArray(images)) throw fail('images must be a list.');
  if (images.length > MAX_IMAGES) throw fail(`At most ${MAX_IMAGES} pictures in a message.`);
  const checked = [];
  let total = 0;
  for (const image of images) {
    if (!image || typeof image !== 'object' || typeof image.data !== 'string' || !(image.type in EXTENSION)) throw fail('Send pictures as JPEG or PNG.', 415);
    if (image.data.length > MAX_IMAGE_BYTES * 1.4) throw fail('A picture is at most 1.5 MB.', 413);
    const bytes = Buffer.from(image.data, 'base64');
    if (bytes.length > MAX_IMAGE_BYTES) throw fail('A picture is at most 1.5 MB.', 413);
    total += bytes.length;
    if (total > MAX_TOTAL_BYTES) throw fail('The pictures together are at most 5 MB.', 413);
    const png = image.type === 'image/png';
    if (!(png ? isPng(bytes) : isJpeg(bytes))) throw fail('Send pictures as JPEG or PNG.', 415);
    const size = png ? pngSize(bytes) : jpegSize(bytes);
    if (!size || size.some(side => side < 1 || side > MAX_SIDE)) throw fail(`A picture is 1 to ${MAX_SIDE} pixels on each side.`);
    const buffer = png ? stripPng(bytes) : stripJpeg(bytes);
    if (!buffer) throw fail('That picture is damaged.');
    checked.push({ buffer, type: image.type, ext: EXTENSION[image.type], width: size[0], height: size[1] });
  }
  return checked;
}

export const toDataUrl = (type, buffer) => `data:${type};base64,${buffer.toString('base64')}`;
