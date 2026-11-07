// The Hub's types (they mirror site/api/hub.mjs, hub-map.mjs and hub-chat.mjs) and its fetch
// helpers. Every request carries the local service's bearer token when there is one, so the same
// code runs against the published site and the local app.
import { authHeaders } from '../local/client'
import type { PcSummary, PcWake, WorkingItem } from './hubPc'
import type { NeedsKind } from './needsKinds'
import { clearHub } from './hubCache.mjs'
import type { SpawnTarget } from './hubSpawn'
import { holdReload } from './reloadGate'

export type ItemKind = 'ask' | 'checklist' | 'request' | 'approval' | 'hermes-approval' | 'run-question' | 'pc-stuck' | 'review' | 'blocked' | 'session'
export interface Item {
  kind: ItemKind
  /** A Hermes approval row: the command Hermes asks to run, its reason, the answers it takes, and when it denies by itself. */
  /** A run-question row: what Hermes asked. */
  question?: string
  /** A pc-stuck row (an approved PC job that did not start): its job's title, the cause, 2 or 3 sentences, the step with its command to copy, and which buttons fit. */
  job?: string
  cause?: string
  step?: string
  canWake?: boolean
  cloudOk?: boolean
  command?: string
  description?: string
  choices?: string[]
  expiresAt?: string
  id: string
  project?: string
  title: string
  at: string
  state?: string
  /** A request row that was taken and has given no word past its limit: when it last did. */
  stale?: string
  bead?: string
  url?: string
  /** The desktop app's link to the session (claude://…); only works on the PC that runs the app. */
  appUrl?: string
  card?: string
  host?: string
  session?: string
  summary?: string
  /** A review row: the owner's 2 or 3 sentences and the one line to decide or do. */
  ownerSummary?: string
  ask?: string
  by?: string
  /** A blocked row's event file, which Mark done names. */
  file?: string
  /** A checklist row: items ticked and items in all. */
  done?: number
  total?: number
  /** A blocked session's event: what posted it and why, when it says (`notification_type` or `reason`). */
  source?: string
  reason?: string
  /** The sending tool of an Ask or a checklist. */
  tool?: string
  /** A review row: each leg's result, and the screenshots that came with it. */
  verdicts?: { leg: Verdict['leg']; result: Verdict['result'] }[]
  shots?: number
  /** A review row: its pull requests (https://github.com links) and how many of them have merged. */
  prs?: string[]
  prsMerged?: number
  /** A sprint-end review names its sprint. */
  sprintEnd?: string
  /** A checklist row that is a playtest, and the platform of its build. */
  playtest?: boolean
  platform?: string
  /** An Ask row that is a Design review, with its decisions (or, for a pick, its pictures) counted. */
  design?: boolean
  decisions?: number
  takes?: number
  /** An Ask or a steps list: its sub-type (the file's `kind`, or the Hub's guess when `kindInferred`). */
  subtype?: string
  kindInferred?: boolean
  /** A request row: its preset, where it is proposed to run, and who wrote it (`origin.kind` is owner, agent or run). */
  preset?: string
  target?: string
  origin?: { kind: 'owner' | 'agent' | 'run'; name?: string }
  /** Needs you rows only: the kind, four plain sentences, and (with `detail=1`) the Ask or list itself. */
  needs?: NeedsKind
  describe?: Described
  detail?: Ask | Checklist
}

/** `describeItem` on the server: what a Needs you card says in its four cells. `age` is in minutes. */
export interface Described { kind: NeedsKind; who: string; age: number; what: string; state: string; next: string; blocker: string }

export type EventKind = 'session-started' | 'session-ended' | 'blocked' | 'ready-for-review' | 'pr-opened' | 'pr-merged' | 'pr-closed'
  | 'ci-failed' | 'ci-passed' | 'deployed' | 'ask-created' | 'alert' | 'review-done' | 'resumed' | 'checklist-created' | 'checklist-submitted' | 'run-started' | 'run-finished' | 'profile-change' | 'profile-change-sent' | 'job-change' | 'job-change-sent' | 'session-items' | 'not-useful'
