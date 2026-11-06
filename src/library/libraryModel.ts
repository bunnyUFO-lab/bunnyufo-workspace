// What the Library shows, as plain functions: no React, no window. The filter, the sort and the grouping that used to sit in App.tsx.
import type { CardWorkspace, WorkspaceCard } from '../types'
import { archiveCutoff } from '../lib/archiveRule.ts'
import { applyOrder, cardKey, type Order } from '../lib/orderKeys.ts'

export type LibraryView = 'all' | 'pinned' | 'archive' | 'trash'

/** Rows drawn before "Show more", and what each press adds. */
export const PAGE = 60

// Freshly-touched work always burns at the top: sort by `updated` (falls back to `created`), regardless of status.
export const lastTouched = (e: WorkspaceCard) => e.updated ?? e.created

/**
 * An explicit `archived` status always wins, so a card can be put away by hand while it is still inside the 7-day window.
 * Otherwise it is the date rule, which `pinned` overrides in the other direction.
 */
export const isArchived = (e: WorkspaceCard) =>
  e.status === 'archived' || (!e.pinned && !e.sample && lastTouched(e) < archiveCutoff())

const statusRank = (e: WorkspaceCard) => (e.status === 'active' ? 0 : 1)
export const byFreshness = (a: WorkspaceCard, b: WorkspaceCard) =>
  lastTouched(b).localeCompare(lastTouched(a)) || statusRank(a) - statusRank(b)

// Pins keep the order they were given; one that has never been moved waits at the bottom, newest first.
const pinRank = (e: WorkspaceCard) => (typeof e.pinOrder === 'number' ? e.pinOrder : Number.POSITIVE_INFINITY)
export const sortPins = (cards: WorkspaceCard[]) =>
  cards.filter(e => e.pinned).sort((a, b) => pinRank(a) - pinRank(b) || byFreshness(a, b))

/** The search field's rule: title, description, category, id and section, any part, any case. */
export const matchesQuery = (e: WorkspaceCard, query: string) => {
  const q = query.trim().toLowerCase()
  return !q || [e.title, e.description, e.category, e.id, e.workspace.name].some(s => s && s.toLowerCase().includes(q))
}

export interface Group {
  /** The heading ("Pinned", "Recent", a category), or null for one run with none. */
  label: string | null
  cards: WorkspaceCard[]
  /** A category heading: it can be renamed and merged. */
  category?: boolean
}

export interface LibraryList {
  groups: Group[]
  /** What each section would show if picked, under this search and view (they add up to `total`). */
  counts: Map<string, number>
  total: number
  /** Put-away cards in the section in view: the Archive segment's count. */
  archivedCount: number
  /** Rows across all groups. */
  shown: number
  searching: boolean
}

/**
 * The rows for a view. `All` with no search and no section is Pinned, then Recent. With one section and no search it is the
 * pins (a pin crosses the section: it says "keep this in front of me"), then that section's cards by category. A search is one
 * newest-first run. Pinned and Archive are flat runs. Trash is drawn by its own rows, not here.
 */
export function libraryList(cards: WorkspaceCard[], order: Order, input: { query: string; section: string; view: LibraryView }): LibraryList {
  const { query, section, view } = input
  const searching = query.trim().length > 0
  const matching = cards.filter(e => matchesQuery(e, query))
  const live = matching.filter(e => !isArchived(e))
  const archivedAll = matching.filter(isArchived)
  const pool = view === 'archive' ? archivedAll : view === 'pinned' ? live.filter(e => e.pinned) : live
  const counts = new Map<string, number>()
  for (const e of pool) counts.set(e.workspace.id, (counts.get(e.workspace.id) ?? 0) + 1)
  const inSection = (e: WorkspaceCard) => !section || e.workspace.id === section
  const visible = pool.filter(inSection)
  const archivedCount = archivedAll.filter(inSection).length

  const groups: Group[] = []
  if (view === 'pinned') {
    groups.push({ label: null, cards: sortPins(visible) })
  } else if (view === 'archive' || searching) {
    groups.push({ label: null, cards: [...visible].sort(byFreshness) })
  } else {
    const pins = sortPins(live)
    if (pins.length) groups.push({ label: 'Pinned', cards: pins })
    const rest = visible.filter(e => !e.pinned).sort(byFreshness)
    if (!section) {
      if (rest.length) groups.push({ label: 'Recent', cards: rest })
    } else {
      const byCategory = new Map<string, WorkspaceCard[]>()
      for (const e of rest) {
        const key = e.category || 'other'
        if (!byCategory.has(key)) byCategory.set(key, [])
        byCategory.get(key)!.push(e)
      }
      for (const [label, list] of applyOrder([...byCategory], ([name]) => name, order.sections, 'last')) {
        groups.push({ label, category: true, cards: applyOrder(list, cardKey, order.cards[`category:${label}`], 'first') })
      }
    }
  }
  return { groups, counts, total: pool.length, archivedCount, shown: groups.reduce((n, g) => n + g.cards.length, 0), searching }
}

/** The first `limit` rows of the groups, headings kept, empty groups dropped. */
export function pageOf(groups: Group[], limit: number): Group[] {
  let left = limit
  const out: Group[] = []
  for (const group of groups) {
    if (left <= 0) break
    out.push(left >= group.cards.length ? group : { ...group, cards: group.cards.slice(0, left) })
    left -= group.cards.length
  }
  return out
}

/** The section chips in order: the workspaces as ordered by `order.projects`, the ones it has not heard of last. */
export const orderedSections = (workspaces: CardWorkspace[], order: Order) => applyOrder(workspaces, w => w.id, order.projects, 'last')
