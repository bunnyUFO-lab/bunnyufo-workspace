// The model a chat starts on when a plan may be paused by its usage limit. The server says which models are paused
// (`pauses`: what it saw of Hermes's quota failures, never a call to a provider) and the order a paused one falls down (`chain`).

/** One paused model, from GET /hub/chat. `until` is when the pause ends; `reported` says whether Hermes gave that time or the site guessed it. */
export interface ChatPause { model: string; seen: string; until: string; reported: boolean }

export interface ModelChoice {
  /** The model id the menu shows and the turn asks for. */
  model: string
  /** Set when the model shown is paused: the note says so. */
  pause?: ChatPause
  /** Set when the default moved off a paused model: the model it moved to (equal to `model`). */
  using?: string
}

/** The pause on a model that is still in force at `now`, or undefined. */
export const pauseOf = (pauses: ChatPause[], model: string, now: number): ChatPause | undefined =>
  pauses.find(entry => entry.model === model && new Date(entry.until).getTime() > now)

/** The first model after `from` in the chain (from the start when `from` is not in it) that is not paused, or null. */
export function nextModel(from: string, chain: string[], pauses: ChatPause[], now: number): string | null {
  const start = chain.indexOf(from) + 1
  return chain.slice(start).find(model => !pauseOf(pauses, model, now)) ?? null
}

/**
 * What the menu shows. A model the owner picked stays, with the pause noted beside it. Otherwise the agent's preferred model is the
 * default, and when it is paused the default is the next model in the chain that is not (the preferred one, still noted, when none is).
 */
export function chooseModel({ picked, preferred, chain, pauses, now }: { picked: string | null; preferred: string; chain: string[]; pauses: ChatPause[]; now: number }): ModelChoice {
  if (picked) return { model: picked, pause: pauseOf(pauses, picked, now) }
  const pause = pauseOf(pauses, preferred, now)
  if (!pause) return { model: preferred }
  const next = nextModel(preferred, chain, pauses, now)
  return next ? { model: next, pause, using: next } : { model: preferred, pause }
}

/** "Codex is paused by its usage limit until 14:20 · using Sonnet"; "... (seen 13:20)" when Hermes gave no reset time. */
export function pauseNote(label: string, pause: ChatPause, when: (iso: string) => string, using?: string): string {
  const head = pause.reported ? `${label} is paused by its usage limit until ${when(pause.until)}` : `${label} is paused by its usage limit (seen ${when(pause.seen)})`
  return using ? `${head} · using ${using}` : head
}
