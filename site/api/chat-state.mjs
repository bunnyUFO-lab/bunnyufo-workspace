// The state of the Hub's chats: pin, rename, archive, Trash and unread. One owner-only file in the Hub's own inbox,
// `chat/state.json` (it is under `chat/`, which a limited token can't write: `OWNER_FILES` in card-api).
//
//   { v: 1, chats: { "<id>": { title?, pinned?: iso, archived?: iso, trashed?: iso, unread?: true } } }
//
// Nothing is ever moved or deleted: Trash only sets `trashed`, and the transcript stays at `chat/<id>.jsonl`.
// The file does not end in `.jsonl`, so the conversation list and "Last chat" never read it as a chat.
// Everything here is pure except `createChatStateStore`, which reads and writes the one file with an etag.

export const TITLE_MAX = 120;
export const PAGE_DEFAULT = 30;
export const PAGE_MAX = 100;
export const VIEWS = ['active', 'archived', 'trash', 'all'];

export const emptyState = () => ({ v: 1, chats: {} });

const stamp = value => (typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null);

/** One chat's entry as stored: only the known fields with the right shape, or null when nothing is left. */
function readEntry(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entry = {};
  const title = typeof value.title === 'string' ? value.title.trim().slice(0, TITLE_MAX) : '';
  if (title) entry.title = title;
  for (const field of ['pinned', 'archived', 'trashed']) { const at = stamp(value[field]); if (at) entry[field] = at; }
  if (value.unread === true) entry.unread = true;
  return Object.keys(entry).length ? entry : null;
}

/** A state file as read: anything that is not one is an empty state. */
export function readState(value) {
  const state = emptyState();
  if (!value || typeof value !== 'object' || Array.isArray(value) || !value.chats || typeof value.chats !== 'object' || Array.isArray(value.chats)) return state;
  for (const [id, entry] of Object.entries(value.chats)) {
    const read = readEntry(entry);
    if (read) state.chats[id] = read;
  }
  return state;
}

/** What a page may see of one chat's state. */
export const viewOfEntry = entry => ({ title: entry?.title ?? null, pinned: entry?.pinned ?? null, archived: entry?.archived ?? null, trashed: entry?.trashed ?? null, unread: entry?.unread === true });

/** Which list a chat is in: Trash wins over Archived, which wins over the rest. */
export const placeOf = entry => (entry?.trashed ? 'trash' : entry?.archived ? 'archived' : 'active');

const FIELDS = ['title', 'pinned', 'archived', 'trashed', 'unread'];

/**
 * A request body as a patch: `{ error }` for a wrong shape, else `{ patch }`. `pinned`, `archived` and `trashed` take a boolean
 * (true sets the time, false or null clears it); `title` a string up to 120 characters (empty or null clears the rename); `unread` a boolean.
 */
export function checkPatch(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'Send { pinned?, title?, archived?, trashed?, unread? }.' };
  const given = Object.keys(body);
  if (!given.length) return { error: 'Send at least one of pinned, title, archived, trashed, unread.' };
  const unknown = given.find(field => !FIELDS.includes(field));
  if (unknown) return { error: `${unknown} is not a chat state. Send { pinned?, title?, archived?, trashed?, unread? }.` };
  const patch = {};
  for (const field of ['pinned', 'archived', 'trashed', 'unread']) {
    if (!(field in body)) continue;
    const value = body[field];
    if (value !== true && value !== false && value !== null) return { error: `${field} is true or false.` };
    patch[field] = value === true;
  }
  if ('title' in body) {
    if (body.title !== null && typeof body.title !== 'string') return { error: 'title is text, or null to clear a rename.' };
    const title = String(body.title ?? '').replace(/\s+/g, ' ').trim();
    if (title.length > TITLE_MAX) return { error: `A title is at most ${TITLE_MAX} characters.` };
    patch.title = title || null;
  }
  return { patch };
}

/**
 * The entry after a patch, at `at`. Pinning clears Archive and archiving clears the pin. Setting a time already set keeps the first one.
 * Trash keeps the other marks, so Restore puts the chat back where it was.
 */
export function applyPatch(entry, patch, at) {
  const next = { ...(entry ?? {}) };
  if ('title' in patch) { if (patch.title) next.title = patch.title; else delete next.title; }
  for (const field of ['pinned', 'archived', 'trashed']) {
    if (!(field in patch)) continue;
    if (!patch[field]) delete next[field]; else next[field] ??= at;
  }
  if (patch.pinned) delete next.archived;
  if (patch.archived) delete next.pinned;
  if ('unread' in patch) { if (patch.unread) next.unread = true; else delete next.unread; }
  return readEntry(next);
}

