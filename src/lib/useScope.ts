import { useMemo, useSyncExternalStore } from 'react'
import { ROUTE_EVENT } from './entries'
import { currentScope, type Scope } from './route'

const subscribe = (notify: () => void) => {
  for (const name of ['hashchange', 'popstate', ROUTE_EVENT]) window.addEventListener(name, notify)
  return () => { for (const name of ['hashchange', 'popstate', ROUTE_EVENT]) window.removeEventListener(name, notify) }
}
const snapshot = () => JSON.stringify(currentScope())

/** The project and sprint of the address now, for links that keep them when moving between screens. */
export function useScope(): Scope {
  const raw = useSyncExternalStore(subscribe, snapshot)
  return useMemo(() => JSON.parse(raw) as Scope, [raw])
}
