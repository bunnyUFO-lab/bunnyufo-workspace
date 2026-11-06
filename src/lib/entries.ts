// Browser history for the app, in one place. Every entry the app adds is a hash change, so Back, Alt+Left and the in-app Back
// button walk the same list. Nothing else calls `history.pushState` or `history.replaceState` for routing: a replace that
// passes `null` as the state would wipe the entry's serial (see `swap`).
//
// Each entry carries a serial in `history.state.hubEntry`, stamped on the first `hashchange` that lands on it. Serials only
// grow, so comparing two of them says whether a move went back or forward, and whether anything of ours is behind us.
import { useCallback, useEffect, useRef, useState } from 'react'

const FIRST_KEY = 'buw.entry.first'
const NEXT_KEY = 'buw.entry.next'
const OVERLAY = '/~o'
/** Fired after `swap`, which changes the address with no `hashchange` for the route listeners to hear. */
export const ROUTE_EVENT = 'buw-route'

let installed = false
let nextSerial = 1
let firstSerial = 0
let currentSerial = 0
let previousSerial = 0
/** Where each entry is (its address without a sheet's tail), and the entry it was opened from. In memory, so a reload starts over. */
const hashOf = new Map<number, string>()
const parentOf = new Map<number, number>()

const read = (key: string): number => {
  try { return Number(sessionStorage.getItem(key)) || 0 } catch { return 0 }
}
const write = (key: string, value: number) => {
  try { sessionStorage.setItem(key, String(value)) } catch { /* storage blocked: the serials live in memory only */ }
}

const serialOf = (state: unknown): number => {
  const value = (state as { hubEntry?: unknown } | null)?.hubEntry
  return typeof value === 'number' ? value : 0
}

function stamp() {
  let serial = serialOf(window.history.state)
  if (!serial) {
    serial = nextSerial++
    write(NEXT_KEY, nextSerial)
    // A new entry is pushed after the one we were on: that one is what Back returns to.
    if (currentSerial) parentOf.set(serial, currentSerial)
    try { window.history.replaceState({ ...(window.history.state ?? {}), hubEntry: serial }, '') } catch { /* memory only */ }
  }
  if (serial !== currentSerial) { previousSerial = currentSerial; currentSerial = serial }
  nextSerial = Math.max(nextSerial, serial + 1)
  hashOf.set(serial, withoutOverlay(window.location.hash))
}

/** The number of `/~o` segments at the end of a hash: the sheets open over the screen. */
export const overlayDepth = (hash: string): number => (/(?:\/~o)+$/.exec(hash)?.[0].length ?? 0) / OVERLAY.length

/** The hash with every trailing `/~o` taken off. */
export const withoutOverlay = (hash: string): string => hash.replace(/(?:\/~o)+$/, '')

const overlays: { onClose: () => void }[] = []

/** A sheet is open in memory (a `/~o` tail with none behind it is a leftover, and is dropped: lib/redirects). */
export const hasOverlay = () => overlays.length > 0

function onHashChange() {
  stamp()
  // Back, with a sheet open, shuts the sheet and stays on the screen beneath.
  const depth = overlayDepth(window.location.hash)
  while (overlays.length > depth) overlays.pop()?.onClose()
}

/** Called once, before the app mounts. */
export function installEntries() {
  if (installed || typeof window === 'undefined') return
  installed = true
  try { window.history.scrollRestoration = 'manual' } catch { /* not supported */ }
  nextSerial = Math.max(read(NEXT_KEY), 1)
  firstSerial = read(FIRST_KEY)
  stamp()
  if (!firstSerial) { firstSerial = currentSerial; write(FIRST_KEY, firstSerial) }
  window.addEventListener('hashchange', onHashChange)
  // On a path-routes host the app also redraws on `popstate`, which fires before `hashchange` and renders the new screen at once:
  // the entry must be stamped by then, or a screen that mounts on Back reads the entry it left. Stamping twice is harmless.
  window.addEventListener('popstate', onHashChange)
}

const normal = (hash: string) => (hash.startsWith('#') ? hash : `#${hash}`)

/** Opens an address as one new entry. The same address adds nothing. */
export function go(hash: string) {
  const next = normal(hash)
  if (window.location.hash === next) return
  window.location.hash = next
}

/** Changes the address in place: no entry, and the entry's serial is kept. `path` also changes the path (a section's page). */
export function swap(hash: string, path?: string, notify = true) {
  const url = (path ?? window.location.pathname) + window.location.search + normal(hash)
  if (url === window.location.pathname + window.location.search + window.location.hash) return
  window.history.replaceState(window.history.state, '', url)
  if (currentSerial) hashOf.set(currentSerial, withoutOverlay(window.location.hash))
  if (notify) window.dispatchEvent(new Event(ROUTE_EVENT))
}

/** Where the tab's history has something of ours behind this entry. */
export const hasBehind = () => currentSerial > firstSerial

/** The address of the entry Back returns to, when this tab opened this one from it (not after a reload, nor a link opened in a new tab). */
export const behindHash = (): string | null => hashOf.get(parentOf.get(currentSerial) ?? 0) ?? null

/** How many entries back the nearest earlier screen with this address is, along the way this one was opened; 0 when there is none. */
export function stepsBackTo(match: (hash: string) => boolean): number {
  let serial = currentSerial
  for (let steps = 1; parentOf.has(serial) && steps < MEMO_KEEP; steps++) {
    serial = parentOf.get(serial)!
    if (match(hashOf.get(serial) ?? '')) return steps
  }
  return 0
}

