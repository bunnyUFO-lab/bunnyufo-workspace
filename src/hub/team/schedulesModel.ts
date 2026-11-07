// Pure words and addresses for the Schedules half of Team. No React, so Node can test it.
import type { GithubSchedule, JobTarget, PcTask, ScheduleJob, ScheduleSource, ScheduleState } from '../../lib/hubTeam'

export const GUEST_LINE = 'Schedules need sign-in.'
export const NOT_REPORTED = 'Not reported'

/** The address of a Hermes job's page. */
export const jobHash = (name: string) => `#/~hub/team/schedules/hermes/${encodeURIComponent(name)}`

export const isSchedulesRoute = (routeId: string | undefined) => routeId === 'schedules' || !!routeId?.startsWith('schedules/')

/** The job named by a Team route id (`schedules/hermes/<name>`); null on the list, or for any other source. */
export function scheduleOf(routeId: string | undefined): { source: 'hermes'; name: string } | null {
  const prefix = 'schedules/hermes/'
  if (!routeId?.startsWith(prefix)) return null
  const name = routeId.slice(prefix.length)
  return name ? { source: 'hermes', name } : null
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/** "6 minutes ago", "9 hours ago", "3 days ago". Empty for a time that does not read. */
export function agoWords(iso: string, now = Date.now()): string {
  const minutes = Math.floor((now - new Date(iso).getTime()) / 60000)
  if (Number.isNaN(minutes)) return ''
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${count(minutes, 'minute', 'minutes')} ago`
  if (minutes < 48 * 60) return `${count(Math.floor(minutes / 60), 'hour', 'hours')} ago`
  return `${count(Math.floor(minutes / 1440), 'day', 'days')} ago`
}

/** The line that heads a list: where it comes from and how old it is ("Hermes host, 6 minutes ago"). */
export function sourceLine(source: Pick<ScheduleSource, 'state' | 'as_of' | 'host' | 'id'>, now = Date.now()): string {
  const where = source.host ?? ''
  if (source.state === 'not-reporting' || !source.as_of) return where ? `${where}, no report` : 'No report'
  const when = agoWords(source.as_of, now)
  return where ? `${where}, ${when}` : when
}

/** The warning above a list whose data is old; empty otherwise. */
export function oldLine(source: Pick<ScheduleSource, 'state' | 'as_of'>, now = Date.now()): string {
  if (source.state !== 'old' || !source.as_of) return ''
  return `Last heard from ${agoWords(source.as_of, now).replace(/ ago$/, '')} ago; these may be out of date.`
}

// --- cron in words ---

const DAYS = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays']
const pad = (n: number) => String(n).padStart(2, '0')
const join = (items: string[]) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`)
const num = (text: string) => (/^\d{1,2}$/.test(text) ? Number(text) : NaN)

/** The zone as a short name: `America/Chicago` is "Central", `UTC` is "UTC". The id itself when the zone has no readable name. */
export function zoneName(zone: string | undefined, at = new Date()): string {
  if (!zone) return ''
  if (zone === 'UTC' || zone === 'Etc/UTC') return 'UTC'
  try {
    const part = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'long' }).formatToParts(at).find(item => item.type === 'timeZoneName')?.value
    if (!part) return zone
    return part.replace(/\s+(Standard|Daylight|Summer)?\s*Time$/i, '').trim() || zone
  } catch {
    return zone
  }
}

/** Day-of-week field to words: `1` Mondays, `1,3` Mondays and Wednesdays, `1-5` weekdays, `*` every day. Null when it is not one of those. */
function daysWords(field: string): string | null {
  if (field === '*') return 'Every day'
  if (field === '1-5') return 'Weekdays'
  if (field === '0,6' || field === '6,0') return 'Weekends'
  const parts = field.split(',')
  const days = parts.map(num)
  if (days.some(day => !(day >= 0 && day <= 7))) return null
  return join(days.map(day => DAYS[day % 7]))
}

/**
 * Five-field cron as words, or '' when the text is not one of the plain shapes (the page then shows the cron text alone and never guesses).
 * "Mondays at 08:00", "Every day at 08:00 and 20:00", "Every 2 hours", "Every 15 minutes", "Day 1 of each month at 06:30". `zone` adds ", Pacific".
 */
