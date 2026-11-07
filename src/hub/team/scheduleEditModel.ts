// Pure words and rules for editing a Hermes job (ws-eh2 G). No React, so Node can test it. The rules mirror the host's (site/api/hub-job-change.mjs, which
// the Hub checks again): five fields, one minute, up to four hours, so a job runs at most four times a day.
import type { JobChange, ScheduleJob } from '../../lib/hubTeam'
import { cadenceWords, clock } from './schedulesModel.ts'

export const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export type CadenceKind = 'daily' | 'weekdays' | 'custom'
export interface Cadence { kind: CadenceKind; time: string; days: number[]; custom: string }

const pad = (n: number) => String(n).padStart(2, '0')

/** The form's cadence for a cron text: a single time every day, a single time on chosen weekdays, or the text itself as Custom. */
export function cadenceOf(expr: string): Cadence {
  const fields = expr.trim().split(/\s+/)
  const custom: Cadence = { kind: 'custom', time: '08:00', days: [1], custom: expr.trim() }
  if (fields.length !== 5) return custom
  const [minute, hour, dom, month, dow] = fields
  if (!/^\d{1,2}$/.test(minute) || !/^\d{1,2}$/.test(hour) || dom !== '*' || month !== '*' || Number(minute) > 59 || Number(hour) > 23) return custom
  const time = `${pad(Number(hour))}:${pad(Number(minute))}`
  if (dow === '*') return { kind: 'daily', time, days: [1], custom: expr.trim() }
  if (/^[0-6](,[0-6])*$/.test(dow) && new Set(dow.split(',')).size === dow.split(',').length) return { kind: 'weekdays', time, days: dow.split(',').map(Number).sort(), custom: expr.trim() }
  return custom
}

/** The cron text for a form's cadence. */
export function cronOf(cadence: Cadence): string {
  if (cadence.kind === 'custom') return cadence.custom.trim()
  const [hour, minute] = cadence.time.split(':').map(Number)
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return ''
  return `${minute} ${hour} * * ${cadence.kind === 'daily' ? '*' : [...cadence.days].sort().join(',')}`
}

/** Why a cron text is not allowed, in words; empty when it is. The host's rule. */
export function cronProblem(expr: string): string {
  const parts = expr.split(' ')
  const bad = 'Use five fields with one minute and up to four hours, so a job runs at most four times a day.'
  if (expr.length > 120 || parts.length !== 5) return bad
  const [minute, hour, ...rest] = parts
  if (!/^\d{1,2}$/.test(minute) || Number(minute) > 59) return bad
  const hours = hour.split(',')
  if (hours.length > 4 || new Set(hours).size !== hours.length || !hours.every(item => /^\d{1,2}$/.test(item) && Number(item) <= 23)) return bad
  return rest.every(part => /^[0-9*,/-]{1,30}$/.test(part)) ? '' : bad
}

/** The cadence in words under the field: "Tuesdays at 09:00, Pacific (Hermes host time)". Empty when the text is not one of the plain shapes. */
export function whenWords(expr: string, zone: string | undefined): string {
  const words = cadenceWords(expr, zone)
  return words ? `${words} (Hermes host time)` : ''
}

/** Says a prompt line by line what changed: `+` for a line added, `-` for a line removed, `=` for one kept. A small LCS; prompts are at most 8000 bytes. */
export function lineDiff(before: string, after: string): { mark: '+' | '-' | '='; text: string }[] {
  const a = before.split('\n')
  const b = after.split('\n')
  const table = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i -= 1) for (let j = b.length - 1; j >= 0; j -= 1) table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1])
  const out: { mark: '+' | '-' | '='; text: string }[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { out.push({ mark: '=', text: a[i] }); i += 1; j += 1 } else if (table[i + 1][j] >= table[i][j + 1]) { out.push({ mark: '-', text: a[i] }); i += 1 } else { out.push({ mark: '+', text: b[j] }); j += 1 }
  }
  for (; i < a.length; i += 1) out.push({ mark: '-', text: a[i] })
  for (; j < b.length; j += 1) out.push({ mark: '+', text: b[j] })
  return out
}

export const promptBytes = (text: string) => new TextEncoder().encode(text).length
export const PROMPT_MAX = 8000

/** Why a prompt is not allowed; empty when it is. */
export function promptProblem(text: string): string {
  if (!text.trim()) return 'The prompt cannot be empty.'
  if (promptBytes(text) > PROMPT_MAX) return `The prompt is longer than ${PROMPT_MAX} bytes.`
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(text)) return 'The prompt holds a control character.'
  return ''
}

