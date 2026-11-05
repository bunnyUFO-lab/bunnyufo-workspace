import type { ChatLine } from '../lib/hub'

/** What reading a conversation answers. `running`: a turn is still answering; the line is saved when it goes. `run`: the Hermes run, for who started it. */
export interface ChatAnswer { messages: ChatLine[]; running?: boolean; run?: string | null }

/** Looks at the saved conversation that find nothing new before the page stops waiting: a turn that is not running may be saving for a moment. */
export const MAX_MISSES = 3

const SECOND = 1000
export const FAST_FOR_MS = 120 * SECOND

export const hasRunningDelegate = (lines: ChatLine[]) => lines.some(line => line.delegates?.some(delegate => delegate.state === 'running'))

/** How long until the next look: soon while a reply is due, then less often; a delegate takes minutes, so it never needs to be soon. */
export const nextLookMs = (waitingForReply: boolean, waitedMs: number) => (waitingForReply ? (waitedMs < FAST_FOR_MS ? 4 * SECOND : 15 * SECOND) : 20 * SECOND)

/** Whether the saved lines end with the reply to this turn: its text, sent no earlier than this (the clocks may differ by a little), answered. */
export function replySaved(lines: ChatLine[], text: string, sentAt: string): boolean {
  const last = lines[lines.length - 1]
  const asked = lines[lines.length - 2]
  if (last?.role !== 'assistant' || asked?.role !== 'user' || asked.text !== text) return false
  return new Date(asked.at).getTime() >= new Date(sentAt).getTime() - FAST_FOR_MS
}

/** The same lines as the ones on screen: nothing to redraw, and no reason to scroll. */
export const sameLines = (a: ChatLine[], b: ChatLine[]) => JSON.stringify(a) === JSON.stringify(b)
