import type { WorkLane } from '../lib/hubWork'

/** The lane a phone opens on: In progress, or Blocked when In progress is empty and Blocked is not. */
export function defaultLane(counts: Record<WorkLane, number>): WorkLane {
  return counts.running === 0 && counts.blocked > 0 ? 'blocked' : 'running'
}
