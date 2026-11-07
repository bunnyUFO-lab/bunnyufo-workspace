// What the Library shows, as plain functions: no React, no window. The filter, the sort and the grouping that used to sit in App.tsx.
import type { CardWorkspace, WorkspaceCard } from '../types'
import { isArchivedCard } from '../lib/archiveRule.ts'
import { applyOrder, cardKey, type Order } from '../lib/orderKeys.ts'

export type LibraryView = 'all' | 'pinned' | 'archive' | 'trash'

/** Rows drawn before "Show more", and what each press adds. */
export const PAGE = 60

// Freshly-touched work always burns at the top: sort by `updated` (falls back to `created`), regardless of status.
export const lastTouched = (e: WorkspaceCard) => e.updated ?? e.created

/**
 * The one rule (site/api/card-liveness.mjs): archived by hand always wins; otherwise only a report or a done card
 * goes by date, and pinned, sample and reference cards stay.
 */
export const isArchived = (e: WorkspaceCard) => isArchivedCard(e)

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
  /** The heading ("Pinned", "Recent", a project, a category), or null for one run with none. */
  label: string | null
  cards: WorkspaceCard[]
  /** A category heading: it can be renamed and merged. */
  category?: boolean
  /** A project heading: the project's id. */
  project?: string
}

/** How the live and archived cards are laid out: one newest-first run, or a heading per project. */
export type Arrange = 'recent' | 'project'

export interface LibraryList {
  groups: Group[]
  /** What each project would show if picked, under this search and view (they add up to `total`). */
  counts: Map<string, number>
  total: number
  /** Put-away cards in the projects in view: the Archive segment's count. */
  archivedCount: number
  /** Rows across all groups. */
  shown: number
  searching: boolean
}

/** The projects the filter picked: ids the registry no longer has are dropped, and repeats. Empty is all of them. */
export function pickedProjects(picks: readonly string[], workspaces: readonly { id: string }[]): string[] {
  const known = new Set(workspaces.map(w => w.id))
  return [...new Set(picks)].filter(id => known.has(id))
}

/** One tap on a project in the filter's list: in the picks it comes out, otherwise it goes in. Unticking the last one leaves none, which is all. */
export const togglePick = (picks: readonly string[], id: string): string[] => (picks.includes(id) ? picks.filter(p => p !== id) : [...picks, id])

/** The filter's list and the headings of By project: projects with cards under the view first, in `workspaces` order, the empty ones after. */
export function projectOrder(workspaces: readonly { id: string }[], counts: ReadonlyMap<string, number>): string[] {
  const ids = workspaces.map(w => w.id)
  return [...ids.filter(id => (counts.get(id) ?? 0) > 0), ...ids.filter(id => !(counts.get(id) ?? 0))]
}

/** What the filter's button says: "All projects", the project's name, or "3 projects". */
export function filterLabel(picks: readonly string[], workspaces: readonly { id: string; name: string }[]): string {
  if (picks.length === 0) return 'All projects'
  if (picks.length === 1) return workspaces.find(w => w.id === picks[0])?.name ?? 'All projects'
  return `${picks.length} projects`
}

export interface LibraryInput {
  query: string
  /** The projects picked; empty is all. */
  projects: readonly string[]
  view: LibraryView
  arrange?: Arrange
  /** The projects in the order their headings come (see `projectOrder`); the order cards arrive in when left out. */
  projectOrder?: readonly string[]
}

/** Whether the Recent | By project toggle changes anything: All and Archive, with no search. */
export const arrangeApplies = (view: LibraryView, query: string) => (view === 'all' || view === 'archive') && query.trim().length === 0

/**
 * The rows for a view. A pin crosses the project filter ("keep this in front of me"), so All is Pinned first, then the rest of the
 * picked projects (none picked is all of them). Recent is one newest-first run; By project is a heading per project, or, with exactly
 * one project picked, that project's categories. A search is one newest-first run. Pinned is a flat run. Archive follows the toggle
 * without the Pinned group. Trash is drawn by its own rows, not here.
 */
export function libraryList(cards: WorkspaceCard[], order: Order, input: LibraryInput): LibraryList {
  const { query, projects, view } = input
  const arrange = input.arrange ?? 'recent'
  const searching = query.trim().length > 0
  const matching = cards.filter(e => matchesQuery(e, query))
  const live = matching.filter(e => !isArchived(e))
  const archivedAll = matching.filter(isArchived)
  const pool = view === 'archive' ? archivedAll : view === 'pinned' ? live.filter(e => e.pinned) : live
  const counts = new Map<string, number>()
  for (const e of pool) counts.set(e.workspace.id, (counts.get(e.workspace.id) ?? 0) + 1)
  const inProjects = (e: WorkspaceCard) => projects.length === 0 || projects.includes(e.workspace.id)
  const visible = pool.filter(inProjects)
  const archivedCount = archivedAll.filter(inProjects).length

  const byProject = (list: WorkspaceCard[]): Group[] => {
    if (projects.length === 1) {
      const byCategory = new Map<string, WorkspaceCard[]>()
      for (const e of list) {
        const key = e.category || 'other'
        if (!byCategory.has(key)) byCategory.set(key, [])
        byCategory.get(key)!.push(e)
      }
      return applyOrder([...byCategory], ([name]) => name, order.sections, 'last')
        .map(([label, run]) => ({ label, category: true, cards: applyOrder(run, cardKey, order.cards[`category:${label}`], 'first') }))
    }
    const rank = new Map((input.projectOrder ?? []).map((id, i) => [id, i]))
    const per = new Map<string, WorkspaceCard[]>()
    for (const e of list) {
      if (!per.has(e.workspace.id)) per.set(e.workspace.id, [])
      per.get(e.workspace.id)!.push(e)
    }
    return [...per.values()]
      .sort((a, b) => (rank.get(a[0].workspace.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b[0].workspace.id) ?? Number.MAX_SAFE_INTEGER))
      .map(run => ({ label: run[0].workspace.name, project: run[0].workspace.id, cards: run }))
  }

  const groups: Group[] = []
  if (view === 'pinned') {
    groups.push({ label: null, cards: sortPins(visible) })
  } else if (searching) {
    groups.push({ label: null, cards: [...visible].sort(byFreshness) })
  } else if (view === 'archive') {
    const sorted = [...visible].sort(byFreshness)
    if (arrange === 'project') groups.push(...byProject(sorted)); else groups.push({ label: null, cards: sorted })
  } else {
    const pins = sortPins(live)
    if (pins.length) groups.push({ label: 'Pinned', cards: pins })
    const rest = visible.filter(e => !e.pinned).sort(byFreshness)
    if (arrange === 'project') groups.push(...byProject(rest))
    else if (rest.length) groups.push({ label: 'Recent', cards: rest })
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
