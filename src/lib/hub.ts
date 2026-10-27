// The Hub's types (they mirror site/api/hub.mjs, hub-map.mjs and hub-chat.mjs) and its fetch
// helpers. Every request carries the local service's bearer token when there is one, so the same
// code runs against the published site and the local app.
import { authHeaders } from '../local/client'

export type ItemKind = 'ask' | 'request' | 'review' | 'blocked' | 'session'
export interface Item {
  kind: ItemKind
  id: string
  project?: string
  title: string
  at: string
  state?: string
  bead?: string
  url?: string
  /** The desktop app's link to the session (claude://…); only works on the PC that runs the app. */
  appUrl?: string
  card?: string
  host?: string
  session?: string
  summary?: string
  by?: string
}

export type EventKind = 'session-started' | 'session-ended' | 'blocked' | 'ready-for-review' | 'pr-opened' | 'pr-merged'
  | 'ci-failed' | 'ci-passed' | 'deployed' | 'ask-created' | 'alert' | 'review-done' | 'resumed'
export interface HubEvent {
  ts: string
  kind: EventKind
  project?: string
  bead?: string
  ask?: string
  session?: string
  host: string
  source: string
  title: string
  url?: string
  appUrl?: string
  card?: string
  review?: string
  summary?: string
  file: string
  prs?: string[]
  cardDir?: string
  cardFiles?: string[]
  screenshots?: string[]
  deployUrl?: string
  verdicts?: Verdict[]
}

export interface Verdict { leg: 'smoke' | 'review' | 'qa'; result: 'pass' | 'fail' | 'noted'; text: string }
export interface ReviewFile { path: string; label: string }
export interface ShotPair { label: string; before?: string; after?: string; other?: string }
/** GET /api/hub/reviews/:id: the server has checked every link and path in it. */
export interface ReviewDetail {
  id: string
  title: string
  at: string
  summary?: string
  project?: string
  host?: string
  source?: string
  url?: string
  card?: string
  prs?: string[]
  cardDir?: string
  cardFiles?: ReviewFile[]
  screenshots?: ShotPair[]
  deployUrl?: string
  verdicts?: Verdict[]
  done: boolean
  doneAt?: string
  doneBy?: string
}

export interface Today {
  counts: { needsYou: number; running: number; recent: number; alerts: number }
  needsYou: Item[]
  running: Item[]
  recent: HubEvent[]
  alerts: HubEvent[]
  at: string
}

export interface AskOption { id: string; label: string; image?: string }
export interface AskAnswer { at: string; by: string; via?: string; choice?: string; note?: string; drawing?: { excalidraw: string; png: string } }
export type AskState = 'open' | 'snoozed' | 'answered' | 'picked-up' | 'cancelled' | 'expired'
export interface Ask {
  id: string
  project: string
  bead?: string
  createdAt: string
  expiresAt: string
  from?: { session?: string; host: string; tool: string; run?: string }
  question: string
  context?: string
  options?: AskOption[]
  allowNote: boolean
  requirePasskey?: boolean
  allowDrawing: boolean
  state: AskState
  snoozedUntil?: string
  answer?: AskAnswer
  pickup?: { at: string; host: string; session?: string; bead?: string }
  cancel?: { at: string; by: string }
  files: string[]
}

export interface HubProject { id: string; name: string; beads: boolean; pushedAt?: string }

export type TaskState = 'done' | 'doing' | 'you' | 'next' | 'later'
export type Sign = 'working' | 'idle' | 'new' | 'pr' | 'ci-failed' | 'review' | 'deployed'
/** One pull request of a task: `prUrl` is only the open one; this keeps merged ones too. */
export interface MapPr { url?: string; state: 'open' | 'merged'; at: string }
export interface MapTask {
  id: string; title: string; state: TaskState; status: string; signs: Sign[]; sprints: string[]
  deps: string[]; ask?: string; prUrl?: string; prs?: MapPr[]; closedAt?: string
}
export interface MapFeature { id: string; title: string; state: TaskState; tasks: MapTask[] }
export interface MapMilestone { id: string; title: string; state: TaskState; features: MapFeature[] }
export interface ProgressMap {
  project: string
  meta: { pushedAt: string; host: string; count: number; repo: string } | null
  ageMinutes: number | null
  milestones: MapMilestone[]
  sprints: { name: string; milestones: { id: string; count: number; total: number }[] }[]
}

export class HubError extends Error {
  status: number
  body: Record<string, unknown> | null
  constructor(message: string, status: number, body: Record<string, unknown> | null) {
    super(message)
    this.status = status
    this.body = body
  }
}

async function parse<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => null) as Record<string, unknown> | null
  if (!response.ok) throw new HubError(typeof body?.error === 'string' ? body.error : `The Hub answered ${response.status}.`, response.status, body)
  return body as T
}

export async function hubGet<T>(path: string, signal?: AbortSignal): Promise<T> {
  return parse<T>(await fetch(`/api/hub${path}`, { headers: authHeaders(), cache: 'no-store', signal }))
}

/** Fired on window after a Hub write, so the data behind the badges is fetched again at once. */
export const HUB_WROTE = 'buw:hub-wrote'

export async function hubPost<T>(path: string, data: unknown = {}, signal?: AbortSignal): Promise<T> {
  const changed = () => window.dispatchEvent(new Event(HUB_WROTE))
  try {
    const answer = await parse<T>(await fetch(`/api/hub${path}`, {
      method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify(data), signal,
    }))
    changed()
    return answer
  } catch (failure) {
    // "Already answered" means the Hub moved on without this screen, so the counts have changed too.
    if (failure instanceof HubError && failure.status === 409) changed()
    throw failure
  }
}

export const fileUrl = (path: string) => `/api/hub/file?path=${encodeURIComponent(path)}`

/** Remembered in this browser only; a blocked store just means nothing is remembered. */
export function remember(key: string, value?: string): string | null {
  try {
    if (value !== undefined) localStorage.setItem(key, value)
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

export function clock(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export function ago(iso: string, now = Date.now()): string {
  const minutes = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60000))
  if (Number.isNaN(minutes)) return ''
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  if (minutes < 48 * 60) return `${Math.floor(minutes / 60)} h ago`
  return `${Math.floor(minutes / 1440)} days ago`
}

/** "Beads copy from 20 min ago", as hours at 120 minutes and days at 48 hours. */
export function copyAge(minutes: number): string {
  if (minutes >= 48 * 60) return `${Math.floor(minutes / 1440)} days ago`
  if (minutes >= 120) return `${Math.floor(minutes / 60)} h ago`
  return `${minutes} min ago`
}

/** A link from an event or item is shown only when it is plain http(s): the text came from an agent. */
export const safeUrl = (value: string | undefined): string | undefined => (value && /^https?:\/\//i.test(value) ? value : undefined)

/** A blocked session's web link: https, and never the bare https://claude.ai/code, which opens a new chat. */
export const sessionUrl = (value: string | undefined): string | undefined => (value && /^https:\/\//i.test(value) && !/^https:\/\/claude\.ai\/code\/?$/i.test(value.trim()) ? value : undefined)

/** The desktop app's link to a session, and nothing else that starts with claude://. */
export const appUrl = (value: string | undefined): string | undefined => (value && /^claude:\/\/claude\.ai\/epitaxy\/local_[0-9a-f-]{36}$/.test(value) ? value : undefined)

export interface ChatImage { file: string; type: string; width: number; height: number }
export interface ChatLine { role: 'user' | 'assistant'; text: string; at: string; created?: Item[]; images?: ChatImage[] }
export interface ChatSummary { id: string; title: string; updated: string | null; count: number }
