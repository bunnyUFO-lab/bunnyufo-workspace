// Pure logic for the Floor view of the Team screen: the rooms, which agent sits where, and the ticker.
// Kept out of the .tsx files so Node can test it.
import type { HubEvent } from '../../lib/hub'

export interface RoomDef {
  id: string
  label: string
  note: string
  /** Columns the room takes on the wide grid (4 columns). */
  span: 1 | 2
}

/** The rooms, in the order they are drawn. An agent whose room is not here sits in Ops. */
export const ROOMS: readonly RoomDef[] = [
  { id: 'Command', label: 'Command', note: 'plans, chats, dispatches', span: 2 },
  { id: 'Research', label: 'Research', note: 'web and market', span: 1 },
  { id: 'Art', label: 'Art', note: 'sprites, boards', span: 1 },
  { id: 'Build', label: 'Build', note: 'design and code', span: 2 },
  { id: 'Review', label: 'Review', note: 'verify and play-test', span: 2 },
  { id: 'Ops', label: 'Ops', note: 'digests, tidy cards', span: 2 },
]

export const FALLBACK_ROOM = 'Ops'

/** The id of the room an agent's `room` names; an unknown or empty one is Ops. */
export const roomIdOf = (room: string | undefined): string => ROOMS.find(def => def.id === room)?.id ?? FALLBACK_ROOM

/** The rooms that have agents, in room order, each with its agents in their given order. */
export function floorRooms<T extends { room: string }>(agents: T[]): { room: RoomDef; agents: T[] }[] {
  return ROOMS
    .map(room => ({ room, agents: agents.filter(agent => roomIdOf(agent.room) === room.id) }))
    .filter(entry => entry.agents.length > 0)
}

/** The Floor reads the view the owner chose last; Roster until then. */
export type TeamViewMode = 'roster' | 'floor'
export const VIEW_KEY = 'hub.team.view'
export const viewOf = (stored: string | null): TeamViewMode => (stored === 'floor' ? 'floor' : 'roster')

export const TICKER_MAX = 12
export const TICKER_ROTATE_MS = 4000
export const TICKER_POLL_MS = 60_000

const isTickerKind = (kind: string): boolean => kind.startsWith('session-') || kind === 'ready-for-review' || kind === 'ask-created'

/** An event may name its agent. */
type EventWithAgent = Pick<HubEvent, 'kind' | 'ts' | 'file' | 'title'> & { agent?: string }

/** The agent an event belongs to: the one it names if the team has it, else Claude Code (the hub hooks' events carry no agent). */
export function agentOfEvent(event: { agent?: unknown }, agents: { id: string }[]): string {
  const named = typeof event.agent === 'string' ? event.agent : ''
  return named && agents.some(agent => agent.id === named) ? named : 'claude'
}

export interface TickerLine {
  /** Stable across polls: the same event keeps its key. */
  key: string
  agent: string
  text: string
  ts: string
}

const FALLBACK_TEXT: Record<string, string> = {
  'session-started': 'started a session',
  'session-ended': 'ended a session',
  'ready-for-review': 'has work ready for review',
  'ask-created': 'asked you something',
}

const eventKey = (event: Pick<HubEvent, 'ts' | 'file'>): string => `${event.ts}|${event.file ?? ''}`

/** Add fresh events to the ones held, without repeats. */
export function mergeEvents<T extends Pick<HubEvent, 'ts' | 'file'>>(held: T[], fresh: T[]): T[] {
  const seen = new Set(held.map(eventKey))
  return [...held, ...fresh.filter(event => !seen.has(eventKey(event)))]
}

/** The newest 12 events of the types the Floor shows, newest first, each tied to an agent. */
export function tickerLines(events: EventWithAgent[], agents: { id: string }[], max = TICKER_MAX): TickerLine[] {
  return events
    .filter(event => isTickerKind(event.kind) && Number.isFinite(Date.parse(event.ts)))
    .sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts))
    .slice(0, max)
    .map(event => ({
      key: eventKey(event),
      agent: agentOfEvent(event, agents),
      text: (typeof event.title === 'string' && event.title.trim()) || FALLBACK_TEXT[event.kind] || event.kind,
      ts: event.ts,
    }))
}

/** The line shown after `step` rotations. Reduced motion never rotates: it is always the newest. */
export const lineAt = (lines: TickerLine[], step: number, reduced: boolean): TickerLine | null =>
  lines.length === 0 ? null : lines[reduced ? 0 : ((step % lines.length) + lines.length) % lines.length]

/** The `since` the next poll asks for: the newest event held, else nothing (the server then gives the last day). */
export function nextSince(events: Pick<HubEvent, 'ts'>[]): string | null {
  let newest = 0
  for (const event of events) { const time = Date.parse(event.ts); if (time > newest) newest = time }
  return newest ? new Date(newest).toISOString() : null
}
