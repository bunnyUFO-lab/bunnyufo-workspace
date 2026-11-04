// The Work board's filter: search text and chips. A pure function over the cards, like the Roadmap's mapFilter.ts.
import type { WorkCard } from '../lib/hubWork'
import { rowMatches, words } from './beadSearch.ts'
import type { SearchRow } from './beadSearch.ts'

export type WorkType = 'task' | 'feature' | 'question'
export const WORK_TYPES: WorkType[] = ['task', 'feature', 'question']

export interface WorkFilter {
  q: string
  needsYou: boolean
  blocked: boolean
  type: WorkType | null
  /** A label every shown bead carries; empty for any. */
  label: string
  /** Updated within this many days; null for any. */
  within: 7 | 30 | null
}

export const DEFAULT_WORK_FILTER: WorkFilter = { q: '', needsYou: false, blocked: false, type: null, label: '', within: null }

export const isDefaultWork = (filter: WorkFilter) => !filter.q.trim() && !filter.needsYou && !filter.blocked && !filter.type && !filter.label && !filter.within

const DAY = 86_400_000

/** A stored value as a filter; anything bad falls back to the default. */
export function parseWorkFilter(raw: unknown): WorkFilter {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return DEFAULT_WORK_FILTER
  const value = raw as Record<string, unknown>
  const filter: WorkFilter = {
    q: typeof value.q === 'string' ? value.q.slice(0, 200) : '',
    needsYou: value.needsYou === true,
    blocked: value.blocked === true,
    type: WORK_TYPES.find(type => type === value.type) ?? null,
    label: typeof value.label === 'string' ? value.label.slice(0, 80) : '',
    within: value.within === 7 || value.within === 30 ? value.within : null,
  }
  return isDefaultWork(filter) ? DEFAULT_WORK_FILTER : filter
}

const isQuestion = (card: WorkCard) => (card.labels ?? []).some(label => label.startsWith('wayfinder:') && label !== 'wayfinder:map')

/** True when the card is one the owner has to act on: an Ask, a checklist, a nothing-asked warning or a "needs you" reason. */
export const needsYou = (card: WorkCard) => Boolean(card.asked || card.nothingAsked || card.why === 'needs you')

/** The chips and the search against one card. `textOf` gives the bead's text row once it has loaded (titles and ids are searched without it). */
export function cardPasses(card: WorkCard, filter: WorkFilter, textOf: (card: WorkCard) => SearchRow | undefined, now: number = Date.now()): boolean {
  if (words(filter.q).length) {
    const row = textOf(card)
    if (!rowMatches({ id: card.id, title: card.title, text: row?.text ?? '' }, filter.q)) return false
  }
  if (filter.needsYou || filter.blocked) {
    const asks = needsYou(card)
    const blocked = card.lane === 'blocked' && !asks
    if (!((filter.needsYou && asks) || (filter.blocked && blocked))) return false
  }
  if (filter.type) {
    if (card.source !== 'beads') return false
    if (filter.type === 'question' ? !isQuestion(card) : filter.type === 'feature' ? card.type !== 'feature' : card.type !== 'task' && card.type !== 'bug') return false
  }
  if (filter.label && !(card.labels ?? []).includes(filter.label)) return false
  if (filter.within) {
    const time = Date.parse(card.updatedAt)
    if (Number.isNaN(time) || time < now - filter.within * DAY) return false
  }
  return true
}