let carryUntil = 0
/** The next screen that asks (`useEntryMemo` with `carry`) and finds nothing kept for its entry starts from what it last had, for a moment. */
export const carryStateOnce = () => { carryUntil = Date.now() + 2000 }

/** Every in-app Back: one browser step when something of ours is behind, else the parent screen. Never leaves the app. */
export function back(parent: string) {
  if (hasBehind()) window.history.back()
  else go(parent)
}

export const direction = (): 'back' | 'fwd' => (currentSerial < previousSerial ? 'back' : 'fwd')

/** The entry's target is gone (a deleted chat): going back keeps going back, anything else replaces it with the parent. */
export function skipGone(parent: string) {
  if (direction() === 'back' && hasBehind()) window.history.back()
  else swap(parent)
}

/** The serial of the screen's own entry: the current one, or with sheets open over it the entry under them. */
export function screenSerial(): number {
  let serial = currentSerial
  for (let depth = overlayDepth(window.location.hash); depth > 0 && parentOf.has(serial); depth--) serial = parentOf.get(serial)!
  return serial
}

/** The tab's serial now, for the things kept against an entry. */
export const entrySerial = () => currentSerial

/** The serial of the entry before this one: under a sheet's entry, the screen the sheet is open over. */
export const entryBelowSerial = () => previousSerial

const MEMO_KEEP = 100
const memo = new Map<string, unknown>()
/** The last value set for each key, on any entry: what `carry` starts from. */
const lastKept = new Map<string, unknown>()
const memoOrder: number[] = []

function remember(serial: number) {
  const at = memoOrder.indexOf(serial)
  if (at >= 0) memoOrder.splice(at, 1)
  memoOrder.push(serial)
  while (memoOrder.length > MEMO_KEEP) {
    const old = memoOrder.shift()!
    for (const key of [...memo.keys()]) if (key.startsWith(`${old}\u0000`)) memo.delete(key)
  }
}

/** State kept in memory against this entry: search text, a chip, a scroll position. Back to the entry finds it again; a reload loses it. */
export function useEntryMemo<T>(key: string, init: T | (() => T), carry = false): [T, (value: T | ((current: T) => T)) => void] {
  const [serial] = useState(() => currentSerial)
  const id = `${serial}\u0000${key}`
  const [value, set] = useState<T>(() => {
    if (memo.has(id)) return memo.get(id) as T
    if (carry && Date.now() < carryUntil && lastKept.has(key)) {
      // Kept against this entry too, so Back to it later finds the same.
      memo.set(id, lastKept.get(key)); remember(serial)
      return lastKept.get(key) as T
    }
    return typeof init === 'function' ? (init as () => T)() : init
  })
  const latest = useRef(value)
  const update = useCallback((next: T | ((current: T) => T)) => {
    const resolved = typeof next === 'function' ? (next as (current: T) => T)(latest.current) : next
    latest.current = resolved
    memo.set(id, resolved)
    lastKept.set(key, resolved)
    remember(serial)
    set(resolved)
  }, [id, serial, key])
  return [value, update]
}

/**
 * An open sheet or dialog is an entry at the screen's own address plus `/~o`. Back while it is open calls `onClose`, and the
 * screen stays. Closing from the UI (`open` going false) takes the entry off with `history.back()`.
 */
export function useOverlayEntry(open: boolean, onClose: () => void) {
  const close = useRef(onClose)
  useEffect(() => { close.current = onClose })
  useEffect(() => {
    if (!open) return undefined
    let cancelled = false
    let pushed = false
    const token = { onClose: () => close.current() }
    // StrictMode runs this effect, its cleanup and the effect again in one task: nothing is pushed until it settles.
    queueMicrotask(() => {
      if (cancelled) return
      pushed = true
      overlays.push(token)
      window.location.hash = `${window.location.hash || '#/'}${OVERLAY}`
    })
    return () => {
      cancelled = true
      if (!pushed) return
      const at = overlays.indexOf(token)
      if (at < 0) return // Back already took the entry.
      overlays.splice(at, 1)
      if (overlayDepth(window.location.hash) > overlays.length) window.history.back()
    }
  }, [open])
}

/** Leaves the screen the app is on by `back` (so Back cannot return to it), then runs `fn` once the address has settled, with a 300 ms fallback. */
export function afterBack(parent: string, fn: () => void) {
  let done = false
  const run = () => {
    if (done) return
    done = true
    window.removeEventListener('hashchange', run)
    window.clearTimeout(timer)
    fn()
  }
  const timer = window.setTimeout(run, 300)
  window.addEventListener('hashchange', run)
  back(parent)
}

/**
 * A sheet's action: take the sheet's entry off first, then run `fn` once the address has settled (with a 300 ms fallback), so
 * Back cannot reopen a finished sheet.
 */
export function afterPop(fn: () => void) {
  if (!overlayDepth(window.location.hash)) { fn(); return }
  let done = false
  const run = () => {
    if (done) return
    done = true
    window.removeEventListener('hashchange', run)
    window.clearTimeout(timer)
    fn()
  }
  const timer = window.setTimeout(run, 300)
  window.addEventListener('hashchange', run)
  // The sheet's own cleanup must not take a second step back.
  overlays.pop()
  window.history.back()
}
