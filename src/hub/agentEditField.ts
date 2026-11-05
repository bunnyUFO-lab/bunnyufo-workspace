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

/** True for an Opus model id. The same test as `isOpus` in site/api/chat-models.mjs: Opus bills through the API. */
export const isOpus = (model: string): boolean => /opus/i.test(String(model))

/** True for a model that only a deliberate pick may add: Opus, and Fable, which costs more than Opus. The same test as `isDear` in site/api/chat-models.mjs. */
export const isDear = (model: string): boolean => /opus|fable/i.test(String(model))

const dearName = (model: string) => (isOpus(model) ? 'Opus' : 'Fable')

/** The warning for an Opus or Fable pick, as primary or as a fallback; null when the order holds neither. Said on the Edit page and on the Ask. */
export function opusNote(primary: ModelRef | null | undefined, fallbacks: ModelRef[]): string | null {
  if (primary && isDear(primary.model)) return `${dearName(primary.model)} is the primary: every reply on this profile bills through the Anthropic API.`
  const fallback = fallbacks.find(item => isDear(item.model))
  if (fallback) return `${dearName(fallback.model)} is a fallback: when the models before it fail, replies bill through the Anthropic API without asking.`
  return null
}
