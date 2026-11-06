import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CardWorkspace, WorkspaceCard } from './types'
import { useWorkspace, archiveCutoff } from './lib/workspace'
import { parseHash, hubHash, libraryHash, navScreen, showsTabs, entityHash, resolveStep, type HubScreen, type Route } from './lib/route'
import { ROUTE_EVENT, back, go, hasOverlay, swap } from './lib/entries'
import { canonicalAddress } from './lib/redirects'
import { useCardDrag, type DragItem, type DropTarget } from './lib/drag'
import { applyOrder, cardKey, moveBeside, moveBy, useOrder } from './lib/order'
import { useCanWrite } from './lib/writes'
import { pathId, projectPath } from './lib/sites'
import { downloadFile } from './lib/download'
import BrandLogo from './components/BrandLogo'
import Sidebar from './components/Sidebar'
import Topbar from './components/Topbar'
import CardWritesStrip from './hub/CardWritesStrip'
import HomeGrid from './components/HomeGrid'
import UndoToast from './components/UndoToast'
import { restore, trashOf } from './lib/trash'
import { LibraryContext, canManage } from './lib/library'
import ReportBoundary from './components/ReportBoundary'
import Shortcuts from './components/Shortcuts'
import CommandPalette from './components/CommandPalette'
import { host } from './lib/host'
import type { Today } from './lib/hub'
import { TodayContext, useHubData } from './hub/useHub'
import Rail from './ui/Rail'
import Tabs from './ui/Tabs'
import TopBar from './ui/TopBar'
import { Screen } from './ui/Layout'
import TrashList from './components/TrashList'
import { Button } from './ui/Controls'
import { useAutoHideHeader, useIsDesktop, useMedia } from './lib/chrome'
import { api, cardFile, cardUrl, reportError } from './local/client'

const Compare3D = lazy(() => import('./components/Compare3D'))
const ReportViewer = lazy(() => import('./components/ReportViewer'))
const HubScreen = lazy(() => import('./hub/HubScreen'))
const WebView = lazy(() => import('./components/WebView'))
const Settings = lazy(() => import('./hub/Settings'))

// Freshly-touched work always burns at the top: sort by `updated` (falls back
// to `created`), regardless of status — a report an agent just edited must not sink
// under long-lived "active" entities. Status only breaks ties.
const lastTouched = (e: WorkspaceCard) => e.updated ?? e.created
// An explicit `archived` status always wins, so a card can be put away by hand
// while it is still inside the 7-day window. Otherwise it is the date rule,
// which `pinned` overrides in the other direction.
const isArchived = (e: WorkspaceCard) =>
  e.status === 'archived' || (!e.pinned && !e.sample && lastTouched(e) < archiveCutoff())
const statusRank = (e: WorkspaceCard) => (e.status === 'active' ? 0 : 1)
const byFreshness = (a: WorkspaceCard, b: WorkspaceCard) =>
  lastTouched(b).localeCompare(lastTouched(a)) || statusRank(a) - statusRank(b)

// Pins keep the order they were dragged into; one that has never been dragged waits at the
// bottom of the list, newest first, rather than jumping around as it is touched.
const pinRank = (e: WorkspaceCard) =>
  typeof e.pinOrder === 'number' ? e.pinOrder : Number.POSITIVE_INFINITY
const sortPins = (cards: WorkspaceCard[]) =>
  cards.filter(e => e.pinned).sort((a, b) => pinRank(a) - pinRank(b) || byFreshness(a, b))

/** A Hub screen is remounted when its address changes, except the map's panel (`map/<project>/<node>`), a project page's tab (`project/<id>/<tab>`) and a review's file (`review/<event>/<path>`), which keep the screen alive. Work keeps it for every address: the board remounts itself when the resolved board changes (Board.tsx). */
const hubKey = (hub: NonNullable<Route['hub']>) => JSON.stringify(hub.screen === 'work' ? { ...hub, id: undefined } : hub.screen === 'map' || hub.screen === 'project' || hub.screen === 'review' ? { ...hub, id: hub.id?.split('/')[0] } : hub)

/**
 * The route in the address. An old or wrong address (an old Hub screen name, an empty hash, a leftover sheet marker) is rewritten
 * in place to the right one (lib/redirects), with no history entry, so the bar shows it. `first` is the page's first render,
 * where an empty address means the home screen, Today; after that it means Back to the cards.
 */
function readRoute(first = false): Route {
  const target = canonicalAddress({
    pathname: window.location.pathname, hash: window.location.hash, hub: host.hub, routes: host.routes,
    first, overlayOpen: hasOverlay(),
    // The project page's Work and Cards tabs arrive with item 9; until then its old tab names stand.
    projectTabs: false,
  })
  if (target) {
    const at = target.indexOf('#')
    swap(target.slice(at), at > 0 ? target.slice(0, at) : undefined, false)
  }
  return parseHash()
}

/** Where the cards are: the Library screen with a Hub, the bare address without one. */
const homeAddress = () => (host.hub ? libraryHash() : '#/')

