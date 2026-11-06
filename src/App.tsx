import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { WorkspaceCard } from './types'
import { useWorkspace } from './lib/workspace'
import { parseHash, parseChatId, hubHash, libraryHash, navScreen, showsTabs, entityHash, resolveStep, type HubScreen, type Route } from './lib/route'
import { ROUTE_EVENT, back, go, hasOverlay, swap } from './lib/entries'
import { canonicalAddress } from './lib/redirects'
import { useOrder } from './lib/order'
import { useCanWrite } from './lib/writes'
import { pathId, projectPath } from './lib/sites'
import { downloadFile } from './lib/download'
import BrandLogo from './components/BrandLogo'
import Topbar from './components/Topbar'
import CardWritesStrip from './hub/CardWritesStrip'
import UndoToast from './components/UndoToast'
import { restore, trashOf } from './lib/trash'
import { LibraryContext, canManage } from './lib/library'
import ReportBoundary from './components/ReportBoundary'
import Shortcuts from './components/Shortcuts'
import Search from './search/Search'
import { host } from './lib/host'
import type { Today } from './lib/hub'
import { TodayContext, useHubData } from './hub/useHub'
import { heldAmong, useHeld } from './hub/heldSend'
import Rail from './ui/Rail'
import Tabs from './ui/Tabs'
import TopBar from './ui/TopBar'
import { Screen, Split } from './ui/Layout'
import LibraryScreen from './library/LibraryScreen'
import { isArchived, orderedSections } from './library/libraryModel'
import { setArchived, setPinned } from './library/cardActions'
import { Button } from './ui/Controls'
import { useAutoHideHeader, useIsDesktop, useMedia } from './lib/chrome'
import { cardFile, cardUrl, reportError } from './local/client'

const Compare3D = lazy(() => import('./components/Compare3D'))
const ReportViewer = lazy(() => import('./components/ReportViewer'))
const HubScreen = lazy(() => import('./hub/HubScreen'))
const WebView = lazy(() => import('./components/WebView'))
const Settings = lazy(() => import('./hub/Settings'))

/** A Hub screen is remounted when its address changes, except a chat's message line (`chat/<id>/m/<line>`) and a review's file (`review/<event>/<path>`), which keep the screen alive. Work keeps it for every address: the board remounts itself when the resolved board changes (Board.tsx). Projects keep it for every project, tab and map address (the Projects list stays put, and the page keys itself on the project), so List and Map never reload the model. */
const hubKey = (hub: NonNullable<Route['hub']>) => JSON.stringify(hub.screen === 'work' || hub.screen === 'map' || hub.screen === 'project' ? { screen: hub.screen === 'work' ? 'work' : 'project' } : hub.screen === 'team' || hub.screen === 'agent' ? { screen: 'team' } : hub.screen === 'chat' ? { ...hub, id: parseChatId(hub.id).id } : hub.screen === 'review' ? { ...hub, id: hub.id?.split('/')[0] } : hub)

/**
 * The route in the address. An old or wrong address (an old Hub screen name, an empty hash, a leftover sheet marker) is rewritten
 * in place to the right one (lib/redirects), with no history entry, so the bar shows it. `first` is the page's first render,
 * where an empty address means the home screen, Today; after that it means Back to the cards.
 */
