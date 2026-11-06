import { useSyncExternalStore } from 'react'
import { HUB_WROTE } from '../lib/hub'
import { dismiss, showUndo } from '../lib/undo'

/**
 * The hold: an answer waits seven seconds in this browser, with Undo, before it reaches an agent. Module state, not
 * component state, so leaving the screen keeps it. One answer waits at a time: a new one sends the old one first.
 *
 * It sends at once when the page is hidden or goes away (`visibilitychange`, `pagehide`), because a phone that sleeps must
 * not lose an answer. The request then carries `keepalive`, and Undo is no longer offered. If the browser kills the page
 * with neither event, nothing was sent, and the item is still open in Needs you: nothing false is claimed.
 *
 * The signing path is not here. A send is whatever the caller's one POST was; the hold only decides when it leaves.
 */

const HOLD_MS = 7000
/** Longest body a `keepalive` request may carry is 64 KB: a send with more (a drawing) is never held. */
export const KEEPALIVE_LIMIT = 60_000
/** After a send lands, the item stays out of the lists a moment, so the refetch that follows can't show it for a flash. */
const LINGER_MS = 4000
const RESTORED_MS = 1800

export type HoldPhase = 'held' | 'sending' | 'sent'

export interface HoldOptions {
  /** The item's key: `<kind>-<id>`, as `itemKey` writes it. */
  key: string
  title: string
  /** Past tense, for the toast: "Answered", "Approved", "Marked done". */
  verb: string
  /** The one write. `keepalive` is true when the page is going away. */
  send: (keepalive: boolean) => Promise<unknown>
}

interface Pending extends HoldOptions { timer: number; toast: number }

interface Snapshot { phases: ReadonlyMap<string, HoldPhase>; restored: string; restoredN: number; counts: ReadonlyMap<string, number> }

let pending: Pending | null = null
const phases = new Map<string, HoldPhase>()
/** How many times Undo or a failed send has brought each item back: a screen compares it with what it saw when it settled the item. */
const counts = new Map<string, number>()
let restored = ''
let restoredN = 0
let snapshot: Snapshot = { phases, restored, restoredN, counts }
const listeners = new Set<() => void>()
const emit = () => { snapshot = { phases: new Map(phases), restored, restoredN, counts: new Map(counts) }; listeners.forEach(listener => listener()) }
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
const getSnapshot = () => snapshot

/** The hold's length: 7 s, or less when `localStorage['hub.undoMs']` says so (a test seam: it can only shorten). */
export function holdMs(): number {
  try {
    const raw = localStorage.getItem('hub.undoMs')
    const value = raw === null ? NaN : Number(raw)
    return Number.isFinite(value) && value >= 0 ? Math.min(HOLD_MS, value) : HOLD_MS
  } catch { return HOLD_MS }
}

const reason = (failure: unknown) => (failure instanceof Error && failure.message ? failure.message : 'It did not work.')

function setPhase(key: string, phase: HoldPhase | null) {
  if (phase) phases.set(key, phase)
  else phases.delete(key)
  emit()
}

function flash(key: string) {
  restored = key
  restoredN += 1
  counts.set(key, (counts.get(key) ?? 0) + 1)
  emit()
  window.setTimeout(() => { if (restored === key) { restored = ''; emit() } }, RESTORED_MS)
}

async function run(item: Pending, keepalive: boolean) {
  setPhase(item.key, 'sending')
  try {
    await item.send(keepalive)
    setPhase(item.key, 'sent')
    window.setTimeout(() => { if (phases.get(item.key) === 'sent') setPhase(item.key, null) }, LINGER_MS)
  } catch (failure) {
    // The item comes back, with the words of the error.
    setPhase(item.key, null)
    flash(item.key)
    showUndo(`Not sent: ${item.title}. ${reason(failure)}`)
    window.dispatchEvent(new Event(HUB_WROTE))
  }
}

/** Send the waiting answer now. `keepalive` is for a page that is going away. */
export function flushHeld(keepalive = false): void {
  const item = pending
  if (!item) return
  pending = null
  window.clearTimeout(item.timer)
  dismiss(item.toast)
  void run(item, keepalive)
}

/** Whether an item is held, sending or just sent, for code that is not a component (a handler that runs right after `hold`). */
export const isHeld = (key: string): boolean => phases.has(key)

/** Undo: nothing is ever sent. The item comes back in every list and count, and flashes. */
export function undoHeld(key?: string): void {
  const item = pending
  if (!item || (key && item.key !== key)) return
  pending = null
  window.clearTimeout(item.timer)
  dismiss(item.toast)
  setPhase(item.key, null)
  flash(item.key)
  showUndo(`Back in Needs you: ${item.title}`)
}

/**
 * Hold an answer. The item leaves its lists and counts at once; the toast names it and offers Undo. A second tap on an item that
 * is already held, sending or just sent does nothing and returns false, so a double tap sends once and counts once.
 */
export function hold(options: HoldOptions): boolean {
  if (phases.has(options.key)) return false
  flushHeld()
  const item = { ...options } as Pending
  const ms = holdMs()
  item.toast = showUndo(`${options.verb}: ${options.title}`, () => undoHeld(options.key))
  item.timer = window.setTimeout(() => { if (pending === item) flushHeld() }, ms)
  pending = item
  setPhase(options.key, 'held')
  return true
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushHeld(true) })
  window.addEventListener('pagehide', () => flushHeld(true))
}

export interface HeldView {
  /** Every item that is out of the lists: waiting, sending, or just sent. */
  keys: ReadonlySet<string>
  /** The phase of one item, if it is held at all. */
  phase: (key: string) => HoldPhase | undefined
  /** The item Undo or a failed send just brought back: its row flashes. */
  restored: string
  /** Counts every restore, so a screen can act once on each. */
  restoredN: number
  /** How many times this item has been brought back. A screen that settled it remembers the number and counts it settled only while the number is the same. */
  restoreCount: (key: string) => number
}

/** What every screen reads, so Today, Needs, the badges and an item's own page agree on what is held. */
export function useHeld(): HeldView {
  const state = useSyncExternalStore(subscribe, getSnapshot)
  return { keys: new Set(state.phases.keys()), phase: key => state.phases.get(key), restored: state.restored, restoredN: state.restoredN, restoreCount: key => state.counts.get(key) ?? 0 }
}

/** The rows that are not held. */
export const notHeld = <T extends { kind: string; id: string }>(items: T[], held: HeldView): T[] => (held.keys.size ? items.filter(item => !held.keys.has(`${item.kind}-${item.id}`)) : items)

/** How many of `items` are held: take them off a count the server made before the answer. */
export const heldAmong = (items: { kind: string; id: string }[], held: HeldView): number => (held.keys.size ? items.length - notHeld(items, held).length : 0)
