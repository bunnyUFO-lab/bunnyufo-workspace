/**
 * The update reload waits for work that a reload would cut: a Chat reply that is streaming, a Hub
 * write in flight. Callers hold the gate while they work; an update that lands meanwhile reloads
 * the page once the last hold is released.
 */
let holds = 0
let wanted: (() => void) | null = null

/** Holds the reload until the returned function is called. Calling it twice is harmless. */
export function holdReload(): () => void {
  holds += 1
  let released = false
  return () => {
    if (released) return
    released = true
    holds -= 1
    if (holds === 0 && wanted) { const run = wanted; wanted = null; run() }
  }
}

/** Runs `reload` now, or when the last hold is released. Asking again before then changes nothing. */
export function reloadWhenIdle(reload: () => void) {
  if (holds === 0) reload()
  else wanted ??= reload
}

/** For tests. */
export function resetReloadGate() { holds = 0; wanted = null }
