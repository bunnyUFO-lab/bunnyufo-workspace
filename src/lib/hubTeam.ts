// The Team screen's data, as the site API sends it (site/api/hub-team.mjs).
import type { WorkingItem } from './hubPc'

export type AgentStatus = 'working' | 'needs-you' | 'failed' | 'idle' | 'offline'

/** The nine rows of a pet sheet, top to bottom. */
export type SheetRow = 'idle' | 'run-right' | 'run-left' | 'waving' | 'jumping' | 'failed' | 'waiting' | 'running' | 'review'

/** A checked custom pet sheet as the sprite of an agent. `url` is a path under the API base (`/api` + url). */
export interface CustomSprite {
  kind: 'custom'
  sheet: string
  url: string
  frame: { w: 192; h: 208 }
  cols: 8
  rows: { state: SheetRow; frames: number; fps: number }[]
}

/** What an avatar choice resolves to. Matches SpriteChoice in src/hub/team/sprites.ts. */
export type AvatarSprite =
  | { kind: 'builtin'; key: string }
  | { kind: 'random'; salt: number; name: string }

/** The body of POST /api/hub/team/:agent/avatar. */
export type AvatarChoice =
  | { kind: 'builtin'; key: string }
  | { kind: 'random'; salt: number }
  | { kind: 'custom'; sheet: string }

/** One entry of GET /api/hub/team/:agent/sheets. */
export interface SheetInfo {
  sheet: string
  at: string
  rows: CustomSprite['rows']
  url: string
  current: boolean
}

/** The one main button of a card: Chat on a persona, or Spawn on a preset (with the project and text filled in when given). */
export type TeamAction =
  | { label: string; chat: string }
  | { label: string; preset: string; project?: string; text?: string }

export interface TeamAgent {
  id: string
  name: string
  room: string
  runtime: string
  model: string
  role: string
  action: TeamAction
  /** The Hermes profile it runs on (`main`, `briefs`), none for Claude Code. */
  profile?: AgentProfile
  /** Spawn presets this agent takes; Details shows the first one's job template. */
  presets?: string[]
  status: AgentStatus
  task: string
  /** Built-in or random, or a custom pet sheet once the owner has chosen one. */
  sprite: AvatarSprite | CustomSprite
  /** Claude Code only: its sessions, as Working now lists them. */
  sessions?: WorkingItem[]
  /** What the Edit page may change: the chat persona of the research agents, and the model of an agent on a Hermes profile. */
  editable?: { persona?: boolean; profile?: boolean }
  /** The label of the chat model an edited persona starts a chat on; none while the persona follows the app's text. */
  chatModel?: string
  /** A persona the owner made from a template: it chats, can be retired, and has no sprite sheet job. */
  custom?: boolean
}

export interface TeamView {
  agents: TeamAgent[]
}

/** The Hermes profile an agent runs on; none for Claude Code. */
export type AgentProfile = 'main' | 'briefs' | null

/** One prompt on the details page. `hermes-host` text was read from the Hermes host; `app` text is in the app's code. */
export interface DetailsPrompt {
  id: 'soul' | 'persona' | 'job'
  title: string
  source: 'hermes-host' | 'app'
  text: string
  note?: string
}

export interface DetailsJob {
  name: string
  schedule: string
  enabled: boolean
  prompt: string
}

/** A profile's settings as the Hermes host's export gave them (no SOUL.md, no jobs). Absent parts are omitted. */
export interface ProfileSettings {
  model?: { provider?: string; default?: string }
  fallbacks: { provider: string; model: string }[]
  /** The order the profile runs on now: the export's, or the last change the host confirmed when no export shows it yet. Absent when the host did not say. */
  effective?: ModelSet
  /** The models the Hermes host would apply for this profile; none until its exporter publishes the list. */
  modelOptions?: ModelRef[]
  toolsets?: string[]
  platformToolsets?: Record<string, string[]>
  skills: { autoLoad: string[]; installed: string[] }
  terminal?: { backend?: string; containerMemoryMb?: number }
}

export interface ModelRef { provider: string; model: string }
/** A primary model with its fallbacks, in order. */
export interface ModelSet extends ModelRef { fallbacks: ModelRef[] }

/** Where a signed change of a profile's model stands: sent, applied by the host, shown in its export, failed, or not picked up in time. */
export type ChangeState = 'waiting' | 'applied' | 'live' | 'failed' | 'late'

