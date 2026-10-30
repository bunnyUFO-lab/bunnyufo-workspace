// The published site's data service: cards out of the bucket, pins and archives into it.
//
// Every section's cards live in one private S3 bucket, `sections/<id>/…`, put there by
// `npm run publish` (an upload, not a commit). Nothing on the server holds a copy: Caddy forwards
// `/w/<id>/<file>` and `/sites.json` here, and this streams the object straight from the bucket
// with its ETag and content type, so a file uploaded a second ago is the file served now.
//
// Pinned, archived, tags and the order of the pinned list are not content — they change several
// times a minute — and live in `state.json` beside `sections/` (card-state.mjs). The local
// service reads and writes the same object, so a pin made on a phone is the pin the desktop shows.
//
// It answers the same paths and shapes as the local service, so the UI calls one or the other
// without knowing which: /api/card-state, /api/workspace/status, /api/workspace/pin,
// /api/workspace/pins, /api/workspace/tags, /api/workspace/icon. /api/sections starts a new section: one
// workspace.json plus the template files, put into the bucket, and it is on the site at once.
// /api/cards… makes cards, adds Markdown sections to them and saves their text (card-writes.mjs).
//
// A request can only name a section the bucket holds, and the only keys it can reach are under
// `sections/`: the state object and anything else in the bucket are not addressable from here.
//
// Reached through Caddy on the same origin as the site. Writes need the Remote-User header that
// Nginx Proxy Manager sets after the passkey check; Caddy only lets that header through from NPM.
import { createServer } from 'node:http';
import { readFile, readdir, stat } from 'node:fs/promises';
import { Readable, pipeline } from 'node:stream';
import path from 'node:path';
import { createBucketCardStore, createCardStore, validEmoji } from './card-state.mjs';
import { bucketStore, cardRoute, cardWriter } from './card-writes.mjs';
import { contentTypeOf } from './s3.mjs';

const STATUSES = ['active', 'archived'];
const RESERVED = new Set(['_app', '_retired', '_index', 'site', 'api', 'w', 'template', 'sections', 'state', 'today', 'inbox', 'board', 'map', 'chat', 'hub', 'inbox-dev']);
const SECTIONS_TTL = 15_000;

const json = (response, status, body) => {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  });
  response.end(text);
};

async function body(request, limit = 256 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('Request too large'), { status: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('Expected JSON');
  }
}

/** "Pixel Scenery" → "pixel-scenery": the id, the folder and the first path segment of its address. */
export const slugify = name =>
  String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);

/** "magic-loops" → "Magic Loops", for a section whose workspace.json carries no name. */
const titleCase = id => id.split('-').filter(Boolean).map(word => word[0].toUpperCase() + word.slice(1)).join(' ');

/** A path inside a section: forward slashes, no empty, dot or dot-dot segments. */
function cleanPath(value) {
  const parts = String(value ?? '').split('/').filter(Boolean);
  if (!parts.length || parts.some(part => part === '.' || part === '..' || part.startsWith('.'))) return null;
  return parts.join('/');
}

/**
 * @param bucket      an s3.mjs bucket, or null: without one the service answers read-only, with a reason.
 * @param prefix      where the sections are in the bucket, `sections` unless told otherwise.
 * @param templateDir what a new section starts as: the app's `workspace/` template, deployed
 *                    beside this service. Without it sections cannot be created, and the rest
 *                    still works.
 * @param stateFile   a local file for pins when there is no bucket (tests, and a site with no bucket).
 * @param requireRemoteUser  refuse every write that arrives without a Remote-User header (401), and
 *                    report the site read-only to a visitor who has none. Off by default: the local
 *                    dev proxy and the tests send no such header.
 * @param siteUrl     the address people sign in at, named in the read-only reason; empty leaves it out.
 * @param allowedOrigins  the origins a write may come from (`https://host`, no path). A write from any other
 *                    page, or with no Origin, is refused (403). With `requireRemoteUser` on and none given,
 *                    every write is refused. With it off, the check runs only when this list is given.
 * @param cardApi     the card API's address, reported to pages in /capabilities as `cardApi` (null when unset).
 * @param contentOrigin  the origin cards are served from (`https://host`), reported in /capabilities as `contentOrigin`
 *                    (null when unset). A request whose Host is that origin's gets only /w/ files, each with the
 *                    sandbox CSP below; everything else on it is a 404. Unset leaves /w/ as it was.
 * @param stateKey    the bucket object holding pins, archives and tags (`dev-state.json` on the development copy).
 * @param dev         null on the real site. On the development copy `{ writable(sectionId) }`: every write to a card
 *                    section is refused unless it says so, and /capabilities reports the deployed branch.
 * @param deployedRef the JSON file (`{ branch, sha, pr, at }`) the deploy leaves beside this file; read for `dev`.
 * @param hub         a Hub from hub.mjs (createHub), or null: the /hub/ routes, answered after the sign-in
 *                    check and before anything that reads a body. It reports itself in /capabilities.
 */