/** Entries for a patch: the state with one chat's entry changed (and dropped when nothing is left). */
export function withPatch(state, id, patch, at) {
  const chats = { ...state.chats };
  const entry = applyPatch(chats[id], patch, at);
  if (entry) chats[id] = entry; else delete chats[id];
  return { v: 1, chats };
}

/** How many chats are in each place, over the ids that have a transcript. */
export function countPlaces(ids, state) {
  const counts = { active: 0, archived: 0, trashed: 0 };
  for (const id of ids) { const place = placeOf(state.chats[id]); counts[place === 'trash' ? 'trashed' : place] += 1; }
  return counts;
}

/**
 * The ids of one view, in order, before any page is cut. `chats` is `[{ id, at }]` (`at` is the transcript's time in ms).
 * Active and All list pins first, newest pin first, then the rest newest first. Archived goes by when it was archived, Trash by when
 * it was trashed. All is Active and Archived together for Search: Trash is never in it.
 */
export function orderView(chats, state, view) {
  const by = (a, b) => (b.at - a.at) || (a.id < b.id ? 1 : -1);
  const time = (id, field) => Date.parse(state.chats[id]?.[field]) || 0;
  const place = chat => placeOf(state.chats[chat.id]);
  if (view === 'trash') return chats.filter(chat => place(chat) === 'trash').sort((a, b) => (time(b.id, 'trashed') - time(a.id, 'trashed')) || by(a, b));
  if (view === 'archived') return chats.filter(chat => place(chat) === 'archived').sort((a, b) => (time(b.id, 'archived') - time(a.id, 'archived')) || by(a, b));
  const shown = chats.filter(chat => (view === 'all' ? place(chat) !== 'trash' : place(chat) === 'active'));
  const pinned = shown.filter(chat => state.chats[chat.id]?.pinned).sort((a, b) => (time(b.id, 'pinned') - time(a.id, 'pinned')) || by(a, b));
  return [...pinned, ...shown.filter(chat => !state.chats[chat.id]?.pinned).sort(by)];
}

/** `offset` and `limit` from a query, as whole numbers in range. */
export function pageOf(query) {
  const whole = (value, fallback) => { const number = value === null || value === undefined || value === '' ? NaN : Number(value); return Number.isInteger(number) && number >= 0 ? number : fallback; };
  const limit = Math.min(Math.max(whole(query?.get?.('limit'), PAGE_DEFAULT), 1), PAGE_MAX);
  return { offset: whole(query?.get?.('offset'), 0), limit };
}

/** Run `fn` over `items`, at most `size` at a time, keeping the order of the results. */
export async function pool(size, items, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) { const index = next++; results[index] = await fn(items[index], index); }
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
  return results;
}

/**
 * The one file, changed through `update`: read, change, write with the etag (`If-None-Match: *` when new), and read again on a lost
 * race (twice), like the queue store. A file that is there but not a state is never written over: `update` refuses, so a bad byte
 * can't wipe the owner's pins and names. `change(state)` answers the state to write, or null for no change.
 */
export function createChatStateStore({ fresh, bucket, key, fail }) {
  const rel = 'chat/state.json';
  let tail = Promise.resolve();

  async function read() {
    const got = await fresh(rel);
    if (got && !(got.value && typeof got.value === 'object' && !Array.isArray(got.value))) return { state: emptyState(), etag: got.etag, exists: true, broken: true };
    return { state: readState(got?.value), etag: got?.etag ?? null, exists: !!got, broken: false };
  }

  async function attempt(change) {
    for (let at = 0; ; at += 1) {
      const current = await read();
      if (current.broken) throw fail('The chat state file cannot be read, so it is left alone.', 502);
      const next = await change(current.state);
      if (!next || JSON.stringify(next) === JSON.stringify(current.state)) return current.state;
      try {
        await bucket.put(key(rel), `${JSON.stringify(next)}\n`, { contentType: 'application/json', ...(current.exists ? { ifMatch: current.etag } : { ifNoneMatch: '*' }) });
        return next;
      } catch (error) {
        if (error.status !== 412 || at >= 2) throw error.status === 412 ? fail('The chat state changed while saving; try again.', 409) : error;
      }
    }
  }

  return {
    read: async () => (await read()).state,
    update(change) {
      const run = tail.catch(() => {}).then(() => attempt(change));
      tail = run;
      return run;
    },
  };
}
