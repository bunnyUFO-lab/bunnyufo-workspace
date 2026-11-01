// "Chat with <agent>" in the Spawn sheet: a new Chat conversation with this agent and the typed text as its first draft.
// The start waits here until the Chat screen is showing (it may have to mount first); Chat takes it once. Nothing is stored
// anywhere and nothing is sent: the text is only a draft in the composer.
export interface ChatStart { persona: string; draft: string }

const EVENT = 'buw-chat-start'
let waiting: { start: ChatStart; at: number } | null = null
const FRESH_MS = 5000   // a start that no Chat took in this time is dropped: it never outlives the open that made it

/** Queue a start and tell a Chat that is already showing. */
export function startChat(start: ChatStart) {
  waiting = { start, at: Date.now() }
  window.dispatchEvent(new Event(EVENT))
}

/** The queued start without taking it: safe where React may run an initializer twice. */
export function peekChatStart(): ChatStart | null {
  return waiting && Date.now() - waiting.at < FRESH_MS ? waiting.start : null
}

/** Drop the queued start: the Chat that read it with peekChatStart calls this once it is showing. */
export function takeChatStart(): ChatStart | null {
  const value = peekChatStart()
  waiting = null
  return value
}

export const onChatStart = (listener: () => void) => {
  window.addEventListener(EVENT, listener)
  return () => window.removeEventListener(EVENT, listener)
}
