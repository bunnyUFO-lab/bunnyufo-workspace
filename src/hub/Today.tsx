import { useContext, useState } from 'react'
import type { CSSProperties } from 'react'
import type { Item, Today as TodayData } from '../lib/hub'
import { HUB_WROTE, ago, clock, hubPost } from '../lib/hub'
import { KIND_ICON, KIND_LABEL, needsKind } from '../lib/needsKinds'
import type { WorkingItem } from '../lib/hubPc'
import { host } from '../lib/host'
import { hubHash } from '../lib/route'
import ItemRow, { openFromClick } from './ItemRow'
import PcTile from './PcTile'
import WorkingNow from './WorkingNow'
import { itemKey, setFocus } from './needsFocus'
import { openSpawn } from './spawnStore'
import { TodayContext, useHubData } from './useHub'
import './today.css'

const ICON_ALERT = '<path d="M12 4 2.8 19.5h18.4z"/><path d="M12 10v4.2M12 16.8h.01"/>'
const ICON_ARROW = '<path d="M5 12h14M13 6l6 6-6 6"/>'
const ICON_REFRESH = '<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M19.5 4.5v4h-4"/>'

function Icon({ paths }: { paths: string }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" dangerouslySetInnerHTML={{ __html: paths }} />
}

const titleCase = (text: string) => text.replace(/[-_]+/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase())
const who = (item: Item) => item.by ?? titleCase(item.project ?? '')
const bare = (text: string) => text.replace(/ ago$/, '')
/** An old site API sends only `running`: show those sessions as event rows. */
const legacyRunning = (data: TodayData): WorkingItem[] =>
  data.running.map(item => ({ id: item.id, source: 'events', host: item.host ?? '', agent: 'claude', title: item.title, project: item.project, state: 'working', since: item.at, url: item.url }))
const stagger = (index: number) => ({ '--i': index }) as CSSProperties

function greeting(hour: number) {
  return hour >= 5 && hour < 12 ? 'Good morning' : hour >= 12 && hour < 18 ? 'Good afternoon' : 'Good evening'
}

function eyebrow(now: Date) {
  const day = now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })
  return `${day} · ${now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}`
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

export default function Today() {
  const shared = useContext(TodayContext)
  const own = useHubData<TodayData>(shared ? null : '/today')
  const { data, error, reload, at, loading } = shared ?? own
  if (!data) return <p className="hub-empty">{error ?? (loading ? 'Loading…' : '')}</p>
  const { counts } = data
  const now = new Date()
  const oldest = data.needsYou.reduce<string | null>((first, item) => (!first || item.at < first ? item.at : first), null)
  const sentence = [
    counts.needsYou ? `${counts.needsYou} ${counts.needsYou === 1 ? 'thing waits' : 'things wait'} on you.` : 'Nothing waits on you.',
    counts.running ? `${counts.running} ${counts.running === 1 ? 'session is' : 'sessions are'} running.` : '',
  ].filter(Boolean).join(' ')
  const tiles: [string, number, string, string, string, string][] = [
    ['needs-you', counts.needsYou, 'Needs you', oldest ? `Oldest waits ${bare(ago(oldest))}` : 'Nothing waiting', hubHash('needs'), 'needs'],
    ['running', counts.running, 'Running', 'on the PC and in the cloud', hubHash('activity'), 'working'],
    ['recent', counts.recent, 'Since yesterday', 'events in 24 h', hubHash('activity'), 'idle'],
    ['alerts', counts.alerts, 'Alerts', counts.alerts ? 'need a look' : 'all quiet', hubHash('activity', 'alerts'), 'failed'],
  ]
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
          {host.write && <button type="button" className="hub-btn" onClick={() => openSpawn()} data-spawn-open>Spawn</button>}
          <a className="hub-btn today-primary" href={hubHash('needs')} data-today-open>Open Needs you · <span className="today-num">{counts.needsYou}</span></a>
        </div>
      </header>
      {error && <p className="hub-error" role="alert">{error}</p>}
      <div className="hub-kpis rise" style={stagger(1)}>
        {tiles.map(([key, value, label, sub, href, state]) => (
          <a key={key} className="hub-kpi" href={href} data-kpi={key}>
            <span className="kpi-label"><span>{label}</span><span className={`dot st-${state}`} aria-hidden="true" /></span>
            <span className="hub-kpi-v">{value}</span>
            <span className="kpi-sub">{sub}</span>
          </a>
        ))}
      </div>
      <div className="today-cols">
        <div className="today-stack">
          <section className="hub-panel rise" style={stagger(2)} aria-label="Needs you">
            <h3><span className="dot st-needs" aria-hidden="true" />Needs you<a className="today-all" href={hubHash('needs')}>All {counts.needsYou} →</a></h3>
            {data.needsYou.length ? data.needsYou.slice(0, 3).map(item => {
              const kind = needsKind(item)
              return (
                <a key={itemKey(item)} className="nrow" href={hubHash('needs')} data-nrow={kind} onClick={() => setFocus(itemKey(item))}>
                  <span className="kind"><Icon paths={KIND_ICON[kind]} /></span>
                  <span className="nrow-text">
                    <b>{item.title}</b>
                    <small>{[KIND_LABEL[kind], who(item), ago(item.at)].filter(Boolean).join(' · ')}</small>
                  </span>
                  <span className="nrow-go"><Icon paths={ICON_ARROW} /></span>
                </a>
              )
            }) : <p className="hub-empty">Nothing waits on you.</p>}
          </section>
          <section className="hub-panel rise" style={stagger(3)} aria-label="Since yesterday">
            <h3>Since yesterday <span>{counts.recent}</span></h3>
            {data.recent.length ? data.recent.slice(0, 10).map(event => <ItemRow key={event.file} event={event} />) : <p className="hub-empty">Nothing has happened in the last 24 hours.</p>}
          </section>
        </div>
        <div className="today-stack">
          <section className="hub-panel rise" style={stagger(3)} aria-label="Alerts">
            <h3>Alerts <span>{counts.alerts ? `${counts.alerts} failed` : ''}</span></h3>
            {data.alerts.length ? data.alerts.slice(0, 5).map(event => (
              <div key={event.file} className="alert-row" data-alert>
                <span className="alert-icon"><Icon paths={ICON_ALERT} /></span>
                <span className="nrow-text"><b>{event.request ? <a href={hubHash('request', event.request)} onClick={click => openFromClick(click, event.request as string)} data-alert-run={event.request}>{event.title}</a> : event.title}</b><small>{[event.summary, event.project].filter(Boolean).join(' · ') || event.kind.replace(/-/g, ' ')}</small></span>
                {host.write && event.retry && event.request && <AlertRetry request={event.request} />}
              </div>
            )) : <p className="hub-empty">No alerts.</p>}
          </section>
          <WorkingNow items={data.working ?? legacyRunning(data)} blocked={data.needsYou} running={counts.running} now={new Date(data.at).getTime()} />
          {data.pc && <PcTile pc={data.pc} />}
        </div>
      </div>
    </div>
  )
}
