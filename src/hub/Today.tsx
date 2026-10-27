import { useContext } from 'react'
import type { Today as TodayData } from '../lib/hub'
import { clock } from '../lib/hub'
import { hubHash } from '../lib/route'
import ItemRow from './ItemRow'
import { TodayContext, useHubData } from './useHub'

export default function Today() {
  const shared = useContext(TodayContext)
  const own = useHubData<TodayData>(shared ? null : '/today')
  const { data, error, reload, at, loading } = shared ?? own
  if (!data) return <p className="hub-empty">{error ?? (loading ? 'Loading…' : '')}</p>
  const { counts } = data
  const tiles: [string, number, string, string][] = [
    ['needs-you', counts.needsYou, 'need you', hubHash('inbox')],
    ['running', counts.running, 'running', hubHash('activity')],
    ['recent', counts.recent, 'since yesterday', hubHash('activity')],
    ['alerts', counts.alerts, 'alerts', hubHash('activity', 'alerts')],
  ]
  return (
    <>
      <div className="hub-top">
        <h2>Today</h2>
        <span className="hub-muted">Updated {at ? clock(at.toISOString()) : ''} <button type="button" className="hub-btn" onClick={reload} aria-label="Refresh">↻</button></span>
      </div>
      {error && <p className="hub-error" role="alert">{error}</p>}
      <div className="hub-kpis">
        {tiles.map(([key, value, label, href]) => (
          <a key={key} className="hub-kpi" href={href} data-kpi={key}><span className="hub-kpi-v">{value}</span><span className="hub-muted">{label}</span></a>
        ))}
      </div>
      <div className="hub-panels">
        <section className="hub-panel" aria-label="Needs you">
          <h3>Needs you <span>{counts.needsYou}</span></h3>
          {data.needsYou.length ? data.needsYou.map(item => <ItemRow key={`${item.kind}-${item.id}`} item={item} />) : <p className="hub-empty">Nothing is waiting for you.</p>}
        </section>
        <section className="hub-panel" aria-label="Running">
          <h3>Running <span>{counts.running}</span></h3>
          {data.running.length ? data.running.map(item => (
            <ItemRow key={item.id} item={{ ...item, title: `${item.project ?? 'session'} · running since ${clock(item.at)}` }} />
          )) : <p className="hub-empty">No agent session is running.</p>}
        </section>
      </div>
      <section className="hub-panel" aria-label="Since yesterday">
        <h3>Since yesterday <span>{counts.recent}</span></h3>
        {data.recent.length ? data.recent.slice(0, 20).map(event => <ItemRow key={event.file} event={event} />) : <p className="hub-empty">Nothing has happened in the last 24 hours.</p>}
      </section>
    </>
  )
}
