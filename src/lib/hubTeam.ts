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
