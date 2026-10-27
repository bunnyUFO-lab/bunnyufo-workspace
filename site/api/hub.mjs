// The Hub: Asks, requests, events, Beads copies and drawings, read from and written to the
// `inbox` section of the cards bucket (`sections/inbox/…`). The published site and the local
// service mount the same code over their own bucket client, so a phone and the PC see one inbox.
//
// Every key this module touches is built by `inboxKey`, which is the whole write boundary: it
// refuses anything outside the six folders the Hub owns, anything with `..` or a hidden segment,
// and anything that looks like a secret. The routes are documented in docs/workspaces.md.
//
// State is derived, never stored: an Ask's state is which files exist next to it, and Today and
// the Inbox are computed from a seven-day window of event files. Event files, ask.json and
// request.json are create-only and so never change; they are cached by key.
import { Readable } from 'node:stream';
import { S3Error, contentTypeOf } from './s3.mjs';
import { checkDrawing } from './card-writes.mjs';
import {
  DAY, WHEN, askItem, askState, buildInbox, buildToday, canAnswer, checkAnswer, INBOX_FILTERS, monthPrefixes, newDrawingId,
  newRequestId, randomId, requestItem, requestState, REVIEW_FILE_RE, reviewDone, titleCase, validDrawingId, validId, validProject, windowDays, WINDOW_DAYS,
} from './hub-model.mjs';
import { buildMap } from './hub-map.mjs';
import { createChat, isChatRoute } from './hub-chat.mjs';

const FOLDERS = ['asks', 'requests', 'events', 'beads', 'drawings', 'chat'];
// Copied from site/card-api/handler.mjs (SECRET), applied to each segment on its own: the card API
// applies it to a whole path, where an Ask whose id mentions a token would be refused as a file.
const SECRET = /(^|\/)(\.env(\..*)?|.*\.(pem|key|p12|pfx)|id_(rsa|ed25519)(\.pub)?|.*(secret|credential|password|token).*\.(json|txt|ya?ml))$/i;

const MB = 1024 * 1024;
const LIMITS = { big: 8 * MB, chat: 64 * 1024, transcribe: 2 * MB, small: 256 * 1024 };
const CACHE_MAX = 5000;
const EVENT_CAP = 2000;
const POOL = 16;

const fail = (message, status = 400, extra) => Object.assign(new Error(message), { status, ...(extra ? { extra } : {}) });

/**
 * The only way this module names a key: `<prefix>/inbox/<rel>`. `rel` has no empty, `..`, dot or
 * underscore-led segment, starts in one of the Hub's folders, and names no secret-looking file.
 */
export function inboxKey(rel, prefix = 'sections') {
  const text = String(rel ?? '');
  const segments = text.split('/');
  if (!text || segments.some(part => !part || part === '..' || part.startsWith('.') || part.startsWith('_') || /[\\\0]/.test(part))) {
    throw fail('That path is not in the inbox.', 400);
  }
  if (!FOLDERS.includes(segments[0]) || segments.length < 2) throw fail('That path is not in the inbox.', 400);
  if (segments.some(part => SECRET.test(part))) throw fail('That file looks like a secret.', 400);
  return `${prefix}/inbox/${text}`;
}

/** Run `fn` over `items`, at most `size` at a time, keeping the order of the results. */
export async function pool(size, items, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
  return results;
}

const json = (response, status, body) => {
  const text = JSON.stringify(body);
  response.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text), 'Cache-Control': 'no-store' });
  response.end(text);
};

