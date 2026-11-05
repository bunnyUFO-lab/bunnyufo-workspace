// The words about a change of a Hermes profile's model, in one place: the Edit page, Details and the Ask use the same ones (ws-ubo.6).
// The server keeps a copy of the time text in site/api/hub-agent-edit.mjs for the Ask text; the UI and Hub tests pin each copy's exact words.
import type { ProfileChange } from '../lib/hubTeam'

/** How long a change takes. */
export const CHANGE_TIME_TEXT = "Usually done in about a minute, at most 5 if the host's quick check is off."

export const restartText = (profile: string) => `Changing this restarts Hermes ${profile}. ${CHANGE_TIME_TEXT} A chat or job running then stops.`

export const BRIEFS_WAIT_TEXT = 'If the weekly jobs are running, it waits until they end, up to an hour.'
export const AUTO_FOLLOWS_TEXT = 'A chat set to Auto follows this. A chat set to a named model stays on that model.'

/** `applied` and `live` are one word: the host said the gateway came up on the new model. `data-state` keeps the four states apart. */
export const STATE_WORDS: Record<ProfileChange['state'], string> = { waiting: 'Sent, not running yet', applied: 'Running', live: 'Running', failed: 'Failed', late: 'Not picked up' }

/** A confirmed change is replaced when another order is in use now (a way back, or an edit on the host). */
export const REPLACED_WORD = 'Replaced'
export const replacedText = (change: Pick<ProfileChange, 'to'>, when: string) => `The change to ${change.to.model} was confirmed ${when}. The host has been changed since, so it no longer runs. The settings below are what it has now.`

/** After this long with no answer, the host is probably off. */
export const WAITING_TOO_LONG_MS = 10 * 60 * 1000
/** The details are read this often while a change waits. */
export const POLL_MS = 5000

export const waitingText = (change: Pick<ProfileChange, 'profile' | 'to'>, sent: string) =>
  `Changing Hermes ${change.profile} to ${change.to.model}. Sent ${sent}. Not running yet: the old model answers until the restart, usually within 40 seconds of pressing. This says Running when the new model is confirmed.`

export const NOT_PICKED_UP_TEXT = 'The Hermes host has not picked this up. It may be off. Nothing has changed.'

/** "14:32" in the reader's own time. */
export const clock = (iso: string) => {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/** "Running: gpt-6-sol, since 14:32." and, until the next export, that the settings below catch up. */
export const runningText = (change: Pick<ProfileChange, 'to' | 'runningAt' | 'resultAt' | 'at'>, caughtUp: boolean) => {
  const since = clock(change.runningAt ?? change.resultAt ?? change.at)
  return `Running: ${change.to.model}${since ? `, since ${since}` : ''}.${caughtUp ? '' : ' The settings below catch up within seconds.'}`
}