/** One change of a profile's model and fallback order (site/api/hub-agent-config.mjs changeView). `reason` is the Hub's words for the host's code. */
export interface ProfileChange {
  id: string
  profile: 'main' | 'briefs'
  state: ChangeState
  at: string
  by: string
  from: ModelSet
  to: ModelSet
  resultAt?: string
  /** When the host's result landed in the bucket: after the new model was confirmed. Falls back to `resultAt` on the page. */
  runningAt?: string
  /** The host confirmed this change, but another order is in use now (a way back, or an edit on the host): it does not say Running. */
  replaced?: boolean
  code?: string
  reason?: string
  rolledBack?: boolean
}

/** What the owner's press on the Edit page answers (201): the change is signed and waits for the Hermes host. */
export interface ProfileChangeAnswer {
  change: string
  state: 'waiting'
  from: ModelSet
  to: ModelSet
}

/** `fresh` under 7 h, `stale` from 7 h, `missing` when the host has published nothing usable, `none` for an agent without a profile. */
export interface DetailsFreshness {
  state: 'fresh' | 'stale' | 'missing' | 'none'
  exportedAt?: string
  changedAt?: string
  ageSeconds?: number
}

/** GET /api/hub/team/:agent/details */
export interface AgentDetailsView {
  agent: { id: string; name: string; role: string; room: string; runtime: string; profile: AgentProfile; editable?: { persona?: boolean; profile?: boolean }; chatModel?: string }
  freshness: DetailsFreshness
  settings: ProfileSettings | null
  prompts: DetailsPrompt[]
  jobs: DetailsJob[]
  /** The newest change of the profile that waits or ended in the last day, and the recent ones, newest first. */
  change?: ProfileChange
  changes?: ProfileChange[]
}

/** One version of a persona on the Edit page. `default` is the app's own text (a stored "back to the app's text" is a default row too). */
export interface PersonaVersion {
  id: string
  at: string
  by: string
  default?: boolean
  /** The first version of a persona the owner made. */
  created?: boolean
  /** The retirement of a made persona: no text, and nothing to revert to. */
  retired?: boolean
  role?: string
  prompt?: string
  model?: string
  note?: string
  revertOf?: string
  fromAsk?: string
}

/** GET /api/hub/team/:agent/persona, and what a save or a revert answers beside `ok` and `version`. */
export interface PersonaView {
  current: { version: string; role: string; prompt: string; model: string }
  /** The app's own text; null for a persona the owner made. */
  default: { role: string; prompt: string; model: string } | null
  versions: PersonaVersion[]
  models: { id: string; label: string; note: string }[]
  custom?: boolean
  name?: string
  retired?: boolean
}

/** One template of a new persona (GET /api/hub/team/templates). `text` shows `<name>` and `<role>` where the owner's words go. */
export interface PersonaTemplate { id: string; label: string; line: string; text: string }

/** A retired persona with what Bring back needs: the version to go back to and the one the page looks at. */
export interface RetiredPersona { id: string; name: string; role: string; to: string; base: string }

export interface TemplatesView { templates: PersonaTemplate[]; retired: RetiredPersona[]; max: number }

/** One skill of GET /api/hub/team/skills. `agents` are the agents on the profiles that have it; an owner skill no profile has lists none. */
export interface TeamSkill {
  id: string
  autoLoad: boolean
  owner: boolean
  profiles: string[]
  autoLoadProfiles: string[]
  sources: ('autoLoad' | 'installed' | 'owner')[]
  agents: { id: string; name: string; profile: AgentProfile }[]
}

/** GET /api/hub/team/skills (site/api/hub-team-skills.mjs). `skills: null` on an agent means the Hub does not know its list. */
export interface TeamSkillsView {
  exportedAt: string | null
  fresh: boolean
  maybeCut: boolean
  skills: TeamSkill[]
  agents: { id: string; name: string; profile: AgentProfile; skills: string[] | null; autoLoad: string[] | null; note?: string }[]
  plugins: { known: boolean; text: string; items: TeamPlugin[] }
}

/** One plugin of the Hermes export: its status on each profile that lists it. */
export interface TeamPlugin {
  name: string
  version: string
  source: string
  description: string
  profiles: { profile: 'main' | 'briefs'; status: 'enabled' | 'disabled' | 'not enabled' }[]
}

