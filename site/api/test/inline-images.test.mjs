// stripInlineImages, and the two places that store a Hermes reply (Hub chat, request report) keeping pictures out.
import test from 'node:test';
import assert from 'node:assert/strict';
import { IMAGE_NOTE, stripInlineImages } from '../inline-images.mjs';
import { approve, stack, until } from './hermes-stack.mjs';

const DATA = `![image](data:image/png;base64,${'iVBORw0KGgo'.repeat(40)}==)`;

test('stripInlineImages: data URLs and MEDIA tags become a note, other text is untouched', () => {
  assert.equal(stripInlineImages(`Here:\n${DATA}\nDone.`), `Here:\n${IMAGE_NOTE}\nDone.`);
  assert.equal(stripInlineImages('MEDIA:/home/x/cache/generated/images/a.png'), IMAGE_NOTE);
  assert.equal(stripInlineImages(`${DATA} and ${DATA}\nMEDIA:/a/b.JPG MEDIA:/c.webp`), `${IMAGE_NOTE} and ${IMAGE_NOTE}\n${IMAGE_NOTE} ${IMAGE_NOTE}`);
  assert.equal(stripInlineImages('![wrapped](data:image/svg+xml;base64,AAAA\nBBBB)'), IMAGE_NOTE, 'Wrapped base64 is covered.');
  const plain = 'See [a link](https://example.com/a.png), ![remote](https://example.com/a.png), data:image text, and MEDIA: notes.txt';
  assert.equal(stripInlineImages(plain), plain);
  assert.equal(stripInlineImages(''), '');
  assert.equal(stripInlineImages(undefined), undefined);
});

test('stripInlineImages: a 5 MB reply is handled fast, with or without a closing bracket', () => {
  const big = `![image](data:image/png;base64,${'A'.repeat(5 * 1024 * 1024)})`;
  let started = Date.now();
  assert.equal(stripInlineImages(`x ${big} y`), `x ${IMAGE_NOTE} y`);
  assert.ok(Date.now() - started < 1000, 'closed');
  started = Date.now();
  const open = big.slice(0, -1);
  assert.equal(stripInlineImages(open), open, 'An unclosed image is left alone');
  assert.ok(Date.now() - started < 1000, 'unclosed');
});

test('a request run whose answer holds a picture stores a report and result without it', async () => {
  const s = await stack({ hermesOptions: { endWith: `Made it.\n${DATA}\nMEDIA:/cache/a.png\nCARD: assistant/pic` } });
  try {
    const api = await s.addHub();
    const id = s.propose();
    assert.equal((await approve(api, id)).status, 201);
    const result = await until(() => s.resultOf(id), 'result.json');
    assert.equal(result.card, 'assistant/pic');
    const report = s.fake.text(`sections/inbox/requests/${id}/report.md`);
    assert.equal(report, `Made it.\n${IMAGE_NOTE}\n${IMAGE_NOTE}\nCARD: assistant/pic`);
    assert.ok(!JSON.stringify(result).includes('data:image'));
  } finally { await s.close(); }
});
