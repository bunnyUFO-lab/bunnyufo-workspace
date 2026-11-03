// What a ring on the progress map counts, in words. Done means closed. A deferred bead is later work: it stays in the total, is listed
// apart, and is never open. Pure functions over the roadmap data; the layout and the drawing both read them.
import type { MapTask } from '../lib/hub'

/** `total` counts every task, deferred ones too. */
export interface Tally { done: number; later: number; total: number }

/** A deferred task that is not closed: Beads parks it for later, so it is neither open nor done. */
export const isLater = (task: Pick<MapTask, 'state' | 'status'>) => task.state !== 'done' && task.status === 'deferred'

export function tallyOf(tasks: readonly Pick<MapTask, 'state' | 'status'>[]): Tally {
  return { done: tasks.filter(task => task.state === 'done').length, later: tasks.filter(isLater).length, total: tasks.length }
}

/** The tally of what is shown plus what the filter took out (`n` tasks, `done` of them done, `later` of them deferred). */
export function withHidden(tally: Tally, lost?: { n: number; done: number; later: number }): Tally {
  return lost ? { done: tally.done + lost.done, later: tally.later + lost.later, total: tally.total + lost.n } : tally
}

/** Only deferred work: the ring reads as later work, not as an unstarted milestone. */
export const isLaterOnly = (tally: Tally) => tally.total > 0 && tally.later === tally.total

/** "24 of 25 done · 1 later", "9 later" when everything is deferred, "no tasks yet" for an empty one. */
export function tallyWords(tally: Tally): string {
  if (!tally.total) return 'no tasks yet'
  if (isLaterOnly(tally)) return `${tally.later} later`
  return `${tally.done} of ${tally.total} done${tally.later ? ` · ${tally.later} later` : ''}`
}

/** The ring's fill: the done part of everything it holds. */
export const tallyFraction = (tally: Tally) => (tally.total ? tally.done / tally.total : 0)
