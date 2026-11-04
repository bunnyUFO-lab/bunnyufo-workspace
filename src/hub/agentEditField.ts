import type { Ask } from '../lib/hub'
import type { ModelRef } from '../lib/hubTeam'

/** What an agent-edit Ask proposes. The Ask is an agent's file, so the shape is checked here too. */
export interface AgentEditField { agent: string; base: string; role?: string; prompt?: string; model?: string; why?: string }

const SLUG = /^[a-z][a-z0-9-]{0,39}$/

export function agentEditOf(ask: Ask): AgentEditField | null {
  const raw = ask.agentEdit as Record<string, unknown> | undefined
  if (!raw || typeof raw !== 'object' || raw.op !== 'persona' || typeof raw.agent !== 'string' || !SLUG.test(raw.agent) || typeof raw.base !== 'string') return null
  const pick = (name: string) => (typeof raw[name] === 'string' ? raw[name] as string : undefined)
  return { agent: raw.agent, base: raw.base, role: pick('role'), prompt: pick('prompt'), model: pick('model'), why: pick('why') }
}

/** What a profile-edit Ask proposes: the model and the fallbacks, in order, of a Hermes profile. Checked here too, since the Ask is a file. */
export interface ProfileEditField { profile: 'main' | 'briefs'; primary: ModelRef; fallbacks: ModelRef[]; why?: string }

const modelRef = (raw: unknown): ModelRef | null => {
  const item = raw as Record<string, unknown> | null
  return item && typeof item === 'object' && typeof item.provider === 'string' && typeof item.model === 'string' && item.provider && item.model ? { provider: item.provider, model: item.model } : null
}

export function profileEditOf(ask: Ask): ProfileEditField | null {
  const raw = ask.agentEdit as Record<string, unknown> | undefined
  if (!raw || typeof raw !== 'object' || raw.op !== 'profile' || (raw.profile !== 'main' && raw.profile !== 'briefs')) return null
  const primary = modelRef(raw.primary)
  const chain = Array.isArray(raw.fallbacks) ? raw.fallbacks.map(modelRef) : null
  if (!primary || !chain || chain.length > 4 || chain.some(item => !item)) return null
  return { profile: raw.profile, primary, fallbacks: chain as ModelRef[], why: typeof raw.why === 'string' ? raw.why : undefined }
}