/** What an unknown underlay falls back to under Search: Today, or the Library where there is no Hub. */
const fallbackRoute = (): Route => (host.hub ? { id: null, step: -1, hub: { screen: 'today' } } : { id: null, step: -1 })

/** The Hub screens that are a page of their own, opened on top of the tabs: a Back button and no tab bar. */
const DETAIL: Partial<Record<HubScreen, { title: string; parent: string }>> = {
  needs: { title: 'Needs you', parent: hubHash('today') },
  ask: { title: 'Question', parent: hubHash('needs') },
  checklist: { title: 'Steps', parent: hubHash('needs') },
  review: { title: 'Review', parent: hubHash('needs') },
  request: { title: 'Request', parent: hubHash('needs') },
  work: { title: 'Work', parent: hubHash('today') },
  activity: { title: 'Work', parent: hubHash('today') },
  jobs: { title: 'Work', parent: hubHash('today') },
  team: { title: 'Team', parent: hubHash('today') },
  agent: { title: 'Team', parent: hubHash('team') },
  'agent-edit': { title: 'Team', parent: hubHash('team') },
  map: { title: 'Roadmap', parent: hubHash('project') },
  sketch: { title: 'Sketch', parent: hubHash('today') },
  settings: { title: 'Settings', parent: homeAddress() },
}

/**
 * On a phone the card list is the grid alone, so what the list used to hold is one row above it: the pinned cards, the Trash, and where there
 * is no Hub (so no tabs) a way to Search and Settings. Replaced by the Library screen in item 3.
 */
function PhoneLibraryBar({ pinned, workspaces }: { pinned: WorkspaceCard[]; workspaces: CardWorkspace[] }) {
  const trashed = trashOf(workspaces)
  const purgePending = host.purge && workspaces.some(w => canManage(w) && Object.values(w.retired ?? {}).some(r => r.kind === 'purged' && r.pending))
  const [trashOpen, setTrashOpen] = useState(false)
  if (!pinned.length && !trashed.length && !purgePending && host.hub) return null
  return (
    <div className="ui-libbar" data-phone-library-bar>
      {pinned.length > 0 && (
        <nav className="ui-pins" aria-label="Pinned cards" data-phone-pins>
          {pinned.map(card => <a key={`${card.workspace.id}/${card.id}`} href={entityHash(card.id)}>{card.title}</a>)}
        </nav>
      )}
      {(trashed.length > 0 || purgePending) && <Button small tone="ghost" data-trash-link="" onClick={() => setTrashOpen(true)}>Trash ({trashed.length})</Button>}
      {!host.hub && <Button small tone="ghost" data-nav="search" onClick={() => go(hubHash('search'))}>Search</Button>}
      {!host.hub && <Button small tone="ghost" data-nav="settings" onClick={() => go(hubHash('settings'))}>Settings</Button>}
      {trashOpen && <TrashList entries={trashed} onClose={() => setTrashOpen(false)} />}
    </div>
  )
}

