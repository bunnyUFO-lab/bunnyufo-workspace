import { useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import type { HubEvent, HubProject, MoveOffer, Today as TodayData } from '../lib/hub'
import { HUB_WROTE, ago, clock, hubPost } from '../lib/hub'
import type { WorkingItem } from '../lib/hubPc'
import { host } from '../lib/host'
import { hubHash } from '../lib/route'
import { needsHref } from '../lib/needsView.mjs'
import ItemRow, { openFromClick } from './ItemRow'
import PcTile from './PcTile'
import ProjectPicker from './ProjectPicker'
import { ProjectLink } from './ProjectChip'
import UnaskedPanel from './UnaskedPanel'
import WorkingNow from './WorkingNow'
import NeedsRows, { Icon } from './NeedsRows'
import { openRun } from './runStore'
import { openSpawn } from './spawnStore'
import { todayFor } from './todayFilter.ts'
import RefreshNote from './RefreshNote'
import { useHubData, useTodayScreen } from './useHub'
import './today.css'

const ICON_ALERT = '<path d="M12 4 2.8 19.5h18.4z"/><path d="M12 10v4.2M12 16.8h.01"/>'
const ICON_REFRESH = '<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M19.5 4.5v4h-4"/>'

const bare = (text: string) => text.replace(/ ago$/, '')
/** An old site API sends only `running`: show those sessions as event rows. */
export const legacyRunning = (data: TodayData): WorkingItem[] =>
  data.running.map(item => ({ id: item.id, source: 'events', host: item.host ?? '', agent: 'claude', title: item.title, project: item.project, state: 'working', since: item.at, url: item.url }))
const stagger = (index: number) => ({ '--i': index }) as CSSProperties

function greeting(hour: number) {
  return hour >= 5 && hour < 12 ? 'Good morning' : hour >= 12 && hour < 18 ? 'Good afternoon' : 'Good evening'
}

function eyebrow(now: Date) {
  const day = now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })
  return `${day} · ${clock(now.toISOString())}`
}

/** Retry on a cloud alert: fires the request again, then tells the other screens. */
function AlertRetry({ request }: { request: string }) {
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const retry = async () => {
    setBusy(true)
    setProblem(null)
    try { await hubPost(`/requests/${encodeURIComponent(request)}/fire`, {}) } catch (failure) { setProblem(failure instanceof Error ? failure.message : 'It did not work.') } finally { setBusy(false); window.dispatchEvent(new Event(HUB_WROTE)) }
  }
  return (
    <>
      <button type="button" className="hub-btn alert-retry" disabled={busy} onClick={() => void retry()} data-alert-retry={request}>Retry</button>
      {problem && <small className="hub-error" role="alert" data-alert-retry-error>{problem}</small>}
    </>
  )
}

/** The Alerts panel: Dismiss on each row, Clear all, and Undo for the last dismissal. Dismissals are kept on the server, so they hold on every device. */
function AlertsPanel({ alerts, count, index, project }: { alerts: HubEvent[]; count: number; index: number; project?: string }) {
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [undo, setUndo] = useState<string[] | null>(null)
  const timer = useRef(0)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  const send = async (verb: 'dismiss' | 'restore', keys: string[]) => {
    setBusy(true)
    setProblem(null)
    try {
      await hubPost(`/alerts/${verb}`, { keys })
      window.clearTimeout(timer.current)
      if (verb === 'dismiss') { setUndo(keys); timer.current = window.setTimeout(() => setUndo(null), 20000) } else setUndo(null)
    } catch (failure) { setProblem(failure instanceof Error ? failure.message : 'It did not work.') } finally { setBusy(false); window.dispatchEvent(new Event(HUB_WROTE)) }
  }
  const keys = alerts.map(event => event.key).filter((key): key is string => !!key)
  return (
    <section className="hub-panel rise" style={stagger(index)} aria-label="Alerts">
      <h3>Alerts <span>{count ? `${count} failed` : ''}</span>
        {host.write && keys.length > 1 && <button type="button" className="hub-btn alert-clear" disabled={busy} onClick={() => void send('dismiss', keys.slice(0, 50))} data-alerts-clear>Clear all</button>}
      </h3>
      {undo && (
        <div className="alert-undo" role="status" data-alerts-undo>
          <span>{undo.length === 1 ? 'Alert dismissed.' : `${undo.length} alerts dismissed.`}</span>
          <button type="button" className="hub-btn" disabled={busy} onClick={() => void send('restore', undo)} data-alerts-undo-button>Undo</button>
        </div>
      )}
      {problem && <p className="hub-error" role="alert" data-alerts-error>{problem}</p>}
      {alerts.length ? alerts.slice(0, 5).map(event => (
        <div key={event.key ?? event.file} className="alert-row" data-alert>
          <span className="alert-icon"><Icon paths={ICON_ALERT} /></span>
          <span className="nrow-text"><b>{event.request ? <a href={hubHash('request', event.request)} onClick={click => openFromClick(click, event.request as string)} data-alert-run={event.request} data-run-open={event.request}>{event.title}</a> : event.title}</b><small>{[event.summary, event.project].filter(Boolean).join(' · ') || event.kind.replace(/-/g, ' ')}</small></span>
          {host.write && event.retry && event.request && <AlertRetry request={event.request} />}
          {host.write && event.key && <button type="button" className="hub-btn alert-dismiss" disabled={busy} onClick={() => void send('dismiss', [event.key as string])} aria-label={`Dismiss: ${event.title}`} data-alert-dismiss>Dismiss</button>}
        </div>
      )) : <p className="hub-empty">{project ? `No alerts for ${project}.` : 'No alerts.'}</p>}
    </section>
  )
}

