// The Roadmap's filter: which tasks the map shows. A pure function over the roadmap data, applied before the layout.
import type { MapMilestone, ProgressMap, TaskState } from '../lib/hub'

export interface MapFilter {
  /** The task states shown. */
  states: TaskState[]
  /** Updated within this many days; null for any. */
  within: 7 | 30 | 90 | null
  /** A custom range, `YYYY-MM-DD` (both ends included); empty for open-ended. */
  from: string
  to: string
}

export const FILTER_STATES: TaskState[] = ['doing', 'you', 'next', 'later', 'done']
export const FILTER_STATE_LABEL: Record<TaskState, string> = { doing: 'In progress', you: 'Needs you', next: 'Next up', later: 'Later', done: 'Done' }
export const WITHIN_CHOICES = [7, 30, 90] as const

export const OPEN_FILTER: MapFilter = { states: ['doing', 'you', 'next', 'later'], within: null, from: '', to: '' }
export const DOING_FILTER: MapFilter = { states: ['doing'], within: null, from: '', to: '' }
export const ALL_FILTER: MapFilter = { states: [...FILTER_STATES], within: null, from: '', to: '' }
export const PRESETS = [{ id: 'open', label: 'Open', states: OPEN_FILTER.states }, { id: 'doing', label: 'In progress only', states: DOING_FILTER.states }, { id: 'all', label: 'All', states: ALL_FILTER.states }] as const

const sameStates = (a: TaskState[], b: TaskState[]) => a.length === b.length && a.every(state => b.includes(state))
export const isOpenFilter = (filter: MapFilter) => sameStates(filter.states, OPEN_FILTER.states) && !filter.within && !filter.from && !filter.to
/** The preset the states match, whatever the dates are; null for a custom choice of states. */
export const presetOf = (filter: MapFilter) => PRESETS.find(preset => sameStates(filter.states, [...preset.states]))?.id ?? null
export const hasDates = (filter: MapFilter) => Boolean(filter.within || filter.from || filter.to)
/** True when the filter shows every task. */
export const showsAll = (filter: MapFilter) => sameStates(filter.states, ALL_FILTER.states) && !hasDates(filter)

const DAY = 86_400_000
const dayStart = (iso: string) => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d).getTime() }
const validDay = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(dayStart(value))

/** A stored value as a filter; anything bad falls back to the default (Open). */
export function parseFilter(raw: unknown): MapFilter {
  if (!raw || typeof raw !== 'object') return OPEN_FILTER
  const value = raw as Record<string, unknown>
  const states = Array.isArray(value.states) ? FILTER_STATES.filter(state => (value.states as unknown[]).includes(state)) : null
  if (!states || !states.length) return OPEN_FILTER
  const within = value.within === 7 || value.within === 30 || value.within === 90 ? value.within : null
  const from = validDay(value.from) ? value.from : ''
  const to = validDay(value.to) ? value.to : ''
  // A range that ends before it starts matches nothing: it falls back to the default date choice (any).
  if (from && to && from > to) return { states, within: null, from: '', to: '' }
  return { states, within, from, to }
}

/** When a task last changed: updated, else closed, else created; null when none parses. */
function dateOf(task: { updatedAt?: string; closedAt?: string; createdAt?: string }): number | null {
  for (const text of [task.updatedAt, task.closedAt, task.createdAt]) {
    const time = text ? Date.parse(text) : NaN
    if (!Number.isNaN(time)) return time
  }
  return null
}

/** How many tasks a milestone or feature lost to the filter, and how many of those were done. */
export interface Hidden { n: number; done: number }

/** The model with only the tasks the filter lets through, plus what each milestone and feature lost. A feature with no match is dropped (its tasks count as its milestone's hidden); a milestone with no match stays, empty, so the spine stays readable. The same model comes back when the filter shows everything. */
export function filterMap(model: ProgressMap, filter: MapFilter, now: number = Date.now()): { model: ProgressMap; hidden: Map<string, Hidden> } {
  const hidden = new Map<string, Hidden>()
  if (showsAll(filter)) return { model, hidden }
  const since = filter.within ? now - filter.within * DAY : null
  const from = filter.from ? dayStart(filter.from) : null
  const to = filter.to ? dayStart(filter.to) + DAY : null
  const dated = since !== null || from !== null || to !== null
  const keep = (task: MapMilestone['features'][number]['tasks'][number]) => {
    if (!filter.states.includes(task.state)) return false
    if (!dated) return true
    const time = dateOf(task)
    if (time === null) return false
    return (since === null || time >= since) && (from === null || time >= from) && (to === null || time < to)
  }
  const milestones = model.milestones.map((milestone): MapMilestone => {
    const total = { n: 0, done: 0 }
    const features = milestone.features.flatMap(feature => {
      const tasks = feature.tasks.filter(keep)
      const lost = feature.tasks.filter(task => !keep(task))
      total.n += lost.length
      total.done += lost.filter(task => task.state === 'done').length
      if (!tasks.length) return feature.tasks.length ? [] : [feature]
      if (lost.length) hidden.set(feature.id, { n: lost.length, done: lost.filter(task => task.state === 'done').length })
      return [{ ...feature, tasks }]
    })
    if (total.n) hidden.set(milestone.id, total)
    return { ...milestone, features }
  })
  return { model: { ...model, milestones }, hidden }
}

/** The chip's words: "Open · 30 d", "All", "In progress, Done · 3 Oct to 9 Oct". */
export function filterLabel(filter: MapFilter): string {
  const preset = presetOf(filter)
  const states = preset ? PRESETS.find(item => item.id === preset)!.label : filter.states.map(state => FILTER_STATE_LABEL[state]).join(', ')
  const short = (day: string) => new Date(dayStart(day)).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
  const dates = filter.within ? `${filter.within} d` : filter.from || filter.to ? `${filter.from ? short(filter.from) : 'start'} to ${filter.to ? short(filter.to) : 'now'}` : ''
  return dates ? `${states} · ${dates}` : states
}
