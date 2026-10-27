import type { MapFeature, MapMilestone, MapPr, MapTask, ProgressMap as MapModel, TaskState } from '../lib/hub'

export const STATE_COLOR: Record<TaskState, string> = { done: 'var(--green)', doing: 'var(--pink)', you: 'var(--amber)', next: 'var(--blue)', later: 'var(--text-muted)' }
export const STATE_LABEL: Record<TaskState, string> = { done: 'done', doing: 'in progress', you: 'needs you', next: 'next up', later: 'later' }
export const SIGN_WORDS = { working: 'an agent is working on it now', idle: 'a session worked on it and is now idle', new: 'brand new, not started' } as const

export type Found =
  | { kind: 'm'; milestone: MapMilestone }
  | { kind: 'f'; milestone: MapMilestone; feature: MapFeature }
  | { kind: 't'; milestone: MapMilestone; feature: MapFeature; task: MapTask }

/** A milestone, feature or task by id, from the model; null when the model has no such id. */
export function find(model: MapModel, id: string): Found | null {
  for (const milestone of model.milestones) {
    if (milestone.id === id) return { kind: 'm', milestone }
    for (const feature of milestone.features) {
      if (feature.id === id) return { kind: 'f', milestone, feature }
      const task = feature.tasks.find(item => item.id === id)
      if (task) return { kind: 't', milestone, feature, task }
    }
  }
  return null
}

/** The tasks a milestone or feature holds; a task is itself. */
export function tasksOf(found: Found): MapTask[] {
  if (found.kind === 'm') return found.milestone.features.flatMap(feature => feature.tasks)
  if (found.kind === 'f') return found.feature.tasks
  return [found.task]
}

export interface PrRow { task: MapTask; pr: MapPr }

/** Every PR of these tasks: open ones first, then merged, newest first within each. */
export function prsOf(tasks: MapTask[]): PrRow[] {
  const rows = tasks.flatMap(task => (task.prs ?? []).map(pr => ({ task, pr })))
  return rows.sort((a, b) => (a.pr.state === b.pr.state ? (a.pr.at < b.pr.at ? 1 : a.pr.at > b.pr.at ? -1 : 0) : a.pr.state === 'open' ? -1 : 1))
}

/** The sprints these tasks are in, as lines such as "sprint-3 · 4 of 7 tasks". For a task, the names alone. */
export function sprintLines(model: MapModel, found: Found): string[] {
  if (found.kind === 'm') {
    return model.sprints.flatMap(sprint => sprint.milestones.filter(item => item.id === found.milestone.id).map(item => `${sprint.name} · ${item.count} of ${item.total} tasks`))
  }
  const tasks = tasksOf(found)
  const names = [...new Set(tasks.flatMap(task => task.sprints))]
  if (found.kind === 't') return names
  return names.map(name => `${name} · ${tasks.filter(task => task.sprints.includes(name)).length} of ${tasks.length} tasks`)
}

