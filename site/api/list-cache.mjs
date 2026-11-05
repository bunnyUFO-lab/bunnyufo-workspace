// A short cache on the bucket's listings, for the Hub's read routes only.
//
// `createListCache` wraps a bucket client. A `list` is answered from memory for `ttlMs` (default 15 s)
// only when it runs inside `cachedReads(fn)` and its prefix is under `root` (the Hub's own section).
// Everything else lists live: every write path, every 409 check, every sweep, because the scope is an
// AsyncLocalStorage that is true only inside `cachedReads`. `liveReads(fn)` steps back out of it.
//
// A write through the wrapper (`put`, `copy`, `del`) calls S3, then, in `finally`, drops every cached
// listing and every load still in flight whose prefix covers the written key. A dropped in-flight load
// still answers the callers that hold it, but is never stored and no later read can join it.
// A write from another process shows up when the entry expires.
import { AsyncLocalStorage } from 'node:async_hooks';

export const DEFAULT_LIST_CACHE_MS = 15_000;

export function createListCache({ bucket, root = '', ttlMs, clock = Date.now, maxEntries = 500, maxObjects = 100_000 } = {}) {
  if (!bucket || !Number.isFinite(ttlMs) || !(ttlMs > 0)) {
    return { bucket, cachedReads: fn => fn(), liveReads: fn => fn(), clear() {}, size: () => 0 };
  }
  const scope = new AsyncLocalStorage();
  /** key -> { prefix, startedAt, value, rows } */
  const entries = new Map();
  /** key -> { prefix, promise, dead } */
  const loading = new Map();
  let rowCount = 0;

  const forget = key => {
    const entry = entries.get(key);
    if (entry) { rowCount -= entry.rows; entries.delete(key); }
  };

  const freeze = result => {
    const objects = result.objects.map(object => Object.freeze({ ...object }));
    return Object.freeze({ ...result, objects: Object.freeze(objects), prefixes: Object.freeze([...(result.prefixes ?? [])]) });
  };

  const store = (key, prefix, startedAt, value) => {
    const rows = value.objects.length + value.prefixes.length;
    if (rows > maxObjects) return;
    const now = clock();
    for (const [k, entry] of entries) if (!(now - entry.startedAt >= 0 && now - entry.startedAt < ttlMs)) forget(k);
    entries.set(key, { prefix, startedAt, value, rows });
    rowCount += rows;
    // Maps iterate in insertion order, so the oldest entry goes first.
    for (const k of entries.keys()) {
      if (entries.size <= maxEntries && rowCount <= maxObjects) break;
      forget(k);
    }
  };

  const drop = writtenKey => {
    for (const [k, entry] of entries) if (writtenKey.startsWith(entry.prefix)) forget(k);
    for (const [k, load] of loading) if (writtenKey.startsWith(load.prefix)) { load.dead = true; loading.delete(k); }
  };

  const writing = (method, keyOf) => async (...args) => {
    try { return await method(...args); } finally { drop(String(keyOf(args))); }
  };

  const list = function (prefix = '', options = {}) {
    if (scope.getStore() !== true || !String(prefix).startsWith(root)) return bucket.list(prefix, options);
    const key = `${prefix}\0${options?.delimiter ?? ''}`;
    const hit = entries.get(key);
    if (hit) {
      const age = clock() - hit.startedAt;
      if (age >= 0 && age < ttlMs) return Promise.resolve(hit.value);
      forget(key);
    }
    const running = loading.get(key);
    if (running) return running.promise;
    const load = { prefix, dead: false, promise: null };
    const startedAt = clock();
    load.promise = bucket.list(prefix, options).then(result => {
      const value = freeze(result);
      if (!load.dead) { loading.delete(key); store(key, prefix, startedAt, value); }
      return value;
    }, error => {
      if (!load.dead) loading.delete(key);
      throw error;
    });
    loading.set(key, load);
    return load.promise;
  };

  const wrapped = {
    ...bucket,
    list,
    put: writing((...args) => bucket.put(...args), args => args[0]),
    del: writing((...args) => bucket.del(...args), args => args[0]),
    // A copy is judged by its destination.
    copy: writing((...args) => bucket.copy(...args), args => args[1]),
  };
  // Methods that use `this` (putJson, getJson) reach the wrapped methods through the spread.
  return {
    bucket: wrapped,
    cachedReads: fn => scope.run(true, fn),
    liveReads: fn => scope.run(false, fn),
    clear() { entries.clear(); rowCount = 0; for (const load of loading.values()) load.dead = true; loading.clear(); },
    size: () => entries.size,
  };
}
