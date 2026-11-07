// Run after npm run build. The app's picture viewer on a card (Markdown cards, image tabs and HTML cards that load
// _shared/report.js): Edit, Ask in chat, New job and Copy image,
// on the site stand-in of card-sandbox-ui.mjs (the app host and a content host, the site API over fake S3, a Hub with a fake Hermes).
// Every action needs a press; Ask in chat leaves an unsent draft and posts nothing until Send; Edit adds a tab and never touches
// the original; Copy puts a PNG on the clipboard (JPEG and SVG are converted) and says so when it cannot. Set BUW_SHOTS=<folder>
// to save the PR screenshots.
import { chromium } from '@playwright/test';
import { ms } from './ui-timeouts.mjs';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSiteApi } from '../../site/api/server.mjs';
import { createBucket } from '../../site/api/s3.mjs';
import { createHub } from '../../site/api/hub.mjs';
import { startFakeS3 } from '../../site/api/test/fake-s3.mjs';
import { startFakeHermes } from '../../site/api/test/fake-hermes.mjs';
import { solidPng } from '../../site/api/test/png.mjs';
import { requestJson, seeder } from '../../site/api/test/hub-fixtures.mjs';
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
const gamma = { id: 'gamma', folder: 'gamma', title: 'Gamma page', description: 'An HTML card.', category: 'test', created: today, updated: today, status: 'active', steps: [{ name: 'Page', path: 'page.html' }, { name: 'Evil', path: 'evil.html' }] };
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
seed('sections/one/workspace.json', JSON.stringify({ name: 'One', entities: [alpha, gamma] }), 'application/json');
seed('state.json', '{"version":1,"cards":{}}', 'application/json');
// The section is a known project once a request names it, so New job picks it.
seeder(fake).request({ ...requestJson({ id: `${today.replace(/-/g, '')}-one-earlier-job-a1b2`, now: new Date() }), project: 'one', text: 'An earlier job' });
seed('sections/inbox/workspace.json', '{"name":"Inbox","hidden":true,"entities":[]}\n', 'application/json');
seed('sections/one/alpha/index.md', '# Alpha notes\n\nA fake note.\n\n![Photo](photo.png)\n\n![Vector](vec.svg)\n\n![Shot](shot.jpg)\n', 'text/markdown');
seed('sections/one/alpha/photo.png', PNG, 'image/png');
seed('sections/one/alpha/vec.svg', SVG, 'image/svg+xml');
seed('sections/one/_shared/report.js', await readFile(path.join(root, 'workspace/_shared/report.js')), 'text/javascript');
seed('sections/one/_shared/report.css', await readFile(path.join(root, 'workspace/_shared/report.css')), 'text/css');
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

