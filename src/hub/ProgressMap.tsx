import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent, ReactNode } from 'react'
import type { MapWayfinder, ProgressMap as MapModel, TaskState } from '../lib/hub'
import { copyAge } from '../lib/hub'
import { hubHash, mapHash } from '../lib/route'
import { layoutMap, type FeatureNode, type Label, type MapNode, type MilestoneNode, type TaskNode } from './mapLayout'
import MapSigns from './MapSigns'
import MapPanel from './MapPanel'
import MapFilterPanel from './MapFilterPanel'
import SearchField from './SearchField'
import { mapMatches } from './mapSearch.ts'
import { words, type SearchRow } from './beadSearch.ts'
import { ALL_FILTER, OPEN_FILTER, filterLabel, filterMap, isOpenFilter, parseFilter, type MapFilter } from './mapFilter'
import { FIT_MAX, centreOn, clamp, fitScale } from './panZoom'
import { usePanZoom } from './usePanZoom'
import type { ZoomReport } from './usePanZoom'
import { stableOf, zoomStep } from './semanticZoom'
import { SIGN_GLYPH, SIGN_LABEL, groupSigns } from './signs'
import { STATE_COLOR, STATE_LABEL, find } from './mapState'
import { tallyFraction } from './mapCount.ts'
import { useHubData } from './useHub'
import ProjectPicker from './ProjectPicker'
import { useProject } from './useProject'
import QuestionActions from './QuestionActions'
import { COST, preparable, questionSeed } from './questionSeed'
import { openSpawn } from './spawnStore'
import PlanInHermes from './PlanInHermes'
import { ProjectLink } from './ProjectChip'
import RunsOnChip from './RunsOnChip'
import { host } from '../lib/host'

const HINT_KEY = 'hub-map-hint-seen'
const FILTER_KEY = 'hub-map-filter'
/** The viewer's saved filter; a missing or bad value is the default (Open). */
const savedFilter = (): MapFilter => { try { const raw = localStorage.getItem(FILTER_KEY); return raw ? parseFilter(JSON.parse(raw)) : OPEN_FILTER } catch { return OPEN_FILTER } }
const saveFilter = (filter: MapFilter) => { try { if (isOpenFilter(filter)) localStorage.removeItem(FILTER_KEY); else localStorage.setItem(FILTER_KEY, JSON.stringify(filter)) } catch { /* private mode: it is the default next time */ } }
const QUERY_KEY = 'hub-map-search'
/** The viewer's saved search; missing storage is no search. */
const savedQuery = () => { try { return localStorage.getItem(QUERY_KEY) ?? '' } catch { return '' } }
const saveQuery = (q: string) => { try { if (q.trim()) localStorage.setItem(QUERY_KEY, q); else localStorage.removeItem(QUERY_KEY) } catch { /* private mode: no search next time */ } }
const PAD = 16
const hintSeen = () => { try { return localStorage.getItem(HINT_KEY) === '1' } catch { return false } }
/** Where a node's circle is centred in the drawing (a feature's node sits right of the end of its branch). */
const pointOf = (node: MapNode) => ({ ...node.center })
/** After a relayout, one node's point goes back where it was on screen: a chevron toggle and zoom both hold the node's stable point (a feature's elbow, a milestone's circle). */
interface Anchor { id: string; old: { x: number; y: number }; origin: { x: number; y: number }; how: 'stable'; /** A zoom step's: it starts the pause before the next one. */ byZoom: boolean }
/** After the axis switches: put a node (else "now") in the middle of the free part of the box. */
/** `axis` is the one the switch asked for: only the layout drawn on that axis may use it (another relayout, such as a refresh of the data, can land first). */
interface Centre { how: 'centre'; id: string | null; axis: Axis }
type Axis = 'x' | 'y'
/** The box turns vertical when it is at least this much taller than wide, and horizontal when it is no taller than wide; in between it keeps its axis. */
const TALL = 1.15
/** The axis a box of this size asks for, or null to keep the current one. */
const axisFor = (w: number, h: number): Axis | null => (h >= TALL * w ? 'y' : w >= h ? 'x' : null)
/** A zoom step's relayout may not be followed by another this soon (ms). */
const SETTLE_MS = 150

/** The screen's id is `<project>[/<node>]`: the project alone decides what is fetched and drawn, so opening a panel never reloads the map. Project and bead ids have no `/`. */
const splitId = (id?: string): [string | undefined, string | undefined] => {
  const at = id ? id.indexOf('/') : -1
  return at < 0 ? [id, undefined] : [id?.slice(0, at), id?.slice(at + 1) || undefined]
}

export default function ProgressMap({ project: routeId }: { project?: string }) {
  const [wanted, nodeId] = splitId(routeId)
  const { list, project, loading: listing } = useProject(wanted)
  const { data: model, error, loading: mapping } = useHubData<MapModel>(project ? `/map/${encodeURIComponent(project)}` : null)
  return (
    <>
      <h2 className="hub-sr">Roadmap{project ? ` · ${list.find(item => item.id === project)?.name ?? project}` : ''}</h2>
      <div className="hub-map-chips">
        <ProjectPicker id="hub-map-project" projects={list} value={project ?? ''} onChange={id => { window.location.hash = hubHash('map', id) }} href={id => hubHash('map', id)} oneRow inRow />
        <RunsOnChip key={project} runsOn={list.find(item => item.id === project)?.runsOn} />
        {project && <ProjectLink id={project} label="Project" className="pp-map-link" />}
      </div>
      {error && <p className="hub-error" role="alert">{error}</p>}
      {!model && !error && (listing || mapping) && <p className="hub-empty">Loading…</p>}
      {model && !model.meta && <p className="hub-empty">No Beads copy yet. It appears after the next agent session in this repo.</p>}
      {model?.meta && project && (
        <Fragment key={project}>
          <MapView model={model} project={project} nodeId={nodeId} header={(() => {
            const name = list.find(item => item.id === project)?.name ?? project
            const found = nodeId ? find(model, nodeId) : null
            const selected = found ? { id: nodeId as string, title: found.kind === 'm' ? found.milestone.title : found.kind === 'f' ? found.feature.title : found.task.title } : null
            const plan = <PlanInHermes project={project} projectName={name} selected={selected} />
            const way = model.wayfinder
            return way && (way.destination || way.decisions || way.open.length)
              ? <WayfinderHeader project={project} repoName={name} wayfinder={way} plan={plan} />
              : host.write && host.chat ? <div className="hub-plan-row">{plan}</div> : null
          })()} />
        </Fragment>
      )}
    </>
  )
}

