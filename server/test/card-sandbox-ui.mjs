// A card page cannot act as the signed-in app. Option B of the sandbox: the site serves cards from a content
// host (here cards.example.localhost against app.example.localhost, both loopback). Stand-in for the site:
// createSiteApi over fake S3, the built dist/, and the two Caddy rules the real site has (a card opened in its own
// tab moves to the content host; the content host serves /w/ only). The card page tries to read the app's
// storage, post to the app, fetch a sibling file and load its stylesheet and script, in the app's frame
// and in its own tab; and it follows the app's light and dark theme.
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSiteApi } from '../../site/api/server.mjs';
import { createBucket } from '../../site/api/s3.mjs';
import { startFakeS3 } from '../../site/api/test/fake-s3.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dist = path.join(root, 'dist');
const step = name => console.log(`- ${name}`);
const today = new Date().toISOString().slice(0, 10);
const CSP = 'sandbox allow-scripts allow-forms allow-popups allow-downloads allow-same-origin';
await mkdir(path.join(root, '.cache'), { recursive: true });

const fake = await startFakeS3();
const bucket = createBucket({ bucket: fake.bucket, endpoint: fake.endpoint, credentials: fake.credentials, region: 'us-east-1' });
const card = { id: 'alpha', folder: 'alpha', title: 'Alpha card', description: 'A card.', category: 'test', created: today, updated: today, status: 'active', steps: [{ name: 'Page', path: 'index.html' }] };
const seed = (key, body, type) => fake.seed(key, body, type);

const log = [];
const site = http.createServer();
await new Promise(resolve => site.listen(0, '127.0.0.1', resolve));
const port = site.address().port;
const appOrigin = `http://app.example.localhost:${port}`;
const contentOrigin = `http://cards.example.localhost:${port}`;
const appHost = new URL(appOrigin).host;
const contentHost = new URL(contentOrigin).host;

// The card: a stylesheet, the shared stylesheet and script, and a script of its own that tries things.
seed('sections/one/workspace.json', JSON.stringify({ name: 'One', entities: [card] }), 'application/json');
seed('state.json', '{"version":1,"cards":{}}', 'application/json');
seed('sections/one/_shared/report.css', await readFile(path.join(root, 'workspace/_shared/report.css')), 'text/css');
seed('sections/one/_shared/report.js', await readFile(path.join(root, 'workspace/_shared/report.js')), 'text/javascript');
seed('sections/one/alpha/style.css', 'html body #mark{color:rgb(1,2,3)}', 'text/css');
seed('sections/one/alpha/data.json', '{"ok":true}', 'application/json');
seed('sections/one/alpha/probe.js', `
window.__result = (async () => {
  const result = {};
  result.sibling = await fetch('data.json').then(r => r.json()).then(j => j.ok, () => false);
  try { result.storage = localStorage.getItem('app-secret'); } catch { result.storage = 'threw'; }
  result.ownApi = await fetch('/api/workspace/pin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then(r => r.status, () => 'error');
  // A simple cross-origin request: it goes out with this page's Origin, and the answer is hidden from the page.
  await fetch(${JSON.stringify(appOrigin)} + '/api/workspace/pin', { method: 'POST', mode: 'no-cors', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ workspace: 'one', id: 'alpha', pinned: true }) }).catch(() => {});
  result.origin = location.origin;
  return result;
})();
`, 'text/javascript');
seed('sections/one/alpha/index.html', '<!doctype html><html data-buw-report="document"><head><meta charset="utf-8"><title>Alpha</title><link rel="stylesheet" href="../_shared/report.css"><link rel="stylesheet" href="style.css"></head><body><main><h1>Alpha heading</h1><p id="mark">Text.</p></main><script src="../_shared/report.js"></script><script src="probe.js"></script></body></html>', 'text/html; charset=utf-8');

