import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { WorkspaceCard } from './types'
import { useWorkspace, archiveCutoff } from './lib/workspace'
import { parseHash, entityHash, resolveStep, type Route } from './lib/route'
import { useCardDrag, type DragItem, type DropTarget } from './lib/drag'
import { applyOrder, cardKey, moveBeside, moveBy, useOrder } from './lib/order'
import { useCanWrite } from './lib/writes'
import { pathId, projectPath } from './lib/sites'
import { downloadFile } from './lib/download'
import BrandLogo from './components/BrandLogo'
import Sidebar from './components/Sidebar'
import Topbar from './components/Topbar'
import HomeGrid from './components/HomeGrid'
import ReportBoundary from './components/ReportBoundary'
import Shortcuts from './components/Shortcuts'
import { host } from './lib/host'
import type { Today } from './lib/hub'
import { TodayContext, useHubData } from './hub/useHub'
import HubTabs from './components/HubTabs'
import { useAutoHideHeader } from './lib/chrome'
import { api, cardFile, cardUrl, reportError } from './local/client'

const Compare3D = lazy(() => import('./components/Compare3D'))
const ReportViewer = lazy(() => import('./components/ReportViewer'))
const HubScreen = lazy(() => import('./hub/HubScreen'))
const WebView = lazy(() => import('./components/WebView'))

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

/** A Hub screen is remounted when its address changes, except the map's panel: `map/<project>/<node>` keeps the map, with what is expanded, alive. */
const hubKey = (hub: NonNullable<Route['hub']>) => JSON.stringify(hub.screen === 'map' ? { ...hub, id: hub.id?.split('/')[0] } : hub)

