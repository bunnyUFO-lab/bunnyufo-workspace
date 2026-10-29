// A card page cannot act as the signed-in app. Option B of the sandbox: the site serves cards from a content
// host (here cards.example.localhost against app.example.localhost, both loopback). Stand-in for the site:
// createSiteApi over fake S3, the built dist/, and the two Caddy rules the real site has (a card opened in its own
// tab moves to the content host; the content host serves /w/ only). The card page tries to read the app's
// storage, post to the app, fetch a sibling file and load its stylesheet and script, in the app's frame
// and in its own tab; and it follows the app's light and dark theme. The one thing it may do is ask the app to
// save for it (the card bridge, by postMessage): its own card's responses and Markdown answer, in the app's
// frame only, with no credential of its own and nothing from a window that is not that frame.
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
const card = { id: 'alpha', folder: 'alpha', title: 'Alpha card', description: 'A card.', category: 'test', created: today, updated: today, status: 'active', steps: [{ name: 'Page', path: 'index.html' }, { name: 'Form', path: 'form.html' }, { name: 'Answers page', path: 'answers.html' }, { name: 'Answers', path: 'answers.md' }] };
const beta = { ...card, id: 'beta', folder: 'beta', title: 'Beta card', steps: [{ name: 'Page', path: 'index.html' }, { name: 'Answers', path: 'answers.md' }] };
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
seed('sections/one/workspace.json', JSON.stringify({ name: 'One', entities: [card, beta] }), 'application/json');
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
// A card that frames an app-host /w/ page: that page must not end up running as the app.
seed('sections/one/alpha/evil.js', `
window.__result = (async () => {
  const result = { origin: location.origin };
  try { result.storage = localStorage.getItem('app-secret'); } catch { result.storage = 'threw'; }
  await fetch('/api/workspace/pin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workspace: 'one', id: 'alpha', pinned: true }) }).catch(() => {});
  return result;
})();
`, 'text/javascript');
seed('sections/one/alpha/evil.html', '<!doctype html><html><head><meta charset="utf-8"><title>Evil</title></head><body><p>evil</p><script src="evil.js"></script></body></html>', 'text/html; charset=utf-8');
seed('sections/one/alpha/nest.html', `<!doctype html><html><head><meta charset="utf-8"><title>Nest</title></head><body><iframe id="inner" src="${appOrigin}/w/one/alpha/evil.html"></iframe></body></html>`, 'text/html; charset=utf-8');
// The card forms: one saves ratings, one saves a Markdown answer, both through the bridge and nothing else.
seed('sections/one/_shared/card-data.js', await readFile(path.join(root, 'workspace/_shared/card-data.js')), 'text/javascript');
seed('sections/one/alpha/answers.md', 'start', 'text/markdown');
seed('sections/one/alpha/form.html', `<!doctype html><html><head><meta charset="utf-8"><title>Form</title></head><body><p id="mode"></p><p id="msg"></p><p id="val"></p>
<script src="../_shared/card-data.js"></script>
<script>
window.__form = (async () => {
  const store = await BuwCardData.open({ doc: 'ratings' });
  const show = () => { mode.textContent = store.mode; msg.textContent = store.message; val.textContent = JSON.stringify(store.get('r1') ?? null); };
  store.on('status', show);
  window.__store = store;
  return store;
})();
</script></body></html>`, 'text/html; charset=utf-8');
seed('sections/one/alpha/answers.html', `<!doctype html><html><head><meta charset="utf-8"><title>Answers</title></head><body><p id="out"></p>
<script src="../_shared/card-data.js"></script>
<script>
const FILE = 'answers.md';
window.__answers = {
  async load() { const got = await BuwCardData.bridge.call('markdown.get', { path: FILE }); out.textContent = got.text; return got; },
  async save(text) {
    let got = await BuwCardData.bridge.call('markdown.get', { path: FILE });
    const post = () => BuwCardData.bridge.call('markdown.save', { path: FILE, text, base: got.etag });
    let r;
    try { r = await post(); } catch (e) { if (e.status !== 409) throw e; got = e.current; r = await post(); }
    out.textContent = r.text;
    return r;
  },
};
</script></body></html>`, 'text/html; charset=utf-8');
// A hostile card (alpha) that gets hold of the app's window and tries to script the frame of another card (beta) in it,
// to send bridge messages as beta. All cards share the content origin, so that frame is script-reachable from alpha
// unless the app cannot be framed (frame-ancestors) or reached through an opener (Cross-Origin-Opener-Policy).
seed('sections/one/beta/index.html', '<!doctype html><html><head><meta charset="utf-8"><title>Beta</title></head><body><h1>Beta heading</h1></body></html>', 'text/html; charset=utf-8');
seed('sections/one/alpha/attack.js', `
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const MESSAGES = [
  { type: 'buw:bridge', v: 1, id: 'atk1', op: 'markdown.save', path: 'answers.md', text: 'written by alpha', base: null },
  { type: 'buw:bridge', v: 1, id: 'atk2', op: 'responses.set', doc: 'ratings', set: { evil: { updated: 'x', data: 1 } } },
];
window.__attack = async mode => {
  let app = null;
  try {
    if (mode === 'frame') { const inner = document.createElement('iframe'); inner.src = ${JSON.stringify(appOrigin)} + '/one#/beta/0'; document.body.append(inner); app = inner.contentWindow; }
    else if (mode === 'popup') app = window.open(${JSON.stringify(appOrigin)} + '/one#/beta/0');
    else app = window.opener && window.opener.top;
  } catch { /* no handle */ }
  if (!app) return 'no app window';
  for (let n = 0; n < 40; n += 1) {
    try {
      const other = app[0];
      if (other && other.location.pathname.includes('/w/one/beta/') && other.document.body) {
        const script = other.document.createElement('script');
        script.textContent = 'for (const m of ' + JSON.stringify(MESSAGES) + ') parent.postMessage(m, "*")';
        other.document.body.append(script);
        await sleep(1500);
        return 'injected';
      }
    } catch { /* cross-origin, or not there */ }
    await sleep(250);
  }
  return 'no beta frame';
};
`, 'text/javascript');
seed('sections/one/alpha/helper.html', '<!doctype html><html><head><meta charset="utf-8"><title>Helper</title></head><body><p>helper</p><script src="attack.js"></script></body></html>', 'text/html; charset=utf-8');
seed('sections/one/alpha/index.html', '<!doctype html><html data-buw-report="document"><head><meta charset="utf-8"><title>Alpha</title><link rel="stylesheet" href="../_shared/report.css"><link rel="stylesheet" href="style.css"></head><body><main><h1>Alpha heading</h1><p id="mark">Text.</p></main><script src="../_shared/report.js"></script><script src="probe.js"></script></body></html>', 'text/html; charset=utf-8');

