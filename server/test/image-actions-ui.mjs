// Run after npm run build. The app's picture viewer on a card (Markdown cards and image tabs): Edit, Ask in chat and Copy image,
// on the site stand-in of card-sandbox-ui.mjs (the app host and a content host, the site API over fake S3, a Hub with a fake Hermes).
// Every action needs a press; Ask in chat leaves an unsent draft and posts nothing until Send; Edit adds a tab and never touches
// the original; Copy puts a PNG on the clipboard (JPEG and SVG are converted) and says so when it cannot. Set BUW_SHOTS=<folder>
// to save the PR screenshots.
import { chromium } from '@playwright/test';
import { ms } from './ui-timeouts.mjs';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSiteApi } from '../../site/api/server.mjs';
import { createBucket } from '../../site/api/s3.mjs';
import { createHub } from '../../site/api/hub.mjs';
import { startFakeS3 } from '../../site/api/test/fake-s3.mjs';
import { startFakeHermes } from '../../site/api/test/fake-hermes.mjs';
import { solidPng } from '../../site/api/test/png.mjs';
import { listenOnGoodPort } from '../listen.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dist = path.join(root, 'dist');
const step = name => console.log(`- ${name}`);
const shots = process.env.BUW_SHOTS;
const today = new Date().toISOString().slice(0, 10);
const sha = data => createHash('sha256').update(data).digest('hex');
await mkdir(path.join(root, '.cache'), { recursive: true });