export default function App() {
  const { data, offline, lastSync } = useWorkspace()
  // Pin, reorder and archive are offered wherever something can write them: the local
  // service, or a published site running the write API. Everywhere else the cards stay
  // read-only, which is what a site without that API has always been.
  const canWrite = useCanWrite()
  const [route, setRoute] = useState<Route>(parseHash)
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

  // Where the menu covers the whole screen rather than sitting beside the content (global.css).
  const overlayMenu = () => window.matchMedia('(max-width: 960px)').matches
  const [collapsed, setCollapsed] = useState(
    // A phone opens on the cards, not on a menu covering them.
    () => overlayMenu() || localStorage.getItem('buw.menuCollapsed') === '1',
  )
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    localStorage.setItem('buw.menuCollapsed', collapsed ? '1' : '0')
  }, [collapsed])
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
    const onPop = () => { setChosenProject(pathId()); setRoute(parseHash()) }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  // Stable between loads: the keyboard shortcuts depend on the list, and a fresh [] every
  // render would rebind the listener on each one.
  // The projects in the order they were dragged into, which is also the order of their number keys.
  const { order, setProjects, setSections, setCards } = useOrder()
  const workspaces = useMemo(
    () => applyOrder(data?.workspaces ?? [], w => w.id, order.projects, 'last'),
    [data, order.projects],
  )
  const cards = data?.cards ?? []
  // A project that is gone from the registry (unregistered, or a site that stopped publishing)
  // would otherwise filter every card away with no visible chip to undo it.
  const project = workspaces.some(w => w.id === chosenProject) ? chosenProject : ''

  // Card ids are unique inside a workspace, not across them: the active workspace wins a tie.
  const open = cards.filter(e => e.id === route.id)
  const entity = open.find(e => e.workspace.active) ?? open[0] ?? null

  const stepIndex = entity
    ? resolveStep(entity.steps.length, route.step, entity.defaultStep)
    : -1
  const step = entity?.steps[stepIndex]
  const reportUrl = entity && step ? cardUrl(entity, step.path) : null
  const liveUrl = step?.url && /^https?:\/\//i.test(step.url) ? step.url : null
  // A phone's header slides away while you read down the page (lib/chrome).
  useAutoHideHeader(`${entity?.id ?? ''}:${stepIndex}`)

  // Hash → state: entity links navigate natively; this also covers back/forward.
  useEffect(() => {
    // Opening a card puts the menu away when the menu is the whole screen — otherwise you
    // land on the card behind a menu you have to dismiss by hand.
    const onHash = () => { setRoute(parseHash()); if (overlayMenu()) setCollapsed(true) }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  const goHome = useCallback(() => {
    history.pushState(null, '', window.location.pathname + window.location.search)
    setRoute({ id: null, step: -1 })
    // Back on the board means the whole board: a search left running would hide cards with only a
    // "matches" line to say why.
    setQuery('')
  }, [])

  // The keyboard map lives in lib/shortcuts, which the Ctrl+H sheet reads too, so the two cannot
  // drift. Ctrl+W is not on it: the browser keeps that one (close tab) and never lets a page
  // have it, so Esc is the way back to the cards.
  const [showKeys, setShowKeys] = useState(false)
  // The rail (outside this tree) has the Shortcuts button, and tells the app the way it tells it
  // about changed cards: a window event.
  useEffect(() => {
    const toggle = () => setShowKeys(v => !v)
    window.addEventListener('bunnyufo-shortcuts', toggle)
    return () => window.removeEventListener('bunnyufo-shortcuts', toggle)
  }, [])
  // Read by the key handler, which is bound once: the open card and what can be done to it.
  // Assigned after each render, so the handlers declared further down are already there.
  const keyState = useRef<{
    entity: WorkspaceCard | null
    reportUrl: string | null
    step: typeof step
    stepIndex: number
    pin?: (card: WorkspaceCard, pinned: boolean) => void
    archive?: (card: WorkspaceCard, archived: boolean) => void
    selectStep?: (id: string, index: number) => void
  }>({ entity, reportUrl, step, stepIndex })
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
        if (ev.shiftKey && key === 'f') {
          ev.preventDefault()
          setCollapsed(false)
          // The menu slides in; focus once it is there, or the browser scrolls to a hidden field.
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
        goHome()
        return
      }
      if (typing || editing || ev.repeat) return
      const { entity: open, stepIndex: at, selectStep: goStep, pin } = keyState.current
      // Q, under the left hand, is the way back to the cards; Esc does the same.
      if (key === 'q' && !ev.shiftKey && open) {
        ev.preventDefault()
        goHome()
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
        searchRef.current?.focus()
      } else if (ev.key === '?') {
        ev.preventDefault()
        setShowKeys(v => !v)
      } else if (ev.key === '[') {
        ev.preventDefault()
        setCollapsed(v => !v)
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
  }, [workspaces, goHome])

  useEffect(() => {
    document.title = entity ? `bunnyUFO Workspace — ${entity.title}` : 'bunnyUFO Workspace'
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
    if (host.routes === 'path') history.replaceState(null, '', projectPath(openProject) + window.location.hash)
  }, [openProject, project])

  const pickProject = useCallback((id: string) => {
    setChosenProject(id)
    setQuery('')
    if (!id) setShowArchived(false)
    // The path is the filter on a site: /magic-loops, or / for every project. pushState rather
    // than a navigation, so switching project does not reload the app or lose the open card.
    if (host.routes === 'path') history.pushState(null, '', projectPath(id) + window.location.hash)
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

  const selectStep = useCallback((id: string, index: number) => {
    history.replaceState(null, '', entityHash(id, index))
    setRoute({ id, step: index })
  }, [])

  // The key handler's view of the open card, refreshed after every render.
  useEffect(() => {
    keyState.current = {
      entity, reportUrl, step, stepIndex,
      pin: canWrite ? setPinned : undefined,
      archive: canWrite ? setArchived : undefined,
      selectStep,
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

  return (
    <TodayContext.Provider value={host.hub ? today : null}>
    <div className={`app-layout${collapsed ? ' sidebar-collapsed' : ''}`} data-entity={route.id}>
      <Sidebar
        hubScreen={host.hub ? route.hub?.screen ?? null : null}
        hubNeedsYou={needsYou}
        canWrite={canWrite}
        dragItem={drag.item}
        dragOver={drag.over}
        onDragStart={drag.begin}
        onDragItem={drag.beginItem}
        afterDrag={drag.afterDrag}
        sectionOf={sectionOf}
        sectionItem={sectionItem}
        onNudge={nudge}
        collapsed={collapsed}
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
        onCollapse={() => setCollapsed(true)}
      />

      <button
        className="sidebar-reopen"
        onClick={() => setCollapsed(false)}
        // Dragging a card at the hidden menu opens it, so the pinned list is there to drop on.
        onPointerEnter={() => { if (drag.card) setCollapsed(false) }}
        title="Show menu — press the logo button ( [ )"
        aria-label="Show menu"
      >
        <BrandLogo size={38} animated={route.id !== 'my-dream-game'} />
      </button>

      {showKeys && <Shortcuts onClose={() => setShowKeys(false)} />}

      <main className="main">
        <Topbar
          entity={entity}
          stepIndex={stepIndex}
          onStep={selectStep}
          onHome={goHome}
          onProject={pickProject}
          showProject={workspaces.length > 1}
          liveAppUrl={liveUrl}
        />

        <div className="content">
          {route.hub && host.hub ? (
            <ReportBoundary key={hubKey(route.hub)} onHome={goHome} title="This Hub screen could not be shown.">
              <Suspense fallback={<div className="boot"><BrandLogo size={56} animated={false} /></div>}><HubScreen route={route.hub} /></Suspense>
            </ReportBoundary>
          ) : (
          <ReportBoundary key={liveUrl || reportUrl || 'home'} onHome={goHome}>
          {entity && step && liveUrl ? (
            <Suspense fallback={<div className="boot"><BrandLogo size={56} animated={false} /></div>}><WebView
              key={liveUrl}
              url={liveUrl}
              title={step.name}
              helpUrl={step.path ? reportUrl : null}
              helpPath={cardFile(entity, step.path)}
            /></Suspense>
          ) : entity && reportUrl && step?.viewer === 'compare3d' ? (
            <Suspense fallback={<div className="boot"><BrandLogo size={56} animated={false} /></div>}><Compare3D
              key={reportUrl}
              manifestUrl={reportUrl}
              baseUrl={reportUrl.slice(0, reportUrl.lastIndexOf('/'))}
            /></Suspense>
          ) : entity && reportUrl ? (
            <Suspense fallback={<div className="boot"><BrandLogo size={56} animated={false} /></div>}><ReportViewer key={reportUrl} url={reportUrl} title={step?.name ?? entity.title} relativePath={cardFile(entity, step?.path ?? '')}
              card={step?.path && !entity.workspace.builtin ? { workspace: entity.workspace.id, id: entity.id, path: step.path } : undefined}
              stepIndex={stepIndex} onStep={index => selectStep(entity.id, index)} /></Suspense>
          ) : (
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
          )}
          </ReportBoundary>
          )}
        </div>
      </main>
      {host.hub && !entity && <HubTabs screen={route.hub?.screen ?? null} needsYou={needsYou} onHome={goHome} />}
    </div>
    </TodayContext.Provider>
  )
}
