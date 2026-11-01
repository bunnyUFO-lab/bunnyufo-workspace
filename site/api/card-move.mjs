// Moving a card to another workspace. The ids and the folder never change, so every link keeps
// working; the card's files are copied (S3 CopyObject on the site, a file copy locally), checked,
// and only then does the card leave the old list. The old files are never deleted.
//
// Every step is safe to repeat, so a move that stopped half way is finished by asking again:
//   1 read both lists          2 list the card's files        3 copy what the target lacks
//   4 verify, re-list, re-copy 5 add the card to the target   6 retire it in the source
//   7 re-key the card's pins, tags and archive state
// `from` and `to` are cardWriters (see card-writes.mjs); their stores need list() and copyFrom().
//
// A big card does not fit in one request, so step 3 works against a time budget (SLICE_MS), copying
// CONCURRENCY files at a time. When the budget runs out the answer is `{ pending: true, progress }`
// (HTTP 202) and the caller asks again; the target's own listing says what is already there, so
// the next call copies only the rest. A progress record (`moves`, one small object per card)
// carries the numbers for a progress bar, and a lease so two tabs do not copy the same files.
// Limits, and why: a copy is an S3 CopyObject, so no bytes pass through this server; what costs time
// is one request per file (about 50 to 150 ms). 5000 files is a few slices and five list pages per
// check; 2 GB keeps one object's server-side copy (the one thing a budget cannot interrupt) to seconds.
import { md5, slug } from './card-writes.mjs';
import { cardKey } from './card-state.mjs';

export const MAX_FILES = 5000;
export const MAX_BYTES = 2 * 1024 * 1024 * 1024;
export const SLICE_MS = 15_000;
export const CONCURRENCY = 8;
const LEASE_MS = 60_000;
const SAVE_EVERY_MS = 700;
const ROUNDS = 3;

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const today = now => now().toISOString().slice(0, 10);
const multipart = etag => String(etag ?? '').includes('-');

/** True when a file in the target is the same as the one listed in the source. */
const same = (a, b) => a && b && a.size === b.size && (multipart(a.etag) || multipart(b.etag) || a.etag === b.etag);

/** A progress log kept in memory: what a move uses when the host gives it none (it then cannot resume after a restart). */
export function memoryMoveLog() {
  const files = new Map();
  const changed = () => Object.assign(new Error('That record changed.'), { status: 412 });
  return {
    async read(file) { return files.has(file) ? { text: files.get(file), etag: md5(files.get(file)) } : null; },
    async write(file, body, { ifMatch } = {}) {
      const current = files.get(file);
      if (ifMatch === null && current !== undefined) throw changed();
      if (ifMatch && (current === undefined || md5(current) !== ifMatch)) throw changed();
      files.set(file, String(body));
      return { etag: md5(String(body)) };
    },
  };
}
const fallbackLog = memoryMoveLog();
const logKey = (workspace, id) => `${workspace}--${id}.json`;
const parseRecord = got => { try { return got ? JSON.parse(got.text) : null; } catch { return null; } };
const progressOf = record => ({ done: record.done ?? 0, total: record.total ?? 0, doneBytes: record.doneBytes ?? 0, bytes: record.bytes ?? 0 });

/** What a move of this card has done so far, for a progress bar: null when none was started. */
export async function moveProgress({ moves = fallbackLog, workspace, id }) {
  const record = parseRecord(await moves.read(logKey(workspace, id)));
  return record ? { phase: record.phase, to: record.to, ...progressOf(record) } : null;
}

/**
 * Take the move's progress record. Another run that touched it within LEASE_MS owns the move: the
 * caller then waits for it. The record is written conditionally, so two callers cannot both win.
 */
