import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react'
import type { Sign } from '../lib/hub'
import type { WorkCard, WorkLane, WorkLanes } from '../lib/hubWork'
import { host } from '../lib/host'
import { find } from './mapState'
import { hubHash, mapHash, workHash } from '../lib/route'
import { useOverflowEdges } from '../lib/useOverflowEdges'
import { openFromClick } from './ItemRow'
import { SIGN_GLYPH, SIGN_LABEL } from './signs'
import { openSpawn } from './spawnStore'
import { useHubData } from './useHub'
import ProjectPicker from './ProjectPicker'
import { useProject } from './useProject'
import './work.css'
import MapPanel from './MapPanel'
import { defaultLane, sheetProject } from './workLanes'
import { useSheetMap } from './workSheet'

const LANES: [WorkLane, string][] = [
  ['backlog', 'Backlog'], ['ready', 'Ready'], ['running', 'In progress'], ['blocked', 'Blocked'], ['review', 'Review'], ['done', 'Done'],
]
const COLLAPSE = 10
const ASKED_LINK: Record<string, string> = { ask: 'Open Ask →', checklist: 'Open checklist →' }
const SOURCE: Record<WorkCard['source'], [string, string]> = { beads: ['◈', 'Beads task'], request: ['✉', 'Request'], hermes: ['☁', 'Hermes run'] }

function Card({ card, href, showProject, projectName, focused, onSheet }: { card: WorkCard; href: string; showProject: boolean; projectName: string; focused?: boolean; /** A plain click on a Beads card, which opens its sheet; it may take over the navigation. */ onSheet: (event: MouseEvent<HTMLAnchorElement>, href: string) => void }) {
  const [glyph, source] = SOURCE[card.source]
  const beads = card.source === 'beads'
  const cardLink = (
    <a className={`wk-card${card.live?.state === 'working' ? ' live' : ''}${focused ? ' focus' : ''}`} href={href} data-card={card.key} data-focused={focused ? 'true' : undefined} data-run-open={card.source === 'request' && card.state !== 'proposed' ? card.id : undefined} aria-haspopup={beads ? 'dialog' : undefined} aria-controls={beads && focused ? 'hub-map-panel' : undefined} onClick={beads ? event => onSheet(event, href) : card.source === 'request' && card.state !== 'proposed' ? event => openFromClick(event, card.id) : undefined}>
      <span className="wk-title">{card.title}</span>
      {card.why && <span className="wk-why">{card.nothingAsked && <><span className="wk-warn" role="img" aria-label="Nothing asked yet">⚠</span>{' '}</>}{card.why}</span>}
      <span className="wk-meta">
        {card.live && <span className={`wk-dot ${card.live.state === 'working' ? 'working' : 'idle'}`} role="img" aria-label={card.live.state === 'working' ? 'A session is working on it' : 'A session is idle on it'} />}
        <span className="wk-src" title={source} aria-label={source}>{glyph}</span>
        <span className="hub-id">{card.id}</span>
        {showProject && card.project && <span className="wk-project">{projectName}</span>}
        {card.signs.map(sign => <span key={sign} className="hub-sign" title={SIGN_LABEL[sign as Sign]} aria-label={SIGN_LABEL[sign as Sign]}>{SIGN_GLYPH[sign as Sign]}</span>)}
      </span>
    </a>
  )
  // The link is a sibling of the card, never inside it: the card is itself an anchor.
  if (!card.asked) return cardLink
  return (
    <div className="wk-card-group">
      {cardLink}
      <a className="wk-asked" href={card.asked.href} data-asked-link={card.asked.kind}>{ASKED_LINK[card.asked.kind] ?? 'Open in Needs you →'}</a>
    </div>
  )
}

/** What the sheet shows while its map is on the way, or when the Hub could not give it. */
function SheetWaiting({ error, onClose }: { error: string | null; onClose: () => void }) {
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    heading.current?.focus({ preventScroll: true })
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <>
      <div className="hub-map-scrim" onClick={onClose} aria-hidden="true" />
      <dialog open id="hub-map-panel" className="hub-map-panel" aria-labelledby="hub-map-panel-title">
        <div className="hub-map-grab" aria-hidden="true" />
        <div className="hub-map-panel-head">
          <div className="hub-map-panel-heading"><h3 id="hub-map-panel-title" ref={heading} tabIndex={-1}>{error ? 'Details not available' : 'Loading…'}</h3></div>
          <button type="button" className="hub-map-panel-close" aria-label="Close details" onClick={onClose}>×</button>
        </div>
        {error && <p className="hub-error" role="alert">{error}</p>}
      </dialog>
    </>
  )
}

