import type { ChatApproval, ChatLine, ChatTool, Item } from '../lib/hub'

export interface ChatHandlers {
  onDelta: (text: string) => void
  onCreated: (items: Item[]) => void
  onDone: (conversation: string, user?: ChatLine, context?: ChatLine) => void
  onError: (message: string) => void
  onTool?: (tool: ChatTool) => void
  onApproval?: (approval: ChatApproval) => void
  onApprovalSettled?: () => void
  /** The reply is a run on the server: its id, so Stop can end it. */
  onStarted?: (run: string) => void
}

/** The reply stream broke after the server had accepted the message, before `done` or `error`. */
export class StreamCut extends Error {
  constructor() { super('The reply was interrupted. Your message was kept; reopen the chat to see what was saved.') }
}

/** Reads the reply stream into the handlers. Throws StreamCut when it breaks, or ends, before `done` or `error`. */
export async function readChatStream(stream: ReadableStream<Uint8Array>, handlers: ChatHandlers, signal: AbortSignal): Promise<void> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let ended = false
  const handle = (block: string) => {
    let event = 'message'
    const data: string[] = []
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('event:')) event = line.slice(6).trim()
      else if (line.startsWith('data:')) data.push(line.slice(5).trim())
    }
    if (!data.length) return
    if (event === 'done' || event === 'error') ended = true
    let value: Record<string, unknown>
    try { value = JSON.parse(data.join('\n')) as Record<string, unknown> } catch { return }
    if (event === 'delta' && typeof value.text === 'string') handlers.onDelta(value.text)
    else if (event === 'created' && Array.isArray(value.items)) handlers.onCreated(value.items as Item[])
    else if (event === 'done' && typeof value.conversation === 'string') handlers.onDone(value.conversation, value.user && typeof value.user === 'object' ? value.user as ChatLine : undefined, value.context && typeof value.context === 'object' ? value.context as ChatLine : undefined)
    else if (event === 'started' && typeof value.run === 'string') handlers.onStarted?.(value.run)
    else if (event === 'tool' && typeof value.name === 'string') handlers.onTool?.(value as unknown as ChatTool)
    else if (event === 'approval' && typeof value.id === 'string') handlers.onApproval?.(value as unknown as ChatApproval)
    else if (event === 'approval-settled') handlers.onApprovalSettled?.()
    else if (event === 'error') handlers.onError(typeof value.error === 'string' ? value.error : 'The reply stopped.')
  }
  try {
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
  } catch (failure) {
    // The caller's own Stop is not a cut.
    if (signal.aborted) throw failure
    throw new StreamCut()
  }
  if (!ended && !signal.aborted) throw new StreamCut()
}
