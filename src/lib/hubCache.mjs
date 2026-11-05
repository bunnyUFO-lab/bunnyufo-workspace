// The Hub's last answers, in memory only. A screen that unmounts and mounts again shows the
// last data in its first paint while `useHubData` fetches the fresh answer. Pure: no window, no
// React. The key is the exact path given to `useHubData`, query included.

export const HUB_CACHE_MAX = 40
export const HUB_CACHE_MAX_AGE_MS = 30 * 60 * 1000

/** @type {Map<string, { data: unknown, at: Date }>} */
const entries = new Map()
let stamp = 0

/** The stamp a request takes when it starts; a clear (any write) makes it stale. */
export function hubCacheStamp() {
  return stamp
}

export function peekHub(path, now = Date.now()) {
  const entry = entries.get(path)
  if (!entry) return null
  if (now - entry.at.getTime() > HUB_CACHE_MAX_AGE_MS) {
    entries.delete(path)
    return null
  }
  return { data: entry.data, at: entry.at }
}

export function putHub(path, data, requestStamp, at) {
  if (requestStamp !== stamp) return
  if (data === null || typeof data !== 'object') return
  entries.delete(path)
  entries.set(path, { data, at })
  while (entries.size > HUB_CACHE_MAX) entries.delete(entries.keys().next().value)
}

/** Drops every entry, or those whose key starts with the prefix. Always makes earlier requests stale. */
export function clearHub(prefix) {
  stamp += 1
  if (!prefix) {
    entries.clear()
    return
  }
  for (const key of [...entries.keys()]) if (key.startsWith(prefix)) entries.delete(key)
}