async function readBody(request, limit) {
  if (Number(request.headers['content-length']) > limit) throw fail('That is too large.', 413);
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw fail('That is too large.', 413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(request, limit) {
  const buffer = await readBody(request, limit);
  if (!buffer.length) return {};
  try {
    const value = JSON.parse(buffer.toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
    return value;
  } catch {
    throw fail('Expected JSON.');
  }
}

const sendTime = value => (typeof value === 'string' && !Number.isNaN(new Date(value).getTime()) ? new Date(value) : null);

/**
 * @param bucket   an s3.mjs bucket (null: the Hub is off)
 * @param prefix   where the sections are in it
 * @param enabled  `HUB=1` on the site, bucket-and-not-`HUB=0` on the local service
 * @param env      the merged environment (the chat routes read HERMES_* and STT_* from it)
 */
export function createHub({ bucket = null, prefix = 'sections', enabled = false, env = {}, fetchImpl = fetch, now = () => new Date() } = {}) {
  const on = !!enabled && !!bucket;
  const key = rel => inboxKey(rel, prefix);
  const cache = new Map();
  const remember = (name, value) => {
    cache.set(name, value);
    while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  };

  /** A create-only JSON file, through the cache; null when it is missing or not JSON. */
  async function cached(rel) {
    const name = key(rel);
    if (cache.has(name)) return cache.get(name);
    const got = await bucket.getText(name);
    if (!got) return null;
    let value;
    try { value = JSON.parse(got.text); } catch { return null; }
    remember(name, value);
    return value;
  }

  /** A JSON file that can change, with its etag; null when missing. Never cached. */
  async function fresh(rel) {
    const got = await bucket.getText(key(rel));
    if (!got) return null;
    try { return { value: JSON.parse(got.text), etag: got.etag, text: got.text }; } catch { return { value: null, etag: got.etag, text: got.text }; }
  }

  const exists = async rel => {
    try { await bucket.head(key(rel)); return true; } catch (error) { if (error.status === 404) return false; throw error; }
  };

  /** The key of a folder of the Hub, with its trailing slash; `inboxKey` checks the name. */
  const folder = root => `${key(`${root}/x`).slice(0, -1)}`;

  const listFolders = async (root, at) => {
    const found = new Map();
    for (const month of monthPrefixes(at)) {
      const { objects } = await bucket.list(key(`${root}/${month}`));
      for (const object of objects) {
        const [id, file] = object.key.slice(folder(root).length).split('/');
        if (!id || !file) continue;
        if (!found.has(id)) found.set(id, new Set());
        found.get(id).add(file);
      }
    }
    return found;
  };

  async function loadAsks(at) {
    const folders = await listFolders('asks', at);
    const rows = await pool(POOL, [...folders], async ([id, names]) => {
      if (!names.has('ask.json') || !validId(id)) return null;
      const ask = await cached(`asks/${id}/ask.json`);
      if (!ask || typeof ask.question !== 'string') return null;
      const snooze = names.has('snooze.json') ? (await fresh(`asks/${id}/snooze.json`))?.value : null;
      const state = askState(names, ask, at, snooze);
      return { ask: { ...ask, id }, names, state, item: askItem({ ...ask, id }, state) };
    });
    return rows.filter(Boolean);
  }

  async function loadRequests(at) {
    const folders = await listFolders('requests', at);
    const rows = await pool(POOL, [...folders], async ([id, names]) => {
      if (!names.has('request.json') || !validId(id)) return null;
      const request = await cached(`requests/${id}/request.json`);
      if (!request || typeof request.text !== 'string') return null;
      const taken = names.has('taken.json') ? await cached(`requests/${id}/taken.json`) : null;
      return requestItem({ ...request, id }, requestState(names), taken);
    });
    return rows.filter(Boolean);
  }

  /** The last `days` UTC days of events, newest first, capped. */
  async function loadEvents(at, days = WINDOW_DAYS) {
    const names = [];
    for (const day of windowDays(at, days)) {
      const { objects } = await bucket.list(key(`events/${day}`) + '/');
      for (const object of objects) {
        const file = object.key.split('/').pop();
        if (file.endsWith('.json')) names.push({ day, file });
      }
    }
    names.sort((a, b) => (a.day === b.day ? (a.file < b.file ? 1 : -1) : a.day < b.day ? 1 : -1));
    const truncated = names.length > EVENT_CAP;
    const kept = names.slice(0, EVENT_CAP);
    const events = (await pool(POOL, kept, async ({ day, file }) => {
      const event = await cached(`events/${day}/${file}`);
      if (!event || typeof event.ts !== 'string' || typeof event.kind !== 'string') return null;
      return { ...event, file };
    })).filter(Boolean);
    events.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : a.file < b.file ? 1 : -1));
    return { events, truncated };
  }

  async function loadBeads(project) {
    const meta = (await fresh(`beads/${project}.meta.json`))?.value ?? null;
    const got = await bucket.getText(key(`beads/${project}.jsonl`));
    const issues = [];
    for (const line of (got?.text ?? '').split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const issue = JSON.parse(line);
        if (issue && typeof issue === 'object' && (issue._type === undefined || issue._type === 'issue') && typeof issue.id === 'string') issues.push(issue);
      } catch { /* a bad line is skipped */ }
    }
    return { meta, issues };
  }

  const stale = what => fail(`This ${what} changed while you were looking; reload and try again.`, 409);

  async function askFolder(id) {
    if (!validId(id)) throw fail('No such Ask.', 404);
    const { objects } = await bucket.list(key(`asks/${id}`) + '/');
    const names = new Set(objects.map(object => object.key.split('/').pop()));
    if (!names.has('ask.json')) throw fail('No such Ask.', 404);
    const ask = await cached(`asks/${id}/ask.json`);
    if (!ask) throw fail('No such Ask.', 404);
    return { ask: { ...ask, id }, names };
  }

  async function askDetail(id, at) {
    const { ask, names } = await askFolder(id);
    const snooze = names.has('snooze.json') ? (await fresh(`asks/${id}/snooze.json`))?.value : null;
    const state = askState(names, ask, at, snooze);
    const read = async name => (names.has(name) ? cached(`asks/${id}/${name}`) : undefined);
    const [answer, pickup, cancel] = await Promise.all([read('answer.json'), read('pickup.json'), read('cancel.json')]);
    return {
      ...ask, ...state,
      ...(answer ? { answer } : {}), ...(pickup ? { pickup } : {}), ...(cancel ? { cancel } : {}),
      files: [...names].sort(),
    };
  }

  async function putCreateOnly(rel, body, contentType, conflict) {
    try {
      return await bucket.put(key(rel), body, { contentType, ifNoneMatch: '*' });
    } catch (error) {
      if (error.status === 412) throw conflict;
      throw error;
    }
  }

  // A drawing file left behind by an answer that never got its answer.json is only meaningful once the
  // create-only answer.json names it, so it can be overwritten. If answer.json exists, the Ask is answered.
  async function putDrawingFile(id, name, body, contentType) {
    try {
      await bucket.put(key(`asks/${id}/${name}`), body, { contentType, ifNoneMatch: '*' });
    } catch (error) {
      if (error.status !== 412) throw error;
      if (await exists(`asks/${id}/answer.json`)) {
        const existing = await fresh(`asks/${id}/answer.json`);
        throw fail('This Ask was answered while you were drawing.', 409, { answer: existing?.value ?? null });
      }
      await bucket.put(key(`asks/${id}/${name}`), body, { contentType });
    }
  }

  async function answerAsk(id, data, user, at, response) {
    if (await exists(`asks/${id}/answer.json`)) {
      const existing = await fresh(`asks/${id}/answer.json`);
      throw fail('This Ask is already answered.', 409, { answer: existing?.value ?? null });
    }
    const { ask, names } = await askFolder(id);
    const snooze = names.has('snooze.json') ? (await fresh(`asks/${id}/snooze.json`))?.value : null;
    const { state } = askState(names, ask, at, snooze);
    if (!canAnswer(state)) {
      throw fail(state === 'expired' ? `This Ask is expired: it ran out at ${ask.expiresAt}.` : `This Ask is ${state.replace('-', ' ')}.`, 409);
    }
    checkAnswer(ask, data);
    const checked = data.drawing ? checkDrawing({ scene: data.drawing.scene, png: data.drawing.png }) : null;
    const answer = { at: at.toISOString(), by: user || 'local' };
    if (data.choice) answer.choice = data.choice;
    if (data.note) answer.note = data.note;
    if (checked) {
      // The drawing first, so an agent never sees an answer.json that points at a missing picture.
      await putDrawingFile(id, 'answer.excalidraw', checked.sceneText, 'application/json');
      await putDrawingFile(id, 'answer.png', checked.pngBuffer, 'image/png');
      answer.drawing = { excalidraw: 'answer.excalidraw', png: 'answer.png' };
    }
    try {
      await bucket.put(key(`asks/${id}/answer.json`), `${JSON.stringify(answer, null, 2)}\n`, { contentType: 'application/json', ifNoneMatch: '*' });
    } catch (error) {
      if (error.status !== 412) throw error;
      const existing = await fresh(`asks/${id}/answer.json`);
      throw fail('This Ask is already answered.', 409, { answer: existing?.value ?? null });
    }
    cache.delete(key(`asks/${id}/answer.json`));
    return { status: 201, body: { state: 'answered', answer } };
  }

  async function snoozeAsk(id, data, user, at) {
    const { ask, names } = await askFolder(id);
    const current = names.has('snooze.json') ? (await fresh(`asks/${id}/snooze.json`))?.value : null;
    const { state } = askState(names, ask, at, current);
    if (!canAnswer(state)) throw fail(`This Ask is ${state.replace('-', ' ')}.`, 409);
    const hours = data.hours === undefined ? 1 : Number(data.hours);
    if (!Number.isInteger(hours) || hours < 1 || hours > 24) throw fail('Snooze for 1 to 24 whole hours.');
    const until = new Date(at.getTime() + hours * 3600_000).toISOString();
    const body = `${JSON.stringify({ at: at.toISOString(), by: user || 'local', until }, null, 2)}\n`;
    for (let attempt = 0; ; attempt += 1) {
      const existing = await fresh(`asks/${id}/snooze.json`);
      try {
        await bucket.put(key(`asks/${id}/snooze.json`), body, { contentType: 'application/json', ...(existing ? { ifMatch: existing.etag } : { ifNoneMatch: '*' }) });
        return { status: 200, body: { state: 'snoozed', snoozedUntil: until } };
      } catch (error) {
        if (error.status !== 412 || attempt >= 1) throw error.status === 412 ? stale('snooze') : error;
      }
    }
  }

  async function cancelAsk(id, user, at) {
    await askFolder(id);
    await putCreateOnly(`asks/${id}/cancel.json`, `${JSON.stringify({ at: at.toISOString(), by: user || 'local' }, null, 2)}\n`, 'application/json', fail('This Ask is already cancelled.', 409));
    return { status: 200, body: { state: 'cancelled' } };
  }

  /** Hide one review in Needs you by writing a `review-done` event that names it; a second call writes nothing. */
  async function markReviewDone(id, user, at) {
    const missing = () => fail('No such review.', 404);
    if (!REVIEW_FILE_RE.test(id)) throw missing();
    const { events } = await loadEvents(at);
    const review = events.find(event => event.kind === 'ready-for-review' && event.file === id);
    if (!review) throw missing();
    if (events.some(event => event.kind === 'review-done' && event.review === id)) return { status: 200, body: { state: 'done' } };
    const body = `${JSON.stringify(reviewDone({ review: id, event: review, user, at }), null, 2)}
`;
    const stamp = at.toISOString();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const clash = fail('Could not find a free name; try again.', 409);
      const name = `${stamp.slice(11, 19).replace(/:/g, '')}-hub-${randomId(4)}.json`;
      try {
        await putCreateOnly(`events/${stamp.slice(0, 10)}/${name}`, body, 'application/json', clash);
        return { status: 201, body: { state: 'done' } };
      } catch (error) {
        if (error !== clash || attempt === 2) throw error;
      }
    }
    throw fail('Could not find a free name; try again.', 409);
  }

  async function createRequest(data, user, at) {
    if (!validProject(data.project)) throw fail('Name the project (lower-case letters, digits and dashes).');
    const text = typeof data.text === 'string' ? data.text.trim() : '';
    if (!text || text.length > 4000) throw fail('A request is 1 to 4000 characters.');
    if (!WHEN.includes(data.when)) throw fail('Say when: next-sprint, nightly or record.');
    const checked = data.drawing ? checkDrawing({ scene: data.drawing.scene, png: data.drawing.png }) : null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const id = newRequestId(data.project, text, at);
      const clash = fail('Could not find a free id; try again.', 409);
      try {
        const request = { id, project: data.project, createdAt: at.toISOString(), by: user || 'local', text, when: data.when };
        if (checked) {
          await putCreateOnly(`requests/${id}/request.excalidraw`, checked.sceneText, 'application/json', clash);
          await putCreateOnly(`requests/${id}/request.png`, checked.pngBuffer, 'image/png', clash);
          request.drawing = { excalidraw: 'request.excalidraw', png: 'request.png' };
        }
        await putCreateOnly(`requests/${id}/request.json`, `${JSON.stringify(request, null, 2)}\n`, 'application/json', clash);
        return { status: 201, body: { id } };
      } catch (error) {
        if (error !== clash || attempt === 2) throw error;
      }
    }
    throw fail('Could not find a free id; try again.', 409);
  }

  async function projects(at) {
    const found = new Map();
    const add = (id, patch = {}) => {
      if (!validProject(id)) return;
      found.set(id, { id, name: titleCase(id), beads: false, ...found.get(id), ...patch });
    };
    const { objects } = await bucket.list(folder('beads'));
    await pool(POOL, objects.filter(object => object.key.endsWith('.meta.json')), async object => {
      const id = object.key.split('/').pop().replace(/\.meta\.json$/, '');
      const meta = (await fresh(`beads/${id}.meta.json`))?.value;
      add(id, { beads: true, ...(meta?.pushedAt ? { pushedAt: meta.pushedAt } : {}) });
    });
    const [asks, requests, window] = await Promise.all([loadAsks(at), loadRequests(at), loadEvents(at)]);
    for (const row of asks) add(row.ask.project);
    for (const item of requests) add(item.project);
    for (const event of window.events) add(event.project);
    return [...found.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
  }

  async function serveFile(response, rel) {
    const segments = String(rel ?? '').split('/');
    if (segments.length !== 3 || !['asks', 'requests', 'drawings'].includes(segments[0])) throw fail('That file is not served.', 400);
    let object;
    try {
      object = await bucket.get(key(rel));
    } catch (error) {
      if (error.status === 404) throw fail('Not found', 404);
      throw error;
    }
    const headers = {
      'Content-Type': contentTypeOf(rel),
      'Cache-Control': 'private, max-age=300',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "sandbox; default-src 'none'; img-src 'self' data:",
      ...(object.etag ? { ETag: `"${object.etag}"` } : {}),
      ...(object.size ? { 'Content-Length': object.size } : {}),
    };
    response.writeHead(200, headers);
    if (!object.body) return response.end();
    Readable.fromWeb(object.body).pipe(response);
  }

  async function drawingList() {
    const { objects } = await bucket.list(folder('drawings'));
    const found = new Map();
    for (const object of objects) {
      const [id, file] = object.key.slice(folder('drawings').length).split('/');
      if (!validDrawingId(id)) continue;
      const row = found.get(id) ?? { id, updated: '', hasPng: false };
      if (file === 'drawing.excalidraw') row.updated = object.lastModified ? new Date(object.lastModified).toISOString() : row.updated;
      if (file === 'drawing.png') row.hasPng = true;
      found.set(id, row);
    }
    return [...found.values()].filter(row => row.updated).sort((a, b) => (a.updated < b.updated ? 1 : -1)).slice(0, 20);
  }

  async function saveDrawingNew(data, at) {
    const checked = checkDrawing({ scene: data.scene, png: data.png });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const id = newDrawingId(at);
      try {
        const written = await bucket.put(key(`drawings/${id}/drawing.excalidraw`), checked.sceneText, { contentType: 'application/json', ifNoneMatch: '*' });
        await bucket.put(key(`drawings/${id}/drawing.png`), checked.pngBuffer, { contentType: 'image/png' });
        return { status: 201, body: { id, etag: written.etag } };
      } catch (error) {
        if (error.status !== 412 || attempt === 2) throw error;
      }
    }
    throw fail('Could not find a free id; try again.', 409);
  }

  async function saveDrawingOld(id, data) {
    if (!validDrawingId(id)) throw fail('No such drawing.', 404);
    const checked = checkDrawing({ scene: data.scene, png: data.png });
    const rel = `drawings/${id}/drawing.excalidraw`;
    const current = await fresh(rel);
    if (!current) throw fail('No such drawing.', 404);
    const conflict = latest => fail('This drawing changed since you opened it.', 409, { current: latest ? { text: latest.text, etag: latest.etag } : null });
    if ((data.base ?? null) !== current.etag) throw conflict(current);
    let written;
    try {
      written = await bucket.put(key(rel), checked.sceneText, { contentType: 'application/json', ifMatch: current.etag });
    } catch (error) {
      if (error.status !== 412) throw error;
      throw conflict(await fresh(rel));
    }
    try {
      await bucket.put(key(`drawings/${id}/drawing.png`), checked.pngBuffer, { contentType: 'image/png' });
    } catch {
      throw fail('The drawing was saved but its picture was not; save again.', 502);
    }
    return { status: 200, body: { etag: written.etag } };
  }

  const bodyLimit = (method, route) => {
    if (method !== 'POST') return 0;
    if (/^\/hub\/asks\/[^/]+\/answer$/.test(route) || route === '/hub/requests' || route.startsWith('/hub/drawings')) return LIMITS.big;
    if (route === '/hub/chat') return LIMITS.chat;
    if (route === '/hub/transcribe') return LIMITS.transcribe;
    return LIMITS.small;
  };

  const chat = createChat({ env, fetchImpl, key, fresh, bucket, loadAsks, loadRequests, readBody, readJson, json, fail, now });

  const self = {
    enabled: on,
    /** What this host tells the page about the Hub (merged into /api/capabilities). */
    capabilities({ signedIn = true, requireRemoteUser = false } = {}) {
      return { hub: on, ...chat.capabilities({ enabled: on, signedIn, requireRemoteUser }) };
    },
    async handle({ request, response, method, route, query = new URLSearchParams(), user = null, requireRemoteUser = false }) {
      if (!String(route).startsWith('/hub/')) return false;
      try {
        if (!on) throw fail('The Hub is off on this host.', 404);
        if (isChatRoute(route)) { await chat.handle({ request, response, method, route, user, requireRemoteUser }); return true; }
        const at = now();
        const limit = bodyLimit(method, route);
        let match;
        const reply = (answer, status = 200) => json(response, status, answer);
        const send = answer => json(response, answer.status, answer.body);

        if (method === 'GET') {
          if (route === '/hub/today') {
            const [asks, window] = await Promise.all([loadAsks(at), loadEvents(at)]);
            reply(buildToday({ asks: asks.map(row => row.item), events: window.events, now: at }));
          } else if (route === '/hub/inbox') {
            const filter = INBOX_FILTERS.includes(query.get('filter')) ? query.get('filter') : 'needs-you';
            const [asks, requests, window] = await Promise.all([loadAsks(at), loadRequests(at), loadEvents(at)]);
            reply({ items: buildInbox({ filter, asks: asks.map(row => row.item), requests, events: window.events, now: at }) });
          } else if ((match = /^\/hub\/asks\/([^/]+)$/.exec(route))) {
            reply(await askDetail(decodeURIComponent(match[1]), at));
          } else if (route === '/hub/events') {
            const floor = at.getTime() - WINDOW_DAYS * DAY;
            const wanted = sendTime(query.get('since'))?.getTime() ?? at.getTime() - DAY;
            const since = Math.max(wanted, floor);
            const project = query.get('project');
            const window = await loadEvents(at);
            reply({
              events: window.events.filter(event => new Date(event.ts).getTime() >= since && (!project || event.project === project)),
              truncated: window.truncated,
            });
          } else if (route === '/hub/projects') {
            reply({ projects: await projects(at) });
          } else if ((match = /^\/hub\/beads\/([^/]+)$/.exec(route))) {
            if (!validProject(match[1])) throw fail('No such project.', 404);
            reply(await loadBeads(match[1]));
          } else if ((match = /^\/hub\/map\/([^/]+)$/.exec(route))) {
            const project = match[1];
            if (!validProject(project)) throw fail('No such project.', 404);
            const [{ meta, issues }, window, asks] = await Promise.all([loadBeads(project), loadEvents(at), loadAsks(at)]);
            reply(buildMap({
              project, meta, issues, events: window.events,
              asks: asks.map(row => ({ id: row.ask.id, bead: row.ask.bead, state: row.state.state })), now: at,
            }));
          } else if (route === '/hub/file') {
            await serveFile(response, query.get('path'));
          } else if (route === '/hub/drawings') {
            reply({ drawings: await drawingList() });
          } else if ((match = /^\/hub\/drawings\/([^/]+)$/.exec(route))) {
            if (!validDrawingId(match[1])) throw fail('No such drawing.', 404);
            const got = await fresh(`drawings/${match[1]}/drawing.excalidraw`);
            if (!got) throw fail('No such drawing.', 404);
            reply({ text: got.text, etag: got.etag });
          } else {
            throw fail('Not found', 404);
          }
          return true;
        }

        if (method !== 'POST') throw fail('Not found', 404);
        const raw = route === '/hub/transcribe' ? null : await readJson(request, limit);
        if ((match = /^\/hub\/asks\/([^/]+)\/(answer|snooze|cancel)$/.exec(route))) {
          const id = decodeURIComponent(match[1]);
          if (!validId(id)) throw fail('No such Ask.', 404);
          if (match[2] === 'answer') send(await answerAsk(id, raw, user, at));
          else if (match[2] === 'snooze') send(await snoozeAsk(id, raw, user, at));
          else send(await cancelAsk(id, user, at));
        } else if ((match = /^\/hub\/reviews\/([^/]+)\/done$/.exec(route))) {
          send(await markReviewDone(decodeURIComponent(match[1]), user, at));
        } else if (route === '/hub/requests') {
          send(await createRequest(raw, user, at));
        } else if (route === '/hub/drawings') {
          send(await saveDrawingNew(raw, at));
        } else if ((match = /^\/hub\/drawings\/([^/]+)$/.exec(route))) {
          send(await saveDrawingOld(match[1], raw));
        } else {
          throw fail('Not found', 404);
        }
        return true;
      } catch (error) {
        if (response.headersSent) { response.end(); return true; }
        const unreachable = error instanceof S3Error || error instanceof TypeError;
        const status = unreachable ? 502 : error.status || 400;
        const message = unreachable ? `The inbox did not answer: ${error.message}` : error.message;
        json(response, status, { error: message, ...(error.extra ?? {}) });
        return true;
      }
    },
  };
  return self;
}