const fake = await startFakeS3();
const bucket = createBucket({ bucket: fake.bucket, endpoint: fake.endpoint, credentials: fake.credentials, region: 'us-east-1' });
const hermes = await startFakeHermes({ key: 'k', delayMs: 5 });
const hub = createHub({ bucket, enabled: true, env: { HUB_SIGNING_KEY: generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'), HERMES_URL: hermes.url, HERMES_API_KEY: 'k' } });
const alpha = { id: 'alpha', folder: 'alpha', title: 'Alpha card', description: 'A card.', category: 'test', created: today, updated: today, status: 'active', steps: [{ name: 'Notes', path: 'index.md' }, { name: 'Page', path: 'page.html' }] };
const log = [];
const site = http.createServer();
await listenOnGoodPort(site, '127.0.0.1');
const port = site.address().port;
const appOrigin = `http://app.example.localhost:${port}`;
const contentOrigin = `http://cards.example.localhost:${port}`;
const contentHost = new URL(contentOrigin).host;

const PNG = solidPng(240, 150, 0x60);
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40" viewBox="0 0 40 20"><rect width="40" height="20" fill="#c33"/></svg>';
const seed = (key, body, type) => fake.seed(key, body, type);
seed('sections/one/workspace.json', JSON.stringify({ name: 'One', entities: [alpha] }), 'application/json');
seed('state.json', '{"version":1,"cards":{}}', 'application/json');
seed('sections/inbox/workspace.json', '{"name":"Inbox","hidden":true,"entities":[]}\n', 'application/json');
seed('sections/one/alpha/index.md', '# Alpha notes\n\nA fake note.\n\n![Photo](photo.png)\n\n![Vector](vec.svg)\n\n![Shot](shot.jpg)\n', 'text/markdown');
seed('sections/one/alpha/photo.png', PNG, 'image/png');
seed('sections/one/alpha/vec.svg', SVG, 'image/svg+xml');
seed('sections/one/alpha/page.html', '<!doctype html><html><head><meta charset="utf-8"><title>Page</title></head><body><p>page</p></body></html>', 'text/html; charset=utf-8');

const api = createSiteApi({
  bucket, sectionsTtl: 0, contentOrigin, allowedOrigins: [appOrigin], hub,
  stateFile: path.join(root, '.cache', 'image-actions-state.json'),
});
const send = (response, status, type, body, extra = {}) => { response.writeHead(status, { 'Content-Type': type, ...extra }); response.end(body); };
site.on('request', async (request, response) => {
  const url = new URL(request.url, 'http://site');
  const host = String(request.headers.host ?? '');
  const chunks = [];
  request.on('data', chunk => chunks.push(chunk));
  // Logged when the request arrives (a streamed chat reply does not finish for a while); the body and status fill in as they come.
  const entry = { method: request.method, host, path: url.pathname, origin: request.headers.origin ?? null, status: 0, body: '' };
  log.push(entry);
  request.on('end', () => { entry.body = Buffer.concat(chunks).toString('utf8'); });
  response.on('finish', () => { entry.status = response.statusCode; });
  const toApi = () => api.emit('request', request, response);
  if (host === contentHost) return toApi();
  if (url.pathname.startsWith('/w/') && ['document', 'iframe', 'frame', 'object', 'embed'].includes(request.headers['sec-fetch-dest'])) {
    return send(response, 302, 'text/plain', '', { Location: `${contentOrigin}${url.pathname}${url.search}` });
  }
  if (url.pathname.startsWith('/api/') || url.pathname === '/sites.json' || url.pathname.startsWith('/w/')) return toApi();
  try {
    const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const body = await readFile(path.join(dist, file));
    return send(response, 200, file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html', body);
  } catch { return send(response, 200, 'text/html', await readFile(path.join(dist, 'index.html'))); }
});

const browser = await chromium.launch({ headless: true, channel: process.env.BUW_TEST_BROWSER || 'msedge' });
const settle = ms => new Promise(resolve => setTimeout(resolve, ms));
const posts = pattern => log.filter(entry => entry.method === 'POST' && pattern.test(entry.path));
const shot = async (page, name) => { if (shots) await page.screenshot({ path: `${shots}/${name}.png` }); };
const contexts = [];
try {
  // A JPEG made by the browser itself, so the file is a real one.
  const maker = await browser.newPage();
  const jpeg = Buffer.from(await maker.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 160; canvas.height = 90;
    const context = canvas.getContext('2d'); context.fillStyle = '#3a7'; context.fillRect(0, 0, 160, 90); context.fillStyle = '#fff'; context.fillRect(20, 20, 60, 30);
    return canvas.toDataURL('image/jpeg', 0.9).split(',')[1];
  }), 'base64');
  await maker.close();
  seed('sections/one/alpha/shot.jpg', jpeg, 'image/jpeg');

  const open = async viewport => {
    const context = await browser.newContext({ viewport, serviceWorkers: 'block', reducedMotion: 'reduce', extraHTTPHeaders: { 'Remote-User': 'sam' } });
    contexts.push(context);
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: appOrigin });
    const page = await context.newPage();
    page.setDefaultTimeout(ms(15000));
    page.on('pageerror', error => { throw error; });
    await page.addInitScript(() => localStorage.setItem('buw.workspaceTheme', 'light'));
    return page;
  };
  const openViewer = async (page, alt) => {
    await page.goto(`${appOrigin}/one#/alpha/0`);
    await page.locator('.markdown-reader img').first().waitFor();
    await page.locator(`.markdown-reader img[alt="${alt}"]`).click();
    await page.locator('dialog.buw-lightbox[open]').waitFor();
  };
  const armed = page => settle(650);
  const clipboardPng = page => page.evaluate(async () => {
    const [item] = await navigator.clipboard.read();
    const blob = await item.getType('image/png');
    const bitmap = await createImageBitmap(blob);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let text = ''; for (const byte of bytes) text += String.fromCharCode(byte);
    return { types: item.types, base64: btoa(text), width: bitmap.width, height: bitmap.height };
  });

  const page = await open({ width: 1280, height: 800 });

  step('PC: the viewer on a Markdown card shows Edit, Ask in chat and Copy image under the picture, with no scrolling');
  await openViewer(page, 'Photo');
  const dialog = page.locator('dialog.buw-lightbox');
  const actions = dialog.locator('[data-lightbox-actions] button');
  assert.deepEqual(await actions.allInnerTexts(), ['✎ Edit', 'Ask in chat', 'Copy image']);
  const inside = async (locator, what) => {
    const box = await locator.boundingBox();
    const view = page.viewportSize();
    assert.ok(box && box.y >= 0 && box.y + box.height <= view.height && box.x >= 0 && box.x + box.width <= view.width, `${what} is inside the window: ${JSON.stringify(box)}`);
    return box;
  };
  for (let n = 0; n < 3; n += 1) await inside(actions.nth(n), `action ${n}`);
  assert.equal(await dialog.evaluate(node => node.scrollHeight <= node.clientHeight), true, 'The viewer does not scroll.');
  assert.equal(await dialog.locator('.buw-lightbox-caption').innerText(), 'Photo');
  await shot(page, 'viewer-markdown-desktop');

  step('a press in the first moments after opening does nothing');
  await page.evaluate(() => { window.__writes = 0; const write = navigator.clipboard.write.bind(navigator.clipboard); navigator.clipboard.write = items => {
    window.__writes += 1;
    items[0].getType('image/png').then(async blob => { const bytes = new Uint8Array(await blob.arrayBuffer()); const digest = await crypto.subtle.digest('SHA-256', bytes); window.__sent = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join(''); });
    return write(items);
  }; });
  await dialog.locator('[data-action=copy]').click({ force: true, noWaitAfter: true });
  assert.equal(await page.evaluate(() => window.__writes), 0, 'The early press was ignored.');
  await dialog.locator('[data-action=ask]').click();
  assert.match(page.url(), /#\/alpha\/0$/, 'The early press did not start a chat.');

  step('Copy image: a PNG goes through unchanged');
  await armed(page);
  await dialog.locator('[data-action=copy]').click();
  await page.locator('dialog.buw-lightbox .buw-lightbox-note', { hasText: 'Image copied' }).waitFor();
  let copied = await clipboardPng(page);
  assert.equal(await page.evaluate(() => window.__sent), sha(PNG), 'The bytes handed to the clipboard are the original file.');
  assert.deepEqual([copied.width, copied.height], [240, 150]);
  await dialog.locator('button', { hasText: 'Close' }).click();

  step('Copy image: a JPEG and an SVG are pasted as PNG');
  await openViewer(page, 'Shot'); await armed(page);
  await page.locator('dialog.buw-lightbox [data-action=copy]').click();
  await page.locator('dialog.buw-lightbox .buw-lightbox-note', { hasText: 'Image copied' }).waitFor();
  copied = await clipboardPng(page);
  assert.deepEqual(copied.types, ['image/png']);
  assert.equal(Buffer.from(copied.base64, 'base64').subarray(1, 4).toString(), 'PNG');
  assert.deepEqual([copied.width, copied.height], [160, 90]);
  await page.locator('dialog.buw-lightbox button', { hasText: 'Close' }).click();
  await openViewer(page, 'Vector'); await armed(page);
  await page.locator('dialog.buw-lightbox [data-action=copy]').click();
  await page.locator('dialog.buw-lightbox .buw-lightbox-note', { hasText: 'Image copied' }).waitFor();
  copied = await clipboardPng(page);
  assert.equal(Buffer.from(copied.base64, 'base64').subarray(1, 4).toString(), 'PNG');
  assert.deepEqual([copied.width, copied.height], [80, 40]);
  await page.locator('dialog.buw-lightbox button', { hasText: 'Close' }).click();

  step('Copy image without clipboard write: the note says so and Download works');
  await openViewer(page, 'Photo'); await armed(page);
  await page.evaluate(() => { Object.defineProperty(navigator.clipboard, 'write', { value: undefined, configurable: true }); });
  await page.locator('dialog.buw-lightbox [data-action=copy]').click();
  const note = page.locator('dialog.buw-lightbox .buw-lightbox-note');
  await note.locator('button', { hasText: 'Download' }).waitFor();
  assert.match(await note.innerText(), /Copying images isn't supported here\. Use Download\./);
  const [download] = await Promise.all([page.waitForEvent('download'), note.locator('button', { hasText: 'Download' }).click()]);
  assert.equal(download.suggestedFilename(), 'photo.png');
  await page.reload();

  step('Ask in chat: a new chat with the picture in the tray and the draft with its card link; nothing is posted until Send');
  log.length = 0;
  await openViewer(page, 'Photo'); await armed(page);
  await page.locator('dialog.buw-lightbox [data-action=ask]').click();
  await page.waitForURL(/#\/~hub\/chat/);
  const composer = page.locator('textarea[aria-label="Message"]');
  await composer.waitFor();
  assert.equal(await composer.inputValue(), `From card "Alpha card" (photo.png): ${appOrigin}/one#/alpha\n\n`);
  await page.locator('[data-tray] img').first().waitFor();
  assert.equal(await page.locator('[data-tray] img').count(), 1, 'One picture, added once.');
  await settle(400);
  assert.deepEqual(posts(/\/api\/hub\/(chat|requests)/), [], 'Nothing was posted yet.');
  await shot(page, 'ask-in-chat-draft');
  await composer.press('Control+End');
  await composer.pressSequentially('What is this?');
  await composer.press('Enter');
  const mine = page.locator('.hub-bubble.user').first();
  await mine.locator('img').waitFor();
  const link = mine.locator('a[data-card-link]');
  assert.equal(await link.getAttribute('href'), '/one#/alpha');
  assert.equal(posts(/\/api\/hub\/chat$/).length, 1, 'One post, after Send.');
  assert.equal(JSON.parse(posts(/\/api\/hub\/chat$/)[0].body).images[0].type, 'image/png');

  step('Edit: a new tab after this one, the original is untouched, and a second Edit makes -2');
  const original = sha(fake.objects.get('sections/one/alpha/photo.png').body);
  await page.goto(`${appOrigin}/one#/alpha/0`);
  await page.locator('.markdown-reader img').first().waitFor();
  const edit = async () => {
    await page.locator('.markdown-reader img[alt="Photo"]').click();
    await page.locator('dialog.buw-lightbox[open]').waitFor();
    await armed(page);
    await page.locator('dialog.buw-lightbox [data-action=edit]').click();
    await page.locator('dialog.buw-lightbox').waitFor({ state: 'detached' });
  };
  await edit();
  await page.waitForURL(/#\/alpha\/1$/);
  let steps = JSON.parse(fake.text('sections/one/workspace.json')).entities[0].steps;
  assert.deepEqual(steps.map(item => item.path), ['index.md', 'photo.annotated.excalidraw', 'page.html']);
  assert.equal(steps[1].from, 'photo.png');
  assert.equal(steps[1].by, 'sam');
  assert.equal(sha(fake.objects.get('sections/one/alpha/photo.png').body), original);
  await page.goto(`${appOrigin}/one#/alpha/0`);
  await page.reload();
  await page.locator('.markdown-reader img').first().waitFor();
  await edit();
  await page.waitForURL(/#\/alpha\/1$/);
  steps = JSON.parse(fake.text('sections/one/workspace.json')).entities[0].steps;
  assert.deepEqual(steps.map(item => item.path), ['index.md', 'photo.annotated-2.excalidraw', 'photo.annotated.excalidraw', 'page.html']);

  step('a saved drawing says what it was drawn over, by whom, and that the original is unchanged; the link goes to the original');
  const scene = await page.evaluate(() => fetch('/api/cards/drawing?workspace=one&id=alpha&path=photo.annotated.excalidraw').then(r => r.json()));
  const saved = await page.evaluate(async ({ etag, png }) => (await fetch('/api/cards/drawing', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workspace: 'one', id: 'alpha', path: 'photo.annotated.excalidraw', scene: JSON.stringify({ type: 'excalidraw', version: 2, source: 'test', elements: [], appState: {}, files: {} }), png, base: etag, by: 'forged' }) })).status, { etag: scene.etag, png: solidPng(240, 150, 0x30).toString('base64') });
  assert.equal(saved, 200);
  await page.goto(`${appOrigin}/one#/alpha/2`);
  await page.reload();
  const origin = page.locator('[data-drawing-origin]');
  await origin.waitFor();
  const text = (await origin.innerText()).replace(/\s+/g, ' ');
  assert.match(text, /^Drawn over photo\.png by sam, \d{1,2} [A-Z][a-z]{2}\. The original is unchanged\.$/);
  assert.equal(await origin.locator('a').getAttribute('href'), `${appOrigin}/w/one/alpha/photo.png`);
  assert.equal(sha(fake.objects.get('sections/one/alpha/photo.png').body), original, 'The original is still byte for byte the same.');

  step('PC: no write to chat or jobs happened except the one Send');
  assert.equal(posts(/\/api\/hub\/requests/).length, 0);

  step('phone: the caption and Close on top, Fit, Open original and Download beneath, the actions as equal columns at the bottom');
  const phone = await open({ width: 375, height: 700 });
  await phone.goto(`${appOrigin}/one#/alpha/0`);
  await phone.locator('.markdown-reader img[alt="Photo"]').click();
  const sheet = phone.locator('dialog.buw-lightbox[open]');
  await sheet.waitFor();
  const buttons = sheet.locator('[data-lightbox-actions] button');
  assert.equal(await buttons.count(), 3);
  const boxes = [];
  for (let n = 0; n < 3; n += 1) boxes.push(await buttons.nth(n).boundingBox());
  for (const box of boxes) { assert.ok(box.height >= 44, `at least 44 px high: ${box.height}`); assert.ok(box.y + box.height <= 700 && box.x >= 0 && box.x + box.width <= 375, 'inside the window'); }
  assert.ok(Math.abs(boxes[0].width - boxes[1].width) < 1.5 && Math.abs(boxes[1].width - boxes[2].width) < 1.5, 'equal columns');
  assert.equal(await sheet.evaluate(node => node.scrollHeight <= node.clientHeight), true, 'The sheet does not scroll.');
  const top = await sheet.locator('.buw-lightbox-caption').boundingBox();
  const close = await sheet.locator('.buw-lightbox-close').boundingBox();
  const fit = await sheet.locator('.buw-lightbox-tools button').first().boundingBox();
  assert.ok(Math.abs(top.y - close.y) < 24 && fit.y > top.y + top.height - 2, 'Close is beside the caption; the tools are a row beneath.');
  assert.equal(await phone.evaluate(() => document.scrollingElement.scrollWidth <= innerWidth), true, 'no sideways scroll');
  await shot(phone, 'viewer-markdown-phone');

  console.log('Image actions passed: the viewer offers Edit, Ask in chat and Copy image on a card, and each waits for a press.');
} finally {
  for (const context of contexts) await context.close().catch(() => {});
  await browser.close();
  site.close();
  await hub.close();
  await hermes.close();
  await fake.close();
}
