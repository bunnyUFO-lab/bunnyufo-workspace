// "Ask Hermes: <text>" from the command palette: open a new Chat conversation and send the text. The text waits here
// until the Chat screen is on screen (it may have to mount first), then Chat takes it.
let waiting: string | null = null
const EVENT = 'buw-ask-hermes'

/** Queue a question and open a new conversation. Chat sends it as soon as it is showing. */
export function askHermes(text: string, go: () => void) {
  waiting = text.trim() || null
  if (!waiting) return
  go()
  window.dispatchEvent(new Event(EVENT))
}

/** The queued question, once. */
export function takeAsk(): string | null {
  const text = waiting
  waiting = null
  return text
}

export const onAsk = (listener: () => void) => {
  window.addEventListener(EVENT, listener)
  return () => window.removeEventListener(EVENT, listener)
}
