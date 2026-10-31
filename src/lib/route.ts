// Hash routing: #/<entityId>/<stepIndex>. Step -1 uses the card's default.
// Plain <a href> hash links do the navigation; App listens to hashchange.
import type { MouseEvent as ReactMouseEvent } from 'react'

export const HUB_SCREENS = ['today', 'needs', 'ask', 'checklist', 'review', 'map', 'work', 'team', 'activity', 'sketch', 'chat', 'request'] as const
export type HubScreen = (typeof HUB_SCREENS)[number]

/** `#/~hub/<screen>[/<rest>]`. Card ids cannot contain `~`, so this never collides with a card. */
export interface HubRoute {
  screen: HubScreen
  id?: string
}

export interface Route {
  id: string | null
  step: number
  hub?: HubRoute
}

const safeDecode = (value: string) => { try { return decodeURIComponent(value) } catch { return value } }

/** Old names of Hub screens, from before the rename: links in Discord history and bookmarks keep working. */
export const HUB_ALIASES: Record<string, HubScreen> = { inbox: 'needs', board: 'work', roadmap: 'map' }

const isAlias = (raw: string) => Object.prototype.hasOwnProperty.call(HUB_ALIASES, raw)
const hubScreenOf = (raw: string) => (isAlias(raw) ? HUB_ALIASES[raw] : raw)

/** The same address with an old screen name swapped for the new one, or null when it already uses the new name. */
export function canonicalHubHash(): string | null {
  const match = /^#\/?~hub\/([^/?#]+)(.*)$/.exec(window.location.hash)
  if (!match || !isAlias(match[1])) return null
  return `#/~hub/${HUB_ALIASES[match[1]]}${match[2]}`
}

export function parseHash(): Route {
  const raw = window.location.hash.replace(/^#\/?/, '')
  if (!raw) return { id: null, step: -1 }
  if (raw === '~hub' || raw.startsWith('~hub/')) {
    const [, first, ...rest] = raw.split('/')
    const screen = hubScreenOf(first)
    const known = (HUB_SCREENS as readonly string[]).includes(screen) ? screen as HubScreen : 'today'
    const id = known === screen ? safeDecode(rest.join('/')) : ''
    return { id: null, step: -1, hub: { screen: known, ...(id ? { id } : {}) } }
  }
  const [id, stepRaw] = raw.split('/')
  const step = Number(stepRaw)
  return {
    id: decodeURIComponent(id),
    step: Number.isInteger(step) && step >= 0 ? step : -1,
  }
}

export function entityHash(id: string, step = -1): string {
  const base = `#/${encodeURIComponent(id)}`
  return step >= 0 ? `${base}/${step}` : base
}

export function hubHash(screen: HubScreen, id?: string): string {
  return id ? `#/~hub/${screen}/${encodeURIComponent(id)}` : `#/~hub/${screen}`
}

/** `#/~hub/map/<project>[/<node>]`: the map, and with a node its details panel open. */
export function mapHash(project: string, node?: string): string {
  const base = `#/~hub/map/${encodeURIComponent(project)}`
  return node ? `${base}/${encodeURIComponent(node)}` : base
}

/**
 * `#/~hub/review/<event file>[/<card file path>]`. Each segment is encoded on its own and the path
 * keeps its slashes; `parseHash` joins them back into `route.id`, which ReviewView splits on the
 * first `/`. An event file name never contains a `/`, so the first one ends the id.
 */
export function reviewHash(id: string, file?: string): string {
  const base = `#/~hub/review/${encodeURIComponent(id)}`
  return file ? `${base}/${file.split('/').map(encodeURIComponent).join('/')}` : base
}

/** The stored kinds a help chat can be about. */
export type HelpKind = 'ask' | 'checklist' | 'review' | 'blocked'

/**
 * `#/~hub/chat/help/<kind>/<step or ->/<id>`: Chat in help mode for one item. The id goes last because a review's or a
 * blocked session's id is an event file name. Nothing personal travels in it; a draft for the composer is handed over
 * through `setHelpDraft`, not the address.
 */
export const helpHash = (item: { kind: HelpKind; id: string }, step?: string): string => `#/~hub/chat/help/${item.kind}/${step || '-'}/${encodeURIComponent(item.id)}`

/** The kind, step and id back out of a Chat route id that starts with `help/`; null for anything else. */
export function parseHelpId(id: string | undefined): { kind: HelpKind; step?: string; id: string } | null {
  const match = /^help\/(ask|checklist|review|blocked)\/([^/]+)\/(.+)$/.exec(id ?? '')
  if (!match) return null
  const step = /^\d{2}$/.test(match[2]) ? match[2] : undefined
  return { kind: match[1] as HelpKind, ...(step ? { step } : {}), id: match[3] }
}

/** The screen the Hub's navigation marks as current: an Ask or a review is opened from Needs you, so Needs you stays lit. A checklist is the same. Activity is Work's second tab, so Work stays lit. */
export const navScreen = (screen: HubScreen | undefined): HubScreen | null => (screen === 'review' || screen === 'ask' || screen === 'checklist' || screen === 'request' ? 'needs' : screen === 'activity' ? 'work' : screen ?? null)

export function resolveStep(count: number, requested: number, preferred?: number): number {
  const valid = (value: number | undefined): value is number =>
    typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < count
  return valid(requested) ? requested : valid(preferred) ? preferred : 0
}

/** The cards' home: this section's page with no hash. */
export const homeHref = () => window.location.pathname + window.location.search

/**
 * A real link to the cards' home: a plain click goes there in place (onHome); Ctrl, Cmd, Shift or a
 * middle click is left to the browser, which opens it in a new tab or window.
 */
export function homeLink(onHome: () => void) {
  return {
    href: homeHref(),
    onClick: (event: ReactMouseEvent) => {
      if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return
      event.preventDefault()
      onHome()
    },
  }
}
