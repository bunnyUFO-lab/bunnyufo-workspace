// Pinned, archived, tags and the order of the pinned list: the metadata a click changes.
//
// It used to live in each section's workspace.json, which made every pin a git commit — on the
// site a commit, a push and a redeploy before the page could show it, and in the local app a dirty
// file in a workspace repository nobody meant to edit. A card's *content* is the bucket's business
// (publish uploads it); which cards you keep in front of you is this file's.
//
// One JSON object, keyed "<workspace>/<card>". Writes are serialized through one promise chain,
// because a drag that reorders the pinned list lands as several changes at once.
//
// Two stores with one interface. `createCardStore(file)` keeps the object in a local file, which
// is what the local app without a bucket uses. `createBucketCardStore(bucket)` keeps it as one object
// in the cards bucket (state.json), so a pin made on a phone is the pin the desktop shows: every
// write re-reads the object and puts it back with If-Match on the ETag it read, and a 412 means
// someone else wrote in between, so it reads again and retries.
//
// Both services use this module: the local one imports it from here, and site/api is rsynced
// whole to the server, so it travels with the deploy.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** @typedef {{ pinned?: boolean, pinOrder?: number, status?: 'active'|'archived', restoredAt?: string, tags?: string[], emoji?: string }} CardState */

/** A card icon chosen in the app: one short emoji (a flag or a family is several code points). */
export const validEmoji = value => typeof value === 'string' && [...value.trim()].length <= 12 && !/[<>"'&]/.test(value);

const today = () => new Date().toISOString().slice(0, 10);
export const cardKey = (workspace, id) => `${workspace || ''}/${id}`;

/**
 * Overlay one card's stored state onto the entity the workspace published.
 *
 * The file is the default and the store is the override, so a card that an agent shipped
 * `pinned: true` stays pinned until someone says otherwise here — and everything written into
 * workspace.json before this existed keeps working untouched.
 */
export function applyCardState(entity, state) {
  if (!state) return entity;
  const merged = { ...entity };
  if (state.pinned === true) merged.pinned = true;
  if (state.pinned === false) { delete merged.pinned; delete merged.pinOrder; }
  if (state.pinned !== false && typeof state.pinOrder === 'number') merged.pinOrder = state.pinOrder;
  if (state.status) merged.status = state.status;
  if (Array.isArray(state.tags)) merged.tags = state.tags.filter(tag => typeof tag === 'string');
  // A chosen icon wins over the card's own image and its category's emoji.
  if (typeof state.emoji === 'string' && state.emoji) merged.emoji = state.emoji;
  // Restoring a card counts as a touch: without a fresh date the 7-day rule would put it straight
  // back in the archive. It never moves the date backwards, so a later real edit still wins.
  if (state.restoredAt && (!merged.updated || state.restoredAt > merged.updated)) merged.updated = state.restoredAt;
  return merged;
}

const parseCards = parsed => (parsed && typeof parsed.cards === 'object' && parsed.cards ? parsed.cards : {});

/** One card's entry after a change, with the fields that say nothing dropped; null when empty. */
function merge(current, change) {
  const next = { ...(current ?? {}), ...change };
  // An entry that says nothing is noise in the file and in every read of it.
  for (const [name, value] of Object.entries(next)) if (value === undefined || value === null) delete next[name];
  return Object.keys(next).length ? next : null;
}

/**
 * Move one card's entry from `from` to `to` in `cards` (changed in place). An entry already at `to`
 * is the newer one and wins field by field; the moved entry only fills what it lacks. Returns whether
 * anything changed.
 */
function moveEntry(cards, from, to) {
  if (from === to || !cards[from]) return false;
  const next = merge(cards[from], cards[to] ?? {});
  delete cards[from];
  if (next) cards[to] = next;
  return true;
}

/**
 * The methods both stores share, over a `load()` that returns the cards object and a
 * `write(key, change)` that applies one change and returns the card's new state.
 */
function methods({ load, write }) {
  return {
    /** Every stored card, keyed "<workspace>/<card>". The caller must not mutate it. */
    all: () => load().then(cards => ({ ...cards })),
    get: async (workspace, id) => (await load())[cardKey(workspace, id)] ?? null,

    /** Overlay the store onto a list of entities from one workspace. */
    async decorate(workspace, entities) {
      const cards = await load();
      return entities.map(entity => applyCardState(entity, cards[cardKey(workspace, entity.id)]));
    },

    setStatus(workspace, id, status) {
      // `active` is stored rather than dropped: it is how a card put away by hand comes back,
      // and `restoredAt` is what keeps the date rule from archiving it again on the spot.
      return write(cardKey(workspace, id), { status, restoredAt: status === 'active' ? today() : undefined });
    },

    setPinned(workspace, id, pinned, order) {
      return write(cardKey(workspace, id), {
        pinned,
        pinOrder: pinned && Number.isInteger(order) ? order : undefined,
      });
    },

    /** Tags are free-text labels; an empty list clears them. */
    setTags(workspace, id, tags) {
      const list = Array.isArray(tags) ? [...new Set(tags.map(tag => String(tag).trim()).filter(Boolean))] : [];
      return write(cardKey(workspace, id), { tags: list.length ? list : undefined });
    },

    /** The card's icon, an emoji; an empty one goes back to the card's own. */
    setEmoji(workspace, id, emoji) {
      const value = typeof emoji === 'string' ? emoji.trim() : '';
      return write(cardKey(workspace, id), { emoji: value || undefined });
    },

    /** The whole pinned list in one go: a reorder moves several cards, across workspaces. */
    async setPins(list) {
      const written = [];
      for (const [index, item] of list.entries()) {
        await write(cardKey(item.workspace, item.id), { pinned: true, pinOrder: index });
        written.push({ id: item.id, workspace: item.workspace ?? null, pinOrder: index });
      }
      return written;
    },
  };
}

/** The store as a local JSON file, written with a temp file and a rename so a reader never catches it half-written. */
export function createCardStore(file) {
  let cache = null;
  let writing = Promise.resolve();

  const load = async () => {
    if (cache) return cache;
    try {
      cache = parseCards(JSON.parse(await readFile(file, 'utf8')));
    } catch {
      // Not there yet, or unreadable: an empty store means "nothing overridden", which shows
      // exactly what the workspaces say — the state before any of this was clicked.
      cache = {};
    }
    return cache;
  };

  /** Apply a change to one card and persist the whole store. Returns the card's new state. */
  const write = (key, change) => {
    const done = writing.then(async () => {
      const cards = await load();
      const next = merge(cards[key], change);
      if (next) cards[key] = next; else delete cards[key];
      await mkdir(path.dirname(file), { recursive: true });
      const temporary = `${file}.new`;
      await writeFile(temporary, `${JSON.stringify({ version: 1, cards }, null, 2)}\n`, { mode: 0o644 });
      await rename(temporary, file);
      return cards[key] ?? {};
    });
    // The chain must survive a failed write, or every later one is rejected with its error.
    writing = done.catch(() => {});
    return done;
  };

  /** Re-key one card's entry (a move to another workspace) in one write. */
  const rekey = (from, to) => {
    const done = writing.then(async () => {
      const cards = await load();
      if (!moveEntry(cards, from, to)) return cards[to] ?? null;
      await mkdir(path.dirname(file), { recursive: true });
      const temporary = `${file}.new`;
      await writeFile(temporary, `${JSON.stringify({ version: 1, cards }, null, 2)}\n`, { mode: 0o644 });
      await rename(temporary, file);
      return cards[to] ?? null;
    });
    writing = done.catch(() => {});
    return done;
  };

  return { kind: 'file', file, ...methods({ load, write }), rekey };
}

/**
 * The same store as one object in the cards bucket. Reads are cached for `ttl` ms so a page
 * load is one GET and a drag that reorders ten cards is not ten; every write starts from a
 * fresh read and is conditional on what it read.
 *
 * @param bucket  from s3.mjs
 * @param key     the object; `state.json` at the bucket root, beside `sections/`
 */
export function createBucketCardStore(bucket, { key = 'state.json', ttl = 5000, retries = 3 } = {}) {
  let cache = null;        // { cards, etag, at }
  let writing = Promise.resolve();

  const fetchState = async () => {
    const got = await bucket.getJson(key);
    cache = { cards: got ? parseCards(got.value) : {}, etag: got?.etag ?? null, at: Date.now() };
    return cache;
  };
  const load = async () => (cache && Date.now() - cache.at < ttl ? cache : await fetchState()).cards;

  const write = (cardKey, change) => {
    const done = writing.then(async () => {
      for (let attempt = 1; ; attempt += 1) {
        const { cards, etag } = await fetchState();
        const next = merge(cards[cardKey], change);
        if (next) cards[cardKey] = next; else delete cards[cardKey];
        try {
          const written = await bucket.putJson(key, { version: 1, cards }, etag ? { ifMatch: etag } : { ifNoneMatch: '*' });
          cache = { cards, etag: written.etag, at: Date.now() };
          return cards[cardKey] ?? {};
        } catch (error) {
          // 412: someone else wrote between the read and this put. Read again and reapply.
          if (error.status !== 412 || attempt >= retries) throw error;
        }
      }
    });
    writing = done.catch(() => {});
    return done;
  };

  /** Re-key one card's entry (a move to another workspace) in one conditional write. */
  const rekey = (from, to) => {
    const done = writing.then(async () => {
      for (let attempt = 1; ; attempt += 1) {
        const { cards, etag } = await fetchState();
        if (!moveEntry(cards, from, to)) return cards[to] ?? null;
        try {
          const written = await bucket.putJson(key, { version: 1, cards }, etag ? { ifMatch: etag } : { ifNoneMatch: '*' });
          cache = { cards, etag: written.etag, at: Date.now() };
          return cards[to] ?? null;
        } catch (error) {
          if (error.status !== 412 || attempt >= retries) throw error;
        }
      }
    });
    writing = done.catch(() => {});
    return done;
  };

  return { kind: 'bucket', key, ...methods({ load, write }), rekey };
}
