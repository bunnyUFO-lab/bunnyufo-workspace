import type { ChatHandlers } from './chatRead'
import { readChatStream } from './chatRead'
import { HubError } from '../lib/hub'
import { authHeaders } from '../local/client'

export type { ChatHandlers } from './chatRead'
export { StreamCut } from './chatRead'

/**
 * Send a message and read the reply as it streams. EventSource cannot POST, so this reads the
 * response body itself and parses its `event:` and `data:` blocks. Throws a HubError, before
 * anything streams, when the server refuses (a 502 from Hermes, a 503 when chat is not set up).
 */
export async function streamChat(body: { conversation?: string; model?: string; text: string; images?: { type: string; data: string }[]; about?: { kind: string; id: string; step?: string } }, handlers: ChatHandlers, signal: AbortSignal): Promise<void> {
  const response = await fetch('/api/hub/chat', {
    method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal,
  })
  if (!response.ok || !response.body) {
    const answer = await response.json().catch(() => null) as { error?: string } | null
    throw new HubError(answer?.error ?? `The Hub answered ${response.status}.`, response.status, answer as Record<string, unknown> | null)
  }
  await readChatStream(response.body, handlers, signal)
}

/** Markdown reduced to what a voice should say: no code blocks, no link syntax, no emphasis marks. */
export function plainText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/[*_~>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}
