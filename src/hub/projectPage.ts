// A project's page, the parts with no screen in them: which tab an address names, which milestone a sprint would run on, and the tab counts.
// `.ts` imports with the suffix so node can test this file.
import type { MapMilestone, MapTask, ProgressMap, Today } from '../lib/hub.ts'
import { isLater, tallyOf } from './mapCount.ts'
import type { Tally } from './mapCount.ts'
import { todayFor } from './todayFilter.ts'

export const PROJECT_TABS = ['roadmap', 'running', 'needs', 'library'] as const
export type ProjectTab = (typeof PROJECT_TABS)[number]

/** The tab an address names (`running`, `needs`, `library`); anything else, and none, is the Roadmap. */
export const tabOf = (raw: string | undefined): ProjectTab => ((PROJECT_TABS as readonly string[]).includes(raw ?? '') ? raw as ProjectTab : 'roadmap')

export const tasksOfMilestone = (milestone: MapMilestone): MapTask[] => milestone.features.flatMap(feature => feature.tasks)

/** A milestone made up by the map for tasks that have none has `~` in its id; it has no sprint of its own. */
const real = (milestone: MapMilestone) => !milestone.id.includes('~')

/**
 * The milestone a sprint button points at: the one with a sprint that has not ended, else the first with a task that is not done and not
 * later work. Undefined when there is none.
 */
export function currentMilestone(model: Pick<ProgressMap, 'milestones'>): MapMilestone | undefined {
  const milestones = model.milestones.filter(real)
  return milestones.find(milestone => milestone.sprint && !milestone.sprint.ended)
    ?? milestones.find(milestone => tasksOfMilestone(milestone).some(task => task.state !== 'done' && !isLater(task)))
}

/** The counts on the Running and Needs you tabs: the same filtering as Today at this project. */
export function tabCounts(today: Today, project: string): { running: number; needs: number } {
  const { counts } = todayFor(today, project).data
  return { running: counts.running, needs: counts.needsYou }
}

/** A milestone's row on the Roadmap tab: its tally over every task, and the tasks to show as chips (open ones first, at most `limit`). */
export function milestoneRow(milestone: MapMilestone, limit = 6): { tally: Tally; chips: MapTask[]; more: number } {
  const tasks = tasksOfMilestone(milestone)
  const rank: Record<string, number> = { doing: 0, you: 1, next: 2, later: 3, done: 4 }
  const ordered = tasks.map((task, index) => ({ task, index })).sort((a, b) => (rank[a.task.state] ?? 3) - (rank[b.task.state] ?? 3) || a.index - b.index).map(row => row.task)
  return { tally: tallyOf(tasks), chips: ordered.slice(0, limit), more: Math.max(0, tasks.length - limit) }
}