// An HTML card that loads the shared script, with three pictures; and one that behaves like a hostile page.
const picturePage = body => `<!doctype html><html data-buw-report="document"><head><meta charset="utf-8"><title>Gamma</title><link rel="stylesheet" href="../_shared/report.css"></head><body><main><h1>Gamma</h1>${body}</main><script src="../_shared/report.js"></script></body></html>`;
seed('sections/one/gamma/page.html', picturePage('<p><img id="a" src="photo.png" alt="Alt text of the first picture" width="120"> <img id="b" src="vec.svg" alt="Second" width="120"> <img id="c" src="shot.jpg" alt="Third" width="120"></p>'), 'text/html; charset=utf-8');
seed('sections/one/gamma/photo.png', PNG, 'image/png');
seed('sections/one/gamma/vec.svg', SVG, 'image/svg+xml');
seed('sections/one/gamma/evil.js', `
const own = new URL('photo.png', location.href).href;
const other = new URL('../alpha/photo.png', location.href).href;
const post = (extra, src = own) => parent.postMessage({ type: 'buw:image', v: 1, id: 'e' + Math.random().toString(36).slice(2, 8), src, all: [src], ...extra }, '*');
window.__replies = [];
window.addEventListener('message', event => { if (event.data?.type === 'buw:image') window.__replies.push(event.data); });
// With no press: ask for a viewer on its own picture, another card's, a data address and an outside one, and click a picture from a
// timer. It waits 6.5 s after the page loads, so that the few seconds of user activation the app gets from the navigation that
// opened the card have run out (the test must not touch the page meanwhile: Playwright's own evaluate counts as a press).
setTimeout(() => {
  post({}); post({}, other); post({}, 'data:image/png;base64,iVBORw0KGgo='); post({}, 'https://example.com/x.png');
  const timer = setInterval(() => document.querySelector('#own').click(), 300);
  setTimeout(() => { clearInterval(timer); window.__attacked = true; }, 3000);
}, 6500);
// On any real press: the same message with extras that name an action, text and a workspace.
document.addEventListener('click', event => { if (event.isTrusted && event.target.id === 'own') { post({ action: 'chat', text: 'hello', alt: 'Ask me', workspace: 'two', card: 'beta' }); post({ action: 'job' }, other); } }, true);
// Writes to the app host as a page can make them: JSON, and a no-cors text body, to the chat and the job routes.
window.__fetches = (async () => {
  const out = {};
  for (const route of ['/api/hub/chat', '/api/hub/requests']) {
    out[route] = {};
    out[route].json = await fetch(${JSON.stringify(appOrigin)} + route, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'hello from a page', preset: 'research' }) }).then(r => r.status, () => 'blocked');
    out[route].text = await fetch(${JSON.stringify(appOrigin)} + route, { method: 'POST', mode: 'no-cors', credentials: 'include', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ text: 'hello from a page', preset: 'research' }) }).then(() => 'sent', () => 'blocked');
  }
  return out;
})();
`, 'text/javascript');
seed('sections/one/gamma/evil.html', picturePage('<p><img id="own" src="photo.png" alt="Click here to continue" width="120"> <img id="other" src="../alpha/photo.png" alt="Another card" width="120"></p>').replace('</body>', '<script src="evil.js"></script></body>'), 'text/html; charset=utf-8');

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

  step('PC: the viewer on a Markdown card shows Edit, Ask in chat, New job and Copy image under the picture, with no scrolling');
  await openViewer(page, 'Photo');
  const dialog = page.locator('dialog.buw-lightbox');
  const actions = dialog.locator('[data-lightbox-actions] button');
  assert.deepEqual(await actions.allInnerTexts(), ['✎ Edit', 'Ask in chat', 'New job', 'Copy image']);
  const inside = async (locator, what) => {
    const box = await locator.boundingBox();
    const view = page.viewportSize();
    assert.ok(box && box.y >= 0 && box.y + box.height <= view.height && box.x >= 0 && box.x + box.width <= view.width, `${what} is inside the window: ${JSON.stringify(box)}`);
    return box;
  };
  for (let n = 0; n < 4; n += 1) await inside(actions.nth(n), `action ${n}`);
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
  assert.equal(await buttons.count(), 4);
  const boxes = [];
  for (let n = 0; n < 4; n += 1) boxes.push(await buttons.nth(n).boundingBox());
  for (const box of boxes) { assert.ok(box.height >= 44, `at least 44 px high: ${box.height}`); assert.ok(box.y + box.height <= 700 && box.x >= 0 && box.x + box.width <= 375, 'inside the window'); }
  assert.ok(Math.abs(boxes[0].width - boxes[1].width) < 1.5 && Math.abs(boxes[1].width - boxes[2].width) < 1.5 && Math.abs(boxes[2].width - boxes[3].width) < 1.5, 'equal columns');
  assert.equal(await sheet.evaluate(node => node.scrollHeight <= node.clientHeight), true, 'The sheet does not scroll.');
  const top = await sheet.locator('.buw-lightbox-caption').boundingBox();
  const close = await sheet.locator('.buw-lightbox-close').boundingBox();
  const fit = await sheet.locator('.buw-lightbox-tools button').first().boundingBox();
  assert.ok(Math.abs(top.y - close.y) < 24 && fit.y > top.y + top.height - 2, 'Close is beside the caption; the tools are a row beneath.');
  assert.equal(await phone.evaluate(() => document.scrollingElement.scrollWidth <= innerWidth), true, 'no sideways scroll');
  await shot(phone, 'viewer-markdown-phone');

  step('HTML card, PC: a picture opens the app viewer with the actions, the file name as caption, and Previous, Next and the arrow keys');
  const html = await open({ width: 1280, height: 800 });
  const viewers = p => p.locator('dialog.buw-lightbox[open]');
  const frameOf = p => p.frameLocator('iframe.report-frame');
  const openHtml = async (p, tab, id) => {
    await p.goto(`${appOrigin}/one#/gamma/${tab}`);
    await frameOf(p).locator(`#${id}`).waitFor();
    await settle(400);
    await frameOf(p).locator(`#${id}`).click();
    await viewers(p).waitFor();
  };
  await openHtml(html, 0, 'a');
  assert.equal(await html.locator('dialog.buw-lightbox').count(), 1, 'The viewer is in the app document.');
  assert.equal(await frameOf(html).locator('dialog.buw-lightbox').count(), 0, 'The page did not open its own.');
  assert.equal(await html.locator('dialog.buw-lightbox .buw-lightbox-caption').innerText(), 'photo.png', 'The caption is the file name, not the picture alt text.');
  const htmlActions = html.locator('dialog.buw-lightbox [data-lightbox-actions] button');
  assert.deepEqual(await htmlActions.allInnerTexts(), ['✎ Edit', 'Ask in chat', 'New job', 'Copy image']);
  for (let n = 0; n < 4; n += 1) { const box = await htmlActions.nth(n).boundingBox(); assert.ok(box.y + box.height <= 800, 'inside the window'); }
  const captionIs = async text => { await html.waitForFunction(expected => document.querySelector('dialog.buw-lightbox .buw-lightbox-caption')?.textContent === expected, text); };
  await html.locator('dialog.buw-lightbox [data-lightbox-next]').click();
  await captionIs('vec.svg');
  await html.keyboard.press('ArrowRight');
  await captionIs('shot.jpg');
  await html.keyboard.press('ArrowRight');
  await captionIs('photo.png');
  await html.keyboard.press('ArrowLeft');
  await captionIs('shot.jpg');
  await html.locator('dialog.buw-lightbox [data-lightbox-prev]').click();
  await captionIs('vec.svg');
  await shot(html, 'viewer-html-desktop');

  step('HTML card: Copy image works from the page (the app reads the picture from its own origin)');
  await settle(650);
  await html.locator('dialog.buw-lightbox [data-action=copy]').click();
  await html.locator('dialog.buw-lightbox .buw-lightbox-note', { hasText: 'Image copied' }).waitFor();
  copied = await clipboardPng(html);
  assert.equal(Buffer.from(copied.base64, 'base64').subarray(1, 4).toString(), 'PNG');
  await html.keyboard.press('Escape');
  await viewers(html).waitFor({ state: 'detached' });

  step('HTML card, phone: the actions are equal columns at the bottom, nothing scrolls');
  const htmlPhone = await open({ width: 375, height: 700 });
  await openHtml(htmlPhone, 0, 'a');
  const phoneButtons = htmlPhone.locator('dialog.buw-lightbox [data-lightbox-actions] button');
  assert.equal(await phoneButtons.count(), 4);
  for (let n = 0; n < 4; n += 1) { const box = await phoneButtons.nth(n).boundingBox(); assert.ok(box.height >= 44 && box.y + box.height <= 700, `phone action ${n}: ${JSON.stringify(box)}`); }
  assert.equal(await htmlPhone.evaluate(() => document.scrollingElement.scrollWidth <= innerWidth), true);
  await shot(htmlPhone, 'viewer-html-phone');

  step('a page opened in its own tab (no app to ask) keeps its own viewer, with no actions');
  const own = await open({ width: 1000, height: 700 });
  await own.goto(`${appOrigin}/w/one/gamma/page.html`);
  await own.locator('#a').click();
  await own.locator('dialog.buw-lightbox[open]').waitFor();
  assert.equal(await own.locator('dialog.buw-lightbox .buw-lightbox-caption').innerText(), 'Alt text of the first picture');
  assert.equal(await own.locator('[data-lightbox-actions]').count(), 0);
  await own.close();

  step('hostile page: with no press it cannot open the viewer, and it cannot post to the chat or job routes');
  log.length = 0;
  const hostile = await open({ width: 1280, height: 800 });
  const inbox = () => [...fake.objects.keys()].filter(key => key.startsWith('sections/inbox/') && !key.endsWith('workspace.json')).sort();
  const inboxBefore = inbox();
  await hostile.goto(`${appOrigin}/one#/gamma/1`);
  await frameOf(hostile).locator('#own').waitFor();
  const evilFrame = () => hostile.frames().find(f => f.url().includes('/w/one/gamma/evil.html'));
  // Left alone while the page attacks (see evil.js): any call of the test's own into a page counts as a press.
  await settle(11000);
  assert.equal(await hostile.locator('dialog.buw-lightbox').count(), 0, 'Messages with no press and clicks from a timer opened no viewer in the app.');
  const early = await evilFrame().evaluate(() => window.__replies);
  assert.ok(early.length >= 4 && early.every(reply => reply.ok === false), `Every early request was refused: ${JSON.stringify(early)}`);
  const fetches = await evilFrame().evaluate(() => window.__fetches);
  for (const route of ['/api/hub/chat', '/api/hub/requests']) assert.ok(![200, 201].includes(fetches[route].json), `${route} refused a page's JSON post: ${fetches[route].json}`);

  step('hostile page: after a real press the viewer opens with the file name, and the extras start nothing');
  // The page's own viewer, opened by its timer (its fallback when the app refuses), is closed first.
  assert.equal(await evilFrame().evaluate(() => { const own = document.querySelector('dialog.buw-lightbox[open]'); own?.close(); return !!own; }), true, 'The refused page fell back to its own viewer.');
  await hostile.evaluate(() => { window.__writes = 0; const write = navigator.clipboard.write.bind(navigator.clipboard); navigator.clipboard.write = items => { window.__writes += 1; return write(items); }; });
  await frameOf(hostile).locator('#own').click();
  await viewers(hostile).waitFor();
  assert.equal(await hostile.locator('dialog.buw-lightbox').count(), 1, 'One viewer only.');
  assert.equal(await hostile.locator('dialog.buw-lightbox .buw-lightbox-caption').innerText(), 'photo.png', 'The caption is the file name, not the picture alt text.');
  assert.equal(await hostile.locator('dialog.buw-lightbox .buw-lightbox-stage img').getAttribute('src'), `${appOrigin}/w/one/gamma/photo.png`, 'The app opened the address it built.');
  assert.match(hostile.url(), /#\/gamma\/1$/, 'No chat was started.');
  assert.equal(await hostile.evaluate(() => window.__writes), 0, 'Nothing was copied.');
  await settle(300);

  step('hostile page: a second press right under the action row starts nothing');
  const ask = await hostile.locator('dialog.buw-lightbox [data-action=ask]').boundingBox();
  await hostile.keyboard.press('Escape');
  await viewers(hostile).waitFor({ state: 'detached' });
  // The page's own viewer opened too (its message found the app's open, so it fell back); close it so the page can be pressed again.
  await evilFrame().evaluate(() => document.querySelector('dialog.buw-lightbox[open]')?.close());
  await settle(1100);
  // The press that opens the viewer, and straight after it a press where Ask in chat is.
  const spot = await frameOf(hostile).locator('#own').boundingBox();
  await hostile.mouse.click(spot.x + spot.width / 2, spot.y + spot.height / 2);
  await hostile.mouse.click(ask.x + ask.width / 2, ask.y + ask.height / 2);
  await viewers(hostile).waitFor();
  await settle(300);
  assert.match(hostile.url(), /#\/gamma\/1$/, 'The second press did not start a chat.');
  assert.equal(await hostile.evaluate(() => window.__writes), 0, 'Nor a copy.');
  await hostile.keyboard.press('Escape');
  await viewers(hostile).waitFor({ state: 'detached' });

  step('hostile page: another card picture is refused and the page keeps its own viewer');
  await evilFrame().evaluate(() => document.querySelector('dialog.buw-lightbox[open]')?.close());
  await settle(1100);
  await frameOf(hostile).locator('#other').click();
  await frameOf(hostile).locator('dialog.buw-lightbox[open]').waitFor();
  assert.equal(await hostile.locator('dialog.buw-lightbox').count(), 0, 'No app viewer for a picture of another card.');

  step('hostile page: no chat or job was posted or stored, and the whole run made no POST to those routes');
  await settle(500);
  assert.deepEqual(posts(/\/api\/hub\/(chat|requests)/).filter(entry => entry.status === 200 || entry.status === 201), [], 'No chat or job post got through.');
  assert.deepEqual(posts(/\/api\/hub\/(chat|requests)/).filter(entry => entry.origin !== contentOrigin), [], 'Only the page\'s own refused attempts reached the routes.');
  assert.deepEqual(inbox(), inboxBefore, 'The fake S3 inbox is unchanged: no chat, no job.');
  await hostile.close();

  step('New job: the form opens with the picture, its card and an empty text box; no job is posted until the button');
  log.length = 0;
  const jobPage = await open({ width: 1280, height: 800 });
  const openJob = async () => {
    await openViewer(jobPage, 'Photo'); await armed(jobPage);
    await jobPage.locator('dialog.buw-lightbox [data-action=job]').click();
    await jobPage.locator('[data-spawn-sheet] [data-spawn-reference]').waitFor();
  };
  assert.deepEqual(await (async () => { await openViewer(jobPage, 'Photo'); return jobPage.locator('dialog.buw-lightbox [data-lightbox-actions] button').allInnerTexts(); })(), ['✎ Edit', 'Ask in chat', 'New job', 'Copy image']);
  await jobPage.keyboard.press('Escape');
  await viewers(jobPage).waitFor({ state: 'detached' });
  await openJob();
  assert.equal(await jobPage.locator('[data-spawn-text]').inputValue(), '', 'No card text is put into the job text.');
  assert.match(await jobPage.locator('[data-spawn-reference-from]').innerText(), /^From card Alpha card \(photo\.png\)\./);
  await jobPage.waitForFunction(() => document.querySelector('[data-spawn-reference-thumb]')?.naturalWidth > 0);
  await jobPage.waitForFunction(() => document.querySelector('[data-spawn-project] , input[data-spawn-project]')?.value !== '');
  await shot(jobPage, 'new-job-reference');
  await settle(400);
  assert.deepEqual(posts(/\/api\/hub\/requests/), [], 'Nothing was posted yet.');

  step('New job: Remove takes the picture off, and the job then goes without a reference');
  await jobPage.locator('[data-spawn-reference-remove]').click();
  assert.equal(await jobPage.locator('[data-spawn-reference]').count(), 0);
  await jobPage.keyboard.press('Escape');
  await jobPage.locator('[data-spawn-sheet]').waitFor({ state: 'detached' });

  step('New job: Chat with in the sheet takes the picture to a new chat tray, and posts nothing');
  await jobPage.goto(`${appOrigin}/one#/alpha/0`);
  await openJob();
  await jobPage.locator('[data-spawn-chat]').click();
  await jobPage.locator('[data-spawn-text]').fill('Is the shadow right?');
  await jobPage.locator('[data-spawn-go]').click();
  await jobPage.locator('[data-tray] img').first().waitFor();
  assert.equal(await jobPage.locator('[data-tray] img').count(), 1);
  assert.equal(await jobPage.locator('textarea[aria-label="Message"]').inputValue(), 'Is the shadow right?');
  assert.deepEqual(posts(/\/api\/hub\/(chat|requests)/), [], 'Still nothing posted.');

  step('New job: Approve files the picture with the job, and the approval, the page and the signed brief carry it');
  await jobPage.goto(`${appOrigin}/one#/alpha/0`);
  await openJob();
  await jobPage.locator('[data-preset="research"]').click();
  await jobPage.locator('[data-spawn-text]').fill('Compare this take with the last one');
  await jobPage.locator('[data-spawn-route="hermes"]').waitFor();
  await jobPage.waitForFunction(() => !document.querySelector('[data-spawn-go]')?.disabled);
  await jobPage.locator('[data-spawn-go]').click();
  await jobPage.locator('[data-spawn-toast]').waitFor();
  const made = posts(/\/api\/hub\/requests$/);
  assert.equal(made.length, 1, 'One job was posted, by the button.');
  const sent = JSON.parse(made[0].body);
  assert.deepEqual(Object.keys(sent.reference).sort(), ['data', 'source', 'type']);
  assert.deepEqual(sent.reference.source, { section: 'one', card: 'alpha', file: 'photo.png', title: 'Alpha card' });
  assert.equal(sent.project, 'one');
  const requestKeys = [...fake.objects.keys()].filter(key => /sections\/inbox\/requests\/[^/]+\/reference\.png$/.test(key));
  assert.equal(requestKeys.length, 1);
  const jobId = requestKeys[0].split('/').at(-2);
  const block = fake.json(`sections/inbox/requests/${jobId}/request.json`).reference;
  assert.equal(block.sha256, sha(fake.objects.get(requestKeys[0]).body));
  assert.deepEqual(block.source, { section: 'one', card: 'alpha', file: 'photo.png', title: 'Alpha card' });
  assert.match(fake.json(`sections/inbox/requests/${jobId}/approved.json`).run.brief, new RegExp(`Reference picture: the owner attached one\\. Get it with \`cards request reference ${jobId} --out <dir>\``));
  await jobPage.goto(`${appOrigin}/one#/~hub/request/${jobId}`);
  const refNote = jobPage.locator('[data-reference]');
  await refNote.waitFor();
  await refNote.locator("img").waitFor();
  assert.match(await refNote.locator("[data-reference-from]").innerText(), /From card Alpha card \(photo\.png\)/);
  await shot(jobPage, 'job-reference-page');

  step('cards request reference writes the same bytes, and refuses when the picture has changed');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'buw-ref-'));
  const cli = (...args) => new Promise(resolve => execFile(process.execPath, [path.join(root, 'scripts/cards.mjs'), ...args, '--via', 's3'], {
    env: { ...process.env, AWS_ACCESS_KEY_ID: 'test', AWS_SECRET_ACCESS_KEY: 'test', BUW_S3_BUCKET: fake.bucket, BUW_S3_ENDPOINT: fake.endpoint, BUW_S3_REGION: 'us-east-1', BUW_CARDS_PASSWORD: '', BUW_CARDS_VIA: '', HOME: dir, USERPROFILE: dir },
  }, (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr })));
  const got = await cli('request', 'reference', jobId, '--out', dir);
  assert.equal(got.code, 0, got.stderr);
  assert.equal(sha(await readFile(path.join(dir, 'reference.png'))), block.sha256);
  fake.seed(requestKeys[0], solidPng(40, 30, 0x11), 'image/png');
  assert.notEqual((await cli('request', 'reference', jobId, '--out', path.join(dir, 'again'))).code, 0, 'A changed picture is refused.');

  console.log('Image actions passed: the viewer offers Edit, Ask in chat, New job and Copy image on Markdown and HTML cards, each waits for a press, and a hostile page can only open the viewer on its own pictures.');
} finally {
  for (const context of contexts) await context.close().catch(() => {});
  await browser.close();
  site.close();
  await hub.close();
  await hermes.close();
  await fake.close();
}