const api = createSiteApi({
  bucket, sectionsTtl: 0, contentOrigin, allowedOrigins: [appOrigin],
  stateFile: path.join(root, '.cache', 'card-sandbox-state.json'),
});
const send = (response, status, type, body, extra = {}) => { response.writeHead(status, { 'Content-Type': type, ...extra }); response.end(body); };
site.on('request', async (request, response) => {
  const url = new URL(request.url, 'http://site');
  const host = String(request.headers.host ?? '');
  response.on('finish', () => log.push({ method: request.method, host, path: url.pathname, origin: request.headers.origin ?? null, status: response.statusCode }));
  const toApi = () => api.emit('request', request, response);
  if (host === contentHost) return toApi();   // the API itself serves /w/ only, with the CSP, on this host
  if (url.pathname.startsWith('/w/') && request.headers['sec-fetch-dest'] === 'document') {
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
try {
  const context = await browser.newContext({ viewport: { width: 1200, height: 900 }, colorScheme: 'light' });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => { throw error; });
  await page.goto(`${appOrigin}/one`);
  await page.locator('.entity-card').waitFor();
  await page.evaluate(() => { localStorage.setItem('app-secret', 'the app only'); localStorage.setItem('buw.workspaceTheme', 'light'); });

  step('the app reports the content origin');
  const caps = await page.evaluate(() => fetch('/api/capabilities').then(r => r.json()));
  assert.equal(caps.contentOrigin, contentOrigin);

  step('the card opens in a frame on the content host');
  await page.goto(`${appOrigin}/one#/alpha/0`);
  const frameElement = page.locator('iframe.report-frame');
  await frameElement.waitFor();
  const src = await frameElement.getAttribute('src');
  assert.ok(src.startsWith(`${contentOrigin}/w/one/alpha/index.html`), `The frame src is on the content host: ${src}`);
  assert.match(await frameElement.getAttribute('sandbox'), /allow-scripts/);
  const frame = page.frameLocator('iframe.report-frame');
  await frame.locator('h1').waitFor();
  const inFrame = page.frames().find(f => f.url().startsWith(contentOrigin));
  assert.ok(inFrame, 'The card runs in a frame of the content origin.');

  step('in the frame: stylesheet and script load, the sibling fetch works, the app storage is out of reach');
  assert.equal(await frame.locator('#mark').evaluate(node => getComputedStyle(node).color), 'rgb(1, 2, 3)');
  assert.deepEqual(await inFrame.evaluate(() => window.__result), { sibling: true, storage: null, ownApi: 404, origin: contentOrigin });
  assert.equal(await inFrame.evaluate(() => window.__buwReportViewer), true, 'report.js ran.');

  step('in the frame: the card follows the app theme, light and dark, through report.js');
  const background = () => frame.locator('body').evaluate(node => getComputedStyle(node).backgroundColor);
  assert.equal(await frame.locator('html').getAttribute('data-buw-theme'), 'light', 'The theme from ?buw-theme= is set on load.');
  assert.equal(await background(), 'rgb(255, 255, 255)');
  await page.evaluate(() => { localStorage.setItem('buw.workspaceTheme', 'dark'); window.dispatchEvent(new Event('bunnyufo-workspace-theme')); });
  await frame.locator('html[data-buw-theme=dark]').waitFor({ timeout: 5000 });
  assert.notEqual(await background(), 'rgb(255, 255, 255)');

  step('the POST the card sent to the app was refused, and changed nothing');
  await settle(300);
  const posts = log.filter(entry => entry.method === 'POST' && entry.path === '/api/workspace/pin');
  const fromCard = posts.find(entry => entry.host === appHost);
  assert.ok(fromCard, "The card's POST reached the app host.");
  assert.equal(fromCard.origin, contentOrigin);
  assert.equal(fromCard.status, 403);
  assert.equal(posts.find(entry => entry.host === contentHost)?.status, 404, 'The same path on the content host is a 404.');
  assert.deepEqual(fake.json('state.json').cards, {}, 'No pin was written.');
  log.length = 0;

  step('opened in its own tab: the app host sends it to the content host, with the same results');
  const tab = await context.newPage();
  tab.setDefaultTimeout(15000);
  const opened = await tab.goto(`${appOrigin}/w/one/alpha/index.html`);
  assert.equal(tab.url(), `${contentOrigin}/w/one/alpha/index.html`);
  assert.equal(opened.headers()['content-security-policy'], CSP);
  assert.equal(await tab.locator('#mark').evaluate(node => getComputedStyle(node).color), 'rgb(1, 2, 3)');
  assert.deepEqual(await tab.evaluate(() => window.__result), { sibling: true, storage: null, ownApi: 404, origin: contentOrigin });
  await settle(300);
  const own = log.find(entry => entry.method === 'POST' && entry.host === appHost);
  assert.equal(own?.status, 403, "The tab's POST to the app is refused.");
  assert.deepEqual(fake.json('state.json').cards, {}, 'Still no pin.');

  step('the content host serves nothing but /w/');
  for (const route of ['/api/capabilities', '/sites.json', '/', '/one']) {
    assert.equal((await tab.goto(`${contentOrigin}${route}`)).status(), 404, `${route} on the content host`);
  }
  assert.equal((await tab.goto(`${appOrigin}/api/capabilities`)).status(), 200);
  console.log('Card sandbox passed: the content host frames and opens cards, they theme, and they cannot post as the app or read its storage.');
} finally {
  await browser.close();
  site.close();
  await fake.close();
}
