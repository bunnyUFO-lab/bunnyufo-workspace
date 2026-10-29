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
  why?: string
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
