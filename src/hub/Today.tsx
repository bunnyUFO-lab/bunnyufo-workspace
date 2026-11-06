import { useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import type { HubEvent, JobsView, MoveOffer, Today as TodayData } from '../lib/hub'
import { HUB_WROTE, clock, hubPost } from '../lib/hub'
import type { WorkingItem } from '../lib/hubPc'
import { host } from '../lib/host'
import { hubHash } from '../lib/route'
import UnaskedPanel from './UnaskedPanel'
import WorkingNow from './WorkingNow'
import WakeButton from './WakeButton'
import NeedsRows, { Icon } from './NeedsRows'
import { go } from '../lib/entries'
import { openSpawn } from './spawnStore'
import RefreshNote from './RefreshNote'
import { JobItem, RUNNING } from './Jobs'
import NextNote from './NextNote'
import { takeHandoff } from './flash'
import { heldAmong, notHeld, useHeld } from './heldSend'
import { useHubData, useTodayScreen } from './useHub'
import './today.css'

const ICON_ALERT = '<path d="M12 4 2.8 19.5h18.4z"/><path d="M12 10v4.2M12 16.8h.01"/>'
const ICON_REFRESH = '<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M19.5 4.5v4h-4"/>'

/** An old site API sends only `running`: show those sessions as event rows. */
export const legacyRunning = (data: TodayData): WorkingItem[] =>
  data.running.map(item => ({ id: item.id, source: 'events', host: item.host ?? '', agent: 'claude', title: item.title, project: item.project, state: 'working', since: item.at, url: item.url }))
const stagger = (index: number) => ({ '--i': index }) as CSSProperties

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
function AlertsPanel({ alerts, count, index }: { alerts: HubEvent[]; count: number; index: number }) {
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
          <span className="nrow-text"><b>{event.request ? <a href={hubHash('request', event.request)} data-alert-run={event.request} data-run-open={event.request}>{event.title}</a> : event.title}</b><small>{[event.summary, event.project].filter(Boolean).join(' · ') || event.kind.replace(/-/g, ' ')}</small></span>
          {host.write && event.retry && event.request && <AlertRetry request={event.request} />}
          {host.write && event.key && <button type="button" className="hub-btn alert-dismiss" disabled={busy} onClick={() => void send('dismiss', [event.key as string])} aria-label={`Dismiss: ${event.title}`} data-alert-dismiss>Dismiss</button>}
        </div>
      )) : <p className="hub-empty">No alerts.</p>}
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
      go(hubHash('request', made.id))
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

