import type { Ask } from '../lib/hub'

/** What an avatar Ask points at. The Ask is an agent's file, so the shape is checked here too. */
export type AvatarField = { agent: string; request: string } | { agent: string; sheet: string }

const SLUG = /^[a-z][a-z0-9-]{0,39}$/
const SHEET = /^sheet-\d{8}T\d{6,9}Z-[A-Za-z0-9]{4}$/

export function avatarOf(ask: Ask): AvatarField | null {
  const raw = ask.avatar as Record<string, unknown> | undefined
  if (!raw || typeof raw !== 'object' || typeof raw.agent !== 'string' || !SLUG.test(raw.agent)) return null
  if (typeof raw.sheet === 'string') return SHEET.test(raw.sheet) ? { agent: raw.agent, sheet: raw.sheet } : null
  return typeof raw.request === 'string' && raw.request ? { agent: raw.agent, request: raw.request } : null
}

/** The sheet check shows the real file, so it hides whatever picture the run attached. */
export const isSheetCheck = (ask: Ask) => { const avatar = avatarOf(ask); return !!avatar && 'sheet' in avatar }
