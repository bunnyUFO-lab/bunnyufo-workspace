const EVENT = 'buw:run-open'
let pending: string | null = null

/** Open the run drawer for a request from anywhere. The drawer is mounted by the Hub screen. */
export function openRun(id: string) {
  pending = id
  window.dispatchEvent(new Event(EVENT))
}

export const takeRun = (): string | null => { const value = pending; pending = null; return value }
export const RUN_EVENT = EVENT