/** What the owner sees on opening the Hub: how many things wait, the first three, and what runs, what finished and what waits for the PC. */
export default function Today() {
  const narrow = useNarrow()
  const today = useTodayScreen()
  const jobs = useHubData<JobsView>('/jobs')
  const presence = useHubData<{ away: boolean; until: string | null }>(host.hub ? '/presence' : null)
  const held = useHeld()
  // The note after the last item was answered from its page, when the owner asked for the next one and none was left.
  const [handoff] = useState(takeHandoff)
  const { data: full, error, reload, at, loading } = today
  if (!full) return <p className="hub-empty">{error ?? (loading ? 'Loading…' : '')}</p>
  // What is held for Undo is out of the rows and out of the count, here and in the badge: the one source is `useHeld`.
  const needsYou = notHeld(full.needsYou, held)
  const waiting = Math.max(0, full.counts.needsYou - heldAmong(full.needsYou, held))
  const data = { ...full, needsYou, counts: { ...full.counts, needsYou: waiting } }
  const { counts } = data
  const title = waiting ? `${waiting} ${waiting === 1 ? 'needs' : 'need'} you` : 'All clear'
  const needsLink = hubHash('needs')
  const delivered = (jobs.data?.jobs ?? []).filter(job => !RUNNING.has(job.state)).slice(0, 3)
  const pc = data.pc ?? null
  const pcWord = pc ? (pc.state === 'asleep-or-off' ? 'PC asleep' : 'PC awake') : data.wake?.wakeAvailable ? (data.wake.state === 'waking' ? 'PC waking' : 'PC asleep') : ''
  const needsPanel = (
    <section className="hub-panel rise" style={stagger(2)} aria-label="Needs you" data-today-needs>
      <h3><span className="dot st-needs" aria-hidden="true" />Needs you<a className="today-all" href={needsLink} data-today-open>All {waiting} →</a></h3>
      {needsYou.length ? <NeedsRows items={needsYou.slice(0, 3)} href={needsLink} pages /> : <p className="hub-empty">Nothing waits on you.</p>}
    </section>
  )
  const deliveredPanel = (
    <section className="hub-panel rise" style={stagger(4)} aria-label="Delivered" data-today-delivered>
      <h3>Delivered<a className="today-all" href={hubHash('jobs', 'finished')}>All in Work →</a></h3>
      {delivered.length ? <div className="jb-list">{delivered.map(job => <JobItem key={job.id} job={job} />)}</div> : <p className="hub-empty">{jobs.data ? 'Nothing has been delivered lately.' : 'Loading…'}</p>}
    </section>
  )
  const offersPanel = data.offers?.length && host.write ? (
    <section className="hub-panel rise" style={stagger(3)} aria-label="Waiting for the PC">
      <h3>Waiting for the PC <span>{data.offers.length}</span></h3>
      {data.offers.slice(0, 3).map(offer => <MoveTile key={offer.request} offer={offer} />)}
      <WakeButton wake={data.wake} />
    </section>
  ) : null
  const alertsPanel = <AlertsPanel alerts={data.alerts} count={counts.alerts} index={3} />
  const workingPanel = <WorkingNow items={data.working ?? legacyRunning(data)} blocked={needsYou} running={counts.running} now={new Date(data.at).getTime()} />
  const unaskedPanel = <UnaskedPanel />
  return (
    <div className="today" data-today>
      <header className="today-head rise" style={stagger(0)}>
        <div>
          <h2 data-today-title>{title}</h2>
          {data.cloud && <p className="today-cloud" data-today-cloud title={`Cloud runs fired today. The count starts again at ${clock(data.cloud.next)}.`}>Cloud: {data.cloud.used} of {data.cloud.cap} today</p>}
        </div>
        <div className="today-actions">
          <span className="hub-muted">Updated {at ? clock(at.toISOString()) : ''}</span>
          <button type="button" className="hub-btn today-icon" onClick={reload} aria-label="Refresh"><Icon paths={ICON_REFRESH} /></button>
          {host.write && <button type="button" className="hub-btn" onClick={() => openSpawn()} data-spawn-open>New job</button>}
        </div>
      </header>
      <a className="today-status rise" style={stagger(1)} href={hubHash('settings')} data-today-status aria-label="PC and Away mode, in Settings">
        <span className="today-pill"><span className={`dot ${counts.running ? 'st-working live' : 'st-idle'}`} aria-hidden="true" />{counts.running} running</span>
        {pcWord && <span className="today-pill" data-today-pc>{pcWord}</span>}
        {presence.data?.away && <span className="today-pill" data-today-away>Away mode</span>}
      </a>
      {handoff && <NextNote note={handoff} />}
      <RefreshNote error={error} hasData at={at} />
      {narrow ? (
        // On a phone, what runs now comes right after what waits on the owner, before what was delivered.
        <div className="today-cols" data-today-layout="phone">
          <div className="today-stack">{needsPanel}{unaskedPanel}{alertsPanel}{workingPanel}{deliveredPanel}{offersPanel}</div>
        </div>
      ) : (
        <div className="today-cols" data-today-layout="wide">
          <div className="today-stack">{needsPanel}{unaskedPanel}{alertsPanel}{offersPanel}</div>
          <div className="today-stack">{workingPanel}{deliveredPanel}</div>
        </div>
      )}
    </div>
  )
}
