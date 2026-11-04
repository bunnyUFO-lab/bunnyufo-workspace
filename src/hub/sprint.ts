// The "Run a sprint" block of a milestone sheet (ws-im1.2.2), as plain functions: the timebox chips, the words for a bead that was left out,
// an item's state, how a sprint ended, and the time left. SprintPanel.tsx draws it.
import type { MapSprint, MapSprintItem } from '../lib/hub'

export interface TimeboxChip { minutes: number; label: string }
/** The three timeboxes, in order: 90 minutes, 4 hours and "until done" (8 hours at most). */
export const TIMEBOXES: readonly TimeboxChip[] = [
  { minutes: 90, label: '90m' },
  { minutes: 240, label: '4h' },
  { minutes: 480, label: 'until done' },
]
/** The chip on when the block opens. */
export const DEFAULT_TIMEBOX = 240

const LEFT_WORDS: Record<string, string> = {
  'needs-owner': 'waits for you', deferred: 'deferred', later: 'not ready yet', question: 'a Wayfinder question', request: 'a run is already on it',
  'open-pr': 'has an open PR', 'in-progress': 'someone is on it', limit: 'over the limit for one sprint',
}
/** Why a bead was left out, in a few words; a blocked one names what it waits for. */
export const leftWord = (reason: string, by?: string): string => (reason === 'blocked' ? `waits for ${by ?? 'another task'}` : LEFT_WORDS[reason] ?? reason)

const ITEM_WORDS: Record<string, string> = {
  waiting: 'Waiting', proposed: 'Queued', approved: 'Queued', taken: 'Starting', running: 'Running', stopping: 'Stopping', asking: 'Asked a question',
  done: 'Done', failed: 'Failed', lost: 'Lost', stopped: 'Stopped', expired: 'Not picked up', declined: 'Declined',
}
export const itemWord = (state: string): string => ITEM_WORDS[state] ?? state

/** States of an item that has not ended: the run is queued, going or stopping. */
const LIVE = new Set(['proposed', 'approved', 'taken', 'running', 'stopping'])
export const isLive = (state: string): boolean => LIVE.has(state)
/** States the Stop button works on (the Hub's own list for a signed stop). */
export const stoppable = (state: string): boolean => LIVE.has(state) && state !== 'stopping' && state !== 'proposed'

/** The item that is going now, or null when none is (the sprint ended, or the next one is about to be made). */
export function currentItem(sprint: MapSprint): MapSprintItem | null {
  return sprint.items.find(item => isLive(item.state)) ?? null
}

/** "Item 2 of 5", from the current item; the last one that started when none is live. */
export function itemLine(sprint: MapSprint): string {
  const live = currentItem(sprint)
  const started = sprint.items.filter(item => item.state !== 'waiting')
  const at = live ? sprint.items.indexOf(live) + 1 : started.length
  return `Item ${Math.max(at, 1)} of ${sprint.items.length}`
}

/** "1 h 20 min left", "45 min left", "less than a minute left" or "time is up". */
export function timeLeft(until: string, now: number): string {
  const ms = Date.parse(until) - now
  if (!Number.isFinite(ms) || ms <= 0) return 'time is up'
  const minutes = Math.floor(ms / 60000)
  if (minutes < 1) return 'less than a minute left'
  const hours = Math.floor(minutes / 60)
  return hours ? `${hours} h ${minutes % 60} min left` : `${minutes} min left`
}

const END_WORDS: Record<string, string> = {
  finished: 'all items done', timebox: 'time ran out', failed: 'an item failed', lost: 'the PC lost an item', stopped: 'you stopped it', expired: 'an item was not picked up in time',
  asking: 'an item asked a question', declined: 'an item was declined', foreign: 'an item did not match the sprint', 'unexpected-outcome': 'an item ended without a pull request or a card',
  refused: 'the Hub could not sign the next item', marked: 'you marked the next item done or not needed',
}
/** "3 of 5 PRs open. Stopped: time ran out" (or "All items done"). */
export function endLine(sprint: MapSprint): string {
  const reason = sprint.ended?.reason ?? ''
  const prs = sprint.ended?.prs ?? sprint.items.filter(item => item.pr).length
  const why = reason === 'finished' ? 'All items done' : `Stopped: ${END_WORDS[reason] ?? reason}`
  return `${prs} of ${sprint.items.length} PRs open. ${why}`
}

/** The text of the confirm: how many beads and for how long. */
export function confirmLine(count: number, minutes: number): string {
  const box = TIMEBOXES.find(chip => chip.minutes === minutes)
  const long = minutes === 90 ? '90 minutes' : minutes === 240 ? '4 hours' : 'up to 8 hours'
  return `Run ${count} ${count === 1 ? 'bead' : 'beads'} one after the other, for ${box ? long : `${minutes} minutes`}. Each opens its own PR on top of the one before; nothing merges.`
}