const api = createSiteApi({
  bucket, sectionsTtl: 0, contentOrigin, allowedOrigins: [appOrigin],
  stateFile: path.join(root, '.cache', 'card-sandbox-state.json'),
});
// What the real site's Caddy sends with the app shell: it must not be framed or reachable from a card's window,
// because every card shares the content origin and could script the card frame the app shows. BUW_TEST_NO_APP_HEADERS=1
// leaves them off (=coop: only the opener policy), to see the hostile steps below fail.
const OFF = process.env.BUW_TEST_NO_APP_HEADERS;   // '1': none; 'coop': all but the opener policy
const APP_SHELL = OFF === '1' ? {} : { ...(OFF === 'coop' ? {} : { 'Cross-Origin-Opener-Policy': 'same-origin' }), 'Content-Security-Policy': "frame-ancestors 'none'", 'X-Frame-Options': 'DENY' };
const send = (response, status, type, body, extra = {}) => { response.writeHead(status, { 'Content-Type': type, ...extra }); response.end(body); };
site.on('request', async (request, response) => {
  const url = new URL(request.url, 'http://site');
  const host = String(request.headers.host ?? '');
  response.on('finish', () => log.push({ method: request.method, host, path: url.pathname, origin: request.headers.origin ?? null, authorization: request.headers.authorization ?? null, status: response.statusCode }));
  const toApi = () => api.emit('request', request, response);
  if (host === contentHost) return toApi();   // the API itself serves /w/ only, with the CSP, on this host
  if (url.pathname.startsWith('/w/') && ['document', 'iframe', 'frame', 'object', 'embed'].includes(request.headers['sec-fetch-dest'])) {
    return send(response, 302, 'text/plain', '', { Location: `${contentOrigin}${url.pathname}${url.search}` });
  }
  if (url.pathname.startsWith('/api/') || url.pathname === '/sites.json' || url.pathname.startsWith('/w/')) return toApi();
  try {
    const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const body = await readFile(path.join(dist, file));
    return send(response, 200, file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html', body, APP_SHELL);
  } catch { return send(response, 200, 'text/html', await readFile(path.join(dist, 'index.html')), APP_SHELL); }
});

const browser = await chromium.launch({ headless: true, channel: process.env.BUW_TEST_BROWSER || 'msedge' });
const settle = ms => new Promise(resolve => setTimeout(resolve, ms));
try {
  const context = await browser.newContext({ viewport: { width: 1200, height: 900 }, colorScheme: 'light' });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => { throw error; });
  await page.goto(`${appOrigin}/one`);
  await page.locator('.entity-card').first().waitFor();
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

  step('a card that frames an app-host /w/ page: the inner page does not run as the app and writes nothing');
  await tab.goto(`${contentOrigin}/w/one/alpha/nest.html`);
  await settle(1500);
  const inner = tab.frames().find(f => f !== tab.mainFrame());
  assert.ok(inner, 'The inner frame exists.');
  const innerOrigin = new URL(inner.url() === 'about:blank' ? contentOrigin : inner.url()).origin;
  assert.notEqual(innerOrigin, appOrigin, `The inner page is not on the app origin (${inner.url()}).`);
  const innerResult = await inner.evaluate(() => window.__result).catch(() => null);
  if (innerResult) assert.deepEqual(innerResult.storage, null, 'The inner page cannot read the app storage.');
  assert.deepEqual(fake.json('state.json').cards, {}, 'The inner page wrote no pin.');

  const NO_BRIDGE = 'Open this card inside the Workspace, signed in, to save it.';
  const appFrame = async (index, ready) => {
    await page.goto(`${appOrigin}/one#/alpha/${index}`);
    await page.locator('iframe.report-frame').waitFor();
    let content;
    for (let n = 0; n < 50 && !content; n += 1) { content = page.frames().find(f => f.url().startsWith(`${contentOrigin}/w/one/alpha/`)); if (!content) await settle(100); }
    assert.ok(content, 'the card frame is on the content origin');
    await content.evaluate(ready);
    return content;
  };

  step('the old card API passphrase is removed from the app origin when the app loads');
  await page.evaluate(() => localStorage.setItem('buw.cardApiPassphrase', 'left over'));
  await page.goto(`${appOrigin}/one`);
  await page.locator('.entity-card').first().waitFor();
  assert.equal(await page.evaluate(() => localStorage.getItem('buw.cardApiPassphrase')), null);
  log.length = 0;

  step('a card form saves through the app: mode server, the doc is in the bucket, and a reload reads it back');
  let form = await appFrame(1, () => window.__form);
  assert.equal(await form.evaluate(() => window.__store.mode), 'server');
  await form.evaluate(async () => { window.__store.set('r1', { stars: 4 }); await window.__store.flush(); });
  assert.deepEqual(fake.json('sections/one/card-responses/alpha/ratings.json').items.r1.data, { stars: 4 });
  assert.equal(fake.json('sections/one/card-responses/alpha/ratings.json').section, 'one');
  await form.evaluate(() => localStorage.clear());   // the browser copy is gone: what comes back is the server's
  form = await appFrame(1, () => window.__form);
  assert.equal(await form.locator('#mode').textContent(), 'server');
  assert.deepEqual(JSON.parse(await form.locator('#val').textContent()), { stars: 4 });

  step('a Markdown answer is read and saved through the app');
  const answers = await appFrame(2, () => window.__answers);
  assert.equal((await answers.evaluate(() => window.__answers.load())).text, 'start');
  await answers.evaluate(() => window.__answers.save('{"picked":"b"}'));
  assert.equal(fake.text('sections/one/alpha/answers.md'), '{"picked":"b"}');

  step('the card never sent a credential, and every save came from the app origin');
  await settle(300);
  assert.deepEqual(log.filter(entry => entry.host === contentHost && entry.authorization), [], 'no Authorization header from the content host');
  const saves = log.filter(entry => entry.method === 'POST' && (entry.path === '/api/cards/responses' || entry.path === '/api/cards/markdown'));
  assert.ok(saves.length >= 2);
  for (const entry of saves) { assert.equal(entry.host, appHost); assert.equal(entry.origin, appOrigin); assert.equal(entry.status, 200); }
  assert.equal(log.filter(entry => entry.host === contentHost && entry.path.startsWith('/api')).length, 0, 'the card made no /api call');
  assert.equal(await page.evaluate(() => localStorage.getItem('buw.cardApiPassphrase')), null);

  step('a nested frame inside the card posts a save to the app with target *: nothing is written');
  form = await appFrame(1, () => window.__form);
  await form.evaluate(() => {
    const inner = document.createElement('iframe');
    inner.srcdoc = '<script>top.postMessage({ type: "buw:bridge", v: 1, id: "hostile01", op: "responses.set", doc: "ratings", set: { evil: { updated: "x", data: 1 } } }, "*"); top.postMessage({ type: "buw:bridge", v: 1, id: "hostile02", op: "markdown.save", path: "answers.md", text: "pwned", base: null }, "*")</scr' + 'ipt>';
    document.body.append(inner);
  });
  await settle(1000);
  assert.equal(fake.json('sections/one/card-responses/alpha/ratings.json').items.evil, undefined, 'the nested frame wrote no response');
  assert.equal(fake.text('sections/one/alpha/answers.md'), '{"picked":"b"}', 'the nested frame wrote no answer');

  // Beta's answers and responses must stay as they were through all three: nothing exists for it, so any write shows.
  const betaUntouched = () => {
    assert.equal(fake.text('sections/one/beta/answers.md'), null, "beta's answer file was not written");
    for (const key of ['sections/one/card-responses/beta/ratings.json']) assert.equal(fake.json(key), null, `${key} was not written`);
    assert.equal(fake.json('sections/one/card-responses/alpha/ratings.json').items.evil, undefined, 'alpha ratings got no evil item');
  };

  step('hostile: a card frames the app to script another card\'s frame: the app refuses to be framed');
  const framer = await context.newPage();
  framer.setDefaultTimeout(30000);
  await framer.goto(`${contentOrigin}/w/one/alpha/helper.html`);
  assert.notEqual(await framer.evaluate(() => window.__attack('frame')), 'injected');
  betaUntouched();
  await framer.close();

  step('hostile: a card opens the app in a popup and scripts another card\'s frame: no handle to the app');
  const opener = await context.newPage();
  opener.setDefaultTimeout(30000);
  await opener.goto(`${contentOrigin}/w/one/alpha/helper.html`);
  assert.notEqual(await opener.evaluate(() => window.__attack('popup')), 'injected');
  betaUntouched();
  for (const extra of context.pages()) if (extra !== page && extra !== tab && extra !== opener) await extra.close();
  await opener.close();

  step('hostile: a popup a card kept open cannot reach the app after the owner moves to another card');
  await appFrame(1, () => window.__form);
  const inFormFrame = page.frames().find(f => f.url().startsWith(`${contentOrigin}/w/one/alpha/form.html`));
  const [popup] = await Promise.all([page.waitForEvent('popup'), inFormFrame.evaluate(() => { window.open('helper.html'); })]);
  await popup.waitForLoadState();
  await page.goto(`${appOrigin}/one#/beta/0`);
  await page.reload();
  await page.locator('iframe.report-frame').waitFor();
  popup.setDefaultTimeout(30000);
  assert.notEqual(await popup.evaluate(() => window.__attack('held')), 'injected');
  betaUntouched();
  await popup.close();

  step('opened in its own tab: local mode, the message, and no request to the responses route');
  log.length = 0;
  await tab.goto(`${appOrigin}/w/one/alpha/form.html`);
  assert.equal(tab.url(), `${contentOrigin}/w/one/alpha/form.html`);
  await tab.evaluate(() => window.__form);
  assert.equal(await tab.evaluate(() => window.__store.mode), 'local');
  assert.equal(await tab.locator('#mode').textContent(), 'local');
  assert.equal(await tab.locator('#msg').textContent(), NO_BRIDGE);
  await tab.evaluate(async () => { window.__store.set('r9', { stars: 1 }); await window.__store.flush(); });
  await settle(300);
  assert.equal(log.filter(entry => entry.path.startsWith('/api')).length, 0, 'no API request from the card in its own tab');
  assert.equal(fake.json('sections/one/card-responses/alpha/ratings.json').items.r9, undefined);

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