/** Where a job posts, or where its failures go: the platform and a label the host chose. */
export interface JobTarget { platform: string; label: string }

/**
 * One scheduled job of the Hermes host (GET /api/hub/schedules, site/api/hub-agent-config.mjs). Every field after `prompt` is absent when the
 * host's exporter did not send it: the page says "not reported", it never guesses.
 */
export interface ScheduleJob {
  name: string
  profile: string
  schedule: string
  enabled: boolean
  prompt: string
  scheduleKind?: string
  state?: string
  model?: string
  provider?: string
  postsTo?: JobTarget | null
  failuresTo?: JobTarget | null
  script?: string
  nextRunAt?: string
  lastRunAt?: string
  lastStatus?: string
  lastError?: string
  lastDeliveryError?: string
  failureStreak?: number
  runsDone?: number
  promptSha256?: string
  promptBytes?: number
  promptCut?: boolean
  promptRedacted?: number
  rev?: string
  /** Set only for a signed-in viewer when the host can apply a job change (ws-eh2 G). */
  editable?: boolean
  /** The prompt can be edited here: it is whole, neither cut nor redacted in the export. */
  promptEditable?: boolean
  /** The job's newest change from this page, while it waits and for a day after it ended. */
  change?: JobChange
}

/** What a signed job change did to the job: the words of the result come from the Hub (`reason`). The prompt text is never sent, only that it moved. */
export interface JobChange {
  id: string
  op: 'edit' | 'pause' | 'resume' | 'remove' | 'add'
  job: string
  state: ChangeState
  /** The change still holds the job: waiting, or applied for under 20 minutes. The same rule the Hub's press check uses. */
  open: boolean
  at: string
  by: string
  from: { schedule: string; provider: string | null; model: string | null } | null
  to: { schedule?: string; provider?: string | null; model?: string | null; promptChanged?: boolean } | null
  resultAt?: string
  runningAt?: string
  code?: string
  reason?: string
  /** The newest confirmed change that still runs: one press puts the changed fields back. */
  canUndo?: boolean
}

/** What the owner's press on a job answers (201): signed, waiting for the host. `nextRunAt` is the next run before the change, for "Next run moved". */
export interface JobChangeAnswer { change: string; state: 'waiting'; op: JobChange['op']; job: string; from: unknown; to: unknown; nextRunAt: string | null }

/** One timer of the Hermes host or of the site host. The Hermes host's export carries no run times; the site host's file does. */
export interface ScheduleTimer { name: string; description: string; schedule: string; enabled: boolean; lastResult: string; nextRun?: string; lastRun?: string }

/** One Windows task of the PC (a non-OS task; `ours` is set for the ones the repo names). `schedule` and `lastResult` are the PC's own words. */
export interface PcTask {
  name: string
  folder: string
  state: 'ready' | 'running' | 'disabled' | 'queued' | 'unknown'
  schedule: string
  nextRun?: string
  lastRun?: string
  lastResult: string
  ours?: boolean
}

/** One cron line of a GitHub workflow, read through the PC. Times are UTC. */
export interface GithubSchedule { repo: string; workflow: string; cron: string; state: 'active' | 'disabled' | 'unknown'; lastRun?: string; lastConclusion?: string }

/** `live` is a fresh export, `old` one past the freshness rule, `not-reporting` a list nobody has sent. */
export type ScheduleState = 'live' | 'old' | 'not-reporting'

export interface ScheduleSource<T = ScheduleJob | ScheduleTimer | PcTask | GithubSchedule> {
  id: 'hermes-jobs' | 'hermes-timers' | 'site-timers' | 'pc-tasks' | 'github'
  label: string
  state: ScheduleState
  as_of: string | null
  host?: string
  timezone?: string
  /** The model each profile follows, for a job that pins none. */
  profileModels?: Record<string, string>
  text?: string
  /** A line that belongs under the heading (GitHub's list comes through the PC). */
  note?: string
  /** The PC's tasks: how many non-OS tasks it has in all, which can be more than the rows. */
  total?: number
  /** The Hermes jobs list: whether the host can apply a job change, and (signed in only) the models and places a job may use. */
  edits?: { available: boolean; models?: ModelRef[]; targets?: { id: string; label: string }[] }
  items: T[]
}

export interface SchedulesView { sources: ScheduleSource[]; note: string; at: string }