export interface HubEvent {
  ts: string
  kind: EventKind
  project?: string
  bead?: string
  ask?: string
  checklist?: string
  session?: string
  host: string
  source: string
  title: string
  url?: string
  appUrl?: string
  card?: string
  review?: string
  /** An alert made from a request (`source: 'request'`): the request's id. */
  request?: string
  /** An alert about a scheduled job of the Hermes host (ws-eh2): the job's name, which is also its page. */
  job?: string
  /** A cloud alert whose request can fire again (`POST /hub/requests/:id/fire`). */
  retry?: boolean
  /** An alert in Today's panel: the key Dismiss sends (`POST /hub/alerts/dismiss`). */
  key?: string
  /** A run event (`run-started`, `run-finished`): how it ended, and the site path of the card it wrote. */
  outcome?: string
  cardHref?: string
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
/** What the server found for an old review that carried no card: the sprint card by its title, and the files the summary cites that exist. */
export interface InferredCard {
  card: { id: string; title: string }
  section: string
  cardDir: string
  cardFiles: ReviewFile[]
  repo?: string
}
/** GET /api/hub/reviews/:id: the server has checked every link and path in it. */
export interface ReviewDetail {
  id: string
  title: string
  at: string
  summary?: string
  /** The title as posted, when the shown `title` is the owner's title or the old one stripped of its label. */
  fullTitle?: string
  ownerSummary?: string
  ask?: string
  tryIt?: string
  doneMeans?: string
  project?: string
  host?: string
  source?: string
  url?: string
  card?: string
  prs?: string[]
  prsMerged?: number
  /** A sprint-end item: the closing prompt and what is not done, built by the Hub from the signed sprint. */
  closing?: { prompt: string; prs: string[]; left: { seq: number; bead: string; title: string; state: string }[] }
  cardDir?: string
  cardFiles?: ReviewFile[]
  screenshots?: ShotPair[]
  deployUrl?: string
  verdicts?: Verdict[]
  inferred?: InferredCard
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
  /** From the PC's status, else from events. Absent from an older site API. */
  working?: WorkingItem[]
  pc?: PcSummary | null
  /** Whether the PC is awake, waking or off, and whether a wake is set up. Absent from an older site API. */
  wake?: PcWake
  /** Cloud runs fired today against the daily cap; absent when no cloud routine is set up. */
  cloud?: { used: number; cap: number; next: string }
  /** Things the owner could do now: a PC request that has waited 6 hours can move to the cloud. */
  offers?: MoveOffer[]
}

export interface MoveOffer { kind: 'move-to-cloud'; request: string; project?: string; repo?: string; title: string; since?: string }

export interface AskOption { id: string; label: string; image?: string }
export type DecisionVerdict = 'approve' | 'change' | 'skip'
export interface AskDecision { id: string; text: string; detail?: string }
export interface AskAnswer { at: string; by: string; via?: string; help?: HelpAttached; choice?: string; note?: string; drawing?: { excalidraw: string; png: string }; decisions?: Record<string, { verdict: DecisionVerdict; note?: string }> }
export type AskState = 'open' | 'snoozed' | 'answered' | 'picked-up' | 'cancelled' | 'expired'
export interface Ask {
  id: string
  project: string
  bead?: string
  createdAt: string
  expiresAt: string
  from?: { session?: string; host: string; tool: string; run?: string; url?: string }
  question: string
  context?: string
  options?: AskOption[]
  allowNote: boolean
  requirePasskey?: boolean
  /** The Ask's sub-type as written; `subtype` is what the Hub reads from it (or guesses, when `kindInferred`). */
  kind?: 'approval' | 'verify' | 'design' | 'decision'
  /** Set by the Hub on a decision Ask whose bead is an open Wayfinder question: the title Beads has for it (the answer decides that question). */
  beadTitle?: string
  subtype?: string
  kindInferred?: boolean
  allowDrawing: boolean
  /** A Design review: a picture in the Ask's folder, and decisions to approve, change or skip. */
  image?: string
  decisions?: AskDecision[]
  /** A plan (change-list Ask): the rows the PC applies after the owner's answer. */
  changes?: unknown[]
  /** The sprite flow: what an avatar Ask points at (an agent's file; checked again where it is used). */
  avatar?: { agent?: string; request?: string; subject?: string; sheet?: string }
  /** The watcher's "run it again": the run this Ask points at; an answer approves a copy of it (the Hub checks every claim). */
  rerun?: { request?: string; kind?: string; ask?: string; allow?: string[] }
  /** An agent's proposal to edit a chat persona (an agent's file; checked again where it is used). The owner's Apply answer applies it. */
  agentEdit?: { op?: string; agent?: string; base?: string; role?: string; prompt?: string; model?: string; why?: string; profile?: string; primary?: { provider?: string; model?: string }; fallbacks?: { provider?: string; model?: string }[] }
  /** Set by the Hub when Apply would write nothing on this agent-edit Ask: the reason. */
  agentEditBlocked?: string
  /** Set on an agent-edit Ask: the revision of the file the page shows; the answer sends it back so Apply applies exactly that. */
  rev?: string
  /** Set by the Hub when this Ask's rerun pointer would start nothing (it was not written by the PC watcher's token): the reason. */
  rerunBlocked?: string
  state: AskState
  snoozedUntil?: string
  answer?: AskAnswer
  pickup?: { at: string; host: string; session?: string; bead?: string }
  cancel?: { at: string; by: string }
  /** Where the answer went, from files an agent wrote (the server checked every field). Only an answered Ask has it. */
  delivery?: AskDelivery
  files: string[]
}

export type AskDeliveryHow = 'turn' | 'woke' | 'prompt' | 'next-session' | 'start'

export interface AskDelivery {
  state: 'delivered' | 'watching' | 'stale' | 'none'
  how?: AskDeliveryHow
  at?: string
  host?: string
  folder?: string
  session?: string
  /** Minutes between the answer and now, for a watched Ask. */
  minutes?: number
  url?: string
  appUrl?: string
  watchers?: number
}

export interface ChecklistItem {
  id: string
  text: string
  group?: string
  guide?: string
  link?: string
  /** Exactly the text the owner runs; shown under the item as a code block with a Copy button. */
  command?: string
  /** The command's language (the code block's), which decides how Copy treats it. */
  shell?: 'bash' | 'powershell' | 'cmd'
  done: boolean
  /** When the winning tick or untick was written. */
  at?: string
}
export type PlaytestVerdict = 'ship' | 'fix-first' | 'rethink'
export interface PlaytestIssue { text: string; shot?: string }
export type ChecklistState = 'open' | 'submitted' | 'picked-up' | 'cancelled'
/** GET /api/hub/checklists/:id: the list as the agent wrote it, with each item's state from the mark files. */
export interface Checklist {
  id: string
  project: string
  createdAt: string
  from?: { host?: string; tool?: string; session?: string }
  bead?: string
  title: string
  context?: string
  card?: string
  state: ChecklistState
  done: number
  total: number
  items: ChecklistItem[]
  /** A playtest: the build to open, its platform and what to look for. */
  kind?: 'steps' | 'playtest' | 'verify' | 'setup' | 'investigate' | 'develop'
  /** The Hub's reading of `kind` for a steps list: the file's value, or a guess (`kindInferred`). */
  subtype?: string
  kindInferred?: boolean
  build?: string
  platform?: string
  lookFor?: string
  submit?: { help?: HelpAttached; at: string; by: string; note?: string; done: string[]; open: string[]; rating?: number; verdict?: PlaytestVerdict; issues?: PlaytestIssue[] }
  pickup?: { at: string; host: string; session?: string }
  /** Where the submission went, from files an agent wrote (the server checked every field). Only a submitted checklist has it. */
  delivery?: AskDelivery
  cancel?: { at: string; by: string }
  files: string[]
  /** The newest picture per step (by step number, "03") and the playtest screenshots; files in the checklist's folder, shown through `fileUrl`. */
  evidence?: Record<string, { file: string; at: string }>
  shots?: { file: string; at: string }[]
}

/** Where a project's work runs by default: the Gaming PC, the cloud, or only when the owner starts it at the PC. */
export type RunsOn = 'pc' | 'cloud' | 'at-pc'
export interface HubProject { id: string; name: string; beads: boolean; pushedAt?: string; order?: number; runsOn?: RunsOn }

export type TaskState = 'done' | 'doing' | 'you' | 'next' | 'later'
export type Sign = 'working' | 'idle' | 'new' | 'pr' | 'ci-failed' | 'review' | 'deployed'
/**
 * One pull request of a task: `prUrl` is only the open one; this keeps merged ones too. A row from the
 * events has a date and a state; one from Beads has a number, maybe a state, and the issue's date.
 */
export interface MapPr { url?: string; state?: 'open' | 'merged' | 'closed'; at: string; number?: number }
/** A Library card the item names: its title and the site path that opens it. */
export interface MapCard { title: string; href: string }
export interface MapTask {
  id: string; title: string; state: TaskState; status: string; signs: Sign[]; sprints: string[]
  deps: string[]; ask?: string; prUrl?: string; prs?: MapPr[]; closedAt?: string
  /** When the issue last changed in Beads; the Roadmap's date filter reads it. */
  updatedAt?: string
  /** Why the task is yellow: an open Ask, an open checklist, or only the `needs-owner` label. */
  you?: 'ask' | 'checklist' | 'label'
  /** The open checklist that names the task. */
  checklist?: string
  /** The newest request made from this bead that has not ended (the Roadmap's Do it block shows it instead of the buttons). */
  run?: { id: string; state: string }
  /** One or two plain sentences saying what the work is, from the description. */
  summary?: string
  closeReason?: string
  cards?: MapCard[]
  commits?: { sha: string; url?: string }[]
  /** The owner marked it on the Roadmap and no agent has closed it in Beads yet: it shows closed. */
  mark?: { verdict: 'done' | 'not-needed' | 'unblock'; at: string; pending: boolean; /** The owner's decision, for a Wayfinder question. */ reason?: string }
}
/** A bead that says it needs the owner but has no Ask, checklist or Needs you item (GET /hub/unasked). */
export interface UnaskedItem { project: string; id: string; title: string; status: string; href: string; reason?: string; mark?: { verdict: 'done' | 'not-needed'; at: string } }
export interface MapNotes { summary?: string; closedAt?: string; closeReason?: string; cards?: MapCard[] }
export interface MapFeature extends MapNotes { id: string; title: string; state: TaskState; tasks: MapTask[] }
/** One bead of a sprint: the id of its request, the bead, and its request's state (`waiting` until the request exists) with the PR it opened. */
export interface MapSprintItem { id: string; bead: string; title: string; state: string; pr?: string }
/** The newest sprint on a milestone (ws-im1.2.2): `ended` once it stopped, with why and how many PRs it opened. */
export interface MapSprint { head: string; until: string; items: MapSprintItem[]; ended?: { reason: string; at?: string; prs?: number } }
export interface MapMilestone extends MapNotes {
  id: string; title: string; state: TaskState; features: MapFeature[]; sprint?: MapSprint
  /** The roadmap above it (ws-im1.3.2); absent for a milestone in no roadmap. */
  roadmap?: string
}
/** A roadmap: an epic labelled `roadmap` that holds milestones and other roadmaps (`parent`). Only the roadmaps' own list is nested; `milestones` stays flat. */
export interface MapRoadmap { id: string; title: string; state: TaskState; parent?: string }
/** `GET /hub/map/:project/sprint/:milestone`: the beads a sprint would run, the ones left out and why, and the sprint that is going on the project. */
export interface SprintPreview {
  allowed: boolean; why?: string; max: number
  items: { id: string; title: string }[]
  left: { id: string; title: string; reason: string; by?: string }[]
  active: { head: string; milestone: string; until: string } | null
  /** What the list was when shown: Start sends it back, and a changed list is a 409. */
  digest?: string
}
/** `GET /hub/project-cards?project=<id>`: the cards of the section whose id is the project's (newest first, at most 20; `total` is all of them). `section` is null when there is no such section. */
export interface ProjectCards { section: string | null; cards: { title: string; href: string; updated?: string }[]; total: number; /** The owner has not turned agent cards off for this section. */ agents?: boolean }

/** One row of `GET /hub/card-writes`: what one agent write (a batch) did to a project section. `agent`, `why` and `context` are the agent's own words; `token` is proven. */
export interface CardWriteGroup {
  batch: string
  folder: string
  agent: string
  token: string
  why: string
  /** `chat` or `job:<request id>`. */
  context: string | null
  at: string | null
  files: { file: string; kind: 'new-card' | 'new-tab' | 'edit' }[]
  title: string
  cardTitle?: string
  canRevert: boolean
  reverted?: { at: string | null; by: string; partial?: boolean; /** Nothing was undone: the owner had changed the file after the agent. */ left?: boolean }
}
export interface CardWrites { groups: CardWriteGroup[]; /** There are older writes than these (`?older=1` reads them). */ more?: boolean }
/** The answer to a Revert. */
export interface CardRevert { restored: string[]; removedTabs: string[]; trashed: string[]; skipped: string[]; /** Files of the batch the Revert did not touch, because someone else changed them after the agent's first write. */ leftAlone?: { file: string; why: string }[]; reverted: { at: string; by: string }; recorded: boolean }
/** `GET /hub/card-write-sections`: where agents may add cards. `saved` is false until the owner has saved the list once. */
export interface CardWriteSections { sections: { id: string; name: string; on: boolean; locked?: boolean }[]; saved: boolean; unreadable?: boolean }
export interface ProgressMap {
  project: string
  meta: { pushedAt: string; host: string; count: number; repo: string } | null
  ageMinutes: number | null
  milestones: MapMilestone[]
  sprints: { name: string; /** The group issue that carries the label and names the sprint. */ title?: string; milestones: { id: string; count: number; total: number }[] }[]
  /** The project's roadmaps in order; left out when it has none. */
  roadmaps?: MapRoadmap[]
  /** The Wayfinder destination, when the project has an open `wayfinder:map` issue. */
  wayfinder: MapWayfinder | null
}
/** One open Wayfinder question: what a run or a session needs to work on it. `blockedBy` lists the titles of open tickets it waits for, `unlocks` the ones it releases. */
export interface WayfinderQuestion { id: string; title: string; type: string; question?: string; blockedBy: string[]; unlocks: string[]; cards?: string[] }
export interface MapWayfinder { mapId: string; mapTitle: string; destination: string | null; notes: string | null; decisions: number; open: WayfinderQuestion[] }

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

// A write from this browser empties the last-answer store (src/lib/hubCache.mjs) before any hook
// refetches. Registered at module level so it always runs ahead of a hook's own listener: the
// refetch then takes the new stamp. Do not move this into a component.
if (typeof window !== 'undefined') {
  window.addEventListener(HUB_WROTE, () => clearHub())
  // Cards are written through the workspace routes; only the Library read depends on them.
  window.addEventListener('bunnyufo-workspace-changed', () => clearHub('/project-cards'))
}

/** `quiet`: a write that no badge or list depends on (a queued chat message) does not make every screen fetch again. `keepalive`: the browser finishes the request even if the page goes away (a held answer flushed as the phone sleeps); the body must stay under 64 KB. */
export async function hubPost<T>(path: string, data: unknown = {}, signal?: AbortSignal, quiet = false, keepalive = false): Promise<T> {
  const changed = () => { if (!quiet) window.dispatchEvent(new Event(HUB_WROTE)) }
  const release = holdReload()   // an update reload waits for this write
  try {
    const answer = await parse<T>(await fetch(`/api/hub${path}`, {
      method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify(data), signal, ...(keepalive ? { keepalive: true } : {}),
    }))
    changed()
    return answer
  } catch (failure) {
    // "Already answered" means the Hub moved on without this screen, so the counts have changed too.
    if (failure instanceof HubError && failure.status === 409) changed()
    // Any other failure (a cut connection, a 500) may still have written something.
    else clearHub()
    throw failure
  } finally {
    release()
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

/** A session's web link: exactly https://claude.ai/code/session_<id>, anchored at both ends. A look-alike host, http, an extra path, a query or the bare https://claude.ai/code (a new chat) is no link: the text came from an agent. */
export const sessionUrl = (value: string | undefined): string | undefined => (value && /^https:\/\/claude\.ai\/code\/session_[A-Za-z0-9]+$/.test(value) ? value : undefined)

/** The desktop app's link to a session, and nothing else that starts with claude://. */
export const appUrl = (value: string | undefined): string | undefined => (value && /^claude:\/\/claude\.ai\/epitaxy\/local_[0-9a-f-]{36}$/.test(value) ? value : undefined)

export interface ChatImage { file: string; type: string; width: number; height: number }
/** What a help chat is about: the stored kind of the item, its id, and the step in focus. */
export interface ChatAbout { kind: 'ask' | 'checklist' | 'review' | 'blocked'; id: string; step?: string; title: string }
/** A job a reply named (`GET /hub/chat/:id/jobs`), built from the request file. A proposal waits for the owner; the rest follow the run. */
export interface ChatJob {
  id: string; title: string; text: string; project: string; preset?: string; agent?: string; runsOn?: SpawnTarget; produces?: string
  repo?: string; model?: string; minutes?: number; doneWhen?: string; estimate?: { cost: string; time: string }; tokens?: { low: number; high: number }
  /** Who the file says wrote it, and whether the Hub could confirm it is Hermes's own proposal from this reply. */
  writer: string; verified: boolean
  state: string; stale?: string; approvable: boolean; why?: string; flag?: 'persona'; by: string; nothing?: boolean
  finish?: { outcome: string; pr?: string; card?: string; cardHref?: string }
}
/** What one tap did to each id, in the order they were signed. Not atomic: a signed approval stands when a later one fails. */
export interface ChatJobResult { id: string; ok: boolean; state?: string; waiting?: string; error?: string }
export interface ChatLine { role: 'user' | 'assistant' | 'context'; text: string; at: string; created?: Item[]; /** the ids of the jobs this reply named */ jobs?: string[]; images?: ChatImage[]; about?: ChatAbout; run?: string; tools?: string[]; delegates?: ChatDelegate[]; model?: string; persona?: string; /** the ids of the queued messages this turn joined */ queued?: string[]; /** a Stop ended the turn before any text: the owner's line carries the note, the history has no extra line */ stopped?: boolean }
/** A message sent while a reply was running, waiting for it to end. */
export interface ChatQueued { id: string; text: string; at: string; model?: string; /** why this row is not going out: the hold's reason when it was held, or `joined` when it was typed during a hold */ why?: ChatHeld['reason'] | 'joined' }
/** Why the waiting messages are not going out by themselves. */
export interface ChatHeld { reason: 'stopped' | 'failed' | 'lost' | 'long' | 'old'; at: string }
/** One thing a job delivered, openable. A task is only a project and an id: the page builds its link. */
export type Deliverable =
  | { kind: 'card'; ref: string; section: string; title?: string; href?: string }
  | { kind: 'pr'; href: string; label: string }
  | { kind: 'ask' | 'checklist' | 'job'; id: string; title: string; state: string }
  | { kind: 'task'; project: string; id: string; title?: string }
export interface JobPill { text: string; tone: 'good' | 'warn' | 'quiet' }
/** A row of `GET /hub/jobs`. `runner` is where it runs (`hermes`, `cloud`, `pc`); `at` is when it started, `finishedAt` when it ended. */
export interface JobListRow {
  id: string; title: string; project: string; preset: string; state: string; agent?: string; runner?: string; stale?: string
  at: string; finishedAt?: string; nothing?: boolean; deliverables: Deliverable[]; pills: JobPill[]
}
export interface JobsView { counts: { running: number; finished: number }; jobs: JobListRow[]; window: string }
/** What the queue routes answer. */
export interface ChatQueueView { queued: ChatQueued[]; held: ChatHeld | null }
/** A delegate Hermes started with `delegate_task`. `unknown`: no result reached the Hub in two hours. */
export interface ChatDelegate { id: string; index?: number; count?: number; goal: string; state: 'running' | 'done' | 'failed' | 'unknown'; summary?: string; seconds?: number }
export interface ChatSummary { id: string; title: string; updated: string | null; count: number; about?: ChatAbout; model?: string; persona?: string; /** the owner renamed it: the title is theirs, not the first message */ renamed?: boolean; /** ISO times of the pin, the archive and the Trash (null: not set) */ pinned?: string | null; archived?: string | null; trashed?: string | null; unread?: boolean; /** its first reply is still running: the chat has no transcript yet */ running?: boolean }
/** One chat's marks (`chat/state.json`): what `GET /hub/chat/<id>` and `POST /hub/chat/<id>/state` answer. */
export interface ChatMarks { title: string | null; pinned: string | null; archived: string | null; trashed: string | null; unread: boolean }
/** What `POST /hub/chat/<id>/state` takes: any of these. `title` null or blank clears a rename. */
export type ChatPatch = { title?: string | null; pinned?: boolean | null; archived?: boolean | null; trashed?: boolean | null; unread?: boolean | null }
/** `GET /hub/chat`: one page of a view, and the counts of the Archived and Trash rows. */
export interface ChatListAnswer { conversations: ChatSummary[]; models?: ChatModel[]; personas?: ChatPersona[]; chain?: string[]; pauses?: import('../hub/chatModel').ChatPause[]; autoFirst?: string; counts?: { active: number; archived: number; trashed: number }; total?: number; more?: boolean; offset?: number }
/** An agent a new chat may talk to instead of Hermes: the id is all the page ever sends. */
export interface ChatPersona { id: string; name: string; role: string; /** The Spawn preset this agent takes; none for an agent that only chats (the Planner). */ preset?: string; /** the model id this agent's chat starts on */ model?: string }
/** A model the chat may ask Hermes for: the id is all the page ever sends. */
export interface ChatModel { id: string; label: string; note: string }
/** What Hermes will be given for an item, as the preview route shows it. */
export interface HelpPreview { about: ChatAbout; title: string; text: string; pictures: { path: string; label?: string }[] }
/** The excerpt an answer or a submission carries when the owner attached a help chat. */
export interface HelpAttached { chat: string; lines: number; excerpt: string }
/** A tool Hermes is using (or used) during a turn. */
export interface ChatTool { id: string; name: string; summary?: string; state: 'running' | 'done' | 'failed' }
/** An approval Hermes asked for during a turn; the answer goes to `/hub/hermes-approvals/<id>/answer`. */
export interface ChatApproval { id: string; title: string; command?: string; description?: string; choices: string[]; expiresAt: string }