/** The Wayfinder destination above the map: one row, with the open questions as links to their nodes. Starts open on a wide box and closed on a narrow one; the state is not remembered. */
function WayfinderHeader({ project, repoName, wayfinder, plan }: { project: string; repoName: string; wayfinder: MapWayfinder; plan?: ReactNode }) {
  const root = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  useLayoutEffect(() => { setOpen((root.current?.clientWidth ?? 0) > 700) }, [])
  const { destination, decisions, open: questions } = wayfinder
  const ready = preparable(wayfinder)
  if (!destination && !decisions && !questions.length) return null
  return (
    <div className="hub-wayfinder" data-open={open} ref={root}>
      <div className="hub-wayfinder-row">
        <span className="hub-wayfinder-eyebrow">Destination</span>
        {destination && (
          <button type="button" className="hub-wayfinder-text" aria-expanded={open} aria-controls="hub-wayfinder-list" onClick={() => setOpen(value => !value)}>
            <span className="hub-wayfinder-dest">{destination}</span>
            <span className="hub-wayfinder-cue" aria-hidden="true">{open ? 'Less' : 'More ›'}</span>
          </button>
        )}
        {decisions > 0 && <span className="hub-wayfinder-count">{decisions} {decisions === 1 ? 'decision' : 'decisions'}</span>}
        {questions.length > 0 && (
          <button type="button" className="hub-wayfinder-toggle" aria-expanded={open} aria-controls="hub-wayfinder-list" onClick={() => setOpen(value => !value)}>
            Open questions · {questions.length}
          </button>
        )}
        {plan}
        {open && host.write && ready.length > 0 && (
          <span className="hub-wayfinder-all">
            <button type="button" className="hub-btn pri" data-q-all onClick={() => openSpawn({ preset: 'question', project, text: questionSeed(project, wayfinder, ready.map(item => item.id), 'grilling') })}>Prepare all · {ready.length}</button>
            <span className="hub-q-cost" data-q-all-cost>{COST.prepareAll}</span>
          </span>
        )}
      </div>
      {open && questions.length > 0 && (
        <ul className="hub-wayfinder-list" id="hub-wayfinder-list">
          {questions.map(item => (
            <li key={item.id} className="hub-q-row" data-q-row={item.id}>
              <span className="hub-q-title"><a href={mapHash(project, item.id)}><span className="hub-wayfinder-type">{item.type}</span> {item.title}</a></span>
              <QuestionActions project={project} repoName={repoName} wayfinder={wayfinder} item={item} layout="row" />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function MapView({ model: fullModel, project, nodeId, header }: { model: MapModel; project: string; nodeId?: string; header?: ReactNode }) {
  const [filter, setFilter] = useState<MapFilter>(savedFilter)
  const [filterOpen, setFilterOpen] = useState(false)
  const [query, setQuery] = useState(savedQuery)
  const searching = query.trim().length > 0
  // The text of the beads, read only while there is a query; titles and ids match before it arrives.
  const text = useHubData<{ rows: SearchRow[] }>(searching ? `/search-text?project=${encodeURIComponent(project)}` : null)
  const rows = searching ? text.data?.rows : undefined
  const matches = useMemo(() => mapMatches(fullModel, query, rows), [fullModel, query, rows])
  // The search looks through the filter: a matched task is drawn whatever the filter says.
  const { model, hidden } = useMemo(() => filterMap(fullModel, filter, undefined, matches.ids), [fullModel, filter, matches])
  // A remembered search opens its matches on the first view; what was open before it is the empty map.
  const [open, setOpen] = useState<ReadonlySet<string>>(() => mapMatches(fullModel, query).open)
  /** What was open before the first search began, to give back when the query is cleared. */
  const beforeSearch = useRef<ReadonlySet<string> | null>(searching ? new Set() : null)
  /** The matches' order the view was last placed for: a data refresh that finds the same matches does not move it. */
  const lastOrder = useRef<string | null>(null)
  /** The match the owner stepped to; null until the first step (the first match is the current one). */
  const [cursor, setCursor] = useState<number | null>(null)
  const [sprints, setSprints] = useState(false)
  const [hint, setHint] = useState(() => !hintSeen())
  const box = useRef<HTMLDivElement>(null)
  const stage = useRef<HTMLDivElement>(null)
  const svg = useRef<SVGSVGElement>(null)
  const drawn = useRef<SVGGElement>(null)
  const origin = useRef({ x: 0, y: 0 })
  /** What to do with the view once the next layout is measured: the first view, a fit, or keep one node where it is on screen. */
  const after = useRef<'init' | 'fit' | Anchor | Centre | null>('init')
  /** The ids that zoom opened (the rest of `open` is the user's); zoom folds only these. */
  const auto = useRef<Set<string>>(new Set())
  const relayoutPending = useRef(false)
  /** The size of the map's frame the view was last placed for: a resize moves the view by the change from this, so a view placed from the live size must say so (else a resize seen later is counted twice). */
  const placedFor = useRef<{ w: number; h: number } | null>(null)
  const lastSemantic = useRef(0)
  const wrap = useRef<HTMLDivElement>(null)
  const keyButton = useRef<HTMLButtonElement>(null)
  const filterButton = useRef<HTMLButtonElement>(null)
  const [keyOpen, setKeyOpen] = useState(false)
  const zoomFn = useRef<(zoom: ZoomReport) => void>(() => {})
  const pushed = useRef(false)
  const lastShown = useRef<string | null>(null)

  const dismissHint = useCallback(() => {
    setHint(false)
    try { localStorage.setItem(HINT_KEY, '1') } catch { /* private mode: it shows again next time */ }
  }, [])
  /** The hint floats over the top of the box: Fit, Now and the first view keep the map clear of it. The control bar sits above the box, under the project chips. */
  const hintBar = useRef<HTMLDivElement>(null)
  const insets = useCallback(() => {
    const frame = box.current?.getBoundingClientRect()
    const hint = hintBar.current?.getBoundingClientRect()
    return { top: frame && hint && hint.height ? Math.max(0, hint.bottom - frame.top + 8) : 0, bottom: 0 }
  }, [])
  const pz = usePanZoom(box, stage, { onGesture: dismissHint, onZoom: zoom => zoomFn.current(zoom), fitMax: FIT_MAX, insets })

  /** The spine runs down when the box is taller than wide, as a phone held upright is. */
  const [axis, setAxis] = useState<Axis>(() => (window.innerHeight > window.innerWidth ? 'y' : 'x'))
  const axisNow = useRef(axis)
  const shown = useRef<string | null>(null)
  const vertical = axis === 'y'
  const layout = useMemo(() => layoutMap(model, open, sprints, axis, hidden), [model, open, sprints, axis, hidden])
  const byId = useMemo(() => new Map(layout.nodes.map(node => [node.id, node])), [layout])
  const toStage = (point: { x: number; y: number }) => ({ x: point.x - origin.current.x, y: point.y - origin.current.y })
  const nowPoint = () => toStage(layout.now)

  /** The part of the box the details panel leaves free: the panel is at the right on a desktop and a sheet below on a phone. */
  const freeRect = () => {
    const element = box.current
    const size = pz.box()
    const { top, bottom } = insets()
    // With no panel open, the map's room is what the hint leaves.
    const clear = { x: 0, y: top, w: size.w, h: Math.max(size.h - top - bottom, 60) }
    const whole = { x: 0, y: 0, w: size.w, h: size.h }
    const panel = document.getElementById('hub-map-panel')
    if (!element || !panel) return clear
    const rect = element.getBoundingClientRect()
    const cover = panel.getBoundingClientRect()
    if (!cover.width || !cover.height) return clear
    const free = cover.width < window.innerWidth * 0.8
      ? { ...whole, w: clamp(cover.left - rect.left, 0, size.w) }
      : { ...whole, h: clamp(cover.top - rect.top, 0, size.h) }
    return free.w < 60 || free.h < 60 ? clear : free
  }

  /** "Now" in the middle of `free` at scale k, without cutting off the text at either side of the spine: the whole width is centred when it fits, else it is pulled in from the nearer edge. */
  const viewOnNow = (k: number, free: { x: number; y: number; w: number; h: number }) => {
    const view = centreOn(nowPoint(), free, k)
    const width = Number(svg.current?.getAttribute('width')) * k
    if (!width) return view
    view.x = width <= free.w ? free.x + (free.w - width) / 2 : clamp(view.x, free.x + free.w - width, free.x)
    return view
  }

  // Once per layout: measure what is drawn, size the SVG and the box to it, and place the view.
  useLayoutEffect(() => {
    const group = drawn.current
    const picture = svg.current
    const frame = box.current
    const waiting = after.current
    // A relayout of the old axis (a data refresh that landed first) must not use the centring meant for the new one: it would place the node by its old coordinates.
    const forNewAxis = typeof waiting === 'object' && waiting !== null && waiting.how === 'centre' && waiting.axis !== axis
    if (!forNewAxis) relayoutPending.current = false
    if (!group || !picture || !frame) return
    const bounds = group.getBBox()
    if (!bounds.width) return // not rendered (a hidden tab): keep the last size and measure at the next layout
    const w = Math.ceil(bounds.width + 2 * PAD)
    const h = Math.ceil(bounds.height + 2 * PAD)
    picture.setAttribute('viewBox', `${bounds.x - PAD} ${bounds.y - PAD} ${w} ${h}`)
    picture.setAttribute('width', String(w))
    picture.setAttribute('height', String(h))
    origin.current = { x: bounds.x - PAD, y: bounds.y - PAD }
    pz.setContent({ w, h })
    const todo = forNewAxis ? null : after.current
    if (!forNewAxis) after.current = null
    if (wrap.current && (todo === 'init' || todo === 'fit' || (todo && todo.how === 'centre'))) placedFor.current = { w: wrap.current.clientWidth, h: wrap.current.clientHeight }
    const size = pz.box()
    if (todo === 'init') {
      // Fitted and centred; a long map on a phone would be too small to read, so it starts at a readable size on "now".
      if (fitScale({ w, h }, size, FIT_MAX) < 0.6) pz.go(viewOnNow(0.6, freeRect()), false)
      else pz.fit(false)
    } else if (todo === 'fit') {
      pz.fit(true)
    } else if (todo && todo.how === 'centre') {
      // The axis switched: the selected node (else "now") goes to the middle of what the panel leaves free, at the scale it had.
      const node = todo.id ? layout.nodes.find(item => item.id === todo.id) : null
      pz.go(centreOn(toStage(node ? pointOf(node) : layout.now), freeRect(), pz.current().k), false)
      pz.rebase()
    } else if (todo) {
      const node = layout.nodes.find(item => item.id === todo.id)
      if (node) {
        // Where the old point is on screen now, from the live view: wheel events that came between the decision and this commit have moved it.
        const view = pz.current()
        const sx = view.x + (todo.old.x - todo.origin.x) * view.k
        const sy = view.y + (todo.old.y - todo.origin.y) * view.k
        const at = toStage(stableOf(node))
        pz.go({ k: view.k, x: sx - at.x * view.k, y: sy - at.y * view.k }, false)
        pz.rebase()
        if (todo.byZoom) lastSemantic.current = performance.now()
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout])

  // The panel the model has for the address; an id the model does not know opens nothing and leaves the address alone.
  const shownId = nodeId && find(fullModel, nodeId) ? nodeId : null
  useLayoutEffect(() => { shown.current = shownId }, [shownId])

  // Semantic zoom: the milestone, then the feature, under the pointer opens as you zoom in; what zoom opened folds as you zoom out.
  // Called at most once per frame by the pan-zoom, never for Fit, Now or glides, and never while a relayout is on its way.
  useEffect(() => {
    zoomFn.current = ({ dir, at, k }) => {
      if (relayoutPending.current || performance.now() - lastSemantic.current < SETTLE_MS) return
      const view = pz.current()
      const here = shownId ? find(fullModel, shownId) : null
      // The ancestors of the node whose panel is open stay open, so the selection stays drawn.
      const keep = new Set<string>()
      if (here) { keep.add(here.milestone.id); if (here.kind !== 'm') keep.add(here.feature.id) }
      const step = zoomStep({
        layout, open, auto: auto.current, k, dir, keep,
        at: { x: (at.x - view.x) / view.k + origin.current.x, y: (at.y - view.y) / view.k + origin.current.y },
      })
      if (!step) return
      const node = byId.get(step.anchor)
      if (!node) return
      auto.current = step.auto
      after.current = { id: node.id, old: stableOf(node), origin: { ...origin.current }, how: 'stable', byZoom: true }
      relayoutPending.current = true
      lastSemantic.current = performance.now()
      setOpen(step.open)
    }
  })

  // The box fills the screen, so a window resize, a rotation or the phone's top bar changes it: keep the middle where it was and the view inside its limits.
  useLayoutEffect(() => {
    const element = wrap.current
    if (!element || typeof ResizeObserver === 'undefined') return undefined
    placedFor.current = { w: element.clientWidth, h: element.clientHeight }
    let first = true
    const observer = new ResizeObserver(() => {
      const next = { w: element.clientWidth, h: element.clientHeight }
      // The first size has no previous axis: vertical when taller than wide. After that the dead band keeps the axis.
      const wanted = first ? (next.h > next.w ? 'y' : 'x') : axisFor(next.w, next.h)
      const initial = first
      first = false
      if (wanted && wanted !== axisNow.current && next.w > 0 && next.h > 0) {
        axisNow.current = wanted
        // Hold the selection (else "now") in view across the switch; zoom waits for the new layout like it does for its own.
        if (after.current !== 'init' || !initial) after.current = { how: 'centre', id: shown.current, axis: wanted }
        relayoutPending.current = true
        placedFor.current = next
        setAxis(wanted)
        return
      }
      const last = placedFor.current ?? next
      if (next.w === last.w && next.h === last.h) return
      const view = pz.current()
      pz.go({ ...view, x: view.x + (next.w - last.w) / 2, y: view.y + (next.h - last.h) / 2 }, false)
      placedFor.current = next
    })
    observer.observe(element)
    return () => observer.disconnect()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Opening a node glides it into the middle of the part of the box the panel leaves free.
  useEffect(() => {
    if (!shownId) return
    const node = byId.get(shownId)
    if (!node) return
    pz.go(centreOn(toStage(pointOf(node)), freeRect(), Math.max(pz.current().k, 1)), true)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shownId])

  // Whatever closes the panel (the button, Escape, Back), focus goes back to the node that opened it.
  useEffect(() => {
    if (shownId) { lastShown.current = shownId; return }
    pushed.current = false
    const id = lastShown.current
    lastShown.current = null
    if (!id) return
    const target = box.current?.querySelector<SVGElement>(`[data-node="${CSS.escape(id)}"]`) ?? box.current
    target?.focus({ preventScroll: true })
  }, [shownId])

  const openPanel = useCallback((id: string) => {
    if (id === shownId) return
    if (shownId) { window.location.replace(mapHash(project, id)); return }
    pushed.current = true
    window.location.assign(mapHash(project, id))
  }, [project, shownId])
  const closePanel = useCallback(() => {
    if (pushed.current) { pushed.current = false; window.history.back() } else window.location.replace(mapHash(project))
  }, [project])

  // Opening or closing a node keeps that node where it is on screen; the rest of the map moves around it.
  const toggle = useCallback((node: MilestoneNode | FeatureNode) => {
    const next = new Set(open)
    if (next.has(node.id)) {
      next.delete(node.id)
      if (node.kind === 'm') for (const feature of model.milestones.find(item => item.id === node.id)?.features ?? []) next.delete(feature.id)
    } else {
      next.add(node.id)
    }
    // The chevron is the user's: zoom does not undo it.
    auto.current.delete(node.id)
    if (node.kind === 'm') for (const feature of model.milestones.find(item => item.id === node.id)?.features ?? []) auto.current.delete(feature.id)
    // The view stays still: the node's stable point (a feature's elbow, where its chevron is; a milestone's circle) keeps its place on screen, and what opens or closes grows away from it.
    after.current = { id: node.id, old: stableOf(node), origin: { ...origin.current }, how: 'stable', byZoom: false }
    setOpen(next)
  }, [open, model])

  const onKey = (event: KeyboardEvent, act: () => void) => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); act() }
  }

  /** Show everything, with the node's milestone and feature open so it is drawn. */
  const showAll = (id: string) => {
    const found = find(fullModel, id)
    saveFilter(ALL_FILTER)
    refit(() => { setFilter(ALL_FILTER); if (found) setOpen(value => new Set([...value, found.milestone.id, ...(found.kind === 't' ? [found.feature.id] : [])])) })
  }
  const applyFilter = (next: MapFilter) => { saveFilter(next); refit(() => setFilter(next)) }
  const tasksIn = (map: MapModel) => map.milestones.reduce((sum, milestone) => sum + milestone.features.reduce((inner, feature) => inner + feature.tasks.length, 0), 0)
  const empty = tasksIn(model) === 0 && tasksIn(fullModel) > 0
  const refit = (change: () => void) => { after.current = 'fit'; auto.current = new Set(); change() }
  const expandAll = () => refit(() => setOpen(new Set(model.milestones.flatMap(milestone => [milestone.id, ...milestone.features.map(feature => feature.id)]))))
  const goNow = () => pz.go(viewOnNow(Math.max(pz.current().k, 1), freeRect()), true)

  /** Glide a match into the middle of the free part of the box; one the owner folded away is unfolded first and centred by the layout effect. */
  const goTo = (id: string) => {
    const node = byId.get(id)
    if (node) { pz.go(centreOn(toStage(pointOf(node)), freeRect(), Math.max(pz.current().k, 1)), true); return }
    const hit = find(fullModel, id)
    if (!hit) return
    const missing = [hit.milestone.id, ...(hit.kind === 't' ? [hit.feature.id] : [])].filter(item => !open.has(item))
    if (!missing.length) return
    if (after.current === null) { after.current = { how: 'centre', id, axis }; relayoutPending.current = true }
    setOpen(new Set([...open, ...missing]))
  }
  // The matches open their milestones and features, and the first is centred at the current scale. Only a change in the matches does it
  // (a refresh of the data finds the same ones), and a pending Fit or first view wins.
  const orderKey = matches.order.join()
  const openKey = [...matches.open].sort().join()
  useEffect(() => {
    if (!searching) {
      lastOrder.current = null
      const back = beforeSearch.current
      beforeSearch.current = null
      if (back && (back.size !== open.size || [...open].some(id => !back.has(id)))) {
        if (after.current === null) after.current = 'fit'
        auto.current = new Set()
        setOpen(back)
      }
      return
    }
    const firstLook = lastOrder.current === null
    const moved = lastOrder.current !== orderKey
    lastOrder.current = orderKey
    if (beforeSearch.current === null) beforeSearch.current = open
    if (moved) setCursor(null)
    const first = matches.order[0]
    const missing = [...matches.open].filter(id => !open.has(id))
    if (missing.length) {
      if (moved && first && !firstLook && after.current === null) { after.current = { how: 'centre', id: first, axis }; relayoutPending.current = true }
      setOpen(new Set([...open, ...missing]))
    } else if (moved && first && !firstLook) goTo(first)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searching, orderKey, openKey])

  const changeQuery = (value: string) => { setQuery(value); saveQuery(value) }
  const found = matches.order.length
  const here = found ? (cursor ?? 0) % found : 0
  const currentId = found ? matches.order[here] : null
  const step = (by: 1 | -1) => {
    if (!found) return
    const next = (here + by + found) % found
    setCursor(next)
    goTo(matches.order[next])
  }
  const onSearchKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && found) { event.preventDefault(); step(event.key === 'ArrowDown' ? 1 : -1) }
    else if (event.key === 'Enter' && currentId) { event.preventDefault(); openPanel(currentId) }
    else if (event.key === 'Escape' && query) { event.preventDefault(); event.stopPropagation(); changeQuery('') }
  }
  const titleOf = (id: string) => { const hit = find(fullModel, id); return hit ? (hit.kind === 'm' ? hit.milestone.title : hit.kind === 'f' ? hit.feature.title : hit.task.title) : id }
  const countText = !searching ? '' : found ? (cursor === null ? `${found} ${found === 1 ? 'match' : 'matches'}${found > 1 ? ' · ↑ ↓ to step' : ''}` : `${here + 1} of ${found} · ${titleOf(matches.order[here])}`) : text.data || text.error ? 'No matches' : 'Searching…'
  /** With matches, only the lit part of the map stays at full strength. */
  const dims = (id: string) => found > 0 && !matches.lit.has(id)
  const terms = words(query)

  /** The "now" pill: below the dot on a horizontal map, to its right on a vertical one. */
  const pill = vertical ? { x: layout.now.x + 16, y: layout.now.y - 8 } : { x: layout.now.x - 18, y: layout.now.y + 14 }
  const bandsDrawn = layout.bands.map(band => (
    <g key={band.name} className="hub-band" data-band={band.name}>
      {vertical && <title>{`${band.name}: ${band.parts}`}</title>}
      <rect x={band.rect.x} y={band.rect.y} width={band.rect.w} height={band.rect.h} rx={Math.min(11, band.rect.w / 2)} strokeWidth="1" style={{ fill: band.col, fillOpacity: 0.13, stroke: band.col }} />
      <text x={band.labelAt.x} y={band.labelAt.y} fontSize="11" fontWeight="600" textAnchor={vertical ? band.labelAt.anchor : undefined} style={{ fill: band.col }}>{band.name}</text>
      {band.partsAt && <text x={band.partsAt.x} y={band.partsAt.y} fontSize="10.5" className="hub-map-label">{band.parts}</text>}
    </g>
  ))

  /** Escape closes the Key or the filter, from the bar or from the map; focus goes back to their button. */
  const onEscape = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape' && keyOpen) { event.stopPropagation(); setKeyOpen(false); keyButton.current?.focus() }
    if (event.key === 'Escape' && filterOpen) { event.stopPropagation(); setFilterOpen(false); filterButton.current?.focus() }
  }

  return (
    <>
      <div className="hub-map-controls" onKeyDown={onEscape}>
          <button type="button" className="hub-btn" onClick={() => pz.fit(true)} aria-label="Fit the whole map">Fit</button>
          <button type="button" className="hub-btn" onClick={goNow} aria-label="Go to now">Now</button>
          <button type="button" className="hub-btn" onClick={expandAll}>Expand all</button>
          <button type="button" className="hub-btn" onClick={() => refit(() => setOpen(new Set()))}>Collapse</button>
          <button type="button" className={`hub-btn${sprints ? ' pri' : ''}`} aria-pressed={sprints} onClick={() => refit(() => setSprints(value => !value))}>Sprints</button>
          <button type="button" className={`hub-btn${filterOpen ? ' pri' : ''}`} ref={filterButton} aria-expanded={filterOpen} aria-controls="hub-map-filter" onClick={() => { setFilterOpen(value => !value); setKeyOpen(false) }}>Filter</button>
          <span className={`hub-filter-chip${isOpenFilter(filter) ? '' : ' changed'}`} data-filter-chip>
            <button type="button" className="hub-filter-chip-text" title="Change the filter" onClick={() => { setFilterOpen(true); setKeyOpen(false) }}>{filterLabel(filter)}</button>
            {!isOpenFilter(filter) && <button type="button" className="hub-filter-chip-x" aria-label="Reset the filter to Open" onClick={() => applyFilter(OPEN_FILTER)}>×</button>}
          </span>
          <button type="button" className={`hub-btn${keyOpen ? ' pri' : ''}`} ref={keyButton} aria-expanded={keyOpen} aria-controls="hub-map-key" onClick={() => { setKeyOpen(value => !value); setFilterOpen(false) }}>Key</button>
          <button type="button" className="hub-btn hub-map-zoom" onClick={() => pz.zoomBy(1 / 1.25, true)} aria-label="Zoom out">−</button>
          <button type="button" className="hub-btn hub-map-zoom" onClick={() => pz.zoomBy(1.25, true)} aria-label="Zoom in">+</button>
        </div>
      <div className="hub-map-search" data-sheet={shownId || filterOpen || keyOpen ? '' : undefined} data-query={searching ? '' : undefined}>
        <SearchField label="Search the roadmap" placeholder="Search the roadmap" value={query} onChange={changeQuery} onKeyDown={onSearchKey} data={{ 'data-map-search': '' }} />
        <span className="hub-map-found" role="status" data-map-count>
          {countText}
          {searching && found === 0 && (text.data || text.error) && <> <button type="button" className="hub-link-btn" data-map-clear onClick={() => changeQuery('')}>Clear</button></>}
        </span>
        {found > 1 && (
          <span className="hub-map-steps">
            <button type="button" className="hub-btn" data-map-step="prev" aria-label="Previous match" onClick={() => step(-1)}>↑</button>
            <button type="button" className="hub-btn" data-map-step="next" aria-label="Next match" onClick={() => step(1)}>↓</button>
          </span>
        )}
      </div>
      {header}
      <div className="hub-map-wrap" ref={wrap} onKeyDown={onEscape}>
        <div className="hub-map-box" ref={box} data-axis={axis} tabIndex={0} role="group" aria-label="Roadmap. Arrow keys move it, plus and minus zoom.">
        <div className="hub-map-stage" ref={stage}>
          <svg ref={svg} role="presentation">
            <defs>
              <marker id="hub-tip" viewBox="0 0 10 10" refX="8" refY="5" markerUnits="userSpaceOnUse" markerWidth="14" markerHeight="14" orient="auto"><path d="M0,0 L10,5 L0,10 z" className="hub-map-tip" /></marker>
            </defs>
            <g ref={drawn}>
              {vertical && bandsDrawn}
              <line x1={layout.spine.from[0]} y1={layout.spine.from[1]} x2={layout.spine.to[0]} y2={layout.spine.to[1]} className="hub-map-spine" strokeWidth="5" strokeLinecap="round" markerEnd="url(#hub-tip)" />
              <line x1={layout.spine.from[0]} y1={layout.spine.from[1]} x2={layout.now.x} y2={layout.now.y} className="hub-map-spine-done" strokeWidth="5" strokeLinecap="round" />
              {layout.branches.map(branch => (
                <path key={branch.id} data-branch={branch.id} className={dims(branch.id) ? 'hub-map-dim' : undefined} d={branch.points.map(([px, py], at) => `${at ? 'L' : 'M'}${px} ${py}`).join(' ')} strokeWidth="2.5" fill="none" strokeLinejoin="round" style={{ stroke: branch.lit ? branch.col : 'var(--hairline-strong)' }} />
              ))}
              {layout.nodes.filter((item): item is TaskNode => item.kind === 't').map(task => {
                const color = STATE_COLOR[task.state]
                return (
                  <g key={task.id} data-node={task.id} data-kind="t" data-state={task.state} role="button" tabIndex={0} className={`hub-map-node${shownId === task.id ? ' selected' : ''}${dims(task.id) ? ' hub-map-dim' : ''}${matches.ids.has(task.id) ? ' hub-map-hit' : ''}`}
                    aria-label={`${task.title}, ${STATE_LABEL[task.state]}`} aria-pressed={shownId === task.id} aria-haspopup="dialog" aria-controls="hub-map-panel" onClick={() => openPanel(task.id)} onKeyDown={event => onKey(event, () => openPanel(task.id))}>
                    <title>{nodeTip(task.title, task.id)}</title>
                    <circle cx={task.x} cy={task.y} r="8" strokeWidth="2.5" style={{ stroke: color, fill: task.state === 'done' || task.state === 'you' ? color : 'var(--surface-solid)' }} />
                    {shownId === task.id && <circle cx={task.x} cy={task.y} r="13" className="hub-map-ring" />}
                    {matches.ids.has(task.id) && <circle cx={task.x} cy={task.y} r="12" className="hub-map-ring hub-map-ring-hit" />}
                    {currentId === task.id && <circle cx={task.x} cy={task.y} r="16" className="hub-map-ring hub-map-ring-current" />}
                    <MapSigns signs={task.signs} x={task.x + 13} y={task.y - 11} />
                    {task.lines.map((line, k) => (
                      <text key={k} x={task.label.x} y={task.label.y + k * (task.label.step ?? 12)} fontSize="10.5" textAnchor={task.label.anchor} className={task.state === 'later' ? 'hub-map-label dim' : 'hub-map-label'}>{matches.ids.has(task.id) ? <Marked text={line} terms={terms} /> : line}</text>
                    ))}
                  </g>
                )
              })}
              {layout.nodes.filter((item): item is FeatureNode => item.kind === 'f').map(feature => {
                const radius = 22
                const cx = feature.center.x
                return (
                  <Fragment key={feature.id}>
                  <g data-node={feature.id} data-kind="f" data-state={feature.state} role="button" tabIndex={0} className={`hub-map-node${shownId === feature.id ? ' selected' : ''}${dims(feature.id) ? ' hub-map-dim' : ''}${matches.ids.has(feature.id) ? ' hub-map-hit' : ''}`}
                    aria-label={`${feature.title}, ${STATE_LABEL[feature.state]}, ${feature.words}`} aria-haspopup="dialog" aria-controls="hub-map-panel" onClick={() => openPanel(feature.id)} onKeyDown={event => onKey(event, () => openPanel(feature.id))}>
                    <title>{`${nodeTip(feature.title, feature.id)} · ${feature.words}`}</title>
                    <circle cx={cx} cy={feature.center.y} r={radius} strokeWidth="2" strokeDasharray={feature.open ? '4 3' : undefined} style={{ fill: feature.col, fillOpacity: feature.state === 'later' ? 0.11 : 0.23, stroke: feature.col }} />
                    <Arc cx={cx} cy={feature.center.y} r={radius} width={4} fraction={tallyFraction(feature)} color={feature.col} />
                    {shownId === feature.id && <circle cx={cx} cy={feature.center.y} r={radius + 5} className="hub-map-ring" />}
                    {matches.ids.has(feature.id) && <circle cx={cx} cy={feature.center.y} r={radius + 4} className="hub-map-ring hub-map-ring-hit" />}
                    {currentId === feature.id && <circle cx={cx} cy={feature.center.y} r={radius + 9} className="hub-map-ring hub-map-ring-current" />}
                    <text x={feature.countAt.x} y={feature.countAt.y} fontSize="11" textAnchor="middle" fontWeight="700" className="hub-map-count">{feature.closedEmpty ? '✓' : feature.muted ? feature.later : feature.done}</text>
                    <MapSigns signs={groupSigns(feature.marks)} x={cx + radius - 2} y={feature.center.y - radius + 2} />
                    <MapTitle label={feature.label} title={feature.title} vertical={vertical} fontWeight="600" className="hub-map-title" terms={matches.ids.has(feature.id) ? terms : undefined} />
                  </g>
                  <Chevron id={feature.id} title={feature.title} dim={dims(feature.id)} open={feature.open} x={feature.chevronAt.x} y={feature.chevronAt.y} onToggle={() => toggle(feature)} />
                  </Fragment>
                )
              })}
              {layout.nodes.filter((item): item is MilestoneNode => item.kind === 'm').map(milestone => {
                const radius = milestone.radius
                return (
                  <Fragment key={milestone.id}>
                  <g data-node={milestone.id} data-kind="m" data-state={milestone.state} role="button" tabIndex={0} className={`hub-map-node${shownId === milestone.id ? ' selected' : ''}${dims(milestone.id) ? ' hub-map-dim' : ''}${matches.ids.has(milestone.id) ? ' hub-map-hit' : ''}`}
                    aria-label={`${milestone.title}, ${STATE_LABEL[milestone.state]}, ${milestone.words}`} aria-haspopup="dialog" aria-controls="hub-map-panel" onClick={() => openPanel(milestone.id)} onKeyDown={event => onKey(event, () => openPanel(milestone.id))}>
                    <title>{`${nodeTip(milestone.title, milestone.id)} · ${milestone.words}`}</title>
                    <circle cx={milestone.x} cy={milestone.y} r={radius} strokeWidth="4" className={milestone.muted ? 'hub-map-muted' : undefined} style={{ stroke: milestone.muted ? undefined : 'var(--hairline-strong)', fill: milestone.state === 'done' ? milestone.col : 'var(--surface-solid)' }} />
                    <Arc cx={milestone.x} cy={milestone.y} r={radius} width={4} fraction={tallyFraction(milestone)} color={milestone.col} />
                    {shownId === milestone.id && <circle cx={milestone.x} cy={milestone.y} r={radius + 6} className="hub-map-ring" />}
                    {matches.ids.has(milestone.id) && <circle cx={milestone.x} cy={milestone.y} r={radius + 4} className="hub-map-ring hub-map-ring-hit" />}
                    {currentId === milestone.id && <circle cx={milestone.x} cy={milestone.y} r={radius + 10} className="hub-map-ring hub-map-ring-current" />}
                    {!milestone.open && <text x={milestone.countAt.x} y={milestone.countAt.y} fontSize="11" textAnchor="middle" fontWeight="700" className="hub-map-count">{milestone.closedEmpty ? '✓' : milestone.muted ? milestone.later : milestone.done}</text>}
                    <MapSigns signs={groupSigns(milestone.marks)} x={milestone.x + radius} y={milestone.y - radius} />
                    <MapTitle label={milestone.label} title={milestone.title} vertical={vertical} fontWeight="700" style={{ fill: milestone.col }} terms={matches.ids.has(milestone.id) ? terms : undefined} />
                  </g>
                  {!milestone.bare && <Chevron id={milestone.id} title={milestone.title} dim={dims(milestone.id)} open={milestone.open} x={milestone.chevronAt.x} y={milestone.chevronAt.y} onToggle={() => toggle(milestone)} />}
                  </Fragment>
                )
              })}
              {!vertical && bandsDrawn}
              <g className="hub-map-nowg" aria-hidden="true">
                <circle cx={layout.now.x} cy={layout.now.y} r="9" className="hub-map-now-ring" />
                <circle cx={layout.now.x} cy={layout.now.y} r="5" className="hub-map-now" />
                <rect x={pill.x} y={pill.y} width="36" height="17" rx="8" className="hub-map-now-pill" />
                <text x={vertical ? pill.x + 18 : layout.now.x} y={pill.y + 12} className="hub-map-now-text" fontSize="11" textAnchor="middle" fontWeight="600">now</text>
              </g>
            </g>
          </svg>
        </div>
        </div>
        {(hint || (sprints && model.sprints.length === 0) || empty) && (
          <div className="hub-map-top" ref={hintBar}>
            {hint && (
              <p className="hub-muted hub-map-hint" data-hint>
                <span><span className="hub-hint-mouse">Scroll to zoom in and open · drag to move · click for details</span><span className="hub-hint-touch">Pinch in to open · drag to move · tap for details</span></span>
                <button type="button" className="hub-map-hint-x" aria-label="Hide the hint" onClick={dismissHint}>×</button>
              </p>
            )}
            {empty && <p className="hub-muted hub-map-note" data-no-match>No tasks match this filter. <button type="button" className="hub-link-btn" onClick={() => applyFilter(OPEN_FILTER)}>Reset</button></p>}
            {sprints && model.sprints.length === 0 && <p className="hub-muted hub-map-note" data-no-sprints>No sprints in this Beads copy yet. Tasks labelled <code>sprint:&lt;name&gt;</code> show here as bands.</p>}
          </div>
        )}
        {filterOpen && <MapFilterPanel filter={filter} shown={tasksIn(model)} total={tasksIn(fullModel)} onChange={applyFilter} onClose={() => { setFilterOpen(false); filterButton.current?.focus() }} />}
        {keyOpen && (
          <div className="hub-legend" id="hub-map-key" aria-label="Legend">
            {model.ageMinutes != null && <p className="hub-muted hub-legend-age">Beads copy from {copyAge(model.ageMinutes)}</p>}
            {(Object.keys(STATE_LABEL) as TaskState[]).map(state => <span key={state}><i style={{ background: STATE_COLOR[state] }} />{STATE_LABEL[state]}</span>)}
            {(['working', 'idle', 'new', 'pr', 'ci-failed', 'review', 'deployed'] as const).map(sign => <span key={sign}><b>{SIGN_GLYPH[sign]}</b>{SIGN_LABEL[sign]}</span>)}
          </div>
        )}
      </div>
      {shownId && <MapPanel model={fullModel} nodeId={shownId} onClose={closePanel} onOpen={openPanel} hiddenBy={find(model, shownId) ? undefined : { filter: filterLabel(filter), onShowAll: () => showAll(shownId) }} />}
    </>
  )
}

/** A milestone's or feature's title at its place in the layout; the vertical layout wraps it into lines. */
function MapTitle({ label, title, vertical, fontWeight, className, style, terms }: { label: Label; title: string; vertical: boolean; fontWeight: string; className?: string; style?: CSSProperties; /** The search words to mark in the text. */ terms?: string[] }) {
  const anchor = vertical || label.anchor === 'middle' ? label.anchor : undefined
  // A milestone says what its ring counts in words, after the title or (vertical) on a line below it.
  const count = label.count ? <tspan className="hub-map-count" dx="8">{label.count}</tspan> : null
  const sub = label.sub ? <tspan className="hub-map-count" x={label.x} dy={label.step ?? 14} fontWeight="400" fontSize="11">{label.sub}</tspan> : null
  if (!label.lines) return <text x={label.x} y={label.y} fontSize="12" textAnchor={anchor} fontWeight={fontWeight} className={className} style={style}>{terms ? <Marked text={title} terms={terms} /> : title}{count}{sub}</text>
  const last = label.lines.length - 1
  return (
    <text x={label.x} y={label.y} fontSize="12" textAnchor={anchor} fontWeight={fontWeight} className={className} style={style}>
      {label.lines.map((line, k) => <tspan key={k} x={label.x} dy={k ? label.step ?? 14 : 0}>{terms ? <Marked text={line} terms={terms} /> : line}{k === last && count}</tspan>)}{sub}
    </text>
  )
}

const ESCAPE = /[.*+?^${}()|[\]\\]/g
/** Text with the search words in coloured bold (SVG text has no background to mark with). A word split over two wrapped lines goes unmarked; the node's ring still shows it. */
function Marked({ text, terms }: { text: string; terms: string[] }) {
  if (!terms.length) return <>{text}</>
  const pattern = terms.map(term => term.replace(ESCAPE, '\\$&')).join('|')
  const parts = text.split(new RegExp(`(${pattern})`, 'i'))
  return <>{parts.map((part, k) => (k % 2 ? <tspan key={k} className="hub-map-hit-text">{part}</tspan> : part))}</>
}

/** The done part of a ring: an arc over the circle, from the top, `fraction` of the way round. Nothing when none is done. */
function Arc({ cx, cy, r, width, fraction, color }: { cx: number; cy: number; r: number; width: number; fraction: number; color: string }) {
  if (fraction <= 0) return null
  // In a group of its own, so the node's own circle stays its only direct circle.
  return <g className="hub-map-arcg"><circle cx={cx} cy={cy} r={r} pathLength="100" strokeWidth={width} strokeDasharray={`${Math.min(fraction, 1) * 100} 100`} transform={`rotate(-90 ${cx} ${cy})`} className="hub-map-arc" style={{ stroke: color }} /></g>
}

/** Hover text for a map node: the full title, then the id unless it is a synthetic group (its id has a ~). */
const nodeTip = (title: string, id: string) => (id.includes('~') ? title : `${title} · ${id}`)

/** The button that opens or closes a milestone or feature, beside its node: a node's tap shows details instead. The group is scaled up (CSS, from the map's zoom) so its target is at least 32 px on a desktop and 44 px on a touch screen whatever the zoom. */
function Chevron({ id, title, open, dim, x, y, onToggle }: { id: string; title: string; open: boolean; dim?: boolean; x: number; y: number; onToggle: () => void }) {
  return (
    <g role="button" tabIndex={0} data-toggle={id} className={`hub-map-chev${dim ? ' hub-map-dim' : ''}`} style={{ transformOrigin: `${x}px ${y}px` }} aria-expanded={open} aria-label={`${open ? 'Close' : 'Open'} ${title}`}
      onClick={onToggle} onKeyDown={(event: KeyboardEvent) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onToggle() } }}>
      <circle cx={x} cy={y} r="20" className="hub-map-chev-hit" />
      <circle cx={x} cy={y} r="10" strokeWidth="1.5" className="hub-map-chev-ring" />
      <text x={x} y={y + 4} fontSize="12" textAnchor="middle" className="hub-map-chev-glyph">{open ? '▾' : '▸'}</text>
    </g>
  )
}
