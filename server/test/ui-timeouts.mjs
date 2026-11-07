// Time limits for the browser tests, set from the machine they run on.
//
// A test written on an idle PC waits 15 s for a toast; on a PC that is also running other
// suites, builds or a game, the same wait can take longer than that and the test fails
// although nothing is wrong. Every wait in a UI test goes through `ms()`, which multiplies the
// number by BUW_UI_TIMEOUT_SCALE (default 4). A wait that is really stuck still ends: it only
// ends later, and always with a message that names the wait.
import { mkdtemp } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { repeatConnect } from '../../site/api/test/steady-fetch.mjs';

const scale = Number(process.env.BUW_UI_TIMEOUT_SCALE);
export const SCALE = Number.isFinite(scale) && scale > 0 ? scale : 4;
export const ms = value => Math.round(value * SCALE);

// Isolation from the machine: the service reads ~/.buw/config.json (the card API's address) and
// ~/.buw/workspaces.json (the registry) when a test does not pass its own. On the owner's PC
// those point at the real site and the real workspaces, so a test page could talk to the live
// card API, or open another checkout's data. Every UI test imports this file first, so point
// both at an empty per-run folder unless the caller already chose one.
const home = await mkdtemp(path.join(os.tmpdir(), 'buw-ui-home-'));
process.env.BUW_CONFIG ||= path.join(home, 'config.json');
process.env.BUW_REGISTRY ||= path.join(home, 'workspaces.json');
process.on('exit', () => { try { rmSync(home, { recursive: true, force: true }); } catch { /* the OS clears the temp folder */ } });

/**
 * `route.fetch()` for a test that rewrites a response. Playwright makes that request itself, and on a
 * loaded PC the connection to the test server now and then fails with ETIMEDOUT before anything is sent
 * (see steady-fetch.mjs), so a timed-out connect is repeated (a refused one for 2 s at most; a reset never).
 */
export async function steadyFetch(route, options) {
  const codeOf = error => /ETIMEDOUT/.test(String(error?.message)) ? 'ETIMEDOUT' : /ECONNREFUSED/.test(String(error?.message)) ? 'ECONNREFUSED' : '';
  // A refused connect to a test server that is up happens too on a loaded PC (a full listen backlog on Windows). It is repeated for
  // 2 s at most, so a fixture that really is gone still fails by name, a few seconds later.
  const end = Date.now() + 2000;
  for (;;) {
    try {
      return await repeatConnect(() => route.fetch(options), codeOf);
    } catch (error) {
      if (codeOf(error) !== 'ECONNREFUSED' || Date.now() > end) throw error;
      await new Promise(resolve => setTimeout(resolve, 150));
    }
  }
}

// Navigation on a busy PC: the browser's connect to the test server can time out
// (net::ERR_CONNECTION_TIMED_OUT) before a byte is sent. Every UI test launches its browser through
// `chromium.launch`, so wrap it once: pages it makes repeat a navigation that failed that way.
import { chromium } from '@playwright/test';

// Only a timed-out connect is repeated. A reset means the server broke: the test fails at once.
const CONNECT_ERROR = /ERR_CONNECTION_TIMED_OUT|ERR_TIMED_OUT/;
// A navigation is also repeated when Chrome's connect was refused (on Windows a busy listener can refuse a connect while its backlog
// is full) or when it ended on Chrome's error page ("interrupted by another navigation to chrome-error://chromewebdata/"). That is
// bounded by the six attempts below (about 3 s), so a fixture that really is gone still fails by name a few seconds later.
const NAVIGATION_ERROR = /ERR_CONNECTION_TIMED_OUT|ERR_TIMED_OUT|ERR_CONNECTION_REFUSED|chrome-error:\/\/chromewebdata/;
const patched = new WeakSet();
const repeatOnConnectError = (proto, name) => {
  const original = proto[name];
  proto[name] = async function steadyNavigation(...args) {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await original.apply(this, args);
      } catch (error) {
        if (attempt >= 6 || !NAVIGATION_ERROR.test(String(error?.message))) throw error;
        await new Promise(resolve => setTimeout(resolve, 200 * attempt));
      }
    }
  };
};
// A request the page makes by itself (its first data fetch, its event socket) fails the same way and the app
// does not repeat it, so the page would sit empty until the test gave up. Reload it, up to three times.
const watchPage = page => {
  let reloads = 0;
  let pending = false;
  page.on('requestfailed', request => {
    if (/ERR_CONNECTION|ERR_TIMED_OUT|ERR_EMPTY|ERR_FAILED/.test(request.failure()?.errorText ?? '')) console.log(`(steady) request failed: ${request.url().slice(0, 120)} ${request.failure()?.errorText}`);
    if (reloads >= 3 || pending || !CONNECT_ERROR.test(request.failure()?.errorText ?? '')) return;
    let local = false;
    try { local = new URL(request.url()).origin === new URL(page.url()).origin; } catch { /* about:blank */ }
    if (!local) return;
    pending = true;
    setTimeout(() => { pending = false; reloads += 1; console.log('(steady) a request to the test server timed out; reloading the page'); page.reload().catch(() => {}); }, 500);
  });
};
// What a page is still waiting for, kept so a wait that times out can say so: the requests in flight, the address and the text on screen.
const inFlight = new WeakMap();
const trackRequests = page => {
  const open = new Map();
  inFlight.set(page, open);
  page.on('request', request => { open.set(request, Date.now()); });
  const done = request => { open.delete(request); };
  page.on('requestfinished', done);
  page.on('requestfailed', done);
};
const explained = new WeakSet();
/** Written once per page, when a wait on it times out and before the test's cleanup closes it. Never throws. */
async function explainTimeout(page) {
  if (explained.has(page)) return;
  explained.add(page);
  try {
    const open = [...(inFlight.get(page) ?? [])].map(([request, since]) => `${request.method()} ${request.url().replace(/^(https?:\/\/[^/]+)/, (host) => host.replace(/:\d+$/, ':port')).slice(0, 140)} (${Date.now() - since} ms)`);
    const text = await page.evaluate(() => document.body?.innerText ?? '').catch(() => '(the page could not be read)');
    console.log(`(pending) address: ${page.url().replace(/:\d+\//, ':port/').slice(0, 200)}`);
    console.log(`(pending) ${open.length} request${open.length === 1 ? '' : 's'} in flight${open.length ? ':' : ''}`);
    for (const line of open.slice(0, 20)) console.log(`(pending)   ${line}`);
    console.log(`(pending) text on the page: ${String(text).replace(/\s+/g, ' ').trim().slice(0, 1200)}`);
  } catch { /* the page is gone; the error itself is still thrown */ }
}
// Every Playwright call that can time out goes through this: the TimeoutError still reaches the test unchanged.
const explainOnTimeout = (proto, pageOf) => {
  for (const name of Object.getOwnPropertyNames(proto)) {
    const original = proto[name];
    if (name === 'constructor' || name.startsWith('_') || typeof original !== 'function' || Object.getOwnPropertyDescriptor(proto, name).get) continue;
    proto[name] = function explaining(...args) {
      const result = original.apply(this, args);
      if (!result || typeof result.then !== 'function') return result;
      return result.catch(async error => {
        if (error?.name === 'TimeoutError') { const page = pageOf(this); if (page) await explainTimeout(page); }
        throw error;
      });
    };
  }
};
const patchPage = page => {
  watchPage(page);
  trackRequests(page);
  const proto = Object.getPrototypeOf(page);
  if (patched.has(proto)) return;
  patched.add(proto);
  repeatOnConnectError(proto, 'goto');
  repeatOnConnectError(proto, 'reload');
  explainOnTimeout(proto, self => self);
  explainOnTimeout(Object.getPrototypeOf(page.locator('body')), self => self.page());
};