/** A PC request that has waited 6 hours: one tap makes a new request for the cloud, which the owner's approval signs again. */
function MoveTile({ offer }: { offer: MoveOffer }) {
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const move = async () => {
    setBusy(true)
    setProblem(null)
    try {
      const made = await hubPost<{ id: string }>(`/requests/${encodeURIComponent(offer.request)}/move-to-cloud`, {})
      window.dispatchEvent(new Event(HUB_WROTE))
      openRun(made.id)
    } catch (failure) { setProblem(failure instanceof Error ? failure.message : 'It did not work.') } finally { setBusy(false) }
  }
  return (
    <div className="move-tile" data-move-offer={offer.request}>
      <span className="nrow-text">
        <b>{offer.title}</b>
        <small>Waited 6 h for the PC. Move it to the cloud{offer.repo ? ` (${offer.repo})` : ''}? It only needs the repo.</small>
      </span>
      <button type="button" className="hub-btn pri" disabled={busy} onClick={() => void move()} data-move-to-cloud>Move to the cloud</button>
      {problem && <small className="hub-error" role="alert" data-move-error>{problem}</small>}
    </div>
  )
}

/** One column on a phone, as `today.css` lays it out at the same width. */
const NARROW = '(max-width: 760px)'
const narrowNow = () => typeof window.matchMedia === 'function' && window.matchMedia(NARROW).matches

function useNarrow() {
  const [narrow, setNarrow] = useState(narrowNow)
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const query = window.matchMedia(NARROW)
    const update = () => setNarrow(query.matches)
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])
  return narrow
}

/** Today's own project, remembered in this browser. It is not `buw.hub.project`, which Work and the Roadmap share: the default here is All. */
const PROJECT_KEY = 'hub-today-project'
const savedProject = () => { try { return localStorage.getItem(PROJECT_KEY) ?? '' } catch { return '' } }
const saveProject = (project: string) => { try { if (project) localStorage.setItem(PROJECT_KEY, project); else localStorage.removeItem(PROJECT_KEY) } catch { /* private mode: All next time */ } }

