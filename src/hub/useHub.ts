import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import type { Today } from '../lib/hub'
import { HUB_WROTE, hubGet } from '../lib/hub'
import { clearHub, hubCacheStamp, peekHub, putHub } from '../lib/hubCache.mjs'

export interface HubData<T> {
  data: T | null
  error: string | null
  loading: boolean
  reload: () => void
  /** When the data last arrived. */
  at: Date | null
  /** A write from this browser is known and the answer after it has not landed yet. */
  behind: boolean
}

interface HubState<T> { path: string | null; data: T | null; error: string | null; at: Date | null; behind: boolean }

/**
 * Fetch a Hub route on mount, again when the tab becomes visible, and every 60 s while it is
 * (polling, not server-sent events). A null url fetches nothing. The last answer for the same path
 * (src/lib/hubCache.mjs) shows in the first paint while the fresh one is on its way; this hook is the
 * only thing that fills that store, and the store never starts a request.
 */
export function useHubData<T>(path: string | null): HubData<T> {
  const [state, setState] = useState<HubState<T>>(() => {
    const hit = path ? peekHub<T>(path) : null
    return { path, data: hit ? hit.data : null, error: null, at: hit ? hit.at : null, behind: false }
  })
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
      // Taken before the request leaves: a write that lands while it is out makes this answer stale for the store.
      const stamp = hubCacheStamp()
      hubGet<T>(path, controller.signal).then(
        data => {
          if (stopped || mine !== live.current) return
          misses = 0
          const arrived = new Date()
          putHub(path, data, stamp, arrived)
          setState({ path, data, error: null, at: arrived, behind: false })
        },
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
          const message = error instanceof Error ? error.message : 'The Hub did not answer.'
          // The session is gone: nothing cached stays. A 403 or 404 means this route now says no: its entry goes.
          if (status === 401) {
            clearHub()
            setState({ path, data: null, error: message, at: null, behind: false })
          } else if (status === 403 || status === 404) {
            clearHub(path)
            setState({ path, data: null, error: message, at: null, behind: false })
          } else {
            // Anything else keeps what is shown, and says so quietly.
            setState(previous => {
              const kept = previous.path === path ? { data: previous.data, at: previous.at } : peekHub<T>(path)
              return { path, data: kept ? kept.data : null, error: message, at: kept ? kept.at : null, behind: false }
            })
          }
        },
      )
    }
    // A write from any screen refreshes every Hub read at once (the Needs you badge, Today's count).
    const onWrote = () => { setState(previous => (previous.behind ? previous : { ...previous, behind: true })); run() }
    run()
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') run() }, 60_000)
    const onVisible = () => { if (document.visibilityState === 'visible') run() }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener(HUB_WROTE, onWrote)
    return () => { stopped = true; window.removeEventListener(HUB_WROTE, onWrote); controller.abort(); window.clearInterval(timer); window.clearTimeout(retry); document.removeEventListener('visibilitychange', onVisible) }
  }, [path, tick])

  const reload = useCallback(() => setTick(value => value + 1), [])
  const current = state.path === path
  // Data of another path is never returned: a new path shows its own cached answer or nothing.
  const hit = !current && path ? peekHub<T>(path) : null
  const data = current ? state.data : hit ? hit.data : null
  const at = current ? state.at : hit ? hit.at : null
  const error = current ? state.error : null
  return { data, error, loading: !!path && data === null && error === null, reload, at, behind: current ? state.behind : false }
}

/** A read that may start before it can be shown: while `show` is false the answer, and any error, stay out of sight and the screen reads as loading. */
export function useHeldHubData<T>(path: string | null, show: boolean): HubData<T> {
  const read = useHubData<T>(path)
  return show ? read : { ...read, data: null, error: null, at: null, behind: false, loading: !!path }
}

/**
 * The one `/today` poll. App makes it (the sidebar badge and the phone's tab bar need the count on
 * every screen) and the Today screen reads the same answer, so a poll sends one request.
 */
export const TodayContext = createContext<HubData<Today> | null>(null)

/**
 * What a screen reads for `/today`: the shared poll when App made one, else its own. When a write was
 * already known as this screen mounted (answering an Ask, then opening Today), the old count never
 * shows: it reads as loading until the answer after the write lands. A write made on this screen does
 * not blank it. The sidebar badge reads the raw hook and keeps its number.
 */
export function useTodayScreen(): HubData<Today> {
  const shared = useContext(TodayContext)
  const own = useHubData<Today>(shared ? null : '/today')
  const source = shared ?? own
  const [held, setHeld] = useState(source.behind)
  if (held && !source.behind) setHeld(false)
  if (!held || !source.behind) return source
  return { ...source, data: null, loading: true, at: null, error: null }
}