// The tests never depend on an outside host: the app's stylesheet link to Google Fonts is answered with an empty file, so a slow or
// stuck font host cannot hold the page's load event (and with it a goto or waitForURL) for a minute.
const FONT_HOSTS = /^https:\/\/fonts\.(googleapis|gstatic)\.com\//;
const blockFonts = context => context.route(FONT_HOSTS, route => route.fulfill({
  status: 200, body: '', contentType: route.request().url().includes('googleapis') ? 'text/css' : 'font/woff2',
}).catch(() => {})).catch(() => {});
// The page's own calls to the test server (/api/...) go through Playwright, which makes them again when the connect timed
// out: reloading the page would throw away what the test had open (a sheet, a typed answer). A stream (event-stream)
// is left to the browser, since its body cannot be handed over whole. A test's own `page.route` handlers run before this one.
const watchContext = context => {
  context.route(url => { try { return /^(127\.0\.0\.1|localhost)$/.test(url.hostname) && url.pathname.startsWith('/api/'); } catch { return false; } }, async route => {
    const request = route.request();
    // The chat reply streams too, though its request does not say so.
    if (String(request.headers().accept ?? '').includes('text/event-stream') || (request.method() === 'POST' && new URL(request.url()).pathname === '/api/hub/chat')) { await route.fallback(); return; }
    let response;
    try { response = await steadyFetch(route); } catch { await route.fallback().catch(() => {}); return; }
    await route.fulfill({ response }).catch(() => {});
  }).catch(() => {});
};
const launch = chromium.launch.bind(chromium);
chromium.launch = async (...args) => {
  const browser = await launch(...args);
  const newContext = browser.newContext.bind(browser);
  browser.newContext = async (...options) => {
    const context = await newContext(...options);
    blockFonts(context);
    watchContext(context);
    const newPage = context.newPage.bind(context);
    context.newPage = async (...a) => { const page = await newPage(...a); patchPage(page); return page; };
    return context;
  };
  const browserNewPage = browser.newPage.bind(browser);
  browser.newPage = async (...a) => { const page = await browserNewPage(...a); blockFonts(page.context()); patchPage(page); return page; };
  return browser;
};

/**
 * Waits until an open drawing editor can be drawn on: its canvas is there and the container has a height. Excalidraw
 * can mount into a container that is still 0 px high (after a reload, while the page lays out), and then the canvas is
 * hidden with height 0 and `waitFor()` on it fails (ws-80j). `page` is the Playwright page.
 */
export async function editorReady(page, selector = '.drawing-editor') {
  const canvas = page.locator(`${selector} canvas.interactive`);
  await canvas.waitFor({ state: 'attached' });
  await page.waitForFunction(root => {
    const element = document.querySelector(`${root} canvas.interactive`);
    const box = document.querySelector(root)?.getBoundingClientRect();
    return !!element && !!box && box.height > 0 && element.getBoundingClientRect().height > 0;
  }, selector, { timeout: ms(15000) });
  await canvas.waitFor();
}
