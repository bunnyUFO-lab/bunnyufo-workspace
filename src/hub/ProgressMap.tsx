import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import type { ProgressMap as MapModel, TaskState } from '../lib/hub'
import { copyAge } from '../lib/hub'
import { hubHash, mapHash } from '../lib/route'
import { useOverflowEdges } from '../lib/useOverflowEdges'
import { layoutMap, type FeatureNode, type MapNode, type MilestoneNode, type TaskNode } from './mapLayout'
import MapSigns from './MapSigns'
import MapPanel from './MapPanel'
import { FIT_MAX, centreOn, clamp, fitScale } from './panZoom'
import { usePanZoom } from './usePanZoom'
import type { ZoomReport } from './usePanZoom'
import { stableOf, zoomStep } from './semanticZoom'
import { SIGN_GLYPH, SIGN_LABEL, groupSigns } from './signs'
import { STATE_COLOR, STATE_LABEL, find } from './mapState'
import { useHubData } from './useHub'
import { useProject } from './useProject'

const HINT_KEY = 'hub-map-hint-seen'
const PAD = 16
const hintSeen = () => { try { return localStorage.getItem(HINT_KEY) === '1' } catch { return false } }
/** Where a node's circle is centred in the drawing (a feature's node sits right of the end of its branch). */
const pointOf = (node: MapNode) => ({ x: node.kind === 'f' ? node.x + 22 : node.x, y: node.y })
/** After a relayout, one node's point goes back where it was on screen: tap and chevron toggles hold the node's circle, zoom holds its stable point (a feature's elbow). */
interface Anchor { id: string; old: { x: number; y: number }; origin: { x: number; y: number }; how: 'circle' | 'stable' }
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
  const chips = useRef<HTMLDivElement>(null)
  const overflow = useOverflowEdges(chips, [list.length, project])
  useEffect(() => { chips.current?.querySelector('.hub-chip.on')?.scrollIntoView({ inline: 'nearest', block: 'nearest' }) }, [list.length, project])
  return (
    <>
      <h2 className="hub-sr">Roadmap{project ? ` · ${list.find(item => item.id === project)?.name ?? project}` : ''}</h2>
      <div className="hub-chips-wrap" data-overflow={overflow}>
        <div className="hub-chips one-row" aria-label="Project" ref={chips}>
          {list.map(item => <a key={item.id} className={`hub-chip${item.id === project ? ' on' : ''}`} href={hubHash('map', item.id)}>{item.name}</a>)}
        </div>
      </div>
      {error && <p className="hub-error" role="alert">{error}</p>}
      {!model && !error && (listing || mapping) && <p className="hub-empty">Loading…</p>}
      {model && !model.meta && <p className="hub-empty">No Beads copy yet. It appears after the next agent session in this repo.</p>}
      {model?.meta && project && <MapView key={project} model={model} project={project} nodeId={nodeId} />}
    </>
  )
}

