import type { ChatApproval, ChatLine, ChatTool, Item } from '../lib/hub'
import { HubError } from '../lib/hub'
import { authHeaders } from '../local/client'

export interface ChatHandlers {
  onDelta: (text: string) => void
  onCreated: (items: Item[]) => void
  onDone: (conversation: string, user?: ChatLine) => void
  onError: (message: string) => void
  onTool?: (tool: ChatTool) => void
  onApproval?: (approval: ChatApproval) => void
  onApprovalSettled?: () => void
}

/**
 * Send a message and read the reply as it streams. EventSource cannot POST, so this reads the
 * response body itself and parses its `event:` and `data:` blocks. Throws a HubError, before
 * anything streams, when the server refuses (a 502 from Hermes, a 503 when chat is not set up).
 */
export async function streamChat(body: { conversation?: string; text: string; images?: { type: string; data: string }[] }, handlers: ChatHandlers, signal: AbortSignal): Promise<void> {
  const response = await fetch('/api/hub/chat', {
    method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal,
  })
  if (!response.ok || !response.body) {
    const answer = await response.json().catch(() => null) as { error?: string } | null
    throw new HubError(answer?.error ?? `The Hub answered ${response.status}.`, response.status, answer as Record<string, unknown> | null)
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const handle = (block: string) => {
    let event = 'message'
    const data: string[] = []
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('event:')) event = line.slice(6).trim()
      else if (line.startsWith('data:')) data.push(line.slice(5).trim())
    }
    if (!data.length) return
    let value: Record<string, unknown>
    try { value = JSON.parse(data.join('\n')) as Record<string, unknown> } catch { return }
    if (event === 'delta' && typeof value.text === 'string') handlers.onDelta(value.text)
    else if (event === 'created' && Array.isArray(value.items)) handlers.onCreated(value.items as Item[])
    else if (event === 'done' && typeof value.conversation === 'string') handlers.onDone(value.conversation, value.user && typeof value.user === 'object' ? value.user as ChatLine : undefined)
    else if (event === 'tool' && typeof value.name === 'string') handlers.onTool?.(value as unknown as ChatTool)
    else if (event === 'approval' && typeof value.id === 'string') handlers.onApproval?.(value as unknown as ChatApproval)
    else if (event === 'approval-settled') handlers.onApprovalSettled?.()
    else if (event === 'error') handlers.onError(typeof value.error === 'string' ? value.error : 'The reply stopped.')
  }
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let cut: number
    while ((cut = buffer.search(/\r?\n\r?\n/)) >= 0) {
      handle(buffer.slice(0, cut))
      buffer = buffer.slice(cut).replace(/^\r?\n\r?\n/, '')
    }
  }
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
