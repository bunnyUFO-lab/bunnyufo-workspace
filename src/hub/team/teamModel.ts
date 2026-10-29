// Pure logic for the Team screen and its Sprite sheet. Kept out of the .tsx files so Node can test it.
import type { AgentStatus, AvatarChoice, AvatarSprite, CustomSprite, TeamAgent } from '../../lib/hubTeam'
import { BUILTIN_KEYS, genSprite } from './sprites.ts'

export const STATUS_LABEL: Record<AgentStatus, string> = {
  working: 'Working', 'needs-you': 'Needs you', failed: 'Failed', idle: 'Idle', offline: 'Offline',
}

/** The state class the dot and the glow use (the shared `st-*` colours). */
export const STATUS_DOT: Record<AgentStatus, 'working' | 'needs' | 'failed' | 'idle'> = {
  working: 'working', 'needs-you': 'needs', failed: 'failed', idle: 'idle', offline: 'idle',
}

export function rosterCounts(agents: Pick<TeamAgent, 'status'>[]) {
  return {
    total: agents.length,
    online: agents.filter(agent => agent.status !== 'offline').length,
    working: agents.filter(agent => agent.status === 'working').length,
  }
}

/** What an agent can wear: a built-in, a random one or a custom pet sheet. */
export type AnySprite = AvatarSprite | CustomSprite

export const sameSprite = (a: AnySprite, b: AnySprite): boolean => {
  if (a.kind === 'custom' || b.kind === 'custom') return a.kind === 'custom' && b.kind === 'custom' && a.sheet === b.sheet
  return a.kind === 'builtin' ? b.kind === 'builtin' && a.key === b.key : b.kind === 'random' && a.salt === b.salt && a.name === b.name
}

/** The body of the avatar POST for a sprite. */
export const choiceOf = (sprite: AnySprite): AvatarChoice | { kind: 'custom'; sheet: string } =>
  sprite.kind === 'custom' ? { kind: 'custom', sheet: sprite.sheet }
    : sprite.kind === 'builtin' ? { kind: 'builtin', key: sprite.key } : { kind: 'random', salt: sprite.salt }

export const SALT_MAX = 9999

/** The salt Randomize starts from: the current random sprite's, else 0. The first press draws salt + 1. */
export const startSalt = (current: AnySprite): number => (current.kind === 'random' ? current.salt : 0)

export const nextSalt = (salt: number): number => (salt >= SALT_MAX ? 1 : salt + 1)

export const randomOf = (name: string, salt: number): AvatarSprite => ({ kind: 'random', salt, name })

/** "Randomized from the name: <label>" for a drawn sprite. */
export const randomLabel = (name: string, salt: number): string => `Randomized from the name: ${genSprite(name, salt).label}`

export const spriteKey = (sprite: AnySprite): string => (sprite.kind === 'builtin' ? `b:${sprite.key}` : sprite.kind === 'custom' ? `c:${sprite.sheet}` : `r:${sprite.salt}`)

/** The Quick tile's name, and its `data-sprite-tile`. A custom sheet is its own tile, never a random one. */
export const tileLabel = (sprite: AnySprite): string => (sprite.kind === 'builtin' ? builtinLabel(sprite.key) : sprite.kind === 'custom' ? 'Custom sprite' : 'Randomized sprite')
export const tileId = (sprite: AnySprite): string => (sprite.kind === 'builtin' ? sprite.key : sprite.kind === 'custom' ? 'custom' : `random-${sprite.salt}`)

/** A readable name for a built-in key: `lib_b` is "lib b". */
export const builtinLabel = (key: string): string => key.replace(/_/g, ' ')

/**
 * The tiles of the Quick picker: the current sprite first, then the one just randomized (if it is
 * not the current one), then every built-in that is not already shown.
 */
export function quickTiles(current: AnySprite, randomized: AvatarSprite | null): AnySprite[] {
  const tiles: AnySprite[] = [current]
  if (randomized && !sameSprite(randomized, current)) tiles.push(randomized)
  for (const key of BUILTIN_KEYS) {
    const tile: AvatarSprite = { kind: 'builtin', key }
    if (!tiles.some(existing => sameSprite(existing, tile))) tiles.push(tile)
  }
  return tiles
}

/** The line under the preview. */
export function sheetNote(name: string, current: AnySprite, selected: AnySprite): string {
  if (sameSprite(current, selected)) return 'This is the current sprite'
  if (selected.kind === 'custom') return 'A custom sheet. Pick it on the Custom tab.'
  return selected.kind === 'random' ? randomLabel(name, selected.salt) : 'Built in. Use this applies it now, no job.'
}
