// Run after npm run build. Isolated repository, registry and browser profile; the fixture
// workspace is the only place written.
//
// Drawing sections: ＋ → Drawing opens the Excalidraw editor, strokes are saved with their PNG
// beside the scene, the section shows the picture after a reload, and the picture can be copied.
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { crc32, deflateSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createService } from '../server.mjs';
import { addWorkspace } from '../workspaces.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
await mkdir(path.join(root, '.cache'), { recursive: true });
const base = await mkdtemp(path.join(root, '.cache/drawing-ui-'));
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const today = new Date().toISOString().slice(0, 10);
const card = (id, title) => ({
  id, folder: id, title, description: 'A card.', category: 'test',
  created: today, updated: today, status: 'active',
  steps: [{ name: 'Notes', path: 'index.md' }],
});

const dir = path.join(base, 'one');
const cards = [card('sketches', 'Sketches'), card('phone', 'Phone sketches'), card('takes', 'Takes')];
cards[2].steps = [{ name: 'Take 2b', path: 'take-2b.png' }, { name: 'Notes', path: 'index.md' }];
cards[0].steps.push({ name: 'Agent', path: 'agent.excalidraw' });
for (const entity of cards) {
  await mkdir(path.join(dir, entity.folder), { recursive: true });
  await writeFile(path.join(dir, entity.folder, 'index.md'), `# ${entity.title}\n`);
}
await writeFile(path.join(dir, 'sketches', 'agent.excalidraw'), JSON.stringify({
  type: 'excalidraw', version: 2,
  elements: [{ type: 'rectangle', x: 0, y: 0, width: 120, height: 60 }, { type: 'text', x: 20, y: 20, text: 'door', fontSize: 20 }],
}));
/** A real PNG, solid grey, `width` x `height`. */
const solid = (width, height) => {
  const chunk = (type, data) => {
    const head = Buffer.alloc(8); head.writeUInt32BE(data.length); head.write(type, 4, 'ascii');
    const tail = Buffer.alloc(4); tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])));
    return Buffer.concat([head, data, tail]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const rows = Buffer.alloc((width * 3 + 1) * height, 0x90);
  for (let y = 0; y < height; y++) rows[y * (width * 3 + 1)] = 0;
  return Buffer.concat([PNG, chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
};
const original = solid(320, 200);
await writeFile(path.join(dir, 'takes', 'take-2b.png'), original);
await writeFile(path.join(dir, 'takes', 'index.md'), '# Takes\n\n![take](take-2b.png)\n\n![elsewhere](https://example.com/x.png)\n');
await writeFile(path.join(dir, 'workspace.json'), JSON.stringify({ entities: cards }, null, 2));
const repo = await mkdtemp(path.join(root, '.cache/drawing-ui-app-'));
for (const folder of ['workspace', 'inbox', 'projects']) await mkdir(path.join(repo, folder), { recursive: true });
await writeFile(path.join(repo, 'workspace/workspace.json'), JSON.stringify({ entities: [] }, null, 2));
const registryFile = path.join(base, 'registry/workspaces.json');
await mkdir(path.dirname(registryFile), { recursive: true });
await addWorkspace({ registryFile, path: dir, name: 'One', activate: true });

const scene = async (id, file) => JSON.parse(await readFile(path.join(dir, id, file), 'utf8'));
const picture = async (id, file) => readFile(path.join(dir, id, file));

const service = await createService({ repo, uiDir: path.join(root, 'dist'), registryFile });
let browser;
try {
  browser = await chromium.launch({ headless: true, channel: process.env.BUW_TEST_BROWSER || 'msedge' });

  /** Rectangle, freehand, then a text label: all picked by their labels, dragged on the canvas. */
  const draw = async page => {
    const canvas = page.locator('.drawing-editor canvas.interactive');
    await canvas.waitFor();
    const box = await canvas.boundingBox();
    const at = (x, y) => [box.x + box.width * x, box.y + box.height * y];
    await page.locator('.drawing-editor label[title^="Rectangle"]').click();
    await page.mouse.move(...at(0.3, 0.3));
    await page.mouse.down();
    await page.mouse.move(...at(0.5, 0.45), { steps: 6 });
    await page.mouse.up();
    await page.locator('.drawing-editor label[title^="Draw"]').click();
    await page.mouse.move(...at(0.35, 0.6));
    await page.mouse.down();
    await page.mouse.move(...at(0.45, 0.65), { steps: 6 });
    await page.mouse.move(...at(0.55, 0.6), { steps: 6 });
    await page.mouse.up();
    await page.locator('.drawing-editor label[title^="Text"]').click();
    await page.mouse.click(...at(0.65, 0.3));
    await page.keyboard.type('door');
    await page.keyboard.press('Escape');
  };
  const addDrawing = async page => {
    await page.locator('.step-tab-add').click();
    await page.getByRole('radio', { name: 'Drawing' }).click();
    assert.equal(await page.getByLabel('Section name').inputValue(), 'Drawing', 'Choosing Drawing offers a name.');
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await page.locator('.drawing-editor').waitFor();
  };
  const save = async page => {
    await page.locator('.drawing-bar button', { hasText: /^Save$/ }).click();
    await page.locator('.drawing-state', { hasText: 'Saved' }).waitFor();
  };
  const checkFiles = async id => {
    const saved = await scene(id, 'drawing.excalidraw');
    assert.equal(saved.type, 'excalidraw');
    assert.deepEqual(saved.elements.map(element => element.type).sort(), ['freedraw', 'rectangle', 'text'], 'The rectangle, the stroke and the label are in the scene.');
    const png = await picture(id, 'drawing.png');
    assert.ok(png.subarray(0, 8).equals(PNG), 'The picture beside it is a PNG.');
    assert.ok(png.readUInt32BE(16) >= 1 && png.readUInt32BE(16) <= 2048 && png.readUInt32BE(20) <= 2048, 'The picture is within 2048 px.');
  };

  // —— Desktop ——————————————————————————————————————————————————————————
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const fetched = []; page.on('request', request => fetched.push(request.url()));
  await page.goto(service.urls.workspace);
  await page.locator('.entity-card').first().waitFor();
  assert.equal(fetched.filter(url => /DrawingEditor|excalidraw/i.test(url)).length, 0, 'The Library loads nothing of Excalidraw.');

  await page.locator('.entity-card[data-entity="sketches"]').click();
  await addDrawing(page);
  await draw(page);
  await page.locator('.drawing-state', { hasText: 'Unsaved changes' }).waitFor();
  await save(page);
  await checkFiles('sketches');
  await page.waitForFunction(() => performance.getEntriesByType('resource').some(entry => /\/assets\/excalidraw\/fonts\/.+\.woff2/.test(entry.name)), null, { timeout: 5000 });

  // Done closes the editor; the section then shows the picture.
  await page.locator('.drawing-bar button', { hasText: /^Done$/ }).click();
  await page.locator('.drawing-section img').waitFor();
  await page.reload();
  await page.locator('.drawing-section img').waitFor();
  assert.ok(await page.locator('.drawing-section img').evaluate(image => image.naturalWidth > 0), 'After a reload the section shows the saved picture.');

  // Edit shows the strokes again: saving without touching anything keeps both elements.
  await page.getByRole('button', { name: '✎ Edit' }).click();
  await page.locator('.drawing-editor canvas.interactive').waitFor();
  await page.waitForTimeout(500);
  await save(page);
  assert.equal((await scene('sketches', 'drawing.excalidraw')).elements.length, 3, 'The editor opened with the saved strokes.');

  // Someone else saved meanwhile: the save is refused with a choice, never overwritten silently.
  const theirs = { ...(await scene('sketches', 'drawing.excalidraw')), source: 'someone-else' };
  await writeFile(path.join(dir, 'sketches', 'drawing.excalidraw'), JSON.stringify(theirs));
  await page.locator('.drawing-bar button', { hasText: /^Save$/ }).click();
  await page.getByText('Changed elsewhere since you opened it.').waitFor();
  assert.equal((await scene('sketches', 'drawing.excalidraw')).source, 'someone-else', 'The refused save wrote nothing.');
  await page.getByRole('button', { name: 'Keep mine' }).click();
  await page.locator('.drawing-state', { hasText: 'Saved' }).waitFor();
  assert.equal((await scene('sketches', 'drawing.excalidraw')).elements.length, 3, 'Keep mine saves the editor scene over theirs.');
  await page.locator('.drawing-bar button', { hasText: /^Cancel$/ }).click();
  await page.locator('.drawing-section img').waitFor();

  // Copy image puts a PNG on the clipboard.
  await page.getByRole('button', { name: /Copy image/ }).click();
  await page.locator('.drawing-section nav small', { hasText: 'Image copied' }).waitFor();
  const types = await page.evaluate(async () => (await navigator.clipboard.read()).map(item => item.types));
  assert.deepEqual(types, [['image/png']], 'One clipboard item of type image/png.');
  await page.getByRole('button', { name: /Copy link for Claude/ }).click();
  await page.locator('.drawing-section nav small', { hasText: 'Link copied' }).waitFor();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), page.url(), 'The link is the page address.');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);

  // A scene an agent wrote by hand, with bare elements and no picture: it opens read-only without an error.
  await page.getByRole('tab', { name: 'Agent' }).click();
  await page.locator('.drawing-viewer canvas.interactive').waitFor();
  // The app's own stylesheet comes from Google Fonts (not ours to change here); Excalidraw adds no call of its own.
  assert.deepEqual(fetched.filter(url => /^https?:/.test(url) && !url.startsWith('http://127.0.0.1') && !/fonts\.(googleapis|gstatic)\.com/.test(url)), [], 'No request leaves the machine for Excalidraw: its fonts are served with the app.');
  await context.close();

  // —— ✎ Annotate ——————————————————————————————————————————————————————————
  const annotating = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const take = await annotating.newPage();
  take.setDefaultTimeout(20000);
  take.on('pageerror', error => errors.push(error.message));
  await take.goto(`${service.urls.workspace}#/takes/0`);
  const stroke = async () => {
    const canvas = take.locator('.drawing-editor canvas.interactive');
    await canvas.waitFor();
    await take.waitForTimeout(600);
    const box = await canvas.boundingBox();
    await take.locator('.drawing-editor label[title^="Draw"]').click();
    await take.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.5);
    await take.mouse.down();
    await take.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.55, { steps: 6 });
    await take.mouse.up();
  };
  const finish = async () => {
    await take.locator('.drawing-bar button', { hasText: /^Save$/ }).click();
    await take.locator('.drawing-state', { hasText: 'Saved' }).waitFor();
  };
  const listed = async () => JSON.parse(await readFile(path.join(dir, 'workspace.json'), 'utf8')).entities.find(entity => entity.id === 'takes').steps;
  const md5 = data => createHash('md5').update(data).digest('hex');

  // From the image step: a drawing beside the picture, right after its tab.
  await take.getByRole('button', { name: '✎ Annotate' }).click();
  await stroke();
  await finish();
  const made = await scene('takes', 'take-2b.annotated.excalidraw');
  assert.deepEqual(made.files, {}, 'The picture is referenced by name, not embedded.');
  assert.ok(made.elements.some(element => element.type === 'freedraw'), 'The stroke is in the scene.');
  const flat = await picture('takes', 'take-2b.annotated.png');
  assert.ok(flat.readUInt32BE(16) >= 320 && flat.readUInt32BE(20) >= 200, 'The background picture was exported with the strokes.');
  assert.deepEqual((await listed()).map(step => step.path), ['take-2b.png', 'take-2b.annotated.excalidraw', 'index.md'], 'The new tab sits right after the image.');
  assert.equal(md5(await picture('takes', 'take-2b.png')), md5(original), 'The original is untouched.');
  await take.locator('.drawing-bar button', { hasText: /^Done$/ }).click();
  await take.locator('.drawing-section img').waitFor();

  // From the Markdown page: the same picture again makes a second drawing, and an outside image has no pencil.
  await take.getByRole('tab', { name: 'Notes' }).click();
  await take.locator('.buw-markdown img').first().waitFor();
  assert.equal(await take.locator('.annotate-badge').count(), 1, 'Only a picture of the card itself can be annotated.');
  await take.locator('.annotatable').hover();
  await take.locator('.annotate-badge').click();
  await stroke();
  await finish();
  assert.ok((await picture('takes', 'take-2b.annotated-2.png')).subarray(0, 8).equals(PNG), 'A second annotation is saved beside the first.');
  assert.equal((await scene('takes', 'take-2b.annotated.excalidraw')).elements.length, made.elements.length, 'The first one is not replaced.');
  assert.deepEqual((await listed()).map(step => step.path), ['take-2b.png', 'take-2b.annotated.excalidraw', 'index.md', 'take-2b.annotated-2.excalidraw']);
  assert.equal(md5(await picture('takes', 'take-2b.png')), md5(original), 'The original is still untouched.');
  await annotating.close();

  // —— A phone ——————————————————————————————————————————————————————————
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const small = await phone.newPage();
  small.setDefaultTimeout(20000);
  small.on('pageerror', error => errors.push(error.message));
  // The app reopens the card last viewed; a route in the address says which one this phone opens.
  await small.goto(`${service.urls.workspace}#/phone/0`);
  await small.locator('.step-tab-add').waitFor();
  await addDrawing(small);
  assert.equal(await small.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'The editor does not scroll sideways.');
  for (const name of [/^Save$/, /^Done$/]) {
    const box = await small.locator('.drawing-bar button', { hasText: name }).boundingBox();
    assert.ok(box && box.x >= 0 && box.x + box.width <= 390, 'Save and Done are on screen at phone width.');
  }
  await draw(small);
  await save(small);
  await checkFiles('phone');
  await small.locator('.drawing-bar button', { hasText: /^Done$/ }).click();
  await small.locator('.drawing-section img').waitFor();
  await small.reload();
  await small.locator('.drawing-section img').waitFor();
  assert.ok(await small.locator('.drawing-section img').evaluate(image => image.naturalWidth > 0), 'The phone drawing survives a reload.');
  await phone.close();

  assert.equal(errors.length, 0, errors.join('\n'));
  console.log('Drawing UI passed: add, draw, save with a PNG, reload, edit again, copy image, phone width, annotate from an image tab and from Markdown.');
} finally { await browser?.close(); await service.close(); }
