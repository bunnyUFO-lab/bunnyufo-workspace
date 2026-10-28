import { authHeaders } from '../local/client'

/**
 * What the host serving this page can do, asked once before the app mounts (main.tsx) and never
 * changed after, so every read stays synchronous. There is one app on both hosts; a feature that
 * needs the local service checks the flag that names it, never which host this is.
 *
 * The published site answers `{ write, create, cards }` and nothing else, so every other flag is false
 * there. The local service answers all of them.
 */
export interface HostCapabilities {
  /** Cards can be pinned, reordered and archived here. */
  write: boolean
  /** New sections can be started here. */
  create: boolean
  /** Cards can be made here, and given Markdown sections whose text can be edited. */
  cards: boolean
  /** The host has the workspace's files: the file tree, previews, local paths. */
  files: boolean
  /** The host runs MCP servers. */
  mcp: boolean
  /** Documents can be saved back (Markdown and HTML editing). */
  saves: boolean
  /** Settings live in the host, not in this browser. */
  settings: boolean
  /** The host keeps a registry of workspaces that can be switched and edited. */
  workspaces: boolean
  /** The host pushes live changes over a websocket. */
  live: boolean
  /** Where the open project lives: in the path (needs an SPA fallback) or remembered. */
  routes: 'path' | 'hash'
  /** The Hub (Today, Needs you, Ask, Roadmap, Work, Activity, Sketch) is on at this host. */
  hub: boolean
  /** The Hub's chat with the assistant is set up and this visitor may use it. */
  chat: boolean
  /** Push-to-talk can turn speech into text here. */
  transcribe: boolean
  /** Why this host is read-only, in its own words (it names where to sign in), or null. */
  reason: string | null
  /** The card API's address (http or https) when the host knows it, else null. */
  cardApi: string | null
  /** Where card pages are served from (`https://host`), when the site has a content host; null when it does not. */
  contentOrigin: string | null
  /** Set only on the development copy: the branch it was deployed from (null before the first deploy). */
  dev?: { branch: string | null; sha?: string; pr?: number; at?: string }
}

const NONE: HostCapabilities = {
  write: false, create: false, cards: false, files: false, mcp: false, saves: false, settings: false, workspaces: false, live: false, routes: 'path', hub: false, chat: false, transcribe: false, reason: null, cardApi: null, contentOrigin: null,
}

export let host: HostCapabilities = NONE
/** Set when a host is present but refused us: the message to show instead of an empty board. */
export let signedOut: string | null = null

const SIGNED_OUT = 'Signed out — reload the page and sign in again.'

function parseDev(value: unknown): Pick<HostCapabilities, 'dev'> {
  if (!value || typeof value !== 'object') return {}
  const raw = value as Record<string, unknown>
  return {
    dev: {
      branch: typeof raw.branch === 'string' ? raw.branch : null,
      ...(typeof raw.sha === 'string' ? { sha: raw.sha } : {}),
      ...(typeof raw.pr === 'number' ? { pr: raw.pr } : {}),
      ...(typeof raw.at === 'string' ? { at: raw.at } : {}),
    },
  }
}

export async function probeHost(): Promise<void> {
  try {
    const response = await fetch('/api/capabilities', { cache: 'no-store', headers: authHeaders() })
    if (response.redirected && new URL(response.url).origin !== window.location.origin) { signedOut = SIGNED_OUT; return }
    if (response.status === 401 || response.status === 403) {
      const answer = await response.json().catch(() => null) as { error?: unknown } | null
      signedOut = typeof answer?.error === 'string' && answer.error ? answer.error : SIGNED_OUT
      return
    }
    if (!response.ok) return
    // HTML from this origin is a single-page fallback answering for a missing route: no API here.
    const answer = await response.json().catch(() => null) as Partial<Record<keyof HostCapabilities, unknown>> | null
    if (!answer || typeof answer !== 'object') return
    host = {
      write: !!answer.write, create: !!answer.create, cards: !!answer.cards, files: !!answer.files, mcp: !!answer.mcp, saves: !!answer.saves,
      settings: !!answer.settings, workspaces: !!answer.workspaces, live: !!answer.live,
      routes: answer.routes === 'hash' ? 'hash' : 'path',
      hub: !!answer.hub, chat: !!answer.chat, transcribe: !!answer.transcribe,
      reason: typeof answer.reason === 'string' ? answer.reason : null,
      cardApi: typeof answer.cardApi === 'string' && /^https?:\/\//.test(answer.cardApi) ? answer.cardApi : null,
      contentOrigin: typeof answer.contentOrigin === 'string' && /^https?:\/\//.test(answer.contentOrigin) ? new URL(answer.contentOrigin).origin : null,
      ...parseDev(answer.dev),
    }
  } catch {
    // No API (the local preview) or no network: a read-only site, as before.
  }
}
