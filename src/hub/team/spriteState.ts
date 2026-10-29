// Pure logic for sprite states: an agent's status becomes a state, and a state becomes a row of the pet sheet.
// Kept out of the .tsx files so Node can test it.
import type { AgentStatus, CustomSprite, SheetRow } from '../../lib/hubTeam'

export type SpriteState = 'working' | 'needs-you' | 'failed' | 'done' | 'review' | 'idle' | 'offline'

/** The nine rows of a pet sheet, top to bottom. */
export const SHEET_ROWS = ['idle', 'run-right', 'run-left', 'waving', 'jumping', 'failed', 'waiting', 'running', 'review'] as const

/** Fields M3 will add to an agent in `/hub/team`. Until then they are absent and `done` and `review` never show. */
export interface AgentActivity {
  /** When the agent's last result landed (ISO text or epoch ms). */
  doneAt?: string | number
  /** An open ready-for-review for the agent's work. */
  review?: boolean
}

export const DONE_MS = 10 * 60_000
export const DEFAULT_FPS = 6

export const STATE_LABEL: Record<SpriteState, string> = {
  working: 'Working', 'needs-you': 'Needs you', failed: 'Failed', done: 'Done', review: 'In review', idle: 'Idle', offline: 'Offline',
}

const ROW_OF: Record<SpriteState, SheetRow> = {
  working: 'running', 'needs-you': 'waiting', failed: 'failed', done: 'jumping', review: 'review', idle: 'idle', offline: 'idle',
}

export const rowOf = (state: SpriteState): SheetRow => ROW_OF[state]

const stamp = (value: string | number | undefined): number | null => {
  if (value === undefined || value === '') return null
  const time = typeof value === 'number' ? value : Date.parse(value)
  return Number.isFinite(time) ? time : null
}

/**
 * The state a sprite shows. Order of weight: offline, needs you, failed, working, review, done, idle.
 * So `needs-you` wins over `working`. `done` holds for ten minutes after `doneAt`.
 */
export function stateOf({ status, doneAt, review, now }: { status: AgentStatus; doneAt?: string | number; review?: boolean; now: number }): SpriteState {
  if (status === 'offline') return 'offline'
  if (status === 'needs-you') return 'needs-you'
  if (status === 'failed') return 'failed'
  if (status === 'working') return 'working'
  if (review) return 'review'
  const at = stamp(doneAt)
  if (at !== null && now - at < DONE_MS) return 'done'
  return 'idle'
}

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, Math.round(value)))

/** Where a row sits in the sheet and how it plays. A row the JSON does not list is one still frame. */
export function rowSpec(sprite: Pick<CustomSprite, 'rows'>, row: SheetRow): { index: number; frames: number; fps: number } {
  const index = SHEET_ROWS.indexOf(row)
  const entry = sprite.rows.find(item => item.state === row)
  return { index, frames: entry ? clamp(entry.frames, 1, 8) : 1, fps: entry ? clamp(entry.fps, 1, 24) : DEFAULT_FPS }
}

/** A sheet url as the page can load it: the hub's file route lives under /api. Anything else is refused. */
export function sheetSrc(url: string): string | null {
  if (!url.startsWith('/') || url.startsWith('//') || /[\\\s"')]/.test(url)) return null
  return url.startsWith('/api/') ? url : `/api${url}`
}