async function claim({ moves, key, run, clock, init }) {
  const got = await moves.read(key);
  const prior = parseRecord(got);
  if (prior?.phase === 'copying' && prior.run !== run && clock() - prior.lease < LEASE_MS) return { busy: prior };
  const resume = prior && prior.to === init.to && prior.phase !== 'done' && prior.folder === init.folder;
  const record = {
    ...init, run, phase: 'copying', lease: clock(), startedAt: resume ? prior.startedAt : clock(),
    copied: resume ? prior.copied ?? 0 : 0, done: resume ? prior.done ?? 0 : 0, doneBytes: resume ? prior.doneBytes ?? 0 : 0,
  };
  const handle = { record, etag: null, lost: false, failure: null, savedAt: clock() };
  try {
    handle.etag = (await moves.write(key, JSON.stringify(record), { ifMatch: got?.etag ?? null })).etag;
  } catch (error) {
    if (error.status === 412) return { busy: parseRecord(await moves.read(key)) ?? record };
    throw error;
  }
  let chain = Promise.resolve();
  const put = async patch => {
    if (handle.lost) return;
    Object.assign(handle.record, patch);
    try {
      handle.etag = (await moves.write(key, JSON.stringify(handle.record), { ifMatch: handle.etag })).etag;
    } catch (error) {
      if (error.status === 412) handle.lost = true; else handle.failure ??= error;
    }
  };
  /** Note progress; written in order, at most every SAVE_EVERY_MS. Writing refreshes the lease. */
  handle.save = patch => {
    Object.assign(handle.record, patch);
    if (clock() - handle.savedAt < SAVE_EVERY_MS) return;
    handle.savedAt = clock();
    chain = chain.then(() => put({ lease: clock() }));
  };
  /** End this run (`phase`: paused after a slice or a failure, done at the end) and let go of the lease. */
  handle.settle = async (phase, patch = {}) => {
    Object.assign(handle.record, patch);
    chain = chain.then(() => put({ phase, lease: 0 }));
    await chain;
    if (handle.failure && phase === 'done') throw handle.failure;
  };
  return { handle };
}

