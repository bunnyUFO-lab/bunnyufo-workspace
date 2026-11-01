import type { WorkLane } from '../lib/hubWork'

/** The lane a phone opens on: In progress, or Blocked when In progress is empty and Blocked is not. */
export function defaultLane(counts: Record<WorkLane, number>): WorkLane {
  return counts.running === 0 && counts.blocked > 0 ? 'blocked' : 'running'
}

/**
 * The project whose map a Work item's sheet reads. A project board asks its own project, even for an id the board does not
 * list. The All board asks the card's project; an id with no card (a task opened from inside the sheet) keeps the project of
 * the sheet it was opened from (`carried`); with neither there is nothing to ask.
 */
export function sheetProject({ all, project, cardProject, carried }: { all: boolean; project?: string; cardProject?: string; carried?: string }): string | undefined {
  if (!all) return project || undefined
  return cardProject || carried || undefined
}