/** A job name for a new job: lower case, digits and dashes, 3 to 60 characters, starting with a letter. */
export const NAME_RE = /^[a-z][a-z0-9-]{2,59}$/

// --- the words of a change ---

export const SCRIPT_NOTE = "This job reads a script's output before it runs. Moving it may run it before that data is ready."
export const POSTS_NOTE = 'A job with a script cannot be added back from this page, so removing it is final here.'
export const NOT_YET = 'Editing jobs is not available yet. The Hermes host needs an update first.'

/** A time with its long weekday in the viewer's zone: "Monday 9 Nov 08:00". */
export const longClock = (iso: string): string => clock(iso, undefined, true)

/** The next run before a press is kept in this tab, so the line can say where it moved from after the reload. */
const storageKey = (id: string) => `buw.jobNext.${id}`
export function rememberNext(id: string, nextRunAt: string | null): void {
  try { sessionStorage.setItem(storageKey(id), JSON.stringify(nextRunAt)) } catch { /* private mode: the line then says where it is now */ }
}
export function recallNext(id: string): string | null | undefined {
  try {
    const text = sessionStorage.getItem(storageKey(id))
    return text === null ? undefined : (JSON.parse(text) as string | null)
  } catch { return undefined }
}

export interface ChangeLine { tone: 'wait' | 'run' | 'done' | 'bad'; text: string }

/**
 * What the page says of a job's newest change. Waiting: "Waiting for the Hermes host". Applied: "Running". Live: what happened, and for a schedule
 * the line that is the point of the page, "Next run moved: A to B". A paused job has no next run (the host clears it until it is resumed), so a
 * schedule change there says so rather than naming a time. A failed one says the Hub's words; `job-check` and `expired` can mean the change went through, and say so.
 */
export function changeLine(change: JobChange, job: Pick<ScheduleJob, 'nextRunAt' | 'enabled' | 'state'> | null, before: string | null | undefined): ChangeLine {
  switch (change.state) {
    case 'waiting': return { tone: 'wait', text: 'Waiting for the Hermes host' }
    case 'applied': return { tone: 'run', text: 'Running. The page updates when the host reports.' }
    case 'failed': return { tone: 'bad', text: change.reason ?? 'The host did not apply the change.' }
    case 'late': return { tone: 'bad', text: change.reason ?? 'The Hermes host did not pick this up.' }
    default: break
  }
  const paused = !!job && (job.state === 'paused' || job.enabled === false)
  const after = job?.nextRunAt
  if (change.op === 'pause') return { tone: 'done', text: 'Paused. It will not run until you resume it.' }
  if (change.op === 'remove') return { tone: 'done', text: 'Removed.' }
  if (change.op === 'add') return { tone: 'done', text: after ? `Added. Next run: ${longClock(after)}` : 'Added.' }
  const scheduleMoved = change.op === 'resume' || (change.op === 'edit' && change.to?.schedule !== undefined)
  if (!scheduleMoved) return { tone: 'done', text: change.op === 'edit' ? 'Changed.' : 'Done.' }
  const lead = change.op === 'resume' ? 'Resumed. ' : ''
  if (paused || !after) return { tone: 'done', text: `${lead}${paused ? 'The job is paused, so it has no next run until you resume it.' : 'The host has not said when it runs next.'}` }
  if (before && before !== after) return { tone: 'done', text: `${lead}Next run moved: ${longClock(before)} to ${longClock(after)}` }
  if (before && before === after) return { tone: 'done', text: `${lead}Next run: ${longClock(after)} (unchanged)` }
  return { tone: 'done', text: `${lead}Next run: ${longClock(after)}` }
}

/** The line under "Go back": what it would put back. */
export function backWords(change: JobChange): string {
  if (change.op === 'pause') return 'Go back: resume the job'
  if (change.op === 'resume') return 'Go back: pause the job'
  const parts: string[] = []
  if (change.to?.schedule !== undefined && change.from) parts.push(`the schedule ${change.from.schedule}`)
  if (change.to?.promptChanged) parts.push('the earlier prompt')
  if (change.to && 'model' in change.to && change.from) parts.push(change.from.model ? `the model ${change.from.model}` : 'following the profile')
  return `Go back to ${parts.join(', ') || 'how it was'}`
}
