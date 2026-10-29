import { createContext, useCallback, useEffect, useRef, useState } from 'react'
import type { Today } from '../lib/hub'
import { HUB_WROTE, hubGet } from '../lib/hub'

export interface HubData<T> {
  data: T | null
  error: string | null
  loading: boolean
  reload: () => void
  /** When the data last arrived. */
  at: Date | null
}

/**
 * Fetch a Hub route on mount, again when the tab becomes visible, and every 60 s while it is
 * (polling, not server-sent events). A null url fetches nothing.
 */
export function useHubData<T>(path: string | null): HubData<T> {
  const [state, setState] = useState<{ path: string | null; data: T | null; error: string | null; at: Date | null }>({ path, data: null, error: null, at: null })
  const [tick, setTick] = useState(0)
  const live = useRef(0)

  useEffect(() => {
    if (!path) return undefined
    let stopped = false
    let retry = 0
    let misses = 0
    const controller = new AbortController()
    const run = () => {
      const mine = ++live.current
      hubGet<T>(path, controller.signal).then(
        data => { if (!stopped && mine === live.current) misses = 0; if (!stopped && mine === live.current) setState({ path, data, error: null, at: new Date() }) },
        (error: unknown) => {
          if (stopped || mine !== live.current || (error as { name?: string }).name === 'AbortError') return
          // A network or server miss is tried again in a few seconds rather than a minute, backing off
          // (5 s, 10 s, 20 s, up to the 60 s poll). A hidden tab does not retry: it fetches again when shown.
          const status = (error as { status?: number }).status
          if (!status || status >= 500) {
            const wait = Math.min(60_000, 5000 * 2 ** misses)
            misses += 1
            window.clearTimeout(retry)
            retry = window.setTimeout(() => { if (document.visibilityState === 'visible') run() }, wait)
          }
          setState(previous => ({ path, data: previous.path === path ? previous.data : null, error: error instanceof Error ? error.message : 'The Hub did not answer.', at: previous.at }))
        },
      )
    }
    run()
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') run() }, 60_000)
    const onVisible = () => { if (document.visibilityState === 'visible') run() }
    document.addEventListener('visibilitychange', onVisible)
    // A write from any screen refreshes every Hub read at once (the Needs you badge, Today's count).
    window.addEventListener(HUB_WROTE, run)
    return () => { stopped = true; window.removeEventListener(HUB_WROTE, run); controller.abort(); window.clearInterval(timer); window.clearTimeout(retry); document.removeEventListener('visibilitychange', onVisible) }
  }, [path, tick])

  const reload = useCallback(() => setTick(value => value + 1), [])
  const current = state.path === path
  return { data: current ? state.data : null, error: current ? state.error : null, loading: !!path && (!current || (state.data === null && state.error === null)), reload, at: current ? state.at : null }
}

/**
 * The one `/today` poll. App makes it (the sidebar badge and the phone's tab bar need the count on
 * every screen) and the Today screen reads the same answer, so a poll sends one request.
 */
export const TodayContext = createContext<HubData<Today> | null>(null)