/** Run `copy` over `items`, `limit` at a time, until they are done, `stop()` says so, or one fails (after the running ones end). */
async function copyAll(items, limit, copy, stop) {
  let next = 0;
  let failure = null;
  const worker = async () => {
    while (!failure && !stop()) {
      const item = items[next];
      if (!item) return;
      next += 1;
      try { await copy(item); } catch (error) { failure ??= error; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failure) throw failure;
  return next >= items.length;
}

export async function moveCard({ from, to, id, category, state, moves = fallbackLog, now = () => new Date(), clock = Date.now, budgetMs = SLICE_MS, concurrency = CONCURRENCY, run = `${clock()}-${Math.random().toString(36).slice(2)}` }) {
  if (!from || !to || from.section === to.section) throw fail('Say which other workspace to move the card to.');
  const [source, target] = await Promise.all([from.readList(), to.readList()]);
  if (target.list.archived === true || target.list.hidden === true) throw fail('That workspace does not take cards.', 409);
  const entity = source.list.entities.find(item => item?.id === id);
  const already = target.list.entities.find(item => item?.id === id);

  // An earlier move got as far as retiring the card: only the state may be left to do.
  if (!entity) {
    const record = source.list.retired?.[id];
    if (already && record?.kind === 'moved' && record.to === to.section) {
      const warning = await rekey(state, from, to, id);
      return { card: already, from: from.section, to: to.section, files: 0, ...(warning ? { warning } : {}) };
    }
    throw fail('No card with that id in this workspace.', 404);
  }
  if (!entity.folder) throw fail('That card has no folder to move.', 409);
  const chosen = typeof category === 'string' && category.trim() ? slug(category) || 'notes' : entity.category;

  if (['deleted', 'purged'].includes(target.list.retired?.[id]?.kind)) throw fail(`${target.list.name || to.section} has had a card with that id in its Trash; that id is not free.`, 409);
  const sameCard = already && already.folder === entity.folder;
  if (!sameCard) {
    const clash = target.list.entities.find(item => item?.id === id || item?.folder === entity.folder);
    if (clash) throw fail(`${target.list.name || to.section} already has a card called "${clash.title || clash.id}"; ids are not renamed to dodge it.`, 409);
  }

  let copied = 0;
  let card = already;
  let handle = null;
  if (!sameCard) {
    const prefixes = [`${entity.folder}/`, `card-responses/${id}/`];
    const listSource = async () => (await Promise.all(prefixes.map(prefix => from.store.list(prefix)))).flat();
    const listTarget = async () => (await Promise.all(prefixes.map(prefix => to.store.list(prefix)))).flat();
    const sizeOf = items => items.reduce((sum, item) => sum + item.size, 0);

    let snapshot = await listSource();
    if (snapshot.length > MAX_FILES || sizeOf(snapshot) > MAX_BYTES) {
      throw fail(`This card is too big to move (more than ${MAX_FILES} files or ${MAX_BYTES / 1024 / 1024 / 1024} GB).`, 413);
    }

    // The target may hold files already: a card that once lived here (moving back), or the part of
    // an earlier attempt. Anything else in those folders is someone else's.
    const there = await listTarget();
    const lived = target.list.retired?.[id]?.folder === entity.folder;
    if (there.length && !lived) {
      const bySource = new Map(snapshot.map(item => [item.file, item]));
      // Files an earlier attempt left may be older than the source's now; the copy below overwrites them.
      // A file the source does not have is someone else's.
      if (!there.every(item => bySource.has(item.file))) {
        throw fail(`${target.list.name || to.section} already has files in that card's folder.`, 409);
      }
    }

    const claimed = await claim({ moves, key: logKey(from.section, id), run, clock, init: { id, from: from.section, to: to.section, folder: entity.folder, total: snapshot.length, bytes: sizeOf(snapshot) } });
    if (claimed.busy) return { pending: true, busy: true, from: from.section, to: to.section, progress: progressOf(claimed.busy), files: 0 };
    handle = claimed.handle;
    copied = handle.record.copied;
    const deadline = clock() + budgetMs;
    const stop = () => handle.lost || clock() >= deadline;

    try {
      // Copy what the target lacks, check it, then look at the source again: a file written meanwhile
      // (an agent saving a page) is copied again, for up to three rounds.
      let settled = false;
      let dirty = null;
      for (let round = 1; round <= ROUNDS && !settled; round += 1) {
        const held = new Map((await listTarget()).map(item => [item.file, item]));
        const todo = snapshot.filter(item => (dirty ? dirty.has(item.file) : !same(held.get(item.file), item)));
        const left = new Set(todo.map(item => item.file));
        let done = snapshot.length - todo.length;
        let doneBytes = sizeOf(snapshot.filter(item => !left.has(item.file)));
        // Progress only goes up: a second round that re-copies a few files does not walk the bar back.
        const note = () => handle.save({ done: Math.max(handle.record.done, done), doneBytes: Math.max(handle.record.doneBytes, doneBytes), total: snapshot.length, bytes: sizeOf(snapshot), copied });
        note();
        const finished = await copyAll(todo, concurrency, async item => {
          await to.store.copyFrom(from.store, item.file);
          copied += 1; done += 1; doneBytes += item.size;
          note();
        }, stop);
        if (!finished) {
          await handle.settle('paused', { done: Math.max(handle.record.done, done), doneBytes: Math.max(handle.record.doneBytes, doneBytes), copied });
          return { pending: true, busy: handle.lost, from: from.section, to: to.section, progress: progressOf(handle.record), files: copied };
        }
        const after = new Map((await listTarget()).map(item => [item.file, item]));
        const bad = snapshot.filter(item => !same(after.get(item.file), item)).map(item => item.file);
        const was = new Map(snapshot.map(item => [item.file, item]));
        const latest = await listSource();
        const moved = latest.filter(item => was.get(item.file)?.etag !== item.etag || was.get(item.file)?.size !== item.size).map(item => item.file);
        dirty = new Set([...bad, ...moved]);
        snapshot = latest;
        settled = dirty.size === 0;
      }
      if (!settled) throw fail('The card changed while it was moving; try again.', 409);

      const { id: _keep, ...rest } = entity;
      card = { id, ...rest, ...(chosen ? { category: chosen } : {}), updated: today(now) };
      try {
        await to.adoptCard({ entity: card });
      } catch (error) {
        throw Object.assign(error, { step: 5 });
      }
    } catch (error) {
      await handle.settle('paused', { error: String(error.message).slice(0, 200), copied }).catch(() => {});
      throw error;
    }
  } else if (chosen && chosen !== already.category) {
    // Retry of a move that also asked for a new category: the target copy gets it too.
    await to.updateCard({ id, category: chosen });
    card = { ...already, category: chosen };
  }

  try {
    await from.retireMoved({ id, to: to.section, folder: entity.folder });
  } catch (error) {
    await handle?.settle('paused', { error: String(error.message).slice(0, 200) }).catch(() => {});
    throw Object.assign(new Error(`The card was copied to ${target.list.name || to.section} but not yet taken off ${source.list.name || from.section} (${error.message}); press Move again.`), { status: error.status && error.status !== 412 ? error.status : 409, step: 6 });
  }
  await handle?.settle('done', { done: handle.record.total, doneBytes: handle.record.bytes, copied }).catch(() => {});
  const warning = await rekey(state, from, to, id);
  return { card, from: from.section, to: to.section, files: copied, ...(warning ? { warning } : {}) };
}

/** Move the card's pins, tags and archive state to its new workspace. A failure is a warning: they can be redone. */
async function rekey(state, from, to, id) {
  if (!state?.rekey) return null;
  try {
    await state.rekey(cardKey(from.section, id), cardKey(to.section, id));
    return null;
  } catch (error) {
    return `The card moved, but its pins and tags were not carried over (${error.message}).`;
  }
}
