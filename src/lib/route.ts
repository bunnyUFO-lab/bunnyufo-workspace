// Hash routing: #/<entityId>/<stepIndex>. Step -1 uses the card's default.
// Plain <a href> hash links do the navigation; App listens to hashchange.
import type { MouseEvent as ReactMouseEvent } from 'react'
import { withoutOverlay } from './entries.ts'

export const HUB_SCREENS = ['today', 'needs', 'ask', 'checklist', 'review', 'project', 'map', 'work', 'team', 'activity', 'jobs', 'sketch', 'chat', 'request', 'agent', 'agent-edit', 'library', 'search', 'settings'] as const
export type HubScreen = (typeof HUB_SCREENS)[number]

/** `#/~hub/<screen>[/<rest>]`. Card ids cannot contain `~`, so this never collides with a card. */
export interface HubRoute {
  screen: HubScreen
  id?: string
  /** `?sprint=<name>`: the sprint (a Beads label `sprint:<name>`) the screen narrows to, where it can. */
  sprint?: string
  /** `?project=<id>`: on Work, Projects and Map with no id in the path it is also the route id. */
  project?: string
}

export interface Route {
  id: string | null
  step: number
  hub?: HubRoute
  /** The address ends in `/~o`: a sheet is open over this screen. Nothing keyed on the route reads it, so the screen under a sheet never remounts. */
  overlay?: boolean
}

const safeDecode = (value: string) => { try { return decodeURIComponent(value) } catch { return value } }

/** Old names of Hub screens, from before the rename: links in Discord history and bookmarks keep working. */
export const HUB_ALIASES: Record<string, HubScreen> = { inbox: 'needs', board: 'work', roadmap: 'map' }

const isAlias = (raw: string) => Object.prototype.hasOwnProperty.call(HUB_ALIASES, raw)
const hubScreenOf = (raw: string) => (isAlias(raw) ? HUB_ALIASES[raw] : raw)

/** A query value of the address: trimmed, at most 80 characters, empty is none. */
const queryValue = (params: URLSearchParams, name: string): string | undefined => params.get(name)?.trim().slice(0, 80) || undefined

export function parseHash(): Route {
  return parseHashString(window.location.hash)
}

