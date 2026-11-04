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
  /** Set on the agents with a chat persona the owner may edit (Edit page). */
  editable?: { persona?: boolean }
  /** The label of the chat model an edited persona starts a chat on; none while the persona follows the app's text. */
  chatModel?: string
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
  toolsets?: string[]
  platformToolsets?: Record<string, string[]>
  skills: { autoLoad: string[]; installed: string[] }
  terminal?: { backend?: string; containerMemoryMb?: number }
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
  agent: { id: string; name: string; role: string; room: string; runtime: string; profile: AgentProfile; editable?: { persona?: boolean }; chatModel?: string }
  freshness: DetailsFreshness
  settings: ProfileSettings | null
  prompts: DetailsPrompt[]
  jobs: DetailsJob[]
}

/** One version of a persona on the Edit page. `default` is the app's own text (a stored "back to the app's text" is a default row too). */
export interface PersonaVersion {
  id: string
  at: string
  by: string
  default?: boolean
  role: string
  prompt: string
  model: string
  note?: string
  revertOf?: string
  fromAsk?: string
}

/** GET /api/hub/team/:agent/persona, and what a save or a revert answers beside `ok` and `version`. */
export interface PersonaView {
  current: { version: string; role: string; prompt: string; model: string }
  default: { role: string; prompt: string; model: string }
  versions: PersonaVersion[]
  models: { id: string; label: string; note: string }[]
}
