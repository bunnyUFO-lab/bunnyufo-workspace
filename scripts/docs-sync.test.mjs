import test from 'node:test';
import assert from 'node:assert/strict';
import { categoryTitle, setFrontMatter, splitFrontMatter } from './docs-sync.mjs';
import { renderGallery } from './docs-gallery.mjs';
import { stripFrontMatter } from '../src/components/frontMatter.ts';

test('front matter: managed keys are replaced, extra keys and the body are kept, and it is idempotent', () => {
  const page = '---\ntitle: Old\ntags:\n  - pixel\nnav_order: 9\nsummary: >\n  folded\n  text\n---\n# Body\n\nText with --- inside.\n';
  const values = { title: 'Pixel Art Studio', parent: 'Image Gen', nav_order: 1, has_children: true, render_with_liquid: false };
  const once = setFrontMatter(page, values);
  assert.equal(once, '---\ntitle: "Pixel Art Studio"\nparent: "Image Gen"\nnav_order: 1\nhas_children: true\nrender_with_liquid: false\ntags:\n  - pixel\nsummary: >\n  folded\n  text\n---\n# Body\n\nText with --- inside.\n');
  assert.equal(setFrontMatter(once, values), once);
  assert.equal(splitFrontMatter(once).body, '# Body\n\nText with --- inside.\n');
});

test('front matter: a page without front matter gains one; managed keys left undefined are removed', () => {
  assert.equal(setFrontMatter('# Plain\n', { title: 'Plain' }), '---\ntitle: "Plain"\n---\n# Plain\n');
  assert.equal(setFrontMatter('---\ntitle: A\nhas_children: true\n---\nx', { title: 'A' }), '---\ntitle: "A"\n---\nx');
  assert.equal(setFrontMatter('---\n---\nx', { title: 'Quote "me"' }), '---\ntitle: "Quote \\"me\\""\n---\nx');
  assert.equal(setFrontMatter(String.fromCharCode(0xfeff) + '---\ntitle: A\n---\nx', { title: 'B' }), '---\ntitle: "B"\n---\nx');
});

test('the app reader hides front matter but leaves other Markdown alone', () => {
  assert.equal(stripFrontMatter('---\ntitle: "A"\nnav_order: 1\n---\n# A\n'), '# A\n');
  assert.equal(stripFrontMatter(String.fromCharCode(0xfeff) + '---\r\ntitle: A\r\n---\r\nBody'), 'Body');
  assert.equal(stripFrontMatter('---\n---\nBody'), 'Body');
  assert.equal(stripFrontMatter('# Title\n\n---\n\nAfter a rule'), '# Title\n\n---\n\nAfter a rule');
  assert.equal(stripFrontMatter('No front matter'), 'No front matter');
});

test('category titles and the gallery page', () => {
  assert.equal(categoryTitle('image-gen'), 'Image Gen');
  assert.equal(categoryTitle(undefined), 'Other');
  const page = renderGallery({ entries: [
    { job_id: 'job_old', op: 'tile', prompt: 'grass', params: { tile_size: 16 }, created: '2026-10-01T10:00:00', assets: [{ id: 'ast_1', kind: 'tile', file: 'job_old/ast_1.png' }] },
    { job_id: 'job_new', op: 'sprite', prompt: 'goblin | lantern', params: { pixels: 32 }, created: '2026-10-05T10:00:00',
      assets: [1, 2, 3, 4, 5].map(n => ({ id: `ast_${n}0`, title: `Sprite #${n}`, status: n === 1 ? 'final' : undefined, file: `job_new/ast_${n}0.png`, w: 30, h: 32, palette: ['#000000', '#ffffff'] })) },
  ] });
  assert.ok(page.indexOf('## goblin \\| lantern') < page.indexOf('## grass'), 'Newest first; table pipes escaped');
  assert.match(page, /\| !\[Sprite #1 \(ast_10\)\]\(gallery\/job_new\/ast_10\.png\) \|/);
  assert.match(page, /`ast_10` · final · 30×32/);
  assert.equal(page.match(/^\| --- \| --- \| --- \| --- \|$/gm).length, 1, 'Four images per table row, the fifth starts a new table');
  assert.match(page, /- `ast_50`: #000000 #ffffff/);
  assert.match(renderGallery({ entries: [] }), /No generations yet/);
});
