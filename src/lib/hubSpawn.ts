// Spawn: the shapes the presets routes answer with, and the small pure helpers the sheet and the palette share.

export type SpawnTarget = 'pc' | 'cloud' | 'hermes' | 'at-pc'

export interface SpawnPreset {
  id: string
  label: string
  icon: string
  /** The agent this kind of job is given to: shown as text, never picked. */
  agent: string
  kind: string
  needs: string[]
  targets: SpawnTarget[]
  sideEffect: string
  minutes: number
  fields: string[]
  example: string
  produces: string
  estimate: { cost: string; time: string }
}

export interface SpawnRule { rule: number; text: string }
export interface SpawnRoute { target: SpawnTarget; rule: number; why: string }

/** What `POST /hub/requests/:id/approve` answers: `waiting` says why an approved request has not started. */
export interface ApproveAnswer { state: string; waiting?: string }

export const MACHINE: Record<SpawnTarget, { name: string; icon: string; starts: string }> = {
  hermes: { name: 'Hermes', icon: 'spark', starts: 'Starts on Hermes right away' },
  pc: { name: 'The PC', icon: 'pc', starts: 'Starts on the PC when the dispatcher next ticks' },
  cloud: { name: 'The cloud', icon: 'cloud', starts: 'Starts in the cloud' },
  'at-pc': { name: 'You, at the PC', icon: 'hand', starts: 'You start it at the PC' },
}

/** Where each of the five routing rules sends a job, for the rule list. */
export const RULE_TO: Record<number, string> = { 1: 'you, at the PC', 2: 'the PC', 3: 'Hermes', 4: 'the PC', 5: 'the cloud, else the PC' }

export const CAPS_LINE = '3 Hermes runs at once · 2 PC runs at once · 10 PC and 10 cloud runs a day'

/** The preset a few typed words most likely mean (the palette's "Spawn: <text>"). */
export function guessPreset(text: string): string {
  const q = text.toLowerCase()
  if (/avatar/.test(q)) return 'agent-avatar'
  if (/market|competitor|pricing/.test(q)) return 'market-research'
  if (/teardown|tear down/.test(q)) return 'game-teardown'
  if (/sprite/.test(q)) return 'sprite-set'
  if (/playtest/.test(q)) return 'playtest-build'
  if (/research/.test(q)) return 'research'
  if (/\bdocs?\b|readme|document/.test(q)) return 'docs'
  return 'code-task'
}

/** The toast after a successful Approve. */
export function approvedNote(target: SpawnTarget, waiting?: string): string {
  if (waiting) return `Approved. It waits: ${waiting.replace(/[.\s]+$/, '')}.`
  if (target === 'hermes') return 'Approved. Hermes starts it now.'
  if (target === 'cloud') return 'Approved. It starts in the cloud.'
  return 'Approved. It waits for the PC dispatcher.'
}
