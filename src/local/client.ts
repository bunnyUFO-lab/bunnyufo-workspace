import { useSyncExternalStore } from 'react'
import type { CardWorkspace } from '../types'
import type { ServiceState, Preview, ServiceEvent } from './types'

const params = new URLSearchParams(window.location.search)
// crypto.randomUUID exists only in secure contexts; a published site on plain http (LAN) lacks it.
export const clientId = typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('')
let token = params.get('token') || sessionStorage.getItem('buw.token') || ''
// The token never stays in the address bar. Old launcher URLs also carried two mode parameters;
// they are dropped too, so a bookmark made from one keeps working.
if (token && params.has('token')) sessionStorage.setItem('buw.token', token)
if (['token', 'desktop', 'surface'].some(name => params.has(name))) {
  for (const name of ['token', 'desktop', 'surface']) params.delete(name)
  const rest = params.toString()
  history.replaceState(null, '', `${location.pathname}${rest ? `?${rest}` : ''}${location.hash}`)
}
const listeners = new Set<() => void>()
const events = new Set<(event: ServiceEvent) => void>()
let state: ServiceState = {
  ready: false, connected: false, error: null, repo: '', contentBase: '', workspace: null, settings: {}, preview: null,
}
let socket: WebSocket | null = null
let started = false
let reconnectTimer = 0
const update = (values: Partial<ServiceState>) => { state = { ...state, ...values }; listeners.forEach(listener => listener()) }
export const serviceState = () => state
export const useService = () => useSyncExternalStore(listener => { listeners.add(listener); return () => listeners.delete(listener) }, serviceState)
export const onServiceEvent = (listener: (event: ServiceEvent) => void) => { events.add(listener); return () => { events.delete(listener) } }
export const setPreview = (preview: Preview | null) => update({ preview })
export const dismissError = () => update({ error: null })
export const reportError = (error: unknown) => update({ error: error instanceof Error ? error.message : String(error) })
/** Enough of a card to find its files: every workspace on screen serves its own (lib/workspace). */
export interface CardLocation { folder: string; workspace: CardWorkspace }
/** URL of a file in a card's folder, served from that card's own workspace. */
export const cardUrl = ({ folder, workspace }: CardLocation, file: string) => `${workspace.base}/${folder}/${file}`
/** Path of a card file for the service: absolute in the local app, relative on a site. */
export const cardFile = ({ folder, workspace }: CardLocation, file: string) =>
  workspace.root ? `${workspace.root}/${folder}/${file}` : `${workspace.base.replace(/^\//, '')}/${folder}/${file}`

/**
 * The body of an API answer, or a readable reason there isn't one.
 *
 * Both services answer JSON, but a *proxy* in front of one need not: behind the Authelia login an
 * expired session answers a card write with a redirect to the sign-in page, and the app parsed
 * that HTML as JSON and reported `Unexpected token '<'`, which says nothing about being signed
 * out. Read the body as text and decide from the response, so what reaches the error bar is
 * something to act on.
 */
async function parse(response: Response, fallback: string): Promise<unknown> {
  const text = await response.text()
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    // Not JSON at all. A redirect that left this origin is a sign-in page, whatever it holds.
    const elsewhere = response.redirected && new URL(response.url).origin !== window.location.origin
    if (elsewhere || response.status === 401 || response.status === 403) {
      throw new Error('Signed out — reload the page, sign in again, and try that once more.')
    }
    // On the published site this is almost always the sign-in page: the proxy answered instead
    // of the service. Say both, because the same body means a missing /api route on a LAN host.
    throw new Error(`${fallback} — the server answered ${response.status}, not JSON. Your sign-in may have expired: reload the page. If it keeps happening, /api is not reaching the write API.`)
  }
  // The status and the whole answer ride along: a 409 on a save carries what the file holds now.
  if (!response.ok) throw Object.assign(new Error((value as { error?: string })?.error || `${fallback} (${response.status})`), { status: response.status, answer: value })
  return value
}

/**
 * The local service's bearer token, and nothing on a published site. An empty `Bearer ` used to
 * go out with every write there, and the Authelia in front of the site tried to parse it, failed,
 * and refused the request with a redirect nowhere — so a pin from a phone failed with "302, not
 * JSON" while the same tap on the LAN worked. No header is what a site expects.
 */
export const authHeaders = (): Record<string, string> => (token ? { Authorization: `Bearer ${token}` } : {})

export async function api<T>(path: string, data?: unknown, method?: string): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method: method || (data === undefined ? 'GET' : 'POST'),
    headers: { ...authHeaders(), ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: data === undefined ? undefined : JSON.stringify(data),
  })
  return await parse(response, 'Request failed') as T
}
export async function uploadFile(file: File, folder: string): Promise<{ path: string; name: string; renamed: boolean }> {
  const response = await fetch(`/api/files/import?folder=${encodeURIComponent(folder)}&name=${encodeURIComponent(file.name)}`, {
    method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/octet-stream' }, body: file,
  })
  return await parse(response, 'File could not be copied') as { path: string; name: string; renamed: boolean }
}
export function sendEvent(value: unknown) {
  if (socket?.readyState !== WebSocket.OPEN) return false
  socket.send(JSON.stringify(value)); return true
}
export async function startService() {
  if (started) return
  started = true
  try {
    const initial = await api<ServiceState>('/bootstrap')
    if (!location.hash && initial.settings.workspaceRoute?.startsWith('#/')) history.replaceState(null, '', location.pathname + location.search + initial.settings.workspaceRoute)
    update({ ...initial, ready: true, error: null })
    connect()
  } catch (error) { started = false; reportError(error) }
}
function connect() {
  // https pages need wss; replacing only 'http:' left an https origin untouched and unusable.
  socket = new WebSocket(`${location.origin.replace(/^http/, 'ws')}/events`)
  socket.onopen = () => socket?.send(JSON.stringify({ type: 'auth', token, clientId }))
  socket.onmessage = ({ data }) => {
    const event = JSON.parse(data) as ServiceEvent
    if (event.type === 'connected') update({ connected: true, error: null })
    if (event.type === 'service-error') reportError(event.error || 'Connection error')
    if (event.type === 'settings' && event.settings) update({ settings: event.settings })
    if (event.type === 'navigate' && event.window === 'workspace') {
      if (event.route !== undefined) { setPreview(null); location.hash = event.route || '' }
      if (event.preview) setPreview(event.preview)
    }
    if (event.type === 'workspace-switched' && event.workspace) { setPreview(null); update({ workspace: event.workspace }); location.hash = '#/' }
    if (event.type === 'workspace-changed') window.dispatchEvent(new Event('bunnyufo-workspace-changed'))
    events.forEach(listener => listener(event))
  }
  socket.onclose = () => {
    update({ connected: false })
    clearTimeout(reconnectTimer)
    reconnectTimer = window.setTimeout(connect, 1500)
    events.forEach(listener => listener({ type: 'disconnected' }))
  }
  socket.onerror = () => socket?.close()
}

// Exposing a capability through a DOM attribute would give report pages access to it.
// It lives only in this UI origin, which is separate from the report server.
window.addEventListener('pagehide', () => { token = ''; socket?.close(); clearTimeout(reconnectTimer) })
