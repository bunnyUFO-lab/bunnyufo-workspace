// "Chat with <agent>" in the Spawn sheet: a new Chat conversation with this agent and the typed text as its first draft.
// The start waits here until the Chat screen is showing (it may have to mount first); Chat takes it once. Nothing is stored
// anywhere and nothing is sent: the text is only a draft in the composer.
export interface ChatStart { persona: string; draft: string }

const EVENT = 'buw-chat-start'
let waiting: ChatStart | null = null

/** Queue a start and tell a Chat that is already showing. */
export function startChat(start: ChatStart) {
  waiting = start
  window.dispatchEvent(new Event(EVENT))
}

/** The queued start, once. */
export function takeChatStart(): ChatStart | null {
  const value = waiting
  waiting = null
  return value
}

export const onChatStart = (listener: () => void) => {
  window.addEventListener(EVENT, listener)
  return () => window.removeEventListener(EVENT, listener)
}
