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

export interface TeamAgent {
  id: string
  name: string
  room: string
  runtime: string
  model: string
  role: string
  /** Spawn presets this agent takes (the research agents); "Give work" opens Spawn on the first. */
  presets?: string[]
  status: AgentStatus
  task: string
  /**
   * Built-in or random today. After the owner picks a custom sheet the API sends a `CustomSprite`; m5-sprite-states
   * widens this to `AvatarSprite | CustomSprite` together with the code that draws it.
   */
  sprite: AvatarSprite
  /** Claude Code only: its sessions, as Working now lists them. */
  sessions?: WorkingItem[]
}

export interface TeamView {
  agents: TeamAgent[]
}