export default function App() {
  const { data, offline, lastSync } = useWorkspace()
  // Pin, reorder and archive are offered wherever something can write them: the local
  // service, or a published site running the write API. Everywhere else the cards stay
  // read-only, which is what a site without that API has always been.
  const canWrite = useCanWrite()
  // `under` is the last screen that was not Search: Search is drawn over it, and a card under it stays open.
  const [{ route, under }, setNav] = useState(() => {
    const first = readRoute(true)
    return { route: first, under: first.hub?.screen === 'search' ? fallbackRoute() : first }
  })
  const setRoute = useCallback((next: Route) => setNav(now => ({ route: next, under: next.hub?.screen === 'search' ? now.under : next })), [])
  const searchOpen = route.hub?.screen === 'search'
  const view = searchOpen ? under : route
  const desktop = useIsDesktop()
  // The Hub's one `/today` poll: the sidebar badge, the phone's tab bar and the Today screen all read it.
  const today = useHubData<Today>(host.hub ? '/today' : null)
  const needsYou = today.data?.counts.needsYou ?? 0
  const [query, setQuery] = useState('')
  // Which project the lists show; '' is all of them. On a site it is the first path segment,
  // so a filtered view can be linked, bookmarked and reached with the back button. In the
  // local app there is no address bar, so it is remembered instead. Never allowed to hide
  // everything (see `project`).
  const [chosenProject, setChosenProject] = useState(
    () => (host.routes === 'hash' ? localStorage.getItem('buw.project') ?? '' : pathId()),
  )
  // Open or shut is this browser's business, like the collapsed sections (lib/collapse): it
  // survives a reload here and says nothing about anyone else's screen.
  const [showArchived, setShowArchived] = useState(() => localStorage.getItem('buw.showArchived') === '1')
  // Recent is a way of looking (one newest-first run, no sections), remembered like the archive.
  const [showRecent, setShowRecent] = useState(() => {
    try { return localStorage.getItem('buw.showRecent') === '1' } catch { return false }
  })
  const [busyCard, setBusyCard] = useState<string | null>(null)

  // Beside an open card the list takes 384 px, which a wide HTML report cannot spare below 1400 px: there it starts folded, with a
  // "Show list" button. The choice is remembered here once made, like the collapsed sections (lib/collapse).
  const wide = useMedia('(min-width: 1400px)')
  const [menuPref, setMenuPref] = useState<boolean | null>(() => {
    const saved = localStorage.getItem('buw.menuCollapsed')
    return saved === '1' ? true : saved === '0' ? false : null
  })
  const collapsed = menuPref ?? !wide
  const setCollapsed = useCallback((next: boolean) => {
    setMenuPref(next)
    try { localStorage.setItem('buw.menuCollapsed', next ? '1' : '0') } catch { /* storage blocked */ }
  }, [])
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    localStorage.setItem('buw.showArchived', showArchived ? '1' : '0')
  }, [showArchived])
  useEffect(() => {
    try { localStorage.setItem('buw.showRecent', showRecent ? '1' : '0') } catch { /* storage blocked */ }
  }, [showRecent])
  useEffect(() => {
    if (host.routes === 'hash') localStorage.setItem('buw.project', chosenProject)
  }, [chosenProject])

  // Back and forward move between filtered views on a site, because the filter is the path.
  useEffect(() => {
    if (host.routes === 'hash') return
    // Both halves of the address at once. Back fires popstate before hashchange, so updating
    // only the project here leaves one render where the filter has moved but the open card has
    // not — long enough for the effect below to rewrite the entry you just came back to.
    const onPop = () => { setChosenProject(pathId()); setRoute(readRoute()) }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [setRoute])

  // Stable between loads: the keyboard shortcuts depend on the list, and a fresh [] every
  // render would rebind the listener on each one.
  // The projects in the order they were dragged into, which is also the order of their number keys.
  const { order, setProjects, setSections, setCards } = useOrder()
  const workspaces = useMemo(
    () => applyOrder(data?.workspaces ?? [], w => w.id, order.projects, 'last'),
    [data, order.projects],
  )
  const cards = useMemo(() => data?.cards ?? [], [data])
  // A project that is gone from the registry (unregistered, or a site that stopped publishing)
  // would otherwise filter every card away with no visible chip to undo it.
  const project = workspaces.some(w => w.id === chosenProject) ? chosenProject : ''

  // Card ids are unique inside a workspace, not across them: the active workspace wins a tie.
  const open = cards.filter(e => e.id === view.id)
  // A Hub run names its card by folder (`assistant/<folder>`), and a move keeps the folder: when no card has
  // that id, open the one whose folder matches.
  const byFolder = open.length || !view.id ? [] : cards.filter(e => e.folder === view.id)
  const entity = open.find(e => e.workspace.active) ?? open[0] ?? byFolder[0] ?? null
  // A link to a card that was deleted: say where it is, with a way back.
  const inTrash = !entity && view.id ? trashOf(workspaces).find(t => t.id === view.id) ?? null : null
  const library = useMemo(() => ({ workspaces, cards }), [workspaces, cards])

  const stepIndex = entity
    ? resolveStep(entity.steps.length, view.step, entity.defaultStep)
    : -1
  const step = entity?.steps[stepIndex]
  const reportUrl = entity && step ? cardUrl(entity, step.path) : null
  const liveUrl = step?.url && /^https?:\/\//i.test(step.url) ? step.url : null
  // A phone's header slides away while you read down the page (lib/chrome).
  useAutoHideHeader(`${entity?.id ?? ''}:${stepIndex}`)

  // The address says what is open: a folder link is rewritten to the card's id.
  const openId = entity?.id
  useEffect(() => {
    if (openId && route.id && openId !== route.id && !searchOpen) swap(entityHash(openId, route.step))
  }, [openId, route.id, route.step, searchOpen])

  // Hash → state: links navigate natively; this also covers back/forward, and `swap`, which changes the address with no hashchange.
  useEffect(() => {
    const onHash = () => setRoute(readRoute())
    window.addEventListener('hashchange', onHash)
    window.addEventListener(ROUTE_EVENT, onHash)
    return () => {
      window.removeEventListener('hashchange', onHash)
      window.removeEventListener(ROUTE_EVENT, onHash)
    }
  }, [setRoute])

  const goHome = useCallback(() => {
    go(homeAddress())
    // Back on the board means the whole board: a search left running would hide cards with only a
    // "matches" line to say why.
    setQuery('')
  }, [])
  /** Every in-app Back: one step of history, or the Library when this page was opened from a link. */
  const goBack = useCallback(() => { back(homeAddress()); setQuery('') }, [])

  // The keyboard map lives in lib/shortcuts, which the Ctrl+H sheet reads too, so the two cannot
  // drift. Ctrl+W is not on it: the browser keeps that one (close tab) and never lets a page
  // have it, so Esc is the way back to the cards.
  const [showKeys, setShowKeys] = useState(false)
  // Read by the key handler, which is bound once: the open card and what can be done to it.
  // Assigned after each render, so the handlers declared further down are already there.
  const keyState = useRef<{
    entity: WorkspaceCard | null
    reportUrl: string | null
    step: typeof step
    stepIndex: number
    pin?: (card: WorkspaceCard, pinned: boolean) => void
    archive?: (card: WorkspaceCard, archived: boolean) => void
    walkStep?: (id: string, index: number) => void
    searching: boolean
    folded: boolean
  }>({ entity, reportUrl, step, stepIndex, searching: searchOpen, folded: collapsed })
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const t = ev.target as HTMLElement | null
      // Single-letter keys must never fire while you write: in a field, a dropdown, editable
      // text, or anywhere while a note or page is in edit mode (its toolbar has focus too).
      const typing =
        !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)
      const editing = !!document.querySelector('[data-buw-editing]')
      const ctrl = ev.ctrlKey || ev.metaKey
      const key = ev.key.toLowerCase()
      if (ctrl && !ev.altKey) {
        if (!ev.shiftKey && key === 'k' && !ev.defaultPrevented) {
          // Works while typing, like Ctrl+Shift+F. Toggles: the same key shuts it.
          ev.preventDefault()
          if (keyState.current.searching) back(hubHash('today')); else go(hubHash('search'))
        } else if (ev.shiftKey && key === 'f') {
          ev.preventDefault()
          setCollapsed(false)
          // The list is drawn once it is unfolded; focus then, or the browser scrolls to a hidden field.
          window.setTimeout(() => { searchRef.current?.focus(); searchRef.current?.select() }, 0)
        } else if (!ev.shiftKey && key === 'h') {
          ev.preventDefault()
          setShowKeys(v => !v)
        } else if (ev.shiftKey && key === 'p') {
          // Archive or restore the open card. Ctrl+Shift+P is Firefox's private window, which a
          // page cannot take; in Chrome and Edge it is free.
          const { entity: open, archive } = keyState.current
          if (!open || !archive) return
          ev.preventDefault()
          void archive(open, !isArchived(open))
        } else if (ev.shiftKey && key === 's') {
          const { entity: open, reportUrl: url, step: current } = keyState.current
          if (!open || !url) return
          ev.preventDefault()
          const name = current?.path?.split('/').pop() || `${open.id}.html`
          void downloadFile(url, name).catch(error => reportError(error))
        }
        return
      }
      // Alt+A: every project, even from inside the search box.
      if (ev.altKey && !ctrl && !ev.shiftKey && key === 'a' && !editing) {
        ev.preventDefault()
        setChosenProject('')
        setShowArchived(false)
        return
      }
      if (ev.altKey || ev.ctrlKey || ev.metaKey) return
      if (ev.key === 'Escape') {
        // Leaving a field, a menu or a dialog comes first; Esc on the page itself goes home.
        if (typing || editing || document.querySelector('dialog[open]')) return
        if (!keyState.current.entity) { setQuery(''); return }
        ev.preventDefault()
        goBack()
        return
      }
      if (typing || editing || ev.repeat) return
      const { entity: open, stepIndex: at, walkStep: goStep, pin } = keyState.current
      // Q, under the left hand, is the way back; Esc does the same.
      if (key === 'q' && !ev.shiftKey && open) {
        ev.preventDefault()
        goBack()
        return
      }
      // ← and → walk the open card's tabs. The page itself is a frame, so the arrows were not
      // scrolling anything here.
      if ((ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') && !ev.shiftKey && open && goStep && open.steps.length > 1) {
        ev.preventDefault()
        const count = open.steps.length
        goStep(open.id, (at + (ev.key === 'ArrowRight' ? 1 : count - 1)) % count)
        return
      }
      if (key === 'p' && !ev.shiftKey && open && pin) {
        ev.preventDefault()
        void pin(open, !open.pinned)
        return
      }
      if (ev.key === '/') {
        ev.preventDefault()
        if (!keyState.current.searching) go(hubHash('search'))
      } else if (ev.key === '?') {
        ev.preventDefault()
        setShowKeys(v => !v)
      } else if (ev.key === '[') {
        // Folds and unfolds the card list beside an open card; there is nothing to fold anywhere else.
        if (!open) return
        ev.preventDefault()
        setCollapsed(!keyState.current.folded)
      } else if (key === 'a' && ev.shiftKey) {
        // Shift+A, not A: a bare A is too easy to hit by accident, and a board that suddenly
        // shows only archived cards looks like everything was put away.
        ev.preventDefault()
        setShowArchived(v => !v)
      } else if (key === 'r' && ev.shiftKey) {
        ev.preventDefault()
        setShowRecent(v => !v)
      } else if (/^[0-9]$/.test(ev.key) && workspaces.length > 1) {
        const picked = ev.key === '0' ? '' : workspaces[Number(ev.key) - 1]?.id
        if (picked === undefined) return
        ev.preventDefault()
        setChosenProject(picked)
        // "All" means everything live; picking a project keeps the archive filter as it is.
        if (!picked) setShowArchived(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [workspaces, goBack, setCollapsed])

  useEffect(() => {
    const title = entity ? `bunnyUFO Workspace — ${entity.title}` : 'bunnyUFO Workspace'
    document.title = host.dev ? `[dev] ${title}` : title
  }, [entity])

  // The open card decides the project. A pin crosses the filter, so a card opened from the
  // sidebar can belong to another project — and the address then read /agent-plans with a
  // sprite-studio card on screen, which is a link that opens the wrong thing when shared.
  // Follow the card instead: move the filter, and on a site the path, to the project it
  // really lives in. `replaceState`, so back still leads where the card was opened from.
  // Nothing happens with every project on screen ('' ): there is no wrong project to correct.
  const openProject = entity?.workspace.id
  useEffect(() => {
    if (!openProject || !project || openProject === project) return
    // The address is the other half of this state and only an effect can rewrite it, so the
    // filter moves here too rather than being derived — a derived filter would snap back to
    // the old project the moment the card is closed, leaving the path behind.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setChosenProject(openProject)
    if (host.routes === 'path') swap(window.location.hash, projectPath(openProject))
  }, [openProject, project])

  const pickProject = useCallback((id: string) => {
    setChosenProject(id)
    setQuery('')
    if (!id) setShowArchived(false)
    // The path is the filter on a site: /magic-loops, or / for every project. Replaced in place, so switching project
    // does not reload the app, lose the open card or add a step to Back; a reload or a shared link keeps the filter.
    if (host.routes === 'path') swap(window.location.hash, projectPath(id))
  }, [])

  // The archive button on a card. Only the local app has a service to write
  // workspace.json; the published site is read-only and leaves the button out.
  // The card names its own workspace: the grid holds cards from all of them.
  const setArchived = useCallback(async (card: WorkspaceCard, archived: boolean) => {
    setBusyCard(card.id)
    try {
      await api('/workspace/status', {
        id: card.id,
        workspace: card.workspace.id,
        status: archived ? 'archived' : 'active',
      })
      window.dispatchEvent(new Event('bunnyufo-workspace-changed'))
    } catch (error) {
      reportError(error)
    } finally {
      setBusyCard(null)
    }
  }, [])

  // The pin button, and dropping a card into the sidebar's pinned list. Local app only, for the
  // same reason as archiving: a published site has no service to write workspace.json.
  const setPinned = useCallback(async (card: WorkspaceCard, pinned: boolean) => {
    setBusyCard(card.id)
    try {
      await api('/workspace/pin', { id: card.id, workspace: card.workspace.id, pinned })
      window.dispatchEvent(new Event('bunnyufo-workspace-changed'))
    } catch (error) {
      reportError(error)
    } finally {
      setBusyCard(null)
    }
  }, [])

  // The card's icon, from the picker on the card: card state like a pin, so no card file changes.
  const setIcon = useCallback(async (card: WorkspaceCard, emoji: string) => {
    setBusyCard(card.id)
    try {
      await api('/workspace/icon', { id: card.id, workspace: card.workspace.id, emoji })
      window.dispatchEvent(new Event('bunnyufo-workspace-changed'))
    } catch (error) {
      reportError(error)
    } finally {
      setBusyCard(null)
    }
  }, [])

  // Dropping a pin into place. Each card stores its own position, because the list mixes
  // workspaces and no single workspace.json could hold the order of all of them; the service
  // writes the new list in one go, one file per workspace it touches.
  const movePin = useCallback(async (card: WorkspaceCard, list: WorkspaceCard[], at: number) => {
    const others = list.filter(e => !(e.id === card.id && e.workspace.id === card.workspace.id))
    const next = [...others]
    next.splice(Math.max(0, Math.min(at, others.length)), 0, card)
    setBusyCard(card.id)
    try {
      // One request for the whole list: a move touches several cards, and writing them one by
      // one left the list half-sorted on screen (and in the files) in between.
      await api('/workspace/pins', { list: next.map(e => ({ id: e.id, workspace: e.workspace.id })) })
      window.dispatchEvent(new Event('bunnyufo-workspace-changed'))
    } catch (error) {
      reportError(error)
    } finally {
      setBusyCard(null)
    }
  }, [])

  // A tab clicked is a step of its own; the arrow keys walk the tabs in place, or each press would fill the history.
  const selectStep = useCallback((id: string, index: number) => { go(entityHash(id, index)) }, [])
  const walkStep = useCallback((id: string, index: number) => { swap(entityHash(id, index)) }, [])

  // The key handler's view of the open card, refreshed after every render.
  useEffect(() => {
    keyState.current = {
      entity, reportUrl, step, stepIndex,
      pin: canWrite ? setPinned : undefined,
      archive: canWrite ? setArchived : undefined,
      walkStep,
      searching: searchOpen,
      folded: collapsed,
    }
  })

  const q = query.trim().toLowerCase()
  const searching = q.length > 0
  const matchesQuery = (e: WorkspaceCard) =>
    !searching ||
    [e.title, e.description, e.category, e.id, e.workspace.name].some(
      s => s && s.toLowerCase().includes(q),
    )

  const matching = cards.filter(matchesQuery)
  // The archive is a filter, a chip beside the projects: on, the board and the list show what
  // was put away instead of what is live, in the same sections and under the same project
  // filter. It was once a switch that folded everything into one "by date" run (which lost the
  // headings), then an always-present section at the foot (which kept the headings above it but
  // threw the archive itself into one heap). As a filter it keeps both: the view you were in,
  // with archived work in its own project and category sections.
  const listed = matching.filter(e => !isArchived(e))
  const archivedAll = matching.filter(isArchived)
  const pool = showArchived ? archivedAll : listed
  // Chip counts are what each project would show if it were picked, so they add up to "All"
  // and a project with nothing left under this search says 0 instead of looking broken.
  const counts = new Map<string, number>()
  for (const e of pool) counts.set(e.workspace.id, (counts.get(e.workspace.id) ?? 0) + 1)

  const inProject = (e: WorkspaceCard) => !project || e.workspace.id === project
  const visible = pool.filter(inProject)
  const archivedCount = archivedAll.filter(inProject).length
  // The header counts the project's state, not the search's: what is live on the board, what has
  // been put away (by hand or by age), and the categories of the live ones.
  const inScope = cards.filter(inProject)
  const live = inScope.filter(e => !isArchived(e))
  const hero = {
    live: live.length,
    archived: inScope.length - live.length,
    categories: new Set(live.map(e => e.category || 'other')).size,
  }

  // Pinned ignores the project filter. A pin says "keep this in front of me", and having it
  // vanish because you flicked to another project is the opposite of that — the filter is for
  // browsing a project, not for hiding the work you parked at the top. It is a *sidebar* list:
  // the grid stopped repeating it, because a pinned card showing up twice on one screen (once
  // in the pinned strip, once in its own section) is noise, and pins from another project made
  // a filtered grid lie about which project it was showing.
  const pinned = showArchived ? [] : sortPins(listed)
  const rest = [...visible].sort(byFreshness)
  // Grouping follows the filter: with every project on screen the useful split is by project,
  // and inside one project it is by category, as before. With a search running the list is a
  // handful of hits from anywhere and the useful order is purely "what did I touch last", so
  // buckets are dropped and everything stays in one date-sorted run.
  const flat = searching || showRecent
  const groupBy = flat ? 'date' : project || workspaces.length < 2 ? 'category' : 'project'
  // The section a card is listed under, which is also the key its saved order is kept by.
  const sectionOf = (e: WorkspaceCard) =>
    groupBy === 'date' ? (showRecent && !searching ? 'Recent' : 'by date')
      : groupBy === 'project' ? e.workspace.name
        : e.category || 'other'
  const group = (list: WorkspaceCard[]) => {
    const map = new Map<string, WorkspaceCard[]>()
    for (const e of list) {
      const key = sectionOf(e)
      if (!map.has(key)) map.set(key, [])
      map.get(key)!.push(e)
    }
    // A single date-sorted run has nothing to arrange.
    if (groupBy === 'date') return map
    let entries = [...map]
    if (groupBy === 'project') {
      // `workspaces` is already in the dragged order; with none saved, the sections keep
      // following whichever project was touched last.
      if (order.projects.length) {
        const rank = new Map(workspaces.map((w, index) => [w.name, index]))
        entries.sort((a, b) => (rank.get(a[0]) ?? Infinity) - (rank.get(b[0]) ?? Infinity))
      }
    } else {
      entries = applyOrder(entries, ([label]) => label, order.sections, 'last')
    }
    return new Map(entries.map(([label, cards]) => [label, applyOrder(cards, cardKey, order.cards[`${groupBy}:${label}`], 'first')]))
  }
  // The grid carries every card the filter admits, pinned ones included and in their own
  // section. The sidebar lists the pins once, at the top, so its sections leave them out.
  const grouped = group(rest)
  const sidebarGrouped = group(showArchived ? rest : rest.filter(e => !e.pinned))
  // The project is only worth repeating on a card when the list actually mixes projects:
  // not under a project filter, and not when the sections already say it.
  const showProject = !project && workspaces.length > 1 && groupBy !== 'project'

  // What a heading stands for when it is dragged or nudged: a project under a project grouping,
  // a category under a category one, and nothing in the single date-sorted run.
  const sectionItem = (label: string): DragItem | null => {
    if (groupBy === 'project') {
      const id = workspaces.find(w => w.name === label)?.id
      return id ? { kind: 'project', id } : null
    }
    return groupBy === 'category' ? { kind: 'section', label } : null
  }

  // Where something dragged was let go. A card on the pinned list takes a place there, on the
  // sections below it comes off the list, on the archive band it is put away, and on a card of
  // its own section it takes that card's place. Projects and headings are only ever moved beside
  // their own kind. Dropping on the same-kind neighbours is view state, so it needs no write API.
  const onDrop = (item: DragItem, target: DropTarget) => {
    if (item.kind === 'project') {
      if (target.kind !== 'project' || !target.key || !target.edge) return
      setProjects(moveBeside(workspaces.map(w => w.id), item.id, target.key, target.edge))
      return
    }
    if (item.kind === 'section') {
      if (target.kind !== 'section' || !target.key || !target.edge) return
      setSections(moveBeside([...grouped.keys()], item.label, target.key, target.edge))
      return
    }
    const card = item.card
    if (target.kind === 'order') {
      if (!target.key || !target.edge || target.section !== sectionOf(card)) return
      const keys = (grouped.get(target.section) ?? []).map(cardKey)
      setCards(`${groupBy}:${target.section}`, moveBeside(keys, cardKey(card), target.key, target.edge))
      return
    }
    // Pinning, unpinning and archiving write card state; a read-only site cannot.
    if (!canWrite) return
    if (target.kind === 'archive') return void setArchived(card, true)
    if (target.kind === 'unpin') return void setPinned(card, false)
    if (target.kind !== 'pin') return
    // The list as it stands right now, not as it was when this handler was made.
    const list = sortPins(data?.cards ?? [])
    const at = target.index === undefined
      ? list.length
      : target.edge === 'before' ? target.index : target.index + 1
    void movePin(card, list, at)
  }
  const drag = useCardDrag(onDrop)

  // The keyboard's way to rearrange: Alt+↑/↓ on a row or heading in the menu moves it one place
  // among what the menu shows, so a pinned card moves in the pinned list and any other card
  // past its visible neighbour.
  const nudge = (item: DragItem, delta: -1 | 1) => {
    if (item.kind === 'project') {
      setProjects(moveBy(workspaces.map(w => w.id), item.id, delta))
    } else if (item.kind === 'section') {
      setSections(moveBy([...grouped.keys()], item.label, delta))
    } else if (item.card.pinned && !showArchived) {
      if (!canWrite) return
      const list = sortPins(data?.cards ?? [])
      const at = list.findIndex(e => cardKey(e) === cardKey(item.card)) + delta
      if (at >= 0 && at < list.length) void movePin(item.card, list, at)
    } else {
      const label = sectionOf(item.card)
      const shown = (sidebarGrouped.get(label) ?? []).map(cardKey)
      const neighbour = shown[shown.indexOf(cardKey(item.card)) + delta]
      if (!neighbour) return
      const keys = (grouped.get(label) ?? []).map(cardKey)
      setCards(`${groupBy}:${label}`, moveBeside(keys, cardKey(item.card), neighbour, delta < 0 ? 'before' : 'after'))
    }
  }

  if (!data) {
    return (
      <div className="boot">
        <BrandLogo size={76} />
      </div>
    )
  }

  const hubScreen = view.hub?.screen
  // The Hub's own screens; the Library, Settings and Search are drawn here, on every host.
  const hubOnly = !!view.hub && host.hub && hubScreen !== 'library' && hubScreen !== 'settings'
  const showSettings = hubScreen === 'settings'
  const detail = entity || !view.hub ? null
    : showSettings ? DETAIL.settings
      : host.hub ? (hubScreen === 'project' && view.hub.id ? { title: 'Project', parent: hubHash('project') } : hubScreen ? DETAIL[hubScreen] : undefined)
        : undefined
  // The list beside the screen: on the Library, on a card (unless folded) and where there is no Hub. A phone has no such column.
  const showSidebar = desktop && !hubOnly && !showSettings && !(entity && collapsed)
  const lit = searchOpen && !desktop ? 'search' : view.hub ? navScreen(view.hub.screen) : 'library'
  const screenKey = hubOnly ? hubKey(view.hub!) : showSettings ? 'settings' : liveUrl || reportUrl || 'home'
  const fallback = <div className="boot"><BrandLogo size={56} animated={false} /></div>

  return (
    <LibraryContext.Provider value={library}>
    <TodayContext.Provider value={host.hub ? today : null}>
    <UndoToast />
    {host.dev && (
      <div className="dev-banner" data-dev-banner role="status">
        <span>Development copy</span>
        <span className="dev-banner-branch">· {host.dev.branch ?? 'no branch deployed yet'}</span>
        {host.dev.sha && <span>· {host.dev.sha.slice(0, 7)}</span>}
        {host.dev.pr && <span>· PR #{host.dev.pr}</span>}
      </div>
    )}
    <div className="app-layout" data-entity={view.id}>
      {desktop && <Rail lit={lit} needsYou={needsYou} />}
      {showSidebar && (
        <Sidebar
          onHome={goHome}
          canWrite={canWrite}
          dragItem={drag.item}
          dragOver={drag.over}
          onDragStart={drag.begin}
          onDragItem={drag.beginItem}
          afterDrag={drag.afterDrag}
          sectionOf={sectionOf}
          sectionItem={sectionItem}
          onNudge={nudge}
          collapsed={false}
          onReveal={() => setCollapsed(false)}
          onArchive={canWrite ? setArchived : undefined}
          onPin={canWrite ? setPinned : undefined}
          isArchived={isArchived}
          pinned={pinned}
          grouped={sidebarGrouped}
          groupBy={groupBy}
          activeId={entity?.id ?? null}
          query={query}
          onQuery={setQuery}
          searchRef={searchRef}
          workspaces={workspaces}
          project={project}
          counts={counts}
          total={pool.length}
          onProject={pickProject}
          archivedCount={archivedCount}
          showArchived={showArchived}
          onToggleArchived={() => setShowArchived(v => !v)}
          showRecent={showRecent}
          onToggleRecent={() => setShowRecent(v => !v)}
          cardCount={cards.length}
          offline={offline}
          lastSync={lastSync}
          onCollapse={entity ? () => setCollapsed(true) : undefined}
        />
      )}

      {showKeys && <Shortcuts onClose={() => setShowKeys(false)} />}
      {searchOpen && (
        <CommandPalette
          cards={cards}
          items={today.data?.needsYou ?? []}
          waiting={needsYou}
          home={homeAddress()}
          onClose={() => back(hubHash('today'))}
        />
      )}

      <main className="main">
        {entity && (
          <Topbar
            entity={entity}
            stepIndex={stepIndex}
            onStep={selectStep}
            onBack={goBack}
            onHome={goHome}
            onShowList={desktop && collapsed ? () => setCollapsed(false) : undefined}
            onProject={pickProject}
            showProject={workspaces.length > 1}
            liveAppUrl={liveUrl}
          />
        )}
        {detail && <TopBar title={detail.title} parent={detail.parent} phoneOnly />}

        {host.hub && entity && !view.hub && !entity.workspace.builtin && <CardWritesStrip key={`${entity.workspace.id}/${entity.folder}`} section={entity.workspace.id} folder={entity.folder} />}

        <div className="content">
          <Screen key={screenKey}>
          {hubOnly ? (
            <ReportBoundary key={hubKey(view.hub!)} onHome={goHome} title="This Hub screen could not be shown.">
              <Suspense fallback={fallback}><HubScreen route={view.hub!} /></Suspense>
            </ReportBoundary>
          ) : showSettings ? (
            <ReportBoundary key="settings" onHome={goHome} title="Settings could not be shown.">
              <Suspense fallback={fallback}><Settings /></Suspense>
            </ReportBoundary>
          ) : (
          <ReportBoundary key={liveUrl || reportUrl || 'home'} onHome={goHome}>
          {entity && step && liveUrl ? (
            <Suspense fallback={fallback}><WebView
              key={liveUrl}
              url={liveUrl}
              title={step.name}
              helpUrl={step.path ? reportUrl : null}
              helpPath={cardFile(entity, step.path)}
            /></Suspense>
          ) : entity && reportUrl && step?.viewer === 'compare3d' ? (
            <Suspense fallback={fallback}><Compare3D
              key={reportUrl}
              manifestUrl={reportUrl}
              baseUrl={reportUrl.slice(0, reportUrl.lastIndexOf('/'))}
            /></Suspense>
          ) : entity && reportUrl ? (
            <Suspense fallback={fallback}><ReportViewer key={reportUrl} url={reportUrl} title={step?.name ?? entity.title} relativePath={cardFile(entity, step?.path ?? '')}
              card={step?.path && !entity.workspace.builtin ? { workspace: entity.workspace.id, id: entity.id, path: step.path, ...(step.agentTab ? { agentTab: true } : {}) } : undefined}
              stepIndex={stepIndex} onStep={index => selectStep(entity.id, index)} /></Suspense>
          ) : (
            <>
            {inTrash && (
              <p className="home-filter lib-trash-notice" role="status" data-trash-notice>
                This card is in the Trash of {inTrash.workspace.name}.{' '}
                {canManage(inTrash.workspace) && <button type="button" className="home-filter-clear" onClick={() => void restore(inTrash)}>Restore</button>}
              </p>
            )}
            {!desktop && <PhoneLibraryBar pinned={pinned} workspaces={project ? workspaces.filter(w => w.id === project) : workspaces} />}
            <HomeGrid
              hero={hero}
              grouped={grouped}
              groupBy={groupBy}
              workspaces={workspaces}
              project={project}
              counts={counts}
              total={pool.length}
              onProject={pickProject}
              offline={offline}
              searching={searching}
              query={query}
              onClearSearch={() => setQuery('')}
              archivedCount={archivedCount}
              showArchived={showArchived}
              onToggleArchived={() => setShowArchived(v => !v)}
              showRecent={showRecent}
              onToggleRecent={() => setShowRecent(v => !v)}
              showProject={showProject}
              onArchive={canWrite ? setArchived : undefined}
              onPin={canWrite ? setPinned : undefined}
              onIcon={canWrite ? setIcon : undefined}
              dragItem={drag.item}
              dragOver={drag.over}
              onDragStart={drag.begin}
              onDragItem={drag.beginItem}
              afterDrag={drag.afterDrag}
              sectionOf={sectionOf}
              sectionItem={sectionItem}
              busyId={busyCard}
            />
            </>
          )}
          </ReportBoundary>
          )}
          </Screen>
        </div>
      </main>
      {!desktop && host.hub && showsTabs(route) && <Tabs lit={lit} needsYou={needsYou} />}
    </div>
    </TodayContext.Provider>
    </LibraryContext.Provider>
  )
}
