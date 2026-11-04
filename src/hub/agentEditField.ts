import type { Ask } from '../lib/hub'

/** What an agent-edit Ask proposes. The Ask is an agent's file, so the shape is checked here too. */
export interface AgentEditField { agent: string; base: string; role?: string; prompt?: string; model?: string; why?: string }

const SLUG = /^[a-z][a-z0-9-]{0,39}$/

export function agentEditOf(ask: Ask): AgentEditField | null {
  const raw = ask.agentEdit as Record<string, unknown> | undefined
  if (!raw || typeof raw !== 'object' || raw.op !== 'persona' || typeof raw.agent !== 'string' || !SLUG.test(raw.agent) || typeof raw.base !== 'string') return null
  const pick = (name: string) => (typeof raw[name] === 'string' ? raw[name] as string : undefined)
  return { agent: raw.agent, base: raw.base, role: pick('role'), prompt: pick('prompt'), model: pick('model'), why: pick('why') }
}
