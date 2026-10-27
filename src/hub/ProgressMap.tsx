import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import type { ProgressMap as MapModel, TaskState } from '../lib/hub'
import { copyAge } from '../lib/hub'
import { hubHash, mapHash } from '../lib/route'
import { TS, layoutMap, type FeatureNode, type MapNode, type MilestoneNode, type TaskNode } from './mapLayout'
import MapSigns from './MapSigns'
import MapPanel from './MapPanel'
import { SIGN_GLYPH, SIGN_LABEL, groupSigns } from './signs'
import { STATE_COLOR, STATE_LABEL, find } from './mapState'
import { useHubData } from './useHub'
import { useProject } from './useProject'

const WHEEL_STEP = 140
const PINCH_STEP = 70

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
      <div className="hub-top">
        <h2>Progress map{project ? ` · ${list.find(item => item.id === project)?.name ?? project}` : ''}</h2>
        {model?.ageMinutes != null && <span className="hub-muted">Beads copy from {copyAge(model.ageMinutes)}</span>}
      </div>
      <div className="hub-chips" aria-label="Project">
        {list.map(item => <a key={item.id} className={`hub-chip${item.id === project ? ' on' : ''}`} href={hubHash('map', item.id)}>{item.name}</a>)}
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
  const [boxWidth, setBoxWidth] = useState(640)
  const box = useRef<HTMLDivElement>(null)
  const pendingScroll = useRef<string | null>(null)
  const pushed = useRef(false)
  const lastShown = useRef<string | null>(null)
  const wheel = useRef(0)
  const pinch = useRef<number | null>(null)

  useEffect(() => {
    const element = box.current
    if (!element) return undefined
    const measure = () => setBoxWidth(element.clientWidth)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const layout = useMemo(() => layoutMap(model, open, boxWidth, sprints), [model, open, boxWidth, sprints])
  const byId = useMemo(() => new Map(layout.nodes.map(node => [node.id, node])), [layout])

  // The panel the model has for the address; an id the model does not know opens nothing and leaves the address alone.
  const shownId = nodeId && find(model, nodeId) ? nodeId : null

  /** The width of the box the side panel covers on a desktop; none on a phone, where the sheet is below. */
  const covered = () => {
    const element = box.current
    const panel = document.getElementById('hub-map-panel')
    if (!element || !panel || !window.matchMedia('(min-width: 641px)').matches) return 0
    return Math.max(0, element.getBoundingClientRect().right - panel.getBoundingClientRect().left)
  }
  const centre = (id: string) => {
    const element = box.current
    const node = byId.get(id)
    if (!element || !node) return
    // An opened feature is centred on its tasks, not on the dot at the end of its branch.
    const tasks = node.kind === 'f' && node.open ? node.total : 0
    element.scrollLeft = Math.max(0, node.x - (tasks * TS) / 2 - (element.clientWidth - covered()) / 2)
  }

  // Keep the node you opened in the middle of the part of the box the panel leaves free.
  useEffect(() => {
    const id = pendingScroll.current
    if (!id) return
    centre(id)
    pendingScroll.current = null
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [byId])

  // A node that ends up under the side panel is scrolled out from under it, once per opening.
  const scrolledFor = useRef<string | null>(null)
  useEffect(() => {
    if (!shownId) { scrolledFor.current = null; return }
    if (scrolledFor.current === shownId) return
    scrolledFor.current = shownId
    const element = box.current
    const node = byId.get(shownId)
    const hidden = covered()
    if (!element || !node || !hidden) return
    const free = element.clientWidth - hidden
    const screenX = node.x - element.scrollLeft
    if (screenX > free - 40 || screenX < 0) centre(shownId)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shownId, byId])

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

  const focus = (id: string) => { pendingScroll.current = id }

  const toggle = useCallback((node: MilestoneNode | FeatureNode) => {
    const next = new Set(open)
    if (next.has(node.id)) {
      next.delete(node.id)
      if (node.kind === 'm') for (const feature of model.milestones.find(item => item.id === node.id)?.features ?? []) next.delete(feature.id)
    } else {
      next.add(node.id)
    }
    pendingScroll.current = node.id
    setOpen(next)
  }, [open, model])

  const onKey = (event: KeyboardEvent, act: () => void) => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); act() }
  }

  // Zoom is opening or closing around the point you zoom at.
  const zoomAt = useCallback((direction: number, px: number) => {
    const next = new Set(open)
    const near = <T extends MapNode>(nodes: T[]) => [...nodes].sort((a, b) => Math.abs(a.x - px) - Math.abs(b.x - px))[0]
    const nodes = layout.nodes
    if (direction > 0) {
      const milestone = near(nodes.filter((node): node is MilestoneNode => node.kind === 'm'))
      if (!milestone) return
      if (!next.has(milestone.id)) { next.add(milestone.id); focus(milestone.id) } else {
        const feature = near(nodes.filter((node): node is FeatureNode => node.kind === 'f' && node.milestone === milestone.id && !next.has(node.id)))
        if (feature) { next.add(feature.id); focus(feature.id) } else {
          const other = model.milestones.find(item => !next.has(item.id))
          if (other) { next.add(other.id); focus(other.id) }
        }
      }
    } else {
      const features = nodes.filter((node): node is FeatureNode => node.kind === 'f' && next.has(node.id))
      if (features.length) { const feature = near(features); next.delete(feature.id); focus(feature.id) } else {
        const milestones = nodes.filter((node): node is MilestoneNode => node.kind === 'm' && next.has(node.id))
        if (milestones.length) { const milestone = near(milestones); next.delete(milestone.id); focus(milestone.id) }
      }
    }
    setOpen(next)
  }, [open, layout, model])

  // Ctrl or Alt + wheel and a two-finger pinch zoom where you point; native listeners, because a
  // React wheel handler is passive and could not stop the page from zooming.
  useEffect(() => {
    const element = box.current
    if (!element) return undefined
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.altKey) return
      event.preventDefault()
      wheel.current += event.deltaY
      if (Math.abs(wheel.current) > WHEEL_STEP) {
        const rect = element.getBoundingClientRect()
        zoomAt(wheel.current < 0 ? 1 : -1, element.scrollLeft + event.clientX - rect.left)
        wheel.current = 0
      }
    }
    const onTouch = (event: TouchEvent) => {
      if (event.touches.length !== 2) return
      const [a, b] = [event.touches[0], event.touches[1]]
      const distance = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
      const rect = element.getBoundingClientRect()
      const mid = element.scrollLeft + (a.clientX + b.clientX) / 2 - rect.left
      if (pinch.current === null) { pinch.current = distance; return }
      if (Math.abs(distance - pinch.current) > PINCH_STEP) { zoomAt(distance > pinch.current ? 1 : -1, mid); pinch.current = null }
    }
    const onEnd = () => { pinch.current = null }
    element.addEventListener('wheel', onWheel, { passive: false })
    element.addEventListener('touchmove', onTouch, { passive: true })
    element.addEventListener('touchend', onEnd)
    return () => {
      element.removeEventListener('wheel', onWheel)
      element.removeEventListener('touchmove', onTouch)
      element.removeEventListener('touchend', onEnd)
    }
  }, [zoomAt])

  const center = () => (box.current ? box.current.scrollLeft + box.current.clientWidth / 2 : 0)
  const expandAll = () => setOpen(new Set(model.milestones.flatMap(milestone => [milestone.id, ...milestone.features.map(feature => feature.id)])))

  return (
    <>
      <div className="hub-map-controls">
        <button type="button" className="hub-btn" onClick={() => zoomAt(-1, center())} aria-label="Zoom out">－</button>
        <button type="button" className="hub-btn" onClick={() => zoomAt(1, center())} aria-label="Zoom in">＋</button>
        <button type="button" className="hub-btn" onClick={expandAll}>Expand all</button>
        <button type="button" className="hub-btn" onClick={() => setOpen(new Set())}>Collapse</button>
        <button type="button" className={`hub-btn${sprints ? ' pri' : ''}`} aria-pressed={sprints} onClick={() => { if (!sprints && model.sprints[0]) pendingScroll.current = model.sprints[0].milestones[0]?.id ?? null; setSprints(value => !value) }}>Sprints</button>
      </div>
      {sprints && model.sprints.length === 0 && <p className="hub-muted" data-no-sprints>No sprints in this Beads copy yet. Tasks labelled <code>sprint:&lt;name&gt;</code> show here as bands.</p>}
      <p className="hub-muted hub-map-hint">Tap a milestone for its details, ▸ to open it · pinch, or Ctrl + scroll, to zoom where you point</p>
      <div className={`hub-map-box${shownId ? ' has-panel' : ''}`} ref={box} data-width={layout.width} tabIndex={-1}>
        <svg width={layout.width} height={layout.height} viewBox={`0 0 ${layout.width} ${layout.height}`} role="group" aria-label="Progress map">
          <defs>
            <marker id="hub-tip" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="9" markerHeight="9" orient="auto"><path d="M0,0 L10,5 L0,10 z" className="hub-map-tip" /></marker>
          </defs>
          <line x1="16" y1={layout.spineY} x2={layout.width - 14} y2={layout.spineY} className="hub-map-spine" strokeWidth="5" strokeLinecap="round" markerEnd="url(#hub-tip)" />
          <line x1="16" y1={layout.spineY} x2={layout.nowX} y2={layout.spineY} className="hub-map-spine-done" strokeWidth="5" strokeLinecap="round" />
          <circle cx={layout.nowX} cy={layout.spineY} r="5" className="hub-map-now" />
          <text x={layout.nowX} y={layout.spineY + 22} className="hub-map-now-text" fontSize="11" textAnchor="middle" fontWeight="600">now</text>
          {layout.branches.map(branch => (
            <path key={branch.id} d={`M${branch.x0} ${branch.y0} L${branch.x1} ${branch.y1} L${branch.x2} ${branch.y1}`} strokeWidth="2.5" fill="none" strokeLinejoin="round" style={{ stroke: branch.lit ? branch.col : 'var(--hairline-strong)' }} />
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
        </svg>
      </div>
      {shownId && <MapPanel model={model} nodeId={shownId} onClose={closePanel} />}
      <div className="hub-legend" aria-label="Legend">
        {(Object.keys(STATE_LABEL) as TaskState[]).map(state => <span key={state}><i style={{ background: STATE_COLOR[state] }} />{STATE_LABEL[state]}</span>)}
        {(['working', 'idle', 'new', 'pr', 'ci-failed', 'review', 'deployed'] as const).map(sign => <span key={sign}><b>{SIGN_GLYPH[sign]}</b>{SIGN_LABEL[sign]}</span>)}
      </div>
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
      <circle cx={x} cy={y} r="11" strokeWidth="1.5" className="hub-map-chev-ring" />
      <text x={x} y={y + 4} fontSize="12" textAnchor="middle" className="hub-map-chev-glyph">{open ? '▾' : '▸'}</text>
    </g>
  )
}