/** `parseHash` for a given `location.hash`: pure, so a node test covers it. */
export function parseHashString(hash: string): Route {
  const full = hash.replace(/^#\/?/, '')
  const raw = withoutOverlay(`/${full}`).slice(1)
  const overlay = raw !== full
  const open = <T extends Route>(route: T): T => (overlay ? { ...route, overlay: true } : route)
  if (!raw) return open({ id: null, step: -1 })
  if (raw === '~hub' || raw.startsWith('~hub/') || raw.startsWith('~hub?')) {
    const cut = raw.indexOf('?')
    const path = cut < 0 ? raw : raw.slice(0, cut)
    const params = new URLSearchParams(cut < 0 ? '' : raw.slice(cut + 1))
    const sprint = queryValue(params, 'sprint')
    const project = queryValue(params, 'project')
    const [, first, ...rest] = path.split('/')
    const screen = hubScreenOf(first)
    const known = (HUB_SCREENS as readonly string[]).includes(screen) ? screen as HubScreen : 'today'
    let id = known === screen ? safeDecode(rest.join('/')) : ''
    if (!id && project && (known === 'work' || known === 'project' || known === 'map')) id = project
    return open({ id: null, step: -1, hub: { screen: known, ...(id ? { id } : {}), ...(sprint ? { sprint } : {}), ...(project ? { project } : {}) } })
  }
  const [id, stepRaw] = raw.split('/')
  const step = Number(stepRaw)
  return open({
    id: decodeURIComponent(id),
    step: Number.isInteger(step) && step >= 0 ? step : -1,
  })
}

export interface Scope { project?: string; sprint?: string }

/** The hash with `?project=` and `?sprint=` appended, for the parts of `scope` that are set. A hash that has a query already gets `&`. */
export function withScope(hash: string, scope: Scope): string {
  const params = new URLSearchParams()
  if (scope.project) params.set('project', scope.project)
  if (scope.sprint) params.set('sprint', scope.sprint)
  const query = params.toString()
  return query ? `${hash}${hash.includes('?') ? '&' : '?'}${query}` : hash
}

/** The project and sprint of a Hub route: the project is the one the screen shows (a path id wins over `?project=`). */
export function scopeOf(hub: HubRoute | undefined): Scope {
  if (!hub) return {}
  const fromPath = hub.screen === 'work' ? parseWorkId(hub.id).project : hub.screen === 'project' ? parseProjectId(hub.id).project : hub.screen === 'map' ? hub.id?.split('/')[0] : undefined
  const project = fromPath || hub.project
  return { ...(project ? { project } : {}), ...(hub.sprint ? { sprint: hub.sprint } : {}) }
}

/** The scope of the address now. */
export const currentScope = (): Scope => scopeOf(parseHash().hub)

/** `#/~hub/work?project=<board>[&sprint=<s>]`, or `#/~hub/work` for none: the Work board, optionally narrowed to a sprint. */
export function workBoardHash(board?: string, sprint?: string): string {
  return withScope('#/~hub/work', { project: board, sprint })
}

export function entityHash(id: string, step = -1): string {
  const base = `#/${encodeURIComponent(id)}`
  return step >= 0 ? `${base}/${step}` : base
}

export function hubHash(screen: HubScreen, id?: string): string {
  return id ? `#/~hub/${screen}/${encodeURIComponent(id)}` : `#/~hub/${screen}`
}

/** `#/~hub/project[/<id>[/<tab>]]`: a project's page. No tab is the Roadmap tab; `work` and `cards` are the others. No id is the Projects list. */
export function projectHash(id?: string, tab?: string, sprint?: string): string {
  if (!id) return withScope('#/~hub/project', { sprint })
  const base = `#/~hub/project/${encodeURIComponent(id)}`
  return withScope(tab && tab !== 'roadmap' ? `${base}/${encodeURIComponent(tab)}` : base, { sprint })
}

/** The project id, the raw tab and, on the Roadmap tab, the node whose details are open, out of a project route id (`[<id>[/<tab>[/<node>]]]`); `tabOf` (projectPage.ts) turns the tab into one of the three. */
export function parseProjectId(id: string | undefined): { project?: string; tab?: string; node?: string } {
  if (!id) return {}
  const [project, tab, ...rest] = id.split('/')
  const node = tab === 'roadmap' ? rest.join('/') : ''
  return { ...(project ? { project } : {}), ...(tab ? { tab } : {}), ...(node ? { node } : {}) }
}

/** `#/~hub/project/<id>/roadmap/<node>`: the project's page with that milestone or task's details open over it. */
export function projectNodeHash(id: string, node: string, sprint?: string): string {
  return withScope(`#/~hub/project/${encodeURIComponent(id)}/roadmap/${encodeURIComponent(node)}`, { sprint })
}

/** `#/~hub/map/<project>[/<node>]`: the map, and with a node its details panel open. */
export function mapHash(project: string, node?: string, sprint?: string): string {
  const base = `#/~hub/map/${encodeURIComponent(project)}`
  return withScope(node ? `${base}/${encodeURIComponent(node)}` : base, { sprint })
}

/** `#/~hub/work/<board>/<bead>`: the Work board (a project's own, or `all`) with that item's card highlighted and its details sheet open. */
export function workHash(board: string, bead: string, sprint?: string): string {
  return withScope(`#/~hub/work/${encodeURIComponent(board)}/${encodeURIComponent(bead)}`, { sprint })
}

/** The board (a project id or `all`) and bead out of a Work route id (`<board>[/<bead>]`); a bare board has no bead. */
export function parseWorkId(id: string | undefined): { project?: string; bead?: string } {
  if (!id) return {}
  const [project, ...rest] = id.split('/')
  const bead = rest.join('/')
  return { project: project || undefined, ...(bead ? { bead } : {}) }
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

/** What the rail and the tab bar can light. */
export type NavId = 'today' | 'chat' | 'library' | 'project' | 'search' | 'work' | 'team' | 'sketch' | 'settings'

/**
 * The rail entry a screen lights. An Ask, a review, a checklist or a request awaiting approval is opened from Today, so Today
 * stays lit; Activity and Jobs are Work's tabs; an agent's page is Team's; the Map is the project's. The cards' own pages are
 * the Library's (`null` route, or no Hub screen).
 */
export function navScreen(screen: HubScreen | undefined): NavId | null {
  switch (screen) {
    case undefined: return null
    case 'today': case 'needs': case 'ask': case 'checklist': case 'review': case 'request': return 'today'
    case 'chat': return 'chat'
    case 'library': return 'library'
    case 'project': case 'map': return 'project'
    case 'search': return 'search'
    case 'work': case 'activity': case 'jobs': return 'work'
    case 'team': case 'agent': case 'agent-edit': return 'team'
    case 'sketch': return 'sketch'
    case 'settings': return 'settings'
    default: return null
  }
}

/** The phone shows its tab bar on a tab's own list and on an open card (Library lit, so the way out is under the thumb), and on no other screen: not on an item, a thread, a project, Work, Team, Sketch or Settings. */
export function showsTabs(route: Route): boolean {
  if (route.id) return true
  const hub = route.hub
  if (!hub) return true
  if (hub.screen === 'today' || hub.screen === 'library' || hub.screen === 'search') return true
  return (hub.screen === 'chat' || hub.screen === 'project') && !hub.id
}

/** A chat route's id: the conversation, and the stored line a search hit lands on (`<id>/m/<line>`). Help ids (`help/...`) pass through. */
export function parseChatId(id: string | undefined): { id?: string; line?: number } {
  const match = id ? /^(.+)\/m\/(\d+)$/.exec(id) : null
  return match ? { id: match[1], line: Number(match[2]) } : { id }
}

/** Where the cards' list is: the Library screen. */
export const libraryHash = (): string => hubHash('library')

export function resolveStep(count: number, requested: number, preferred?: number): number {
  const valid = (value: number | undefined): value is number =>
    typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < count
  return valid(requested) ? requested : valid(preferred) ? preferred : count - 1
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
