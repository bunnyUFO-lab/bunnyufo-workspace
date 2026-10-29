import { hubHash, parseHash } from '../lib/route'

/** What to prefill when the Spawn sheet opens. */
export interface SpawnOptions {
  text?: string
  preset?: string
  project?: string
  /** Edit a request: the sheet starts from it, locks everything but the text and the machine, and replaces the request. */
  edit?: { id: string; project: string; preset: string; text: string; target: string; repo?: string; doneWhen?: string }
}

const EVENT = 'buw:spawn-open'
let pending: SpawnOptions | null = null

/**
 * Open the Spawn sheet from anywhere (a header button, the palette, Work). The sheet lives in the Hub screen;
 * from a card page this first goes to Today, and the sheet picks the request up when it mounts.
 */
export function openSpawn(options: SpawnOptions = {}) {
  pending = options
  if (!parseHash().hub) window.location.hash = hubHash('today')
  window.dispatchEvent(new Event(EVENT))
}

export const takeSpawn = (): SpawnOptions | null => { const value = pending; pending = null; return value }
export const SPAWN_EVENT = EVENT
