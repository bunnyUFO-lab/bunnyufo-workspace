// A sprint (a Beads label `sprint:<name>`) seen from a project's map: the sprints of a project and the map narrowed to one of them.
// Pure, so a node test covers it. `.ts` imports with the suffix so node can read this file.
import type { MapMilestone, ProgressMap, TaskState } from '../lib/hub.ts'

export interface SprintInfo { name: string; title?: string; done: number; total: number }

/**
 * The sprints of a project in the order the Work board lists them: open ones first, then the newest first. The map orders its bands
 * oldest first, so the newest is the last one; the sort is stable, so that order survives inside each group. Counts come from the
 * tasks (`task.sprints`); groups are not counted, as on the board.
 */
export function sprintsOf(model: Pick<ProgressMap, 'milestones' | 'sprints'>): SprintInfo[] {
  const tasks = model.milestones.flatMap(milestone => milestone.features.flatMap(feature => feature.tasks))
  const rows = [...model.sprints].reverse().map(band => {
    const own = tasks.filter(task => task.sprints.includes(band.name))
    return { name: band.name, ...(band.title ? { title: band.title } : {}), done: own.filter(task => task.state === 'done').length, total: own.length }
  })
  return [...rows.filter(row => row.done < row.total), ...rows.filter(row => row.done >= row.total)]
}

/** A group's state from its children's, as the server rolls it. */
function roll(states: TaskState[]): TaskState {
  if (!states.length) return 'later'
  if (states.every(state => state === 'done')) return 'done'
  if (states.includes('you')) return 'you'
  if (states.includes('doing')) return 'doing'
  if (states.includes('next')) return 'next'
  if (states.some(state => state === 'done')) return 'doing'
  return 'later'
}

/**
 * The map with only the tasks of one sprint: the milestones that have one, their features and tasks narrowed (a group's state is rolled up
 * from what is left), no roadmaps, and only that sprint's band. A name nothing carries gives no milestones.
 */
export function sprintModel(model: ProgressMap, name: string): ProgressMap {
  const milestones = model.milestones.flatMap((milestone): MapMilestone[] => {
    const features = milestone.features
      .map(feature => ({ ...feature, tasks: feature.tasks.filter(task => task.sprints.includes(name)) }))
      .filter(feature => feature.tasks.length > 0)
      .map(feature => ({ ...feature, state: roll(feature.tasks.map(task => task.state)) }))
    if (!features.length) return []
    const narrowed: MapMilestone = { ...milestone, state: roll(features.flatMap(feature => feature.tasks.map(task => task.state))), features }
    delete narrowed.roadmap
    return [narrowed]
  })
  // A band's parts count the sprint's own tasks in each milestone: the whole milestone's total would not match the list.
  const own = new Map(milestones.map(milestone => [milestone.id, milestone.features.reduce((sum, feature) => sum + feature.tasks.length, 0)]))
  const sprints = model.sprints.filter(band => band.name === name).map(band => ({
    ...band,
    milestones: band.milestones.filter(item => own.has(item.id)).map(item => ({ id: item.id, count: own.get(item.id) ?? 0, total: own.get(item.id) ?? 0 })),
  }))
  return { ...model, milestones, roadmaps: [], sprints }
}