/** `https://host/path` → `https://host`. A malformed address gives nothing, which refuses every write. */
export function originOf(value) {
  try { return new URL(String(value)).origin; } catch { return ''; }
}

/** The origins writes may come from: a comma list if given, else the origin of the site address. */
export function allowedOriginsFrom({ origins = '', siteUrl = '' } = {}) {
  const list = String(origins).split(',').map(item => item.trim()).filter(Boolean);
  return (list.length ? list : [siteUrl]).map(originOf).filter(o => o && o !== 'null');
}

/**
 * What main.mjs passes as `allowedOrigins`: the list when sign-in is required or an origin was configured,
 * else null, so a local run with neither set (the dev proxy keeps the browser's own Origin) is not refused.
 */
export function writeOriginsFor({ requireRemoteUser = false, origins = '', siteUrl = '' } = {}) {
  const list = allowedOriginsFrom({ origins, siteUrl });
  return requireRemoteUser || list.length ? list : null;
}

/** The CSP of a card page on the content host: its own origin (cookies reach it) but none of the app's storage. */
export const CONTENT_CSP = 'sandbox allow-scripts allow-forms allow-popups allow-downloads allow-same-origin';

export function createSiteApi({
  bucket = null,
  prefix = 'sections',
  templateDir = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), 'template'),
  stateFile = path.join('.', 'card-state.json'),
  sectionsTtl = SECTIONS_TTL,
  requireRemoteUser = false,
  hub = null,
  siteUrl = '',
  allowedOrigins = null,
  cardApi = '',
  contentOrigin = '',
  stateKey = 'state.json',
  dev = null,
  deployedRef = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '.deployed-ref'),
} = {}) {
  const cards = bucket ? createBucketCardStore(bucket, { key: stateKey }) : createCardStore(stateFile);
  /** The development copy's write boundary: a card section is writable only when `dev.writable` says so. */
  const mayWrite = id => {
    if (dev && !dev.writable(String(id ?? ''))) {
      throw Object.assign(new Error('The development copy writes only dev-… sections.'), { status: 403 });
    }
  };
  let refCache = { at: 0, value: { branch: null } };
  async function devInfo() {
    if (Date.now() - refCache.at < 30000) return refCache.value;
    let value = { branch: null };
    try {
      const ref = JSON.parse(await readFile(deployedRef, 'utf8'));
      value = {
        branch: typeof ref.branch === 'string' ? ref.branch : null,
        ...(typeof ref.sha === 'string' ? { sha: ref.sha } : {}),
        ...(Number.isInteger(ref.pr) ? { pr: ref.pr } : {}),
        ...(typeof ref.at === 'string' ? { at: ref.at } : {}),
      };
    } catch {
      // No .deployed-ref yet: the copy runs, with no branch to name.
    }
    refCache = { at: Date.now(), value };
    return value;
  }
  const keyOf = (id, file) => `${prefix}/${id}/${file}`;
  const reason = bucket ? null : 'This site has no cards bucket configured, so it is read-only.';

  /**
   * Which sections the bucket holds: every `sections/<id>/workspace.json`, with the name the
   * file carries. Cached briefly — the list is read on every page load and changes on a publish.
   */
  let sectionsCache = null;
  async function sections({ fresh = false } = {}) {
    if (!bucket) return new Map();
    if (!fresh && sectionsCache && Date.now() - sectionsCache.at < sectionsTtl) return sectionsCache.map;
    const { prefixes } = await bucket.list(`${prefix}/`, { delimiter: '/' });
    const found = new Map();
    await Promise.all(prefixes.map(async folder => {
      const id = folder.slice(prefix.length + 1).replace(/\/$/, '');
      if (!id || id.startsWith('_')) return;
      const got = await bucket.getJson(keyOf(id, 'workspace.json')).catch(() => null);
      if (!got || !Array.isArray(got.value?.entities)) return;
      found.set(id, {
        id,
        name: typeof got.value.name === 'string' && got.value.name.trim() ? got.value.name.trim() : titleCase(id),
        base: `/w/${id}`,
        publishedAt: got.lastModified ? new Date(got.lastModified).toISOString() : undefined,
        // A hidden section holds data (inbox, events), not cards: it is served, but the UI never lists it.
        ...(got.value.hidden === true ? { hidden: true } : {}),
      });
    }));
    sectionsCache = { map: found, at: Date.now() };
    return found;
  }

  const findSection = async id => {
    const section = (await sections()).get(id) ?? (await sections({ fresh: true })).get(id);
    if (!section) throw Object.assign(new Error(`No section "${id}" on this site.`), { status: 404 });
    return section;
  };

  const findEntity = (stored, id) => {
    const entity = stored.entities.find(item => item?.id === id);
    if (!entity) throw Object.assign(new Error('No card with that id in this section.'), { status: 404 });
    return entity;
  };

  /**
   * A section's card list, as published. Read to check that a card really is in the section a
   * request names — the state object holds ids, and an id nobody published is a typo, not a card.
   */
  async function sectionStored(section) {
    const got = await bucket.getJson(keyOf(section.id, 'workspace.json'));
    if (!Array.isArray(got?.value?.entities)) throw new Error('That section has no card list.');
    return got.value;
  }

  /** Every file a new section starts with: the shared template, plus its own card list. */
  async function newSectionFiles(id, name, hidden = false) {
    const files = [{ key: keyOf(id, 'workspace.json'), content: `${JSON.stringify({ name, ...(hidden ? { hidden: true } : {}), entities: [] }, null, 2)}\n` }];
    if (hidden) return files;                          // data, not cards: no template files
    const walk = async dir => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        // The template's two sample cards and the pages listing them show the formats in the app;
        // a new section starts empty.
        if (dir === templateDir && (entry.name.startsWith('sample-') || ['categories', 'index.md'].includes(entry.name))) continue;
        if (entry.isDirectory()) {
          if (['_site', '.jekyll-cache', '.git', 'node_modules'].includes(entry.name)) continue;
          await walk(full);
          continue;
        }
        const relative = path.relative(templateDir, full).split(path.sep).join('/');
        if (relative === 'workspace.json') continue;        // generated above, with the name in it
        files.push({ key: keyOf(id, relative), content: await readFile(full) });
      }
    };
    try {
      await stat(templateDir);
      await walk(templateDir);
    } catch {
      throw Object.assign(new Error('This site has no section template, so it cannot make one.'), { status: 503 });
    }
    return files;
  }

  /** Stream one object of a section to the browser, headers and all. */
  async function serve(request, response, id, file, { sandboxed = false } = {}) {
    const clean = cleanPath(file);
    if (!clean) throw Object.assign(new Error('Not found'), { status: 404 });
    await findSection(id);
    let object;
    try {
      object = await bucket.get(keyOf(id, clean), { ifNoneMatch: request.headers['if-none-match']?.replace(/^"|"$/g, '') });
    } catch (error) {
      if (error.status === 404) throw Object.assign(new Error('Not found'), { status: 404 });
      throw Object.assign(new Error(`The cards bucket did not answer: ${error.message}`), { status: 502 });
    }
    const headers = {
      'Content-Type': object.contentType || contentTypeOf(clean),
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      // With a content host, a /w/ file the app host still serves (a frame request an old browser sent without
      // Sec-Fetch-Dest, a cached copy) may not be framed by another origin: that would run it as the app.
      ...(sandboxed ? { 'Content-Security-Policy': CONTENT_CSP } : contentHost ? { 'Content-Security-Policy': "frame-ancestors 'self'" } : {}),
      ...(object.etag ? { ETag: `"${object.etag}"` } : {}),
      ...(object.lastModified ? { 'Last-Modified': object.lastModified } : {}),
    };
    if (object.status === 304) {
      object.body?.cancel?.();
      response.writeHead(304, headers);
      return response.end();
    }
    if (object.size) headers['Content-Length'] = object.size;
    response.writeHead(200, headers);
    if (request.method === 'HEAD' || !object.body) { object.body?.cancel?.(); return response.end(); }
    // pipeline, not pipe: a body error or a client that leaves ends this one response and never throws on the process.
    pipeline(Readable.fromWeb(object.body), response, () => {});
  }

  const contentHost = contentOrigin ? new URL(contentOrigin).host : '';
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://site');
      const route = url.pathname.replace(/^\/api(?=\/|$)/, '');
      const reading = request.method === 'GET' || request.method === 'HEAD';
      // The content host shows card files and nothing else: no /api, no sites.json, no writes.
      const onContentHost = !!contentHost && String(request.headers.host ?? '').toLowerCase() === contentHost.toLowerCase();
      if (onContentHost && !(reading && url.pathname.startsWith('/w/'))) return json(response, 404, { error: 'Not found' });
      const signedIn = String(request.headers['remote-user'] ?? '').trim() !== '';

      // The Asks bot's two routes carry a bearer token, not Remote-User, so they come before the sign-in
      // check. Whatever they are sent, they end here: nothing falls through to a route that could read the header.
      if (route === '/hub/discord' || route.startsWith('/hub/discord/')) {
        if (hub) await hub.handleDiscord({ request, response, method: request.method, route });
        else json(response, 404, { error: 'Not found' });
        return;
      }

      if (requireRemoteUser && !reading && !signedIn) {
        return json(response, 401, { error: 'Writes need a signed-in user (Remote-User).' });
      }

      // A write comes from this site's own pages and says so in JSON. A page an agent wrote lives on
      // another origin (or an opaque one), and a form post from anywhere sends text or form types.
      if (!reading && request.method !== 'OPTIONS' && (requireRemoteUser || allowedOrigins)) {
        const origins = allowedOrigins ?? [];
        if (!origins.length) return json(response, 403, { error: 'No allowed origin is configured (BUW_SITE_URL or BUW_SITE_ORIGINS is missing or malformed), so writes are off.' });
        if (!origins.includes(String(request.headers.origin ?? ''))) {
          return json(response, 403, { error: "Writes come only from this site's own pages." });
        }
        const type = String(request.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
        if (type !== 'application/json') return json(response, 415, { error: 'Send JSON.' });
      }

      // The site list the UI loads first: one entry per section in the bucket.
      if (reading && route === '/sites.json') {
        return json(response, 200, [...(await sections()).values()]);
      }

      // A section's files, straight from the bucket.
      const served = reading && /^\/w\/([^/]+)\/(.+)$/.exec(route);
      if (served) {
        if (!bucket) throw Object.assign(new Error(reason), { status: 503 });
        return await serve(request, response, decodeURIComponent(served[1]), decodeURIComponent(served[2]), { sandboxed: onContentHost });
      }

      if (request.method === 'GET' && route === '/capabilities') {
        const known = await sections();
        let template = true;
        try { await stat(templateDir); } catch { template = false; }
        if (requireRemoteUser && !signedIn) {
          return json(response, 200, {
            write: false,
            create: false,
            cards: false,
            sections: [...known.keys()],
            store: cards.kind,
            ...(hub?.capabilities({ signedIn, requireRemoteUser }) ?? { hub: false, chat: false }),
            cardApi: cardApi || null,
            contentOrigin: contentOrigin || null,
            ...(dev ? { dev: await devInfo() } : {}),
            reason: siteUrl ? `Read-only here: sign in at ${siteUrl} to change cards.` : 'Read-only here: sign in to change cards.',
          });
        }
        return json(response, 200, {
          // The UI shows the pin and archive controls when this is true.
          write: !!bucket && known.size > 0,
          // Starting a section is a few puts into the bucket; it needs the template to copy.
          create: !!bucket && template,
          // Making cards and editing their Markdown sections: puts into a section that exists.
          cards: !!bucket && known.size > 0,
          // The Trash empties itself after 30 days (card-purge.mjs).
          purge: !!bucket && known.size > 0,
          sections: [...known.keys()],
          store: cards.kind,
          cardApi: cardApi || null,
          contentOrigin: contentOrigin || null,
          ...(dev ? { dev: await devInfo() } : {}),
          ...(hub?.capabilities({ signedIn, requireRemoteUser }) ?? { hub: false, chat: false }),
          ...(reason ? { reason } : {}),
        });
      }

      // The Hub (hub.mjs) reads its own bodies, because their limits differ per route.
      if (hub && route.startsWith('/hub/')) {
        const user = String(request.headers['remote-user'] ?? '').trim() || null;
        if (await hub.handle({ request, response, method: request.method, route, query: url.searchParams, user, requireRemoteUser })) return;
      }

      // What the page overlays onto the workspace.json files: one object, every card that has
      // been pinned, tagged or put away, keyed "<section>/<card>".
      if (request.method === 'GET' && route === '/card-state') {
        return json(response, 200, { cards: await cards.all() });
      }

      const writerFor = async (id, { target = false } = {}) => {
        const section = await findSection(id);
        // A card moves only into a workspace that lists cards: not the Inbox or another hidden one.
        if (target && (section.hidden || /^inbox/.test(section.id))) throw Object.assign(new Error(`"${section.name}" does not take cards.`), { status: 409 });
        const found = section.id;
        return cardWriter(bucketStore(bucket, keyOf(found, '').replace(/\/$/, '')), { section: found });
      };
      if (request.method === 'GET' && (route === '/cards/markdown' || route === '/cards/drawing' || route === '/cards/responses')) {
        if (!bucket) throw Object.assign(new Error(reason), { status: 503 });
        const answer = await cardRoute({ method: 'GET', route, query: url.searchParams, data: {}, writerFor });
        return json(response, answer.status, answer.body);
      }

      if (request.method !== 'POST') throw Object.assign(new Error('Not found'), { status: 404 });
      if (!bucket) throw Object.assign(new Error(reason), { status: 503 });
      const data = await body(request, route === '/cards/drawing' ? 8 * 1024 * 1024 : route === '/cards/markdown' ? 2 * 1024 * 1024 : route === '/cards/responses' ? 5 * 1024 * 1024 : undefined);

      if (route.startsWith('/cards') || route.startsWith('/workspace/')) {
        // /workspace/pins crosses sections and names each one per pin; the app sends no top-level workspace.
        if (route === '/workspace/pins') {
          if (Array.isArray(data.list)) for (const item of data.list) mayWrite(item?.workspace ?? data.workspace);
        } else mayWrite(data.workspace);
        if (route === '/cards/move') mayWrite(data.to);
      }
      const card = await cardRoute({ method: 'POST', route, query: url.searchParams, data, writerFor, state: cards });
      if (card) return json(response, card.status, card.body);

      // Archiving, pinning and tagging write the state object and answer at once. The card's files
      // are untouched; only which cards you keep in front of you changed.
      if (route === '/workspace/status') {
        if (!STATUSES.includes(data.status)) throw new Error('Unknown card status');
        const section = await findSection(data.workspace);
        findEntity(await sectionStored(section), data.id);
        const state = await cards.setStatus(section.id, data.id, data.status);
        return json(response, 200, { id: data.id, status: state.status, updated: state.restoredAt });
      }

      if (route === '/workspace/pin') {
        if (typeof data.pinned !== 'boolean') throw new Error('Say whether the card is pinned.');
        if (data.order !== undefined && !(Number.isInteger(data.order) && data.order >= 0)) {
          throw new Error('A pin position is a whole number from 0.');
        }
        const section = await findSection(data.workspace);
        findEntity(await sectionStored(section), data.id);
        const state = await cards.setPinned(section.id, data.id, data.pinned, data.order);
        return json(response, 200, { id: data.id, pinned: !!state.pinned, pinOrder: state.pinOrder });
      }

      if (route === '/workspace/tags') {
        if (!Array.isArray(data.tags) || data.tags.some(tag => typeof tag !== 'string')) throw new Error('Tags are a list of strings.');
        const section = await findSection(data.workspace);
        findEntity(await sectionStored(section), data.id);
        const state = await cards.setTags(section.id, data.id, data.tags);
        return json(response, 200, { id: data.id, tags: state.tags ?? [] });
      }

      if (route === '/workspace/icon') {
        if (!validEmoji(data.emoji)) throw new Error('An icon is one emoji, or empty to go back to the card’s own.');
        const section = await findSection(data.workspace);
        findEntity(await sectionStored(section), data.id);
        const state = await cards.setEmoji(section.id, data.id, data.emoji);
        return json(response, 200, { id: data.id, emoji: state.emoji ?? null });
      }

      if (route === '/workspace/pins') {
        const list = Array.isArray(data.list) ? data.list : null;
        if (!list?.length) throw new Error('Say which cards are pinned, in order.');
        // The pinned list crosses sections; each one keeps its own cards' positions.
        const bySection = new Map();
        for (const [index, item] of list.entries()) {
          if (!item?.id) throw new Error('Every pinned card needs an id.');
          const where = item.workspace ?? data.workspace;
          if (!bySection.has(where)) bySection.set(where, []);
          bySection.get(where).push({ id: item.id, order: index });
        }
        const ordered = [];
        for (const [id, items] of bySection) {
          const section = await findSection(id);
          const stored = await sectionStored(section);
          for (const item of items) {
            findEntity(stored, item.id);
            ordered[item.order] = { id: item.id, workspace: section.id };
          }
        }
        // One pass over the whole list, so the positions it writes are the positions the UI sent.
        const pins = await cards.setPins(ordered.filter(Boolean));
        return json(response, 200, { pins });
      }

      if (route === '/sections') {
        // A new section is a folder in the bucket: the shared template, and an empty card list
        // carrying its name. It is on the site as soon as the puts land.
        const name = String(data.name ?? '').trim();
        if (!name) throw new Error('A section needs a name.');
        const id = slugify(name);
        if (!id) throw new Error('That name has no letters or digits in it.');
        if (RESERVED.has(id)) throw new Error(`"${id}" is reserved; pick another name.`);
        mayWrite(id);
        if ((await sections({ fresh: true })).has(id)) throw Object.assign(new Error(`A section called "${id}" is already here.`), { status: 409 });
        const files = await newSectionFiles(id, name, data.hidden === true);
        // The card list goes first, and only if nothing is there: two taps on "create" make one section.
        try {
          await bucket.put(files[0].key, files[0].content, { contentType: 'application/json', ifNoneMatch: '*' });
        } catch (error) {
          if (error.status === 412) throw Object.assign(new Error(`A section called "${id}" is already here.`), { status: 409 });
          throw error;
        }
        await Promise.all(files.slice(1).map(file => bucket.put(file.key, file.content)));
        sectionsCache = null;
        return json(response, 201, { id, name, path: `${prefix}/${id}`, files: files.length });
      }

      throw Object.assign(new Error('Not found'), { status: 404 });
    } catch (error) {
      if (response.headersSent) return response.end();
      json(response, error.status || 400, { error: error.message, ...(error.current !== undefined ? { current: error.current } : {}) });
    }
  });

  return server;
}
