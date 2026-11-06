// A project's page, the parts with no screen in them: which tab an address names, which milestone a sprint would run on, and the tab counts.
// `.ts` imports with the suffix so node can test this file.
import type { HubProject, MapMilestone, MapTask, ProgressMap, Today } from '../lib/hub.ts'
import { isLater } from './mapCount.ts'
import { todayFor } from './todayFilter.ts'

export const PROJECT_TABS = ['roadmap', 'work', 'cards'] as const
export type ProjectTab = (typeof PROJECT_TABS)[number]

/** The tab an address names. The old names (`running`, `needs`, `library`) still read as the tab that took their place; anything else, and none, is the Roadmap. */
export function tabOf(raw: string | undefined): ProjectTab {
  if (raw === 'work' || raw === 'running' || raw === 'needs') return 'work'
  if (raw === 'cards' || raw === 'library') return 'cards'
  return 'roadmap'
}

/** The projects the Projects list shows: those with a Beads copy, or all of them while none has one. */
export const listed = (all: HubProject[]): HubProject[] => {
  const withBeads = all.filter(item => item.beads)
  return withBeads.length ? withBeads : all
}

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

/** The counts on the Work tab: what runs and what waits on you: the same filtering as Today at this project. */
export function tabCounts(today: Today, project: string): { running: number; needs: number } {
  const { counts } = todayFor(today, project).data
  return { running: counts.running, needs: counts.needsYou }
}

const RANK: Record<string, number> = { doing: 0, you: 1, next: 2, later: 3, done: 4 }

/** A milestone's tasks with the open ones first (doing, waiting on you, next, later, done), each group in its own order. */
export function orderedTasks(milestone: MapMilestone): MapTask[] {
  return tasksOfMilestone(milestone).map((task, index) => ({ task, index })).sort((a, b) => (RANK[a.task.state] ?? 3) - (RANK[b.task.state] ?? 3) || a.index - b.index).map(row => row.task)
}

/** A milestone opens with this many tasks, and "Show more" adds this many each time. */
export const TASK_PAGE = 20

/**
 * The Roadmap list: the milestones that are not done, each with its tasks (the current one starts open), and the finished ones folded
 * into one "Done (n)" group. `current` is the milestone the work is in, or the first that is not done.
 */
export function roadmapList(model: Pick<ProgressMap, 'milestones'>): { current?: string; open: MapMilestone[]; done: MapMilestone[] } {
  const done = model.milestones.filter(milestone => milestone.state === 'done')
  const open = model.milestones.filter(milestone => milestone.state !== 'done')
  return { current: (currentMilestone(model) ?? open[0])?.id, open, done }
}
