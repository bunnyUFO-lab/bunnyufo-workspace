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
 * (see steady-fetch.mjs), so a timed-out connect is repeated (a refused one only in the first second; a reset never).
 */
export function steadyFetch(route, options) {
  return repeatConnect(() => route.fetch(options), error => /ETIMEDOUT/.test(String(error?.message)) ? 'ETIMEDOUT' : /ECONNREFUSED/.test(String(error?.message)) ? 'ECONNREFUSED' : '');
}

// Navigation on a busy PC: the browser's connect to the test server can time out
// (net::ERR_CONNECTION_TIMED_OUT) before a byte is sent. Every UI test launches its browser through
// `chromium.launch`, so wrap it once: pages it makes repeat a navigation that failed that way.
import { chromium } from '@playwright/test';

// Only a timed-out connect is repeated. A reset or a refused connect means the server is gone or broke: the test fails at once.
const CONNECT_ERROR = /ERR_CONNECTION_TIMED_OUT|ERR_TIMED_OUT/;
const patched = new WeakSet();
const repeatOnConnectError = (proto, name) => {
  const original = proto[name];
  proto[name] = async function steadyNavigation(...args) {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await original.apply(this, args);
      } catch (error) {
        if (attempt >= 6 || !CONNECT_ERROR.test(String(error?.message))) throw error;
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
    if (reloads >= 3 || pending || !CONNECT_ERROR.test(request.failure()?.errorText ?? '')) return;
    let local = false;
    try { local = new URL(request.url()).origin === new URL(page.url()).origin; } catch { /* about:blank */ }
    if (!local) return;
    pending = true;
    setTimeout(() => { pending = false; reloads += 1; console.log('(steady) a request to the test server timed out; reloading the page'); page.reload().catch(() => {}); }, 500);
  });
};
const patchPage = page => {
  watchPage(page);
  const proto = Object.getPrototypeOf(page);
  if (patched.has(proto)) return;
  patched.add(proto);
  repeatOnConnectError(proto, 'goto');
  repeatOnConnectError(proto, 'reload');
};
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
    watchContext(context);
    const newPage = context.newPage.bind(context);
    context.newPage = async (...a) => { const page = await newPage(...a); patchPage(page); return page; };
    return context;
  };
  const browserNewPage = browser.newPage.bind(browser);
  browser.newPage = async (...a) => { const page = await browserNewPage(...a); patchPage(page); return page; };
  return browser;
};
