// The Team screen's data, as the site API sends it (site/api/hub-team.mjs).
import type { WorkingItem } from './hubPc'

export type AgentStatus = 'working' | 'needs-you' | 'failed' | 'idle' | 'offline'

/** What an avatar choice resolves to. Matches SpriteChoice in src/hub/team/sprites.ts. */
export type AvatarSprite =
  | { kind: 'builtin'; key: string }
  | { kind: 'random'; salt: number; name: string }

/** The body of POST /api/hub/team/:agent/avatar. */
export type AvatarChoice =
  | { kind: 'builtin'; key: string }
  | { kind: 'random'; salt: number }

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
  sprite: AvatarSprite
  /** Claude Code only: its sessions, as Working now lists them. */
  sessions?: WorkingItem[]
}

export interface TeamView {
  agents: TeamAgent[]
}
