import { crc32, deflateSync } from 'node:zlib';

// A hand-built PNG head for tests: only the part the drawing routes read.
/** The 24 bytes a PNG starts with up to its size: signature, IHDR length and type, width, height. */
export const png = (width, height, extra = 0) => {
  const head = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(head);
  head.writeUInt32BE(13, 8);
  head.write('IHDR', 12, 'ascii');
  head.writeUInt32BE(width, 16);
  head.writeUInt32BE(height, 20);
  return Buffer.concat([head, Buffer.alloc(extra, 7)]);
};

/** A whole PNG a browser can decode: solid grey (`shade`), `width` x `height`. */
export const solidPng = (width, height, shade = 0x90) => {
  const chunk = (type, data) => {
    const head = Buffer.alloc(8); head.writeUInt32BE(data.length); head.write(type, 4, 'ascii');
    const tail = Buffer.alloc(4); tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])));
    return Buffer.concat([head, data, tail]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const rows = Buffer.alloc((width * 3 + 1) * height, shade);
  for (let y = 0; y < height; y++) rows[y * (width * 3 + 1)] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
};