export function cadenceWords(expr: string, zone?: string): string {
  const text = expr.trim()
  const every = /^every\s+(\d+)\s*(m|min|minutes?|h|hours?|d|days?)$/i.exec(text)
  if (every) {
    const n = Number(every[1])
    const [one, many] = { m: ['minute', 'minutes'], h: ['hour', 'hours'], d: ['day', 'days'] }[every[2].toLowerCase()[0] as 'm' | 'h' | 'd']
    return n === 1 ? `Every ${one}` : `Every ${n} ${many}`
  }
  const fields = text.split(/\s+/)
  if (fields.length !== 5) return ''
  const [minute, hour, dom, month, dow] = fields
  const where = zone ? `, ${zoneName(zone)}` : ''
  if (month !== '*') return ''
  const step = /^\*\/(\d+)$/
  if (hour === '*' && dom === '*' && dow === '*') {
    const m = step.exec(minute)
    if (m) return `Every ${m[1] === '1' ? 'minute' : `${m[1]} minutes`}${where}`
    return minute === '*' ? `Every minute${where}` : ''
  }
  const m = num(minute)
  if (Number.isNaN(m) || m > 59) return ''
  const hourStep = step.exec(hour)
  if (hourStep && dom === '*' && dow === '*') return `Every ${hourStep[1] === '1' ? 'hour' : `${hourStep[1]} hours`}${m ? ` at minute ${m}` : ''}${where}`
  const hours = hour.split(',').map(num)
  if (hours.some(h => !(h >= 0 && h <= 23))) return ''
  const times = join(hours.map(h => `${pad(h)}:${pad(m)}`))
  if (dom === '*') {
    const days = daysWords(dow)
    return days ? `${days} at ${times}${where}` : ''
  }
  if (dow === '*' && /^\d{1,2}$/.test(dom) && Number(dom) >= 1 && Number(dom) <= 31) return `Day ${Number(dom)} of each month at ${times}${where}`
  return ''
}

// --- one job ---

/** On, Paused or Off, with a tone for the tag. A job the host calls paused is paused even when its `enabled` flag lags. */
export function onWords(job: Pick<ScheduleJob, 'enabled' | 'state'>): { label: string; on: boolean } {
  if (job.state === 'paused') return { label: 'Paused', on: false }
  return job.enabled ? { label: 'On', on: true } : { label: 'Off', on: false }
}

const GOOD = new Set(['ok', 'success', 'succeeded', 'completed', 'done'])
const BAD = new Set(['error', 'failed', 'failure', 'timeout', 'timed-out'])

/** How the last run ended: Worked, Failed, or the host's own word. Empty when the host did not say (a job that never ran). */
export function resultWords(job: Pick<ScheduleJob, 'lastStatus'>): { label: string; failed: boolean } {
  const status = job.lastStatus?.toLowerCase()
  if (!status) return { label: '', failed: false }
  if (GOOD.has(status)) return { label: 'Worked', failed: false }
  if (BAD.has(status)) return { label: 'Failed', failed: true }
  return { label: job.lastStatus as string, failed: false }
}

/** A failed last run, or a streak of failures: seen in the list without opening the row. */
export const troubled = (job: Pick<ScheduleJob, 'lastStatus' | 'failureStreak'>): boolean => resultWords(job).failed || (job.failureStreak ?? 0) > 0

/** The words under a job's name in the list: its cadence, next run and last run. */
export function jobSummary(job: ScheduleJob, zone: string | undefined, now = Date.now(), viewerZone?: string): string[] {
  const out: string[] = []
  const when = cadenceWords(job.schedule, zone)
  if (when) out.push(when)
  if (job.nextRunAt && onWords(job).on) out.push(`Next ${clock(job.nextRunAt, viewerZone)}`)
  if (job.lastRunAt) {
    const result = resultWords(job)
    out.push(`Last ${agoWords(job.lastRunAt, now)}${result.label ? `: ${result.label.toLowerCase()}` : ''}`)
  } else if (job.lastStatus === undefined) {
    out.push('No run yet')
  }
  return out
}

/** A time as the viewer reads it, in their zone: "Mon 9 Nov 08:00". */
export function clock(iso: string, zone?: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  try {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: zone, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date)
    const get = (type: string) => parts.find(part => part.type === type)?.value ?? ''
    return `${get('weekday')} ${get('day')} ${get('month')} ${get('hour')}:${get('minute')}`
  } catch {
    return date.toISOString()
  }
}

/** A time in the viewer's zone and, beside it, the host's when that reads differently: "Mon 9 Nov 08:00 (host: Mon 9 Nov 16:00 UTC)". */
export function clockBoth(iso: string, hostZone: string | undefined, viewerZone?: string): string {
  const mine = clock(iso, viewerZone)
  if (!hostZone) return mine
  const theirs = clock(iso, hostZone)
  return !theirs || theirs === mine ? mine : `${mine} (host: ${theirs} ${zoneName(hostZone, new Date(iso))})`
}