function MapView({ model, project, nodeId }: { model: MapModel; project: string; nodeId?: string }) {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set())
  const [sprints, setSprints] = useState(false)
  const [hint, setHint] = useState(() => !hintSeen())
  const box = useRef<HTMLDivElement>(null)
  const stage = useRef<HTMLDivElement>(null)
  const svg = useRef<SVGSVGElement>(null)
  const drawn = useRef<SVGGElement>(null)
  const origin = useRef({ x: 0, y: 0 })
  /** What to do with the view once the next layout is measured: the first view, a fit, or keep one node where it is on screen. */
  const after = useRef<'init' | 'fit' | Anchor | null>('init')
  /** The ids that zoom opened (the rest of `open` is the user's); zoom folds only these. */
  const auto = useRef<Set<string>>(new Set())
  const relayoutPending = useRef(false)
  const lastSemantic = useRef(0)
  const wrap = useRef<HTMLDivElement>(null)
  const keyButton = useRef<HTMLButtonElement>(null)
  const [keyOpen, setKeyOpen] = useState(false)
  const zoomFn = useRef<(zoom: ZoomReport) => void>(() => {})
  const pushed = useRef(false)
  const lastShown = useRef<string | null>(null)

  const dismissHint = useCallback(() => {
    setHint(false)
    try { localStorage.setItem(HINT_KEY, '1') } catch { /* private mode: it shows again next time */ }
  }, [])
  const pz = usePanZoom(box, stage, { onGesture: dismissHint, onZoom: zoom => zoomFn.current(zoom), fitMax: FIT_MAX })

  const layout = useMemo(() => layoutMap(model, open, sprints), [model, open, sprints])
  const byId = useMemo(() => new Map(layout.nodes.map(node => [node.id, node])), [layout])
  const toStage = (point: { x: number; y: number }) => ({ x: point.x - origin.current.x, y: point.y - origin.current.y })
  const nowPoint = () => toStage({ x: layout.nowX, y: layout.spineY })

  /** The part of the box the details panel leaves free: the panel is at the right on a desktop and a sheet below on a phone. */
  const freeRect = () => {
    const element = box.current
    const size = pz.box()
    const whole = { x: 0, y: 0, w: size.w, h: size.h }
    const panel = document.getElementById('hub-map-panel')
    if (!element || !panel) return whole
    const rect = element.getBoundingClientRect()
    const cover = panel.getBoundingClientRect()
    if (!cover.width || !cover.height) return whole
    const free = cover.width < window.innerWidth * 0.8
      ? { ...whole, w: clamp(cover.left - rect.left, 0, size.w) }
      : { ...whole, h: clamp(cover.top - rect.top, 0, size.h) }
    return free.w < 60 || free.h < 60 ? whole : free
  }

  // Once per layout: measure what is drawn, size the SVG and the box to it, and place the view.
  useLayoutEffect(() => {
    const group = drawn.current
    const picture = svg.current
    const frame = box.current
    relayoutPending.current = false
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
    const todo = after.current
    after.current = null
    const size = pz.box()
    if (todo === 'init') {
      // Fitted and centred; a long map on a phone would be too small to read, so it starts at a readable size on "now".
      if (fitScale({ w, h }, size, FIT_MAX) < 0.6) pz.go(centreOn(nowPoint(), { x: 0, y: 0, w: size.w, h: size.h }, 0.6), false)
      else pz.fit(false)
    } else if (todo === 'fit') {
      pz.fit(true)
    } else if (todo) {
      const node = layout.nodes.find(item => item.id === todo.id)
      if (node) {
        // Where the old point is on screen now, from the live view: wheel events that came between the decision and this commit have moved it.
        const view = pz.current()
        const sx = view.x + (todo.old.x - todo.origin.x) * view.k
        const sy = view.y + (todo.old.y - todo.origin.y) * view.k
        const at = toStage(todo.how === 'stable' ? stableOf(node) : pointOf(node))
        pz.go({ k: view.k, x: sx - at.x * view.k, y: sy - at.y * view.k }, false)
        pz.rebase()
        if (todo.how === 'stable') lastSemantic.current = performance.now()
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout])

  // The panel the model has for the address; an id the model does not know opens nothing and leaves the address alone.
  const shownId = nodeId && find(model, nodeId) ? nodeId : null

  // Semantic zoom: the milestone, then the feature, under the pointer opens as you zoom in; what zoom opened folds as you zoom out.
  // Called at most once per frame by the pan-zoom, never for Fit, Now or glides, and never while a relayout is on its way.
  useEffect(() => {
    zoomFn.current = ({ dir, at, k }) => {
      if (relayoutPending.current || performance.now() - lastSemantic.current < SETTLE_MS) return
      const view = pz.current()
      const here = shownId ? find(model, shownId) : null
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
      after.current = { id: node.id, old: stableOf(node), origin: { ...origin.current }, how: 'stable' }
      relayoutPending.current = true
      lastSemantic.current = performance.now()
      setOpen(step.open)
    }
  })

  // The box fills the screen, so a window resize, a rotation or the phone's top bar changes it: keep the middle where it was and the view inside its limits.
  useLayoutEffect(() => {
    const element = wrap.current
    if (!element || typeof ResizeObserver === 'undefined') return undefined
    let last = { w: element.clientWidth, h: element.clientHeight }
    const observer = new ResizeObserver(() => {
      const next = { w: element.clientWidth, h: element.clientHeight }
      if (next.w === last.w && next.h === last.h) return
      const view = pz.current()
      pz.go({ ...view, x: view.x + (next.w - last.w) / 2, y: view.y + (next.h - last.h) / 2 }, false)
      last = next
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
    after.current = { id: node.id, old: pointOf(node), origin: { ...origin.current }, how: 'circle' }
    setOpen(next)
  }, [open, model])

  const onKey = (event: KeyboardEvent, act: () => void) => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); act() }
  }

  const refit = (change: () => void) => { after.current = 'fit'; auto.current = new Set(); change() }
  const expandAll = () => refit(() => setOpen(new Set(model.milestones.flatMap(milestone => [milestone.id, ...milestone.features.map(feature => feature.id)]))))
  const goNow = () => pz.go(centreOn(nowPoint(), freeRect(), Math.max(pz.current().k, 1)), true)

  return (
    <>
      <div className="hub-map-wrap" ref={wrap} onKeyDown={event => { if (event.key === 'Escape' && keyOpen) { event.stopPropagation(); setKeyOpen(false); keyButton.current?.focus() } }}>
        <div className="hub-map-controls">
          <button type="button" className="hub-btn" onClick={() => pz.fit(true)} aria-label="Fit the whole map">Fit</button>
          <button type="button" className="hub-btn" onClick={goNow} aria-label="Go to now">Now</button>
          <button type="button" className="hub-btn" onClick={expandAll}>Expand all</button>
          <button type="button" className="hub-btn" onClick={() => refit(() => setOpen(new Set()))}>Collapse</button>
          <button type="button" className={`hub-btn${sprints ? ' pri' : ''}`} aria-pressed={sprints} onClick={() => refit(() => setSprints(value => !value))}>Sprints</button>
          <button type="button" className={`hub-btn${keyOpen ? ' pri' : ''}`} ref={keyButton} aria-expanded={keyOpen} aria-controls="hub-map-key" onClick={() => setKeyOpen(value => !value)}>Key</button>
          <button type="button" className="hub-btn hub-map-zoom" onClick={() => pz.zoomBy(1 / 1.25, true)} aria-label="Zoom out">−</button>
          <button type="button" className="hub-btn hub-map-zoom" onClick={() => pz.zoomBy(1.25, true)} aria-label="Zoom in">+</button>
        </div>
        <div className="hub-map-box" ref={box} tabIndex={0} role="group" aria-label="Roadmap. Arrow keys move it, plus and minus zoom.">
        <div className="hub-map-stage" ref={stage}>
          <svg ref={svg} role="presentation">
            <defs>
              <marker id="hub-tip" viewBox="0 0 10 10" refX="8" refY="5" markerUnits="userSpaceOnUse" markerWidth="14" markerHeight="14" orient="auto"><path d="M0,0 L10,5 L0,10 z" className="hub-map-tip" /></marker>
            </defs>
            <g ref={drawn}>
              <line x1="16" y1={layout.spineY} x2={layout.width - 14} y2={layout.spineY} className="hub-map-spine" strokeWidth="5" strokeLinecap="round" markerEnd="url(#hub-tip)" />
              <line x1="16" y1={layout.spineY} x2={layout.nowX} y2={layout.spineY} className="hub-map-spine-done" strokeWidth="5" strokeLinecap="round" />
              {layout.branches.map(branch => (
                <path key={branch.id} data-branch={branch.id} d={`M${branch.x0} ${branch.y0} L${branch.x1} ${branch.y1} L${branch.x2} ${branch.y1}`} strokeWidth="2.5" fill="none" strokeLinejoin="round" style={{ stroke: branch.lit ? branch.col : 'var(--hairline-strong)' }} />
              ))}
              {layout.nodes.filter((item): item is TaskNode => item.kind === 't').map(task => {
                const color = STATE_COLOR[task.state]
                const ty = task.up ? task.y - 22 : task.y + 32
                return (
                  <g key={task.id} data-node={task.id} data-kind="t" data-state={task.state} role="button" tabIndex={0} className={`hub-map-node${shownId === task.id ? ' selected' : ''}`}
                    aria-label={`${task.title}, ${STATE_LABEL[task.state]}`} aria-pressed={shownId === task.id} aria-haspopup="dialog" aria-controls="hub-map-panel" onClick={() => openPanel(task.id)} onKeyDown={event => onKey(event, () => openPanel(task.id))}>
                    <title>{nodeTip(task.title, task.id)}</title>
                    <circle cx={task.x} cy={task.y} r="8" strokeWidth="2.5" style={{ stroke: color, fill: task.state === 'done' || task.state === 'you' ? color : 'var(--surface-solid)' }} />
                    {shownId === task.id && <circle cx={task.x} cy={task.y} r="13" className="hub-map-ring" />}
                    <MapSigns signs={task.signs} x={task.x + 13} y={task.y - 11} />
                    {task.lines.map((line, k) => (
                      <text key={k} x={task.x} y={task.up ? ty - (task.lines.length - 1 - k) * 12 : ty + k * 12} fontSize="10.5" textAnchor="middle" className={task.state === 'later' ? 'hub-map-label dim' : 'hub-map-label'}>{line}</text>
                    ))}
                  </g>
                )
              })}
              {layout.nodes.filter((item): item is FeatureNode => item.kind === 'f').map(feature => {
                const radius = 22
                const cx = feature.x + radius
                return (
                  <Fragment key={feature.id}>
                  <g data-node={feature.id} data-kind="f" data-state={feature.state} role="button" tabIndex={0} className={`hub-map-node${shownId === feature.id ? ' selected' : ''}`}
                    aria-label={`${feature.title}, ${STATE_LABEL[feature.state]}, ${feature.done} of ${feature.total} done`} aria-haspopup="dialog" aria-controls="hub-map-panel" onClick={() => openPanel(feature.id)} onKeyDown={event => onKey(event, () => openPanel(feature.id))}>
                    <title>{nodeTip(feature.title, feature.id)}</title>
                    <circle cx={cx} cy={feature.y} r={radius} strokeWidth="2" strokeDasharray={feature.open ? '4 3' : undefined} style={{ fill: feature.col, fillOpacity: feature.state === 'later' ? 0.11 : 0.23, stroke: feature.col }} />
                    {shownId === feature.id && <circle cx={cx} cy={feature.y} r={radius + 5} className="hub-map-ring" />}
                    <text x={cx} y={feature.y + 4} fontSize="11" textAnchor="middle" fontWeight="700" className="hub-map-count">{feature.done}/{feature.total}</text>
                    <MapSigns signs={groupSigns(feature.marks)} x={cx + radius - 2} y={feature.y - radius + 2} />
                    <text x={feature.open ? cx + radius + 8 : feature.labelX} y={feature.open ? feature.y + 4 : feature.y + (feature.side < 0 ? -10 : 18)} fontSize="12" fontWeight="600" className="hub-map-title">{feature.title}</text>
                  </g>
                  <Chevron id={feature.id} title={feature.title} open={feature.open} x={cx} y={feature.y + feature.side * (radius + 16)} onToggle={() => toggle(feature)} />
                  </Fragment>
                )
              })}
              {layout.nodes.filter((item): item is MilestoneNode => item.kind === 'm').map(milestone => {
                const radius = milestone.open ? 15 : 26
                return (
                  <Fragment key={milestone.id}>
                  <g data-node={milestone.id} data-kind="m" data-state={milestone.state} role="button" tabIndex={0} className={`hub-map-node${shownId === milestone.id ? ' selected' : ''}`}
                    aria-label={`${milestone.title}, ${STATE_LABEL[milestone.state]}, ${milestone.done} of ${milestone.total} done`} aria-haspopup="dialog" aria-controls="hub-map-panel" onClick={() => openPanel(milestone.id)} onKeyDown={event => onKey(event, () => openPanel(milestone.id))}>
                    <title>{nodeTip(milestone.title, milestone.id)}</title>
                    <circle cx={milestone.x} cy={milestone.y} r={radius} strokeWidth="4" style={{ stroke: milestone.col, fill: milestone.state === 'done' ? milestone.col : 'var(--surface-solid)' }} />
                    {shownId === milestone.id && <circle cx={milestone.x} cy={milestone.y} r={radius + 6} className="hub-map-ring" />}
                    {!milestone.open && <text x={milestone.x} y={milestone.y + 4} fontSize="11" textAnchor="middle" fontWeight="700" className="hub-map-count">{milestone.done}/{milestone.total}</text>}
                    <MapSigns signs={groupSigns(milestone.marks)} x={milestone.x + radius} y={milestone.y - radius} />
                    <text x={milestone.x} y={milestone.y + (milestone.open ? 34 : milestone.index % 2 ? 48 : -38)} fontSize="12" textAnchor="middle" fontWeight="700" style={{ fill: milestone.col }}>{milestone.title}</text>
                  </g>
                  <Chevron id={milestone.id} title={milestone.title} open={milestone.open} x={milestone.x - radius - 16} y={milestone.y} onToggle={() => toggle(milestone)} />
                  </Fragment>
                )
              })}
              {layout.bands.map(band => (
                <g key={band.name} className="hub-band" data-band={band.name}>
                  <rect x={band.x1} y={band.y} width={band.x2 - band.x1} height="22" rx="11" strokeWidth="1" style={{ fill: band.col, fillOpacity: 0.13, stroke: band.col }} />
                  <text x={band.x1 + 10} y={band.y + 15} fontSize="11" fontWeight="600" style={{ fill: band.col }}>{band.name}</text>
                  <text x={band.x1 + 12 + band.name.length * 6.4 + 10} y={band.y + 15} fontSize="10.5" className="hub-map-label">{band.parts}</text>
                </g>
              ))}
              <g className="hub-map-nowg" aria-hidden="true">
                <circle cx={layout.nowX} cy={layout.spineY} r="9" className="hub-map-now-ring" />
                <circle cx={layout.nowX} cy={layout.spineY} r="5" className="hub-map-now" />
                <rect x={layout.nowX - 18} y={layout.spineY + 14} width="36" height="17" rx="8" className="hub-map-now-pill" />
                <text x={layout.nowX} y={layout.spineY + 26} className="hub-map-now-text" fontSize="11" textAnchor="middle" fontWeight="600">now</text>
              </g>
            </g>
          </svg>
        </div>
        </div>
        {(hint || (sprints && model.sprints.length === 0)) && (
          <div className="hub-map-top">
            {hint && (
              <p className="hub-muted hub-map-hint" data-hint>
                <span><span className="hub-hint-mouse">Scroll to zoom in and open · drag to move · click for details</span><span className="hub-hint-touch">Pinch in to open · drag to move · tap for details</span></span>
                <button type="button" className="hub-map-hint-x" aria-label="Hide the hint" onClick={dismissHint}>×</button>
              </p>
            )}
            {sprints && model.sprints.length === 0 && <p className="hub-muted hub-map-note" data-no-sprints>No sprints in this Beads copy yet. Tasks labelled <code>sprint:&lt;name&gt;</code> show here as bands.</p>}
          </div>
        )}
        {keyOpen && (
          <div className="hub-legend" id="hub-map-key" aria-label="Legend">
            {model.ageMinutes != null && <p className="hub-muted hub-legend-age">Beads copy from {copyAge(model.ageMinutes)}</p>}
            {(Object.keys(STATE_LABEL) as TaskState[]).map(state => <span key={state}><i style={{ background: STATE_COLOR[state] }} />{STATE_LABEL[state]}</span>)}
            {(['working', 'idle', 'new', 'pr', 'ci-failed', 'review', 'deployed'] as const).map(sign => <span key={sign}><b>{SIGN_GLYPH[sign]}</b>{SIGN_LABEL[sign]}</span>)}
          </div>
        )}
      </div>
      {shownId && <MapPanel model={model} nodeId={shownId} onClose={closePanel} onOpen={openPanel} />}
    </>
  )
}

/** Hover text for a map node: the full title, then the id unless it is a synthetic group (its id has a ~). */
const nodeTip = (title: string, id: string) => (id.includes('~') ? title : `${title} · ${id}`)

/** The button that opens or closes a milestone or feature, beside its node: a node's tap shows details instead. A transparent ring makes the touch target about 40 px. */
function Chevron({ id, title, open, x, y, onToggle }: { id: string; title: string; open: boolean; x: number; y: number; onToggle: () => void }) {
  return (
    <g role="button" tabIndex={0} data-toggle={id} className="hub-map-chev" aria-expanded={open} aria-label={`${open ? 'Close' : 'Open'} ${title}`}
      onClick={onToggle} onKeyDown={(event: KeyboardEvent) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onToggle() } }}>
      <circle cx={x} cy={y} r="20" className="hub-map-chev-hit" />
      <circle cx={x} cy={y} r="10" strokeWidth="1.5" className="hub-map-chev-ring" />
      <text x={x} y={y + 4} fontSize="12" textAnchor="middle" className="hub-map-chev-glyph">{open ? '▾' : '▸'}</text>
    </g>
  )
}
