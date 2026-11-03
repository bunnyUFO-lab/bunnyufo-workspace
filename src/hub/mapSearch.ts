// The Roadmap's search: pure, so the map and node tests share it. A node matches on its id or title, or through a bead text row with the same id
// (`GET /hub/search-text`). Titles match at once; the text arrives with the read.
import type { ProgressMap } from '../lib/hub'
import { rowMatches, words, type SearchRow } from './beadSearch.ts'

export interface MapMatches {
  /** The nodes that match. */
  ids: Set<string>
  /** The matches in model order: a milestone, then its features, then their tasks. */
  order: string[]
  /** The matches and the feature and milestone each sits in: the part of the map that stays lit. */
  lit: Set<string>
  /** The nodes that must be open to draw the matches: every matched feature's milestone, every matched task's milestone and feature. */
  open: Set<string>
}

const NONE = (): MapMatches => ({ ids: new Set(), order: [], lit: new Set(), open: new Set() })

/** What the query finds on the map. A synthetic group (its id has a `~`) never matches: "X · other tasks" would echo its parent's title. An empty query finds nothing. */
export function mapMatches(model: ProgressMap, q: string, rows?: readonly SearchRow[]): MapMatches {
  const found = NONE()
  const terms = words(q)
  if (!terms.length) return found
  const byId = new Map<string, SearchRow>()
  for (const row of rows ?? []) byId.set(row.id, row)
  const hits = (id: string, title: string) => {
    if (id.includes('~')) return false
    const hay = `${id} ${title}`.toLowerCase()
    if (terms.every(term => hay.includes(term))) return true
    const row = byId.get(id)
    return Boolean(row && rowMatches(row, q))
  }
  const add = (id: string, ...parents: string[]) => {
    found.ids.add(id)
    found.order.push(id)
    found.lit.add(id)
    for (const parent of parents) found.lit.add(parent)
  }
  for (const milestone of model.milestones) {
    if (hits(milestone.id, milestone.title)) add(milestone.id)
    for (const feature of milestone.features) {
      if (hits(feature.id, feature.title)) { add(feature.id, milestone.id); found.open.add(milestone.id) }
      for (const task of feature.tasks) {
        if (hits(task.id, task.title)) { add(task.id, feature.id, milestone.id); found.open.add(milestone.id); found.open.add(feature.id) }
      }
    }
  }
  return found
}