/** The model line: pinned to one, or following the profile. */
export function modelWords(job: Pick<ScheduleJob, 'model' | 'provider'>, followed: string | undefined): { pinned: boolean; text: string; model: string } {
  if (job.model) return { pinned: true, text: 'Pinned: ', model: job.model }
  return followed ? { pinned: false, text: 'Follows the profile: ', model: followed } : { pinned: false, text: 'Follows the profile', model: '' }
}

const PLATFORMS: Record<string, string> = { discord: 'Discord', slack: 'Slack', telegram: 'Telegram', email: 'Email' }

/** Where a job posts: "Discord, #label", or "Not reported" when the host sent nothing, "No destination" when it sent an empty one. */
export function targetWords(target: JobTarget | null | undefined): string {
  if (target === undefined) return NOT_REPORTED
  if (target === null) return 'No destination known'
  return `${PLATFORMS[target.platform] ?? target.platform}, ${target.label}`
}

/** The notes under a prompt: it was cut or had secret-like text replaced, so it is not the whole prompt. */
export function promptNotes(job: Pick<ScheduleJob, 'promptCut' | 'promptRedacted'>): string[] {
  const out: string[] = []
  if (job.promptCut) out.push('This is the first part of the prompt. The export cuts a long one.')
  if (job.promptRedacted) out.push(`${count(job.promptRedacted, 'secret-like text was', 'secret-like texts were')} replaced with [redacted].`)
  return out
}

export const STATE_WORDS: Record<ScheduleState, string> = { live: 'Live', old: 'Old', 'not-reporting': 'Not reporting' }

// --- the PC's tasks, GitHub's schedules and the site host's timers ---

const TASK_STATE: Record<PcTask['state'], string> = { ready: 'Ready', running: 'Running', disabled: 'Off', queued: 'Queued', unknown: 'Unknown' }
export const taskStateWords = (state: PcTask['state']): { label: string; on: boolean } => ({ label: TASK_STATE[state] ?? 'Unknown', on: state === 'ready' || state === 'running' || state === 'queued' })

/** A run's result in the words of the page. The PC and the host write their own ("ok", "error 0x1", "exit-code"); a word not known is shown as it is. */
export function plainResult(text: string | undefined): { label: string; failed: boolean } {
  const word = (text ?? '').trim()
  if (!word) return { label: '', failed: false }
  const lower = word.toLowerCase()
  if (lower === 'ok' || GOOD.has(lower)) return { label: 'Worked', failed: false }
  if (/^(error|failed|failure|exit-code|timeout|signal|core-dump|watchdog)/.test(lower) || BAD.has(lower)) return { label: `Failed (${word})`, failed: true }
  return { label: word.charAt(0).toUpperCase() + word.slice(1), failed: false }
}

/** The PC's tasks split into the repo's own and the rest, which the page folds. */
export function splitTasks(tasks: PcTask[]): { ours: PcTask[]; others: PcTask[] } {
  return { ours: tasks.filter(task => task.ours), others: tasks.filter(task => !task.ours) }
}
export const othersTitle = (n: number) => `Other programs' tasks (${n})`
/** "Showing 60 of 212 tasks" when the PC sent fewer than it has; empty otherwise. */
export const tasksCut = (shown: number, total: number | undefined) => (total !== undefined && total > shown ? `Showing ${shown} of ${total} tasks.` : '')

/** The words under a row that has a next and a last run: "Next Mon 9 Nov 08:00", "Last 3 hours ago: worked". */
export function runLines(row: { nextRun?: string; lastRun?: string; lastResult?: string }, now = Date.now(), on = true, viewerZone?: string): string[] {
  const out: string[] = []
  if (row.nextRun && on) out.push(`Next ${clock(row.nextRun, viewerZone)}`)
  const result = plainResult(row.lastResult)
  if (row.lastRun) out.push(`Last ${agoWords(row.lastRun, now)}${result.label ? `: ${result.label}` : ''}`)
  else if (result.label) out.push(`Last result: ${result.label}`)
  return out
}

/** A workflow's cron line in words, in UTC (GitHub runs them in UTC); empty when the line is not a plain shape. */
export const workflowCadence = (item: Pick<GithubSchedule, 'cron'>): string => cadenceWords(item.cron, 'UTC')
