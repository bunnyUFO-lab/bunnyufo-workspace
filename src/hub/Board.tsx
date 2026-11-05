import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import type { Sign } from '../lib/hub'
import type { WorkCard, WorkLane, WorkLanes } from '../lib/hubWork'
import { rowMatches, snippetOf, words } from './beadSearch.ts'
import type { SearchRow } from './beadSearch.ts'
import { DEFAULT_WORK_FILTER, cardPasses, isDefaultWork, parseWorkFilter, type WorkFilter, type WorkType } from './workFilter.ts'
import Combobox from './Combobox'
import SearchField from './SearchField'
import { host } from '../lib/host'
import { find } from './mapState'
import { hubHash, mapHash, workHash } from '../lib/route'
import { useOverflowEdges } from '../lib/useOverflowEdges'
import { openFromClick } from './ItemRow'
import { SIGN_GLYPH, SIGN_LABEL } from './signs'
import { openSpawn } from './spawnStore'
import RefreshNote from './RefreshNote'
import { useHeldHubData, useHubData } from './useHub'
import ProjectPicker from './ProjectPicker'
import { ProjectLink } from './ProjectChip'
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
const FILTER_KEY = 'hub-work-filter'
/** The viewer's saved filter, one for the Work view across projects; a missing or bad value is the default. */
const savedFilter = (): WorkFilter => { try { const raw = localStorage.getItem(FILTER_KEY); return raw ? parseWorkFilter(JSON.parse(raw)) : DEFAULT_WORK_FILTER } catch { return DEFAULT_WORK_FILTER } }
const saveFilter = (filter: WorkFilter) => { try { if (isDefaultWork(filter)) localStorage.removeItem(FILTER_KEY); else localStorage.setItem(FILTER_KEY, JSON.stringify(filter)) } catch { /* private mode: it is the default next time */ } }
const ALSO_MAX = 20
const SOURCE: Record<WorkCard['source'], [string, string]> = { beads: ['◈', 'Beads task'], request: ['✉', 'Request'], hermes: ['☁', 'Hermes run'] }

