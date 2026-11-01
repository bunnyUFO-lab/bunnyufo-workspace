// Run after npm run build. The phone app: the published site's worker, against a stand-in for the
// proxy in front of it (the built app, a workspace list, one card, and a login page).
//
// A card read once opens again with no network; /api/* is never kept; the manifest names its three
// icons; and a redirect to the sign-in page reaches the browser, not a cached copy of the app.
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listenOnGoodPort } from '../listen.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const today = new Date().toISOString().slice(0, 10);
const card = { id: 'alpha', folder: 'alpha', title: 'Offline card', description: 'Read me with no signal.', category: 'test', created: today, updated: today, status: 'active', steps: [{ name: 'Notes', path: 'notes.md' }] };
const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' };

let signIn = false;
let hits = { api: 0 };
const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, 'http://site');
  const send = (status, type, body, extra = {}) => { response.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-cache', ...extra }); response.end(body); };
  if (url.pathname === '/login') return send(200, 'text/html', '<title>Sign in</title><h1>Sign in</h1>');
  // Like Authelia in front of the site: a page request without a session is sent to the sign-in page.
  if (signIn && request.headers['sec-fetch-mode'] === 'navigate') {
    return send(302, 'text/plain', '', { Location: `http://127.0.0.2:${server.address().port}/login` });
  }
  if (url.pathname === '/api/capabilities') { hits.api += 1; return send(200, 'application/json', JSON.stringify({ write: false })); }
  if (url.pathname.startsWith('/api/')) return send(404, 'application/json', '{}');
  if (url.pathname === '/sites.json') return send(200, 'application/json', JSON.stringify([{ id: 'one', name: 'One', base: '/w/one' }]));
  if (url.pathname === '/w/one/workspace.json') return send(200, 'application/json', JSON.stringify({ entities: [card] }));
  if (url.pathname === '/w/one/alpha/notes.md') return send(200, 'text/markdown', '# Offline card\n\nStill here with no signal.\n');
  const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  // dist is what Vite built; the icons are copied in beside it by the publish workflow, so read them from public/.
  for (const base of [path.join(root, 'dist'), path.join(root, 'public')]) {
    try { return send(200, TYPES[path.extname(file)] ?? 'application/octet-stream', await readFile(path.join(base, file))); } catch { /* next */ }
  }
  return send(200, 'text/html', await readFile(path.join(root, 'dist', 'index.html')));
});
await listenOnGoodPort(server, '0.0.0.0');
const origin = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({ headless: true, channel: process.env.BUW_TEST_BROWSER || 'msedge' });
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));

  // 1. The worker installs. The first load is not under it, so load again to let it see the app.
  await page.goto(`${origin}/one`);
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  await page.reload();
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  await page.locator('.entity-card[data-entity="alpha"]').click();

  // 2. Open the card's page, so it is read once.
  await page.locator('.buw-markdown h1', { hasText: 'Offline card' }).waitFor();
  const cardUrl = page.url();

  // 4. /api is never kept: the capabilities answer came from the network, and no cache holds it.
  const kept = await page.evaluate(async () => {
    await fetch('/api/capabilities');
    const urls = [];
    for (const name of await caches.keys()) for (const request of await (await caches.open(name)).keys()) urls.push(new URL(request.url).pathname);
    return urls;
  });
  assert.ok(kept.length > 0, 'Something is kept.');
  assert.deepEqual(kept.filter(pathname => pathname.startsWith('/api/')), [], '/api/* is never cached.');
  assert.ok(kept.includes('/w/one/alpha/notes.md') && kept.includes('/sites.json'), 'The card and the section list are kept.');

  // 3. No network: the shell and the card still open.
  await context.setOffline(true);
  await page.reload();
  assert.equal(page.url(), cardUrl);
  await page.locator('.buw-markdown h1', { hasText: 'Offline card' }).waitFor();
  assert.match(await page.locator('.buw-markdown').innerText(), /Still here with no signal/);
  await context.setOffline(false);

  // 5. The manifest.
  const manifest = await (await page.request.get(`${origin}/manifest.webmanifest`)).json();
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.icons.length, 3, 'Three icons: 192, 512 and a maskable one.');
  assert.ok(manifest.icons.some(icon => icon.purpose === 'maskable'));
  for (const icon of manifest.icons) assert.equal((await page.request.get(`${origin}${icon.src}`)).status(), 200, icon.src);
  assert.equal((await page.request.get(`${origin}/sw.js`)).headers()['content-type'], 'text/javascript', 'The worker is served as JavaScript.');

  // 6. A redirect to the sign-in page reaches the browser, and no copy of the app answers instead.
  signIn = true;
  await page.goto(origin, { waitUntil: 'load' });
  assert.match(page.url(), /\/login$/, 'An expired session lands on the sign-in page, not on a cached shell.');
  assert.equal(await page.locator('h1').innerText(), 'Sign in');
  signIn = false;

  assert.equal(errors.length, 0, errors.join('\n'));
  console.log(`PWA UI passed: worker installs, a card read once opens offline, /api never cached (${hits.api} live answers), manifest with 3 icons, sign-in redirect untouched.`);
} finally { await browser.close(); server.close(); }