export default function Today() {
  const narrow = useNarrow()
  const today = useTodayScreen()
  const projects = useHubData<{ projects: HubProject[] }>('/projects')
  const [chosen, setChosen] = useState(savedProject)
  const list = projects.data?.projects
  // A saved project that is gone counts as All once the list is known, and the key is cleared.
  const gone = !!chosen && !!list && !list.some(item => item.id === chosen)
  useEffect(() => { if (gone) saveProject('') }, [gone])
  // If /projects fails there is no picker to undo a remembered project: show All for this view and leave the saved choice alone.
  const failed = !!projects.error && !list
  const project = gone || failed ? '' : chosen
  const choose = (id: string) => { const next = id === 'all' ? '' : id; setChosen(next); saveProject(next) }
  const { data: full, error, reload, at, loading } = today
  if (!full) return <p className="hub-empty">{error ?? (loading ? 'Loading…' : '')}</p>
  // Filtered once, here: the sentence, the tiles and both layouts read `data`. The context keeps the full answer for the badge.
  const { data, elsewhere } = todayFor(full, project)
  const { counts } = data
  const projectName = list?.find(item => item.id === project)?.name ?? project
  const needsByProject = full.needsYou.reduce<Record<string, number>>((all, item) => (item.project ? { ...all, [item.project]: (all[item.project] ?? 0) + 1 } : all), {})
  const now = new Date()
  const oldest = data.needsYou.reduce<string | null>((first, item) => (!first || item.at < first ? item.at : first), null)
  const sentence = [
    counts.needsYou ? `${counts.needsYou} ${counts.needsYou === 1 ? 'thing waits' : 'things wait'} on you.` : project ? `Nothing for ${projectName} waits on you.` : 'Nothing waits on you.',
    counts.running ? `${counts.running} ${counts.running === 1 ? 'session is' : 'sessions are'} running.` : '',
  ].filter(Boolean).join(' ')
  const needsLink = project ? needsHref('all', project) : hubHash('needs')
  const tiles: [string, number, string, string, string, string][] = [
    ['needs-you', counts.needsYou, 'Needs you', oldest ? `Oldest waits ${bare(ago(oldest))}` : 'Nothing waiting', needsLink, 'needs'],
    ['running', counts.running, 'Running', 'on the PC and in the cloud', hubHash('activity'), 'working'],
    ['recent', counts.recent, 'Since yesterday', 'events in 24 h', hubHash('activity'), 'idle'],
    ['alerts', counts.alerts, 'Alerts', counts.alerts ? 'need a look' : 'all quiet', hubHash('activity', 'alerts'), 'failed'],
  ]
  const unaskedPanel = <UnaskedPanel project={project} />
  const needsPanel = (
    <section className="hub-panel rise" style={stagger(2)} aria-label="Needs you">
      <h3><span className="dot st-needs" aria-hidden="true" />Needs you<a className="today-all" href={needsLink}>All {counts.needsYou} →</a></h3>
      {data.needsYou.length ? <NeedsRows items={data.needsYou.slice(0, 3)} href={needsLink} /> : <p className="hub-empty">{project ? `Nothing for ${projectName} waits on you.` : 'Nothing waits on you.'}</p>}
    </section>
  )
  const recentPanel = (
    <section className="hub-panel rise" style={stagger(3)} aria-label="Since yesterday">
      <h3>Since yesterday <span>{counts.recent}</span></h3>
      {data.recent.length ? data.recent.slice(0, 10).map(event => <ItemRow key={event.file} event={event} />) : <p className="hub-empty">{project ? `Nothing has happened for ${projectName} in the last 24 hours.` : 'Nothing has happened in the last 24 hours.'}</p>}
    </section>
  )
  const offersPanel = data.offers?.length && host.write ? (
    <section className="hub-panel rise" style={stagger(3)} aria-label="Waiting for the PC">
      <h3>Waiting for the PC <span>{data.offers.length}</span></h3>
      {data.offers.slice(0, 3).map(offer => <MoveTile key={offer.request} offer={offer} />)}
    </section>
  ) : null
  const alertsPanel = <AlertsPanel alerts={data.alerts} count={counts.alerts} index={3} project={projectName} />
  const workingPanel = <WorkingNow items={data.working ?? legacyRunning(data)} blocked={data.needsYou} running={counts.running} now={new Date(data.at).getTime()} />
  const pcPanel = (data.pc || data.wake?.wakeAvailable) && <PcTile pc={data.pc ?? null} wake={data.wake} />
  return (
    <div className="today">
      <header className="today-head rise" style={stagger(0)}>
        <div>
          <div className="today-eyebrow" data-today-eyebrow>{eyebrow(now)}</div>
          <h2>{greeting(now.getHours())}</h2>
          <p>{sentence}</p>
          {data.cloud && <p className="today-cloud" data-today-cloud title={`Cloud runs fired today. The count starts again at ${clock(data.cloud.next)}.`}>Cloud: {data.cloud.used} of {data.cloud.cap} today</p>}
        </div>
        <div className="today-actions">
          <span className="hub-muted">Updated {at ? clock(at.toISOString()) : ''}</span>
          <button type="button" className="hub-btn today-icon" onClick={reload} aria-label="Refresh"><Icon paths={ICON_REFRESH} /></button>
          {host.write && <button type="button" className="hub-btn" onClick={() => openSpawn(project ? { project } : {})} data-spawn-open>Spawn</button>}
          <a className="hub-btn today-primary" href={needsLink} data-today-open>Open Needs you · <span className="today-num">{counts.needsYou}</span></a>
        </div>
      </header>
      <RefreshNote error={error} hasData at={at} />
      {!!list?.length && (
        <div className="today-project rise" style={stagger(1)} data-today-project>
          <ProjectPicker id="hub-today-project" projects={list} value={project || 'all'} allValue="all" onChange={choose} oneRow counts={needsByProject} allCount={full.counts.needsYou} />
          {project && <ProjectLink id={project} name={projectName} />}
          {elsewhere > 0 && <p className="hub-muted today-elsewhere" data-today-elsewhere>{elsewhere} more {elsewhere === 1 ? 'waits' : 'wait'} in other projects · <button type="button" className="today-linkbtn" onClick={() => choose('all')}>Show all</button></p>}
        </div>
      )}
      <div className="hub-kpis rise" style={stagger(1)}>
        {tiles.map(([key, value, label, sub, href, state]) => (
          <a key={key} className="hub-kpi" href={href} data-kpi={key}>
            <span className="kpi-label"><span>{label}</span><span className={`dot st-${state}`} aria-hidden="true" /></span>
            <span className="hub-kpi-v">{value}</span>
            <span className="kpi-sub">{sub}</span>
          </a>
        ))}
      </div>
      {narrow ? (
        // On a phone, what runs now comes right after what waits on the owner, before the day's history.
        <div className="today-cols" data-today-layout="phone">
          <div className="today-stack">{needsPanel}{unaskedPanel}{workingPanel}{recentPanel}{offersPanel}{alertsPanel}{pcPanel}</div>
        </div>
      ) : (
        <div className="today-cols" data-today-layout="wide">
          <div className="today-stack">{needsPanel}{unaskedPanel}{recentPanel}</div>
          <div className="today-stack">{offersPanel}{alertsPanel}{workingPanel}{pcPanel}</div>
        </div>
      )}
    </div>
  )
}
