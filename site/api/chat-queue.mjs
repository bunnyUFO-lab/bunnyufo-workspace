// The chat queue: what the owner typed while a reply was still running, kept in the inbox as
// `chat/queue/<conversation>.json` so a reload, a sleeping phone or a restart of the service loses nothing.
//
//   { v: 1, items: [{ id, text, at, by?, model? }], held: { reason, at } | null, turn: {...} | null, tries?: n }
//
// `items` wait for the running reply to end; then the Hub joins them into one turn (`turn`) and starts it.
// `held` says why nothing goes out by itself: `stopped`, `failed`, `lost` or `long`. `turn` is the run turn in
// progress, a plain one too, so a restart can still finish and save it. `tries` counts failed starts of a delivered turn.
//
// The file is never deleted (the bucket client has no delete); an idle one is `emptyQueue()`.
// Everything here is pure except `createQueueStore`, which reads and writes one file with an etag.

export const QUEUE_LIMITS = { items: 5, chars: 16000, text: 8000, tries: 3 };

/** Unheld messages older than this are held, not delivered: nobody asked for them to go out now. */
export const STALE_MS_DEFAULT = 3600_000;

export const emptyQueue = () => ({ v: 1, items: [], held: null, turn: null });

const HOLD_REASONS = ['stopped', 'failed', 'lost', 'long', 'old'];
const WHY = [...HOLD_REASONS, 'joined'];

/** A queue file as read: anything that is not a queue is an empty one, and an item or a hold with the wrong shape is dropped. */
export function readQueue(value) {
  const queue = emptyQueue();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return queue;
  if (Array.isArray(value.items)) {
    queue.items = value.items
      .filter(item => item && typeof item.id === 'string' && typeof item.text === 'string' && item.text)
      .map(item => ({ id: item.id, text: item.text, at: String(item.at ?? ''), ...(typeof item.by === 'string' ? { by: item.by } : {}), ...(typeof item.model === 'string' ? { model: item.model } : {}), ...(WHY.includes(item.why) ? { why: item.why } : {}) }));
  }
  if (value.held && HOLD_REASONS.includes(value.held.reason)) queue.held = { reason: value.held.reason, at: String(value.held.at ?? '') };
  if (value.turn && typeof value.turn === 'object' && typeof value.turn.key === 'string') queue.turn = value.turn;
  if (Number.isInteger(value.tries) && value.tries > 0) queue.tries = value.tries;
  return queue;
}

/** What a page may see of a queue: the waiting messages and why they are held. */
export const viewOf = queue => ({ queued: queue.items.map(({ id, text, at, model, why }) => ({ id, text, at, ...(model ? { model } : {}), ...(why ? { why } : {}) })), held: queue.held });

/** The queue held for a reason: each waiting message keeps that reason, so a row says why itself however old the hold is. */
export const holdQueue = (queue, reason, at) => ({ ...queue, items: queue.items.map(item => ({ ...item, why: reason })), held: { reason, at } });

/** Whether every waiting message is older than the limit. */
export const tooOld = (items, nowMs, limit = STALE_MS_DEFAULT) => items.length > 0 && items.every(item => nowMs - (Date.parse(item.at) || 0) > limit);

/** Adds one message. `{ error: 'items' | 'chars' }` when a limit is over, else `{ queue }`. */
export function addItem(queue, { id, text, at, by, model }) {
  if (queue.items.length >= QUEUE_LIMITS.items) return { error: 'items' };
  if (queue.items.reduce((sum, item) => sum + item.text.length, 0) + text.length > QUEUE_LIMITS.chars) return { error: 'chars' };
  const item = { id, text, at, ...(by ? { by } : {}), ...(model ? { model } : {}), ...(queue.held ? { why: 'joined' } : {}) };
  return { queue: { ...queue, items: [...queue.items, item] } };
}

/** Removes one message by id; null when it is not there (cancelled twice, or already sent). With nothing left there is nothing to hold. */
export function cancelItem(queue, id) {
  if (!queue.items.some(item => item.id === id)) return null;
  const items = queue.items.filter(item => item.id !== id);
  return { ...queue, items, held: items.length ? queue.held : null };
}

/**
 * The messages as one turn: the texts joined with a blank line, the model of the last one, and who sent it.
 * The returned queue has no items and is no longer held (the owner asked for the send, or the reply ended well).
 */
export function takeItems(queue) {
  const items = queue.items;
  const last = items[items.length - 1];
  return {
    text: items.map(item => item.text).join('\n\n'),
    model: last?.model,
    by: last?.by,
    ids: items.map(item => item.id),
    taken: items,
    queue: { ...queue, items: [], held: null },
  };
}

/** Why a failed reply holds the queue: a stop (the owner's, or Hermes's own) is `stopped`, anything else `failed`. */
export const holdFor = (failure, stopAsked = false) => (stopAsked || failure === 'The run was stopped.' ? 'stopped' : 'failed');

/** Messages put back at the front of a queue, after a start that did not happen. */
export const restoreItems = (queue, items) => ({ ...queue, items: [...items, ...queue.items] });

/**
 * One file per conversation, changed through `update`: read, change, write with the etag (`If-None-Match: *` when new),
 * and read again on a lost race (twice). In this process a promise chain per conversation runs the changes one at a time.
 * `change(queue)` answers `{ queue?, out? }`: a queue to write (skipped when it is the same), and anything for the caller.
 */
export function createQueueStore({ fresh, bucket, key }) {
  const rel = id => `chat/queue/${id}.json`;
  const tails = new Map();

  async function read(id) {
    const got = await fresh(rel(id));
    return { queue: readQueue(got?.value), etag: got?.etag ?? null, exists: !!got };
  }

  async function attempt(id, change) {
    for (let at = 0; ; at += 1) {
      const current = await read(id);
      const result = (await change(current.queue)) ?? {};
      if (!result.queue || JSON.stringify(result.queue) === JSON.stringify(current.queue)) return { queue: current.queue, out: result.out };
      try {
        await bucket.put(key(rel(id)), `${JSON.stringify(result.queue)}\n`, { contentType: 'application/json', ...(current.exists ? { ifMatch: current.etag } : { ifNoneMatch: '*' }) });
        return { queue: result.queue, out: result.out };
      } catch (error) {
        if (error.status !== 412 || at >= 2) throw error;
      }
    }
  }

  return {
    read: async id => (await read(id)).queue,
    update(id, change) {
      const run = (tails.get(id) ?? Promise.resolve()).catch(() => {}).then(() => attempt(id, change));
      tails.set(id, run);
      run.finally(() => { if (tails.get(id) === run) tails.delete(id); }).catch(() => {});
      return run;
    },
  };
}