/** Work's Lanes tab: `project` is a project id, `all` for every project, or absent for the default one. */
export default function Board(props: { project?: string; focus?: string }) {
  // The board's own state (lane, folds, scroll) restarts with the board it shows, never with the item a sheet is open on:
  // the bare `work` address and the default board's own address are the same board.
  const { project } = useProject(props.project === 'all' ? undefined : props.project)
  return <BoardView key={props.project === 'all' ? 'all' : project ?? ''} {...props} />
}

function BoardView({ project: wanted, focus }: { project?: string; focus?: string }) {
  const all = wanted === 'all'
  const { list, project: chosen, loading: listing, error: listError } = useProject(all ? undefined : wanted)
  const project = all ? undefined : chosen
  const work = useHubData<WorkLanes>(all || project ? `/work${project ? `?project=${encodeURIComponent(project)}` : ''}` : null)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [picked, setPicked] = useState<WorkLane | null>(null)
  const nameOf = (id: string) => list.find(item => item.id === id)?.name ?? id
  const data = work.data
  const focusKey = focus ? `bead:${focus}` : undefined
  const board = all ? 'all' : project ?? ''
  // The lane that holds the item a link pointed at, once the board has loaded; undefined when the board does not have it.
  const focusLane = focusKey && data ? LANES.find(([lane]) => data.lanes[lane].some(card => card.key === focusKey))?.[0] : undefined
  // The item's details sheet: the Roadmap's panel, over the board. It reads the map of the item's project, only while open.
  const focusCard = focusKey && data ? LANES.flatMap(([lane]) => data.lanes[lane]).find(card => card.key === focusKey) : undefined
  const [carried, setCarried] = useState<{ id: string; project: string } | null>(null)
  const sheetOf = sheetProject({ all, project, cardProject: focusCard?.project, carried: carried && carried.id === focus ? carried.project : undefined })
  const sheetMap = useSheetMap(focus ? sheetOf : undefined)
  const sheetFound = !!(focus && sheetMap.model && find(sheetMap.model, focus))
  // Nothing to open a sheet for: the board lacks the id and so does the map (or there is no project to ask).
  const unknown = !!(focus && data && !focusLane && (!sheetOf || (sheetMap.model && !sheetFound)))
  const pushed = useRef(false)
  const lastFocus = useRef<string | null>(null)
  const boardHash = hubHash('work', board)
  const openFromCard = useCallback((event: MouseEvent<HTMLAnchorElement>, href: string) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    if (focus) { event.preventDefault(); window.location.replace(href); return }
    pushed.current = true
  }, [focus])
  const closeSheet = useCallback(() => {
    if (pushed.current) { pushed.current = false; window.history.back() } else window.location.replace(boardHash)
  }, [boardHash])
  const openRelated = useCallback((id: string) => {
    if (sheetOf) setCarried({ id, project: sheetOf })
    window.location.replace(workHash(board, id))
  }, [board, sheetOf, setCarried])
  // Whatever closes the sheet (the button, Escape, Back), focus goes back to the card that opened it.
  useEffect(() => {
    if (focus) { lastFocus.current = focus; return }
    pushed.current = false
    const id = lastFocus.current
    lastFocus.current = null
    if (id) laneGrid.current?.querySelector<HTMLElement>(`[data-card="${CSS.escape(`bead:${id}`)}"]`)?.focus({ preventScroll: true })
  }, [focus])
  const active = picked ?? focusLane ?? (data ? defaultLane(data.counts) : 'running')
  // Each scroller that can hide something shows a fade at its cut edge (the Roadmap's pattern).
  const laneChips = useRef<HTMLDivElement>(null)
  const laneGrid = useRef<HTMLDivElement>(null)
  const laneChipEdges = useOverflowEdges(laneChips, [data])
  const laneEdges = useOverflowEdges(laneGrid, [project, data])
  // Open the lane that holds the item (a collapsed one too) and bring its card into view.
  // Once per link: a refresh of the board must not pull the person back from a lane they moved to.
  const focused = useRef('')
  useEffect(() => {
    if (!focusKey || !focusLane || focused.current === focusKey) return
    focused.current = focusKey
    setPicked(focusLane)
    setExpanded(value => ({ ...value, [focusLane]: true }))
    requestAnimationFrame(() => requestAnimationFrame(() => laneGrid.current?.querySelector(`[data-card="${CSS.escape(focusKey)}"]`)?.scrollIntoView({ block: 'center', inline: 'center' })))
  }, [focusKey, focusLane])
  useEffect(() => { laneChips.current?.querySelector('.wk-lane-chip.on')?.scrollIntoView({ inline: 'nearest', block: 'nearest' }) }, [active, data])

  return (
    <div className="work" data-sheet={focus && !unknown ? 'open' : undefined}>
      <ProjectPicker id="hub-work-project" projects={list} value={all ? 'all' : project ?? ''} allValue="all" onChange={id => { window.location.hash = hubHash('work', id) }} href={id => hubHash('work', id)} oneRow />
      {project && host.write && <div className="work-spawn"><button type="button" className="hub-btn pri" data-spawn-open onClick={() => openSpawn({ project })}>Spawn work</button></div>}
      {project && !host.write && <p className="hub-muted">Sign in to ask an agent to do something.</p>}
      {all && <p className="hub-muted">Pick a project to ask an agent to do something.</p>}
      {!data && !work.error && (listing || work.loading) && !listError && <p className="hub-empty">Loading…</p>}
      {!listing && !listError && !project && !all && <p className="hub-empty">No projects yet. A project appears once an agent session pushes a Beads copy or writes to the Hub.</p>}
      {(work.error || listError) && <p className="hub-error" role="alert">{work.error ?? listError}</p>}
      {data && unknown && <p className="hub-muted" role="status" data-board-note>{focus} is not on the board: it may be closed long ago, a group, or in another project.</p>}
      {data && (
        <>
          <div className="wk-chips-wrap" data-overflow={laneChipEdges}>
          <div className="wk-lane-chips" role="group" aria-label="Lane" ref={laneChips}>
            {LANES.map(([lane, label]) => (
              <button key={lane} type="button" className={`wk-lane-chip${lane === active ? ' on' : ''}`} aria-pressed={lane === active} data-lane-chip={lane} onClick={() => setPicked(lane)}>
                {label} <span className="n">{data.counts[lane]}</span>
              </button>
            ))}
          </div>
          </div>
          <div className="wk-lanes-wrap" data-overflow={laneEdges}>
          <div className="wk-lanes" data-active={active} ref={laneGrid}>
            {LANES.map(([lane, label]) => {
              const cards = data.lanes[lane]
              const collapsible = (lane === 'backlog' || lane === 'done') && cards.length > COLLAPSE
              const shown = collapsible && !expanded[lane] ? cards.slice(0, COLLAPSE) : cards
              return (
                <section key={lane} className="wk-lane" data-lane={lane} aria-label={label}>
                  <h3>{label} <span>{data.counts[lane]}</span></h3>
                  {shown.map(card => <Card key={card.key} card={card} href={card.source === 'beads' ? workHash(board, card.id) : card.href} showProject={all} projectName={nameOf(card.project)} focused={card.key === focusKey} onSheet={openFromCard} />)}
                  {!cards.length && <p className="hub-empty">Nothing here.</p>}
                  {collapsible && (
                    <button type="button" className="hub-btn wk-more" onClick={() => setExpanded(value => ({ ...value, [lane]: !value[lane] }))}>
                      {expanded[lane] ? 'Show fewer' : `Show all ${cards.length}`}
                    </button>
                  )}
                  {data.counts[lane] > cards.length && <p className="hub-muted">{data.counts[lane] - cards.length} older not shown.</p>}
                </section>
              )
            })}
          </div>
          </div>
        </>
      )}
      {focus && !unknown && (
        <div className="wk-sheet">
          {sheetMap.model && sheetFound
            ? <MapPanel model={sheetMap.model} nodeId={focus} onClose={closeSheet} onOpen={openRelated} headerExtra={<p className="hub-map-panel-roadmap"><a href={mapHash(sheetMap.model.project, focus)} data-show-on-roadmap>Show on roadmap</a></p>} />
            : <SheetWaiting error={sheetMap.model ? 'The roadmap does not have this item.' : sheetMap.error} onClose={closeSheet} />}
        </div>
      )}
    </div>
  )
}
