// The Workspace app on a phone: the app shell and the cards last read stay readable with no signal.
//
// Only reading is cached. Writes are never queued or replayed, and /api/* is never touched: every
// pin, archive and save goes to the network and fails visibly when there is none. Plain JS, no
// imports; vite.config.ts copies it to /sw.js, and src/lib/serviceWorker.ts registers it on the
// published site only.
// A new cache name drops what an older worker kept: activate deletes every cache not listed here.
const SHELL = 'buw-shell-v2'
const CARDS = 'buw-cards-v1'
const KEEP = [SHELL, CARDS]
// The last 20 card pages, with the workspace.json that goes with each.
const MAX_CARD_ENTRIES = 40
// Built files of past deploys are never asked for again; the oldest go first. index.html is exempt.
const MAX_ASSET_ENTRIES = 200
// Vite names built files `name-<8 hash characters>.ext`; anything else under /assets/ (the logo,
// icons, copied fonts) can change under the same name.
const HASHED = /-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/i

/** Only a plain answer from this origin is worth keeping: not an error, a partial, or a login page. */
const cacheable = response => response.status === 200 && response.type === 'basic'

self.addEventListener('install', event => {
  self.skipWaiting()
  event.waitUntil(
    fetch('/index.html', { redirect: 'manual' })
      .then(async response => { if (cacheable(response)) await (await caches.open(SHELL)).put('/index.html', response) })
      .catch(() => {}),
  )
})

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    await self.clients.claim()
    for (const name of await caches.keys()) if (!KEEP.includes(name)) await caches.delete(name)
  })())
})

async function navigation(request) {
  try {
    const response = await fetch(request)
    // A redirect to the sign-in page (an expired passkey session) goes to the browser untouched, never cached.
    if (response.type === 'opaqueredirect' || !cacheable(response)) return response
    // Only the app's page is the shell: not an image, the worker or the manifest opened in a tab.
    if (!(response.headers.get('content-type') ?? '').includes('text/html')) return response
    const copy = response.clone()
    // Every address of the app serves the same shell.
    void caches.open(SHELL).then(cache => cache.put('/index.html', copy))
    return response
  } catch (error) {
    const shell = await caches.match('/index.html', { cacheName: SHELL })
    if (shell) return shell
    throw error
  }
}

async function trim(cache, max, keep = () => false) {
  const keys = (await cache.keys()).filter(key => !keep(new URL(key.url).pathname))
  for (const key of keys.slice(0, Math.max(0, keys.length - max))) await cache.delete(key)
}

async function assetFirst(request) {
  const cache = await caches.open(SHELL)
  const hit = await cache.match(request)
  if (hit) return hit
  const response = await fetch(request)
  if (cacheable(response)) {
    await cache.put(request, response.clone())
    await trim(cache, MAX_ASSET_ENTRIES, pathname => pathname === '/index.html')
  }
  return response
}

/** Files that keep their name when they change: the network first, the last copy only with no signal. */
async function assetFromNetwork(request) {
  const cache = await caches.open(SHELL)
  try {
    const response = await fetch(request)
    if (cacheable(response)) await cache.put(request, response.clone())
    return response
  } catch (error) {
    const hit = await cache.match(request)
    if (hit) return hit
    throw error
  }
}

async function cardFirstFromNetwork(request) {
  const cache = await caches.open(CARDS)
  try {
    const response = await fetch(request)
    if (cacheable(response)) {
      await cache.put(request, response.clone())
      const keys = await cache.keys()
      for (const key of keys.slice(0, Math.max(0, keys.length - MAX_CARD_ENTRIES))) await cache.delete(key)
    }
    return response
  } catch (error) {
    const hit = await cache.match(request)
    if (hit) return hit
    throw error
  }
}

self.addEventListener('fetch', event => {
  const { request } = event
  const url = new URL(request.url)
  // Reads from this origin only. Everything else (writes, other origins) is not ours to answer.
  if (request.method !== 'GET' || url.origin !== self.location.origin) return
  if (url.pathname.startsWith('/api/')) return
  if (request.headers.has('range')) return
  if (url.pathname === '/sites.json' || url.pathname.startsWith('/w/')) {
    event.respondWith(cardFirstFromNetwork(request))
  } else if (request.mode === 'navigate') {
    event.respondWith(navigation(request))
  } else if (url.pathname.startsWith('/assets/')) {
    event.respondWith(HASHED.test(url.pathname) ? assetFirst(request) : assetFromNetwork(request))
  }
})
