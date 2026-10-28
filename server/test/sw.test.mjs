// The phone app's service worker (public/sw.js), run in a sandbox with a fake cache and network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../../public/sw.js', import.meta.url), 'utf8');
const ORIGIN = 'https://site.test';

function worker(network = {}) {
  const listeners = {};
  const stores = new Map();
  const open = name => {
    if (!stores.has(name)) stores.set(name, new Map());
    const map = stores.get(name);
    const key = request => new URL(typeof request === 'string' ? request : request.url, ORIGIN).href;
    return {
      put: async (request, response) => { map.delete(key(request)); map.set(key(request), response); },
      match: async request => map.get(key(request)),
      delete: async request => map.delete(key(request)),
      keys: async () => [...map.keys()].map(url => ({ url })),
    };
  };
  const caches = {
    open: async name => open(name),
    keys: async () => [...stores.keys()],
    delete: async name => stores.delete(name),
    match: async (request, { cacheName }) => open(cacheName).match(request),
  };
  const answer = (body, type = 'text/html') => ({ status: 200, type: 'basic', headers: new Headers({ 'content-type': type }), body, clone() { return this; } });
  let offline = false;
  const served = { ...network };
  const fetchFn = async request => {
    if (offline) throw new TypeError('offline');
    const path = new URL(typeof request === 'string' ? request : request.url, ORIGIN).pathname;
    const found = served[path];
    return found ? answer(found.body, found.type) : answer('', 'text/plain');
  };
  const self = { location: { origin: ORIGIN }, clients: { claim: async () => {} }, skipWaiting() {}, addEventListener: (type, fn) => { listeners[type] = fn; } };
  vm.runInNewContext(source, { self, caches, fetch: fetchFn, URL, Headers, console });
  const event = extra => { const waits = []; const e = { ...extra, waitUntil: p => waits.push(p), respondWith: p => waits.push(Promise.resolve(p).then(r => { e.response = r; })), done: () => Promise.all(waits) }; return e; };
  const request = (path, mode = 'cors') => ({ url: ORIGIN + path, method: 'GET', mode, headers: new Headers() });
  const get = async (path, mode) => { const e = event({ request: request(path, mode) }); listeners.fetch(e); await e.done(); return e.response; };
  return { caches, stores, get, listeners, event, offline: value => { offline = value; }, serve: (path, body, type) => { served[path] = { body, type }; } };
}

test('only an HTML navigation becomes the offline app shell', async () => {
  const w = worker({ '/one': { body: 'app', type: 'text/html' }, '/assets/x.svg': { body: '<svg/>', type: 'image/svg+xml' }, '/manifest.webmanifest': { body: '{}', type: 'application/manifest+json' } });
  const settle = () => new Promise(resolve => setTimeout(resolve, 5));
  await w.get('/one', 'navigate'); await settle();
  assert.equal((await w.caches.match('/index.html', { cacheName: 'buw-shell-v2' })).body, 'app');
  for (const path of ['/assets/x.svg', '/manifest.webmanifest']) {
    const shown = await w.get(path, 'navigate'); await settle();
    assert.ok(shown, path);
    assert.equal((await w.caches.match('/index.html', { cacheName: 'buw-shell-v2' })).body, 'app', `${path} opened in a tab does not replace the shell`);
  }
  w.offline(true);
  assert.equal((await w.get('/anything', 'navigate')).body, 'app', 'Offline, the shell answers.');
});

test('a card page loaded in a tab or a frame is left to the network; its files are not', async () => {
  const w = worker({ '/w/one/alpha/index.html': { body: 'card', type: 'text/html' } });
  const ask = destination => { const e = w.event({ request: { ...{ url: ORIGIN + '/w/one/alpha/index.html', method: 'GET', mode: 'navigate', headers: new Headers() }, destination } }); w.listeners.fetch(e); return e.done().then(() => e.response); };
  assert.equal(await ask('document'), undefined, 'The worker does not answer, so the host sees the real navigation (and may redirect it).');
  assert.equal(await ask('iframe'), undefined, 'A frame too: it must reach the host to be moved to the content host.');
  assert.equal((await w.get('/w/one/alpha/index.html', 'cors')).body, 'card', 'Subresource reads still go through the card cache.');
});

test('built files are cache-first and bounded; files that keep their name go to the network first', async () => {
  const w = worker();
  for (let n = 0; n < 230; n += 1) w.serve(`/assets/chunk-${String(n).padStart(8, '0')}.js`, `v${n}`, 'text/javascript');
  w.serve('/index.html', 'app', 'text/html');
  await (async () => { const e = w.event({}); w.listeners.install(e); await e.done(); })();
  for (let n = 0; n < 230; n += 1) await w.get(`/assets/chunk-${String(n).padStart(8, '0')}.js`);
  const kept = [...w.stores.get('buw-shell-v2').keys()].map(url => new URL(url).pathname);
  assert.equal(kept.filter(p => p.startsWith('/assets/')).length, 200, 'Old deploys\' files are dropped past the cap.');
  assert.ok(kept.includes('/index.html'), 'The shell is never trimmed away.');
  assert.ok(kept.includes('/assets/chunk-00000229.js') && !kept.includes('/assets/chunk-00000000.js'), 'The oldest go first.');

  w.serve('/assets/bunnyufo-logo.svg', 'old', 'image/svg+xml');
  assert.equal((await w.get('/assets/bunnyufo-logo.svg')).body, 'old');
  w.serve('/assets/bunnyufo-logo.svg', 'new', 'image/svg+xml');
  assert.equal((await w.get('/assets/bunnyufo-logo.svg')).body, 'new', 'An unhashed file is not served stale.');
  w.offline(true);
  assert.equal((await w.get('/assets/bunnyufo-logo.svg')).body, 'new', 'With no signal the last copy answers.');
});

test('activating deletes the caches of older workers', async () => {
  const w = worker();
  await w.caches.open('buw-shell-v1'); await (await w.caches.open('buw-shell-v1')).put('/assets/a.js', {});
  await w.caches.open('buw-cards-v1'); await w.caches.open('buw-shell-v2');
  const e = w.event({}); w.listeners.activate(e); await e.done();
  assert.deepEqual([...w.stores.keys()].sort(), ['buw-cards-v1', 'buw-shell-v2']);
});
