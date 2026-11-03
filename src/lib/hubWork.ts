// Work's lanes, as the site API sends them (site/api/hub-work.mjs).

export type WorkLane = 'backlog' | 'ready' | 'running' | 'blocked' | 'review' | 'done'

export interface WorkCard {
  key: string
  source: 'beads' | 'request' | 'hermes'
  id: string
  project: string
  title: string
  lane: WorkLane
  state: string
  /** A Beads card's issue type (`task`, `bug`, `feature`, `epic`...); requests and Hermes runs have none. */
  type?: string
  /** A Beads card's labels. */
  labels?: string[]
  why?: string
  /** What is asked of the owner about this bead: an Ask, a checklist, or another Needs you item. */
  asked?: { kind: string; id: string; href: string }
  /** The bead has the needs-owner label and nothing is asked. */
  nothingAsked?: boolean
  signs: string[]
  live?: { host: string; session: string; state: 'working' | 'idle' }
  updatedAt: string
  href: string
}

export interface WorkLanes {
  lanes: Record<WorkLane, WorkCard[]>
  /** Real totals: a lane may hold fewer cards than its count (Backlog keeps 50, Done 30). */
  counts: Record<WorkLane, number>
  at: string
}