function readRoute(first = false): Route {
  const target = canonicalAddress({
    pathname: window.location.pathname, hash: window.location.hash, hub: host.hub, routes: host.routes,
    first, overlayOpen: hasOverlay(),
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
  request: { title: 'Job', parent: hubHash('today') },
  work: { title: 'Work', parent: hubHash('today') },
  activity: { title: 'Work', parent: hubHash('today') },
  jobs: { title: 'Work', parent: hubHash('today') },
  team: { title: 'Team', parent: hubHash('today') },
  agent: { title: 'Team', parent: hubHash('team') },
  'agent-edit': { title: 'Team', parent: hubHash('team') },
  sketch: { title: 'Sketch', parent: hubHash('today') },
  settings: { title: 'Settings', parent: homeAddress() },
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
  // What is held for Undo is out of the count, like it is out of Today's rows and Needs you: `useHeld` is the one source.
  const held = useHeld()
  const needsYou = Math.max(0, (today.data?.counts.needsYou ?? 0) - heldAmong(today.data?.needsYou ?? [], held))
  // Which project the lists show; '' is all of them. On a site it is the first path segment,
  // so a filtered view can be linked, bookmarked and reached with the back button. In the
  // local app there is no address bar, so it is remembered instead. Never allowed to hide
  // everything (see `project`).
  const [chosenProject, setChosenProject] = useState(
    () => (host.routes === 'hash' ? localStorage.getItem('buw.project') ?? '' : pathId()),
  )
  // Beside an open card the list takes 384 px, which a wide HTML report cannot spare below 1400 px: there it starts folded, with a
  // "Show list" button. The choice is remembered here once made, like the collapsed sections (lib/collapse).
  const wide = useMedia('(min-width: 1400px)')
  const [menuPref, setMenuPref] = useState<boolean | null>(() => {
    const saved = localStorage.getItem('buw.menuCollapsed')
    return saved === '1' ? true : saved === '0' ? false : null
  })
  const setCollapsed = useCallback((next: boolean) => {
    setMenuPref(next)
    try { localStorage.setItem('buw.menuCollapsed', next ? '1' : '0') } catch { /* storage blocked */ }
  }, [])
  const searchRef = useRef<HTMLInputElement>(null)

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

  // The section chips' order, if one was ever saved (lib/order).
  const { order } = useOrder()
  const workspaces = useMemo(
    () => orderedSections(data?.workspaces ?? [], order),
    [data, order],
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
  // Beside a card the list starts folded below 1400 px; on the Library it is the screen, and folds only when asked.
  const listFolded = entity ? (menuPref ?? !wide) : menuPref === true
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

  const goHome = useCallback(() => { go(homeAddress()) }, [])
  /** Every in-app Back: one step of history, or the Library when this page was opened from a link. */
  const goBack = useCallback(() => { back(homeAddress()) }, [])

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
  }>({ entity, reportUrl, step, stepIndex, searching: searchOpen, folded: false })
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
          window.setTimeout(() => { searchRef.current?.focus(); searchRef.current?.select() }, 60)
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
      if (ev.altKey || ev.ctrlKey || ev.metaKey) return
      if (ev.key === 'Escape') {
        // Leaving a field, a menu or a dialog comes first; Esc on the page itself goes home.
        if (typing || editing || document.querySelector('dialog[open]')) return
        if (!keyState.current.entity) return
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
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [goBack, setCollapsed])

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
    // Only where the project is in the address: a hash host has no path to correct, and the chip is the Library's, kept for Back.
    if (host.routes !== 'path' || !openProject || !project || openProject === project) return
    // The address is the other half of this state and only an effect can rewrite it, so the
    // filter moves here too rather than being derived — a derived filter would snap back to
    // the old project the moment the card is closed, leaving the path behind.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setChosenProject(openProject)
    if (host.routes === 'path') swap(window.location.hash, projectPath(openProject))
  }, [openProject, project])

  const pickProject = useCallback((id: string) => {
    setChosenProject(id)
    // The path is the filter on a site: /magic-loops, or / for every project. Replaced in place, so switching project
    // does not reload the app, lose the open card or add a step to Back; a reload or a shared link keeps the filter.
    if (host.routes === 'path') swap(window.location.hash, projectPath(id))
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
      folded: listFolded,
    }
  })

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
      : host.hub ? ((hubScreen === 'project' || hubScreen === 'map') && view.hub.id ? { title: 'Project', parent: hubHash('project') } : hubScreen === 'team' && view.hub.id?.startsWith('skills/') ? { title: 'Team', parent: hubHash('team', 'skills') } : hubScreen ? DETAIL[hubScreen] : undefined)
        : undefined
  // The list is the Library: the screen itself where no card is open, and beside an open card on a desktop (unless folded).
  const libraryScreen = !hubOnly && !showSettings
  const showList = !entity ? !(desktop && listFolded) : desktop && !listFolded
  const lit = searchOpen && !desktop ? 'search' : view.hub ? navScreen(view.hub.screen) : 'library'
  const screenKey = hubOnly ? hubKey(view.hub!) : showSettings ? 'settings' : liveUrl || reportUrl || 'home'
  const fallback = <div className="boot"><BrandLogo size={56} animated={false} /></div>
  const trashNotice = inTrash && (
    <p className="home-filter lib-trash-notice" role="status" data-trash-notice>
      This card is in the Trash of {inTrash.workspace.name}.{' '}
      {canManage(inTrash.workspace) && <button type="button" className="home-filter-clear" onClick={() => void restore(inTrash)}>Restore</button>}
    </p>
  )
  const list = (
    <LibraryScreen
      workspaces={workspaces}
      cards={cards}
      section={project}
      onSection={pickProject}
      active={entity}
      offline={offline}
      lastSync={lastSync}
      notice={trashNotice}
      searchRef={searchRef}
      onCollapse={desktop && entity ? () => setCollapsed(true) : undefined}
    />
  )

  const body = (
    <>
        {entity && (
          <Topbar
            entity={entity}
            stepIndex={stepIndex}
            onStep={selectStep}
            onBack={goBack}
            onHome={goHome}
            onShowList={desktop && listFolded ? () => setCollapsed(false) : undefined}
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
          ) : null}
          </ReportBoundary>
          )}
          </Screen>
        </div>
    </>
  )

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

      {showKeys && <Shortcuts onClose={() => setShowKeys(false)} />}
      {searchOpen && desktop && <Search desktop onClose={() => back(hubHash('today'))} />}

      <main className="main">
        {searchOpen && !desktop ? (
          <div className="content"><Screen key="search"><Search desktop={false} onClose={() => back(hubHash('today'))} /></Screen></div>
        ) : libraryScreen ? (
          <Split
            list={showList ? (desktop ? list : <Screen key="library">{list}</Screen>) : null}
            detail={entity ? <div className="lib-detail">{body}</div> : undefined}
            folded={!showList}
            empty={<>Pick a card to read it.{desktop && listFolded && <><br /><Button small tone="ghost" data-show-list="" onClick={() => setCollapsed(false)}>Show list</Button></>}</>}
          />
        ) : body}
      </main>
      {!desktop && host.hub && showsTabs(route) && <Tabs lit={lit} needsYou={needsYou} />}
    </div>
    </TodayContext.Provider>
    </LibraryContext.Provider>
  )
}
