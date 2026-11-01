// stripInlineImages, and the two places that store a Hermes reply (Hub chat, request report) keeping pictures out.
import test from 'node:test';
import assert from 'node:assert/strict';
import { IMAGE_NOTE, stripInlineImages } from '../inline-images.mjs';
import { approve, stack, until } from './hermes-stack.mjs';

const DATA = `![image](data:image/png;base64,${'iVBORw0KGgo'.repeat(40)}==)`;

test('stripInlineImages: data URLs and MEDIA lines become a note, other text is untouched', () => {
  assert.equal(stripInlineImages(`Here:\n${DATA}\nDone.`), `Here:\n${IMAGE_NOTE}\nDone.`);
  assert.equal(stripInlineImages('MEDIA:/home/x/cache/generated/images/a.png'), IMAGE_NOTE);
  assert.equal(stripInlineImages(`${DATA} and ${DATA}\nMEDIA:/a/b.JPG\n  MEDIA:/c.webp  `), `${IMAGE_NOTE} and ${IMAGE_NOTE}\n${IMAGE_NOTE}\n${IMAGE_NOTE}`);
  assert.equal(stripInlineImages('![wrapped](data:image/svg+xml;base64,AAAA\nBBBB)'), IMAGE_NOTE, 'Wrapped base64 is covered.');
  assert.equal(stripInlineImages('see (data:image/png;base64,AAAA) there'), 'see [image made by Hermes, not kept here] there', 'A bare data URL is covered.');
  const plain = 'See [a link](https://example.com/a.png), ![remote](https://example.com/a.png), data:image text, and MEDIA: notes.txt';
  assert.equal(stripInlineImages(plain), plain);
  assert.equal(stripInlineImages(''), '');
  assert.equal(stripInlineImages(undefined), undefined);
});

test('stripInlineImages: an unclosed data URL is stripped through the end of its base64 run', () => {
  const open = `Look: ![image](data:image/png;base64,${'A'.repeat(1000)}\n- after`;
  assert.equal(stripInlineImages(open), `Look: ${IMAGE_NOTE}\n- after`);
  assert.equal(stripInlineImages(`![image](data:image/png;base64,${'A'.repeat(1000)}`), IMAGE_NOTE);
});

test('stripInlineImages: MEDIA: only counts as a whole line outside a code fence', () => {
  const mid = 'The tag MEDIA:/a/b.png is what Hermes writes.';
  assert.equal(stripInlineImages(mid), mid);
  const fenced = 'Example:\n```\nMEDIA:/a/b.png\n```\nMEDIA:/c/d.png\nend';
  assert.equal(stripInlineImages(fenced), `Example:\n\`\`\`\nMEDIA:/a/b.png\n\`\`\`\n${IMAGE_NOTE}\nend`);
  const tilde = '~~~\nMEDIA:/a/b.png\n~~~';
  assert.equal(stripInlineImages(tilde), tilde);
  assert.equal(stripInlineImages('MEDIA:/a/b.png trailing words'), 'MEDIA:/a/b.png trailing words');
});

test('stripInlineImages: 5 MB inputs finish fast, even with thousands of openers', () => {
  const time = (what, input, expected) => {
    const started = Date.now();
    const out = stripInlineImages(input);
    const took = Date.now() - started;
    console.log(`  ${what}: ${took} ms`);
    assert.ok(took < 2000, `${what} took ${took} ms`);
    if (expected !== undefined) assert.equal(out, expected);
  };
  time('one big closed image', `x ![image](data:image/png;base64,${'A'.repeat(5 * 1024 * 1024)}) y`, `x ${IMAGE_NOTE} y`);
  time('one big unclosed image', `![image](data:image/png;base64,${'A'.repeat(5 * 1024 * 1024)}`, IMAGE_NOTE);
  time('many ![ openers', '!['.repeat(2.5 * 1024 * 1024));
  time('many ![x]( openers', '![x](data:image/'.repeat(300_000));
  time('many ](data:image/ openers', '](data:image/png;base64,'.repeat(200_000));
  time('many MEDIA: openers', 'MEDIA:'.repeat(850_000));
  time('many MEDIA: lines', 'MEDIA:/a.png.\n'.repeat(350_000));
  time('many bracket openers', '[a'.repeat(1_000_000) + '](data:image/png;base64,AA)');
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
