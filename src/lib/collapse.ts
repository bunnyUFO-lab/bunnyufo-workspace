import { useCallback, useSyncExternalStore } from 'react'

/**
 * Which list sections are folded shut.
 *
 * A view preference, not data: it lives in this browser and nowhere else, so the phone and the
 * desktop can each fold away what is in their way without arguing about it. Kept as a list of
 * keys that are *closed*, because a new section should arrive open rather than hidden.
 *
 * One state for the sidebar and the card board: a section is folded or it is not, and the two
 * panes saying different things about the same project read as a bug. So it is a small store
 * every hook instance subscribes to, rather than a useState each.
 */
const KEY = 'buw.collapsedSections'

const read = (): string[] => {
  try {
    const stored = JSON.parse(localStorage.getItem(KEY) ?? '[]')
    return Array.isArray(stored) ? stored.filter(item => typeof item === 'string') : []
  } catch {
    return []
  }
}

let closed = read()
const listeners = new Set<() => void>()
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
const snapshot = () => closed

function set(next: string[]) {
  closed = next
  try { localStorage.setItem(KEY, JSON.stringify(next)) } catch { /* private window, or storage off */ }
  listeners.forEach(listener => listener())
}

export function useCollapsedSections() {
  const list = useSyncExternalStore(subscribe, snapshot)
  const toggle = useCallback((key: string) => {
    set(closed.includes(key) ? closed.filter(item => item !== key) : [...closed, key])
  }, [])
  return { isClosed: (key: string) => list.includes(key), toggle }
}
