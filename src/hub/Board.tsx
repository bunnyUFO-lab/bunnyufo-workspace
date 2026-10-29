import { useEffect, useRef, useState } from 'react'
import type { Sign } from '../lib/hub'
import { hubPost } from '../lib/hub'
import type { WorkCard, WorkLane, WorkLanes } from '../lib/hubWork'
import { host } from '../lib/host'
import { hubHash } from '../lib/route'
import { useOverflowEdges } from '../lib/useOverflowEdges'
import { SIGN_GLYPH, SIGN_LABEL } from './signs'
import { useHubData } from './useHub'
import { useProject } from './useProject'
import './work.css'
import { defaultLane } from './workLanes'

const WHEN: [string, string][] = [['next-sprint', 'Next sprint'], ['nightly', 'Nightly'], ['record', 'Just record it']]

function RequestForm({ project }: { project: string }) {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [when, setWhen] = useState('next-sprint')
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const send = async () => {
    setBusy(true)
    setError(null)
    try {
      const answer = await hubPost<{ id: string }>('/requests', { project, text: text.trim(), when })
      setSent(answer.id)
      setText('')
      setOpen(false)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The request was not sent.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="hub-request">
      {!open && <button type="button" className="hub-btn pri" onClick={() => { setOpen(true); setSent(null) }}>Ask an agent to do something</button>}
      {sent && <p className="hub-ok" role="status">Request sent <code>{sent}</code></p>}
      {open && (
        <section className="hub-panel" aria-label="New request">
          <label className="hub-field">What should happen?
            <textarea value={text} onChange={event => setText(event.target.value)} rows={3} maxLength={4000} />
          </label>
          <div className="hub-seg" role="radiogroup" aria-label="When">
            {WHEN.map(([key, label]) => (
              <button key={key} type="button" role="radio" aria-checked={when === key} className={when === key ? 'on' : ''} onClick={() => setWhen(key)}>{label}</button>
            ))}
          </div>
          {error && <p className="hub-error" role="alert">{error}</p>}
          <div className="hub-actions">
            <button type="button" className="hub-btn" onClick={() => setOpen(false)}>Cancel</button>
            <button type="button" className="hub-btn pri" disabled={busy || !text.trim()} onClick={() => void send()}>Send</button>
          </div>
        </section>
      )}
    </div>
  )
}

const LANES: [WorkLane, string][] = [
  ['backlog', 'Backlog'], ['ready', 'Ready'], ['running', 'Running'], ['blocked', 'Blocked'], ['review', 'Review'], ['done', 'Done'],
]
const COLLAPSE = 10
const SOURCE: Record<WorkCard['source'], [string, string]> = { beads: ['◈', 'Beads task'], request: ['✉', 'Request'], hermes: ['☁', 'Hermes run'] }

function Card({ card, showProject, projectName }: { card: WorkCard; showProject: boolean; projectName: string }) {
  const [glyph, source] = SOURCE[card.source]
  return (
    <a className={`wk-card${card.live?.state === 'working' ? ' live' : ''}`} href={card.href} data-card={card.key}>
      <span className="wk-title">{card.title}</span>
      {card.why && <span className="wk-why">{card.why}</span>}
      <span className="wk-meta">
        {card.live && <span className={`wk-dot ${card.live.state === 'working' ? 'working' : 'idle'}`} role="img" aria-label={card.live.state === 'working' ? 'A session is working on it' : 'A session is idle on it'} />}
        <span className="wk-src" title={source} aria-label={source}>{glyph}</span>
        <span className="hub-id">{card.id}</span>
        {showProject && card.project && <span className="wk-project">{projectName}</span>}
        {card.signs.map(sign => <span key={sign} className="hub-sign" title={SIGN_LABEL[sign as Sign]} aria-label={SIGN_LABEL[sign as Sign]}>{SIGN_GLYPH[sign as Sign]}</span>)}
      </span>
    </a>
  )
}

/** Work's Lanes tab: `project` is a project id, `all` for every project, or absent for the default one. */
export default function Board({ project: wanted }: { project?: string }) {
  const all = wanted === 'all'
  const { list, project: chosen, loading: listing, error: listError } = useProject(all ? undefined : wanted)
  const project = all ? undefined : chosen
  const work = useHubData<WorkLanes>(all || project ? `/work${project ? `?project=${encodeURIComponent(project)}` : ''}` : null)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [picked, setPicked] = useState<WorkLane | null>(null)
  const nameOf = (id: string) => list.find(item => item.id === id)?.name ?? id
  const data = work.data
  const active = picked ?? (data ? defaultLane(data.counts) : 'running')
  // Each scroller that can hide something shows a fade at its cut edge (the Roadmap's pattern).
  const projectChips = useRef<HTMLDivElement>(null)
  const laneChips = useRef<HTMLDivElement>(null)
  const laneGrid = useRef<HTMLDivElement>(null)
  const projectEdges = useOverflowEdges(projectChips, [list.length, project, all])
  const laneChipEdges = useOverflowEdges(laneChips, [data])
  const laneEdges = useOverflowEdges(laneGrid, [project, data])
  useEffect(() => { projectChips.current?.querySelector('.hub-chip.on')?.scrollIntoView({ inline: 'nearest', block: 'nearest' }) }, [list.length, project, all])
  useEffect(() => { laneChips.current?.querySelector('.wk-lane-chip.on')?.scrollIntoView({ inline: 'nearest', block: 'nearest' }) }, [active, data])

  return (
    <div className="work">
      <div className="hub-chips-wrap" data-overflow={projectEdges}>
        <div className="hub-chips one-row" aria-label="Project" ref={projectChips}>
          <a className={`hub-chip${all ? ' on' : ''}`} href={hubHash('work', 'all')}>All</a>
          {list.map(item => <a key={item.id} className={`hub-chip${!all && item.id === project ? ' on' : ''}`} href={hubHash('work', item.id)}>{item.name}</a>)}
        </div>
      </div>
      {project && host.write && <RequestForm project={project} />}
      {project && !host.write && <p className="hub-muted">Sign in to ask an agent to do something.</p>}
      {all && <p className="hub-muted">Pick a project to ask an agent to do something.</p>}
      {!data && !work.error && (listing || work.loading) && !listError && <p className="hub-empty">Loading…</p>}
      {!listing && !listError && !project && !all && <p className="hub-empty">No projects yet. A project appears once an agent session pushes a Beads copy or writes to the Hub.</p>}
      {(work.error || listError) && <p className="hub-error" role="alert">{work.error ?? listError}</p>}
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
                  {shown.map(card => <Card key={card.key} card={card} showProject={all} projectName={nameOf(card.project)} />)}
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
    </div>
  )
}
