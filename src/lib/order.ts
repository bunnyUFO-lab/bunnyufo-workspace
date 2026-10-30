import { useCallback, useSyncExternalStore } from 'react'

/**
 * The order the lists are shown in, when you have dragged them into one.
 *
 * A view preference like the folded sections (lib/collapse): it lives in this browser, so it works
 * on a published site that cannot write anything, and the phone and the desktop can each be
 * arranged their own way. Pins are not here; their order is card state the service writes.
 *
 * Three lists: the projects (workspace ids), the section headings under a category grouping, and
 * the cards inside each section. Each is the whole list as it was when you dropped something, so
 * a later addition is the only thing the saved order does not know about.
 */
export interface Order {
  projects: string[]
  sections: string[]
  /** Card keys (`workspace/id`) per section, under `${groupBy}:${label}`. */
  cards: Record<string, string[]>
}

const KEY = 'buw.order'
const empty: Order = { projects: [], sections: [], cards: {} }

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []

const read = (): Order => {
  try {
    const stored = JSON.parse(localStorage.getItem(KEY) ?? '{}')
    const cards: Record<string, string[]> = {}
    if (stored && typeof stored.cards === 'object' && stored.cards) {
      for (const [section, list] of Object.entries(stored.cards)) cards[section] = strings(list)
    }
    return { projects: strings(stored?.projects), sections: strings(stored?.sections), cards }
  } catch {
    return empty
  }
}

let current = read()
const listeners = new Set<() => void>()
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
const snapshot = () => current

function set(next: Order) {
  current = next
  try { localStorage.setItem(KEY, JSON.stringify(next)) } catch { /* private window, or storage off */ }
  listeners.forEach(listener => listener())
}

export function useOrder() {
  const order = useSyncExternalStore(subscribe, snapshot)
  const setProjects = useCallback((projects: string[]) => set({ ...current, projects }), [])
  const setSections = useCallback((sections: string[]) => set({ ...current, sections }), [])
  const setCards = useCallback(
    (section: string, list: string[]) => set({ ...current, cards: { ...current.cards, [section]: list } }),
    [],
  )
  return { order, setProjects, setSections, setCards }
}

/** The key a card has in a saved order: card ids are only unique inside a workspace. */
export const cardKey = (card: { id: string; workspace: { id: string } }) => `${card.workspace.id}/${card.id}`

/**
 * `items` in the saved order. What the order has never heard of keeps its own order and goes first
 * for cards (a card that was just touched belongs at the top) or last for projects (a new project
 * should not take the number key you were used to).
 */
export function applyOrder<T>(items: T[], keyOf: (item: T) => string, saved: string[] | undefined, unknown: 'first' | 'last'): T[] {
  if (!saved?.length) return items
  const rank = new Map(saved.map((key, index) => [key, index]))
  const known = items.filter(item => rank.has(keyOf(item))).sort((a, b) => rank.get(keyOf(a))! - rank.get(keyOf(b))!)
  const rest = items.filter(item => !rank.has(keyOf(item)))
  return unknown === 'first' ? [...rest, ...known] : [...known, ...rest]
}

/** `list` with `key` taken out and put beside `target`. Returns it unchanged when either is missing. */
export function moveBeside(list: string[], key: string, target: string, edge: 'before' | 'after'): string[] {
  if (key === target || !list.includes(key) || !list.includes(target)) return list
  const others = list.filter(item => item !== key)
  others.splice(others.indexOf(target) + (edge === 'after' ? 1 : 0), 0, key)
  return others
}

/** `list` with `key` moved one place up (-1) or down (1). */
export function moveBy(list: string[], key: string, delta: -1 | 1): string[] {
  const at = list.indexOf(key)
  const to = at + delta
  if (at < 0 || to < 0 || to >= list.length) return list
  const next = [...list]
  next.splice(at, 1)
  next.splice(to, 0, key)
  return next
}

/** A category was renamed: its saved place among the headings and its cards' order follow the new name. */
export function renameCategoryOrder(from: string, to: string) {
  const sections = current.sections.includes(to) ? current.sections.filter(label => label !== from) : current.sections.map(label => label === from ? to : label)
  const cards = { ...current.cards }
  const old = cards[`category:${from}`]
  if (old) {
    cards[`category:${to}`] = [...new Set([...(cards[`category:${to}`] ?? []), ...old])]
    delete cards[`category:${from}`]
  }
  set({ ...current, sections, cards })
}
