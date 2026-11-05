import { useEffect, useRef } from 'react'
import { POLL_MS, WAITING_TOO_LONG_MS } from './profileChangeWords'

/**
 * Reads again every few seconds while a change waits for the host, so the page sees the result with no reload.
 * - Only while `waiting`, and only while the tab is visible; a tab shown again reads once at once.
 * - Never two reads at once; one AbortController ends the read in flight when the change stops waiting or the page goes away.
 * - After 10 minutes the timer stops (the host is probably off); showing the tab still reads once.
 */
export function useWaitingPoll(waiting: boolean, read: (signal: AbortSignal) => Promise<unknown>) {
  const latest = useRef(read)
  useEffect(() => { latest.current = read })
  useEffect(() => {
    if (!waiting) return
    const controller = new AbortController()
    const started = Date.now()
    let busy = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const visible = () => document.visibilityState === 'visible'
    const run = async () => {
      if (busy || controller.signal.aborted) return
      busy = true
      try { await latest.current(controller.signal) } catch { /* the next read tries again */ } finally { busy = false }
      if (!controller.signal.aborted && visible() && Date.now() - started < WAITING_TOO_LONG_MS) timer = setTimeout(() => { void run() }, POLL_MS)
    }
    const onVisibility = () => {
      clearTimeout(timer)
      if (visible()) void run()
    }
    if (visible()) timer = setTimeout(() => { void run() }, POLL_MS)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      controller.abort()
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [waiting])
}
