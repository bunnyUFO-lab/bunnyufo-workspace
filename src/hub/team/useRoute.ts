import { useCallback, useEffect, useState } from 'react'
import { HubError, hubGet } from '../../lib/hub'

export type Load<T> = { data: T | null; error: string | null; status: number | null; refresh: (signal: AbortSignal) => Promise<void> }

/** One Hub route, fetched on mount. The status is kept so a 401 can say "sign in" instead of a bare error. `refresh` reads it again and keeps what is shown when that fails. */
export function useRoute<T>(path: string): Load<T> {
  const [state, setState] = useState<{ path: string; data: T | null; error: string | null; status: number | null }>({ path, data: null, error: null, status: null })
  useEffect(() => {
    const controller = new AbortController()
    hubGet<T>(path, controller.signal).then(
      data => setState({ path, data, error: null, status: 200 }),
      (problem: unknown) => {
        if ((problem as { name?: string }).name === 'AbortError') return
        setState({ path, data: null, error: problem instanceof Error ? problem.message : 'Could not load this.', status: problem instanceof HubError ? problem.status : 0 })
      },
    )
    return () => controller.abort()
  }, [path])
  const refresh = useCallback(async (signal: AbortSignal) => {
    const data = await hubGet<T>(path, signal)
    if (!signal.aborted) setState({ path, data, error: null, status: 200 })
  }, [path])
  return state.path === path ? { ...state, refresh } : { data: null, error: null, status: null, refresh }
}