/** The text with each word of the query wrapped in <mark>. */
function Marked({ text, q }: { text: string; q: string }) {
  const found = words(q)
  if (!found.length) return <>{text}</>
  const parts = text.split(new RegExp(`(${found.map(word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'i'))
  return <>{parts.map((part, index) => (index % 2 ? <mark key={index}>{part}</mark> : part))}</>
}

function Card({ card, href, showProject, projectName, focused, onSheet, q = '', row }: { card: WorkCard; q?: string; /** The bead's text row, once the search has loaded it. */ row?: SearchRow; href: string; showProject: boolean; projectName: string; focused?: boolean; /** A plain click on a Beads card, which opens its sheet; it may take over the navigation. */ onSheet: (event: MouseEvent<HTMLAnchorElement>, href: string) => void }) {
  const [glyph, source] = SOURCE[card.source]
  const beads = card.source === 'beads'
  // A hit that is only in the description or the acceptance criteria: the words the title and id lack, found in the text.
  const absent = words(q).filter(word => !`${card.id} ${card.title}`.toLowerCase().includes(word))
  const snippet = row && absent.length ? snippetOf(row.text, absent.join(' ')) : null
  const cardLink = (
    <a className={`wk-card${card.live?.state === 'working' ? ' live' : ''}${focused ? ' focus' : ''}`} href={href} data-card={card.key} data-focused={focused ? 'true' : undefined} data-run-open={card.source === 'request' && card.state !== 'proposed' ? card.id : undefined} aria-haspopup={beads ? 'dialog' : undefined} aria-controls={beads && focused ? 'hub-map-panel' : undefined} onClick={beads ? event => onSheet(event, href) : card.source === 'request' && card.state !== 'proposed' ? event => openFromClick(event, card.id) : undefined}>
      <span className="wk-title"><Marked text={card.title} q={q} /></span>
      {snippet && <small className="wk-snip">text: <Marked text={snippet} q={q} /></small>}
      {card.why && <span className="wk-why">{card.nothingAsked && <><span className="wk-warn" role="img" aria-label="Nothing asked yet">⚠</span>{' '}</>}{card.why}</span>}
      <span className="wk-meta">
        {card.live && <span className={`wk-dot ${card.live.state === 'working' ? 'working' : 'idle'}`} role="img" aria-label={card.live.state === 'working' ? 'A session is working on it' : 'A session is idle on it'} />}
        <span className="wk-src" title={source} aria-label={source}>{glyph}</span>
        <span className="hub-id"><Marked text={card.id} q={q} /></span>
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
  // The key falls back to the early guess, so it does not change when the list confirms it (a remount would fetch twice).
  const { project, early } = useProject(props.project === 'all' ? undefined : props.project)
  return <BoardView key={props.project === 'all' ? 'all' : project ?? early ?? ''} {...props} />
}

function BoardView({ project: wanted, focus }: { project?: string; focus?: string }) {
  const all = wanted === 'all'
  const { list, project: chosen, early, loading: listing, error: listError } = useProject(all ? undefined : wanted)
  const project = all ? undefined : chosen
  const target = all ? undefined : chosen ?? early
  const work = useHeldHubData<WorkLanes>(all || target ? `/work${target ? `?project=${encodeURIComponent(target)}` : ''}` : null, all || !!project)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [picked, setPicked] = useState<WorkLane | null>(null)
  // Read in the initializer: the board re-mounts per project and must not fall back to the default.
  const [filter, setFilter] = useState<WorkFilter>(savedFilter)
  const change = (next: Partial<WorkFilter>) => { setFilter(value => ({ ...value, ...next })); setPicked(null) }
  const clearFilter = () => { setFilter(DEFAULT_WORK_FILTER); setPicked(null) }
  useEffect(() => { saveFilter(filter) }, [filter])
  const hasQuery = words(filter.q).length > 0
  const filtering = !isDefaultWork(filter)
  // The text of the beads, read only while there is a query.
  const text = useHubData<{ rows: SearchRow[] }>(hasQuery ? `/search-text${project ? `?project=${encodeURIComponent(project)}` : ''}` : null)
  const rowOf = useMemo(() => new Map((hasQuery ? text.data?.rows ?? [] : []).map(row => [`${row.project}/${row.id}`, row])), [hasQuery, text.data])
  const nameOf = (id: string) => list.find(item => item.id === id)?.name ?? id
  const data = work.data
  const focusKey = focus ? `bead:${focus}` : undefined
  // The lanes the board shows. A focused card always passes, so a link to a bead never opens on a hidden card. `focusLane` and `focusCard` read `data.lanes`.
  const shownLanes = useMemo(() => {
    if (!data || !filtering) return data?.lanes
    const textOf = (card: WorkCard) => rowOf.get(`${card.project}/${card.id}`)
    return Object.fromEntries(LANES.map(([lane]) => [lane, data.lanes[lane].filter(card => card.key === focusKey || cardPasses(card, filter, textOf))])) as Record<WorkLane, WorkCard[]>
  }, [data, filtering, filter, rowOf, focusKey])
  const laneCount = (lane: WorkLane) => (filtering && shownLanes ? shownLanes[lane].length : data?.counts[lane] ?? 0)
  const loaded = data ? LANES.reduce((sum, [lane]) => sum + data.lanes[lane].length, 0) : 0
  const matching = shownLanes ? LANES.reduce((sum, [lane]) => sum + shownLanes[lane].length, 0) : 0
  const labelOptions = useMemo(() => {
    const labels = new Set<string>(filter.label ? [filter.label] : [])
    if (data) for (const [lane] of LANES) for (const card of data.lanes[lane]) for (const label of card.labels ?? []) labels.add(label)
    return [{ value: '', label: 'Any label' }, ...[...labels].sort().map(label => ({ value: label, label }))]
  }, [data, filter.label])
  // Beads that match the search but have no card here: old Done, past the Backlog cap, a group.
  const also = useMemo(() => {
    if (!hasQuery || !data) return []
    const onBoard = new Set(LANES.flatMap(([lane]) => data.lanes[lane]).map(card => card.key))
    return (text.data?.rows ?? []).filter(row => !onBoard.has(`bead:${row.id}`) && rowMatches(row, filter.q))
  }, [hasQuery, data, text.data, filter.q])
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
  // While filtering, a phone shows the first lane with a match until the person taps another.
  const firstMatch = filtering && shownLanes ? LANES.find(([lane]) => shownLanes[lane].length)?.[0] : undefined
  const active = picked ?? focusLane ?? firstMatch ?? (data ? defaultLane(data.counts) : 'running')
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
      {data && (
        <>
          <div className="wk-search"><SearchField label="Search work" value={filter.q} onChange={q => change({ q })} onKeyDown={event => { if (event.key === 'Escape' && filter.q) { event.stopPropagation(); change({ q: '' }) } }} data={{ 'data-work-search': '' }} placeholder="Search id, title and description" /></div>
          <div className="wk-filters" role="group" aria-label="Filters">
            <button type="button" className={`hub-chip${filter.needsYou ? ' on' : ''}`} aria-pressed={filter.needsYou} data-filter="needs-you" onClick={() => change({ needsYou: !filter.needsYou })}>Needs you</button>
            <button type="button" className={`hub-chip${filter.blocked ? ' on' : ''}`} aria-pressed={filter.blocked} data-filter="blocked" onClick={() => change({ blocked: !filter.blocked })}>Blocked</button>
            <div className="hub-seg" role="group" aria-label="Type">
              {(['task', 'feature', 'question'] as WorkType[]).map(type => <button key={type} type="button" className={filter.type === type ? 'on' : ''} aria-pressed={filter.type === type} data-filter-type={type} onClick={() => change({ type: filter.type === type ? null : type })}>{type}</button>)}
            </div>
            <Combobox className="cb-bar wk-label" id="hub-work-label" value={filter.label} options={labelOptions} onChange={label => change({ label })} openLabel="Show labels" inputAttrs={{ 'aria-label': 'Label', 'data-filter-label': '' }} />
            <div className="hub-seg" role="group" aria-label="Updated">
              {([[7, '7d'], [30, '30d'], [null, 'any']] as const).map(([within, label]) => <button key={label} type="button" className={filter.within === within ? 'on' : ''} aria-pressed={filter.within === within} data-filter-within={label} onClick={() => change({ within })}>{label}</button>)}
            </div>
          </div>
          {filtering && (
            <p className="wk-count" role="status" data-work-count>{matching} of {loaded} on the board shown · <button type="button" className="wk-clear" onClick={clearFilter}>Clear</button></p>
          )}
          {hasQuery && text.error && !text.data && <p className="hub-muted" data-search-note>Searching titles and ids only: the text did not load.</p>}
        </>
      )}
      {project && <div className="work-spawn">{host.write && <button type="button" className="hub-btn pri" data-spawn-open onClick={() => openSpawn({ project })}>Spawn work</button>}<ProjectLink id={project} label="Project" /></div>}
      {project && !host.write && <p className="hub-muted">Sign in to ask an agent to do something.</p>}
      {all && <p className="hub-muted">Pick a project to ask an agent to do something.</p>}
      {!data && !work.error && (listing || work.loading) && !listError && <p className="hub-empty">Loading…</p>}
      {!listing && !listError && !project && !all && <p className="hub-empty">No projects yet. A project appears once an agent session pushes a Beads copy or writes to the Hub.</p>}
      {listError && <p className="hub-error" role="alert">{listError}</p>}
      {!listError && <RefreshNote error={work.error} hasData={!!work.data} at={work.at} />}
      {data && unknown && <p className="hub-muted" role="status" data-board-note>{focus} is not on the board: it may be closed long ago, a group, or in another project.</p>}
      {data && (
        <>
          <div className="wk-chips-wrap" data-overflow={laneChipEdges}>
          <div className="wk-lane-chips" role="group" aria-label="Lane" ref={laneChips}>
            {LANES.map(([lane, label]) => (
              <button key={lane} type="button" className={`wk-lane-chip${lane === active ? ' on' : ''}`} aria-pressed={lane === active} data-lane-chip={lane} onClick={() => setPicked(lane)}>
                {label} <span className="n">{laneCount(lane)}</span>
              </button>
            ))}
          </div>
          </div>
          <div className="wk-lanes-wrap" data-overflow={laneEdges}>
          <div className="wk-lanes" data-active={active} ref={laneGrid}>
            {LANES.map(([lane, label]) => {
              const cards = (shownLanes ?? data.lanes)[lane]
              // Every match shows while filtering: no fold, no "older not shown".
              const collapsible = !filtering && (lane === 'backlog' || lane === 'done') && cards.length > COLLAPSE
              const shown = collapsible && !expanded[lane] ? cards.slice(0, COLLAPSE) : cards
              return (
                <section key={lane} className="wk-lane" data-lane={lane} aria-label={label}>
                  <h3>{label} <span>{laneCount(lane)}</span></h3>
                  {shown.map(card => <Card key={card.key} card={card} href={card.source === 'beads' ? workHash(board, card.id) : card.href} showProject={all} projectName={nameOf(card.project)} focused={card.key === focusKey} onSheet={openFromCard} q={filter.q} row={rowOf.get(`${card.project}/${card.id}`)} />)}
                  {!cards.length && <p className="hub-empty">{filtering ? 'No match' : 'Nothing here.'}</p>}
                  {collapsible && (
                    <button type="button" className="hub-btn wk-more" onClick={() => setExpanded(value => ({ ...value, [lane]: !value[lane] }))}>
                      {expanded[lane] ? 'Show fewer' : `Show all ${cards.length}`}
                    </button>
                  )}
                  {!filtering && data.counts[lane] > cards.length && <p className="hub-muted">{data.counts[lane] - cards.length} older not shown.</p>}
                </section>
              )
            })}
          </div>
          </div>
          {also.length > 0 && (
            <section className="wk-also" aria-label="Also found, not on the board" data-also-found>
              <h3>Also found, not on the board <span>{also.length}</span></h3>
              <p className="hub-muted">Matches with no card on this board.</p>
              {also.slice(0, ALSO_MAX).map(row => (
                <a key={`${row.project}/${row.id}`} className="wk-also-row" href={workHash(board, row.id)} data-also={row.id} onClick={() => { if (all) setCarried({ id: row.id, project: row.project }) }}>
                  <span className="wk-title"><Marked text={row.title} q={filter.q} /></span>
                  <span className="wk-meta"><span className="hub-id"><Marked text={row.id} q={filter.q} /></span><span>{row.status === 'closed' ? 'closed' : 'open'}</span>{all && <span className="wk-project">{nameOf(row.project)}</span>}</span>
                </a>
              ))}
              {also.length > ALSO_MAX && <p className="hub-muted">+{also.length - ALSO_MAX} more</p>}
            </section>
          )}
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
