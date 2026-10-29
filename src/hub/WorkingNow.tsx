import type { CSSProperties } from 'react'
import type { Item } from '../lib/hub'
import { appUrl as safeApp, sessionUrl } from '../lib/hub'
import type { WorkingItem } from '../lib/hubPc'
import { hubHash, mapHash } from '../lib/route'
import { AgentSprite } from './team/AgentSprite'
import { defaultSprite } from './team/sprites'
import { STATE_DOT, STATE_LABEL, duration } from './working'
import './working.css'

const SPRITE = defaultSprite('claude', 'Claude Code')

/** A needs-you row opens its blocked item; without a match it opens the list. */
function needsHref(item: WorkingItem, blocked: Item[]) {
  const match = blocked.find(entry => entry.kind === 'blocked' && entry.session === item.id)
  return hubHash('needs', match ? match.file ?? match.id : undefined)
}

function Row({ item, blocked, now }: { item: WorkingItem; blocked: Item[]; now: number }) {
  const link = sessionUrl(item.url) ?? safeApp(item.appUrl)
  const where = [item.project, item.branch].filter(Boolean).join(' · ')
  const since = duration(item.since, now)
  return (
    <div className={`wn-row wn-${item.state}`} data-working={item.state} data-source={item.source}>
      <span className="wn-sprite"><AgentSprite sprite={SPRITE} size={32} /></span>
      <span className="wn-text">
        <b>{item.state === 'needs-you' ? <a href={needsHref(item, blocked)}>{item.title}</a> : item.title}</b>
        <small>
          {where}
          {item.bead && <>{where ? ' · ' : ''}{item.project ? <a className="wn-bead" href={mapHash(item.project, item.bead)}>{item.bead}</a> : <span className="wn-bead">{item.bead}</span>}</>}
        </small>
      </span>
      <span className="wn-meta">
        <span className="wn-state"><span className={`dot st-${STATE_DOT[item.state]}${item.state === 'working' ? ' live' : ''}`} aria-hidden="true" />{STATE_LABEL[item.state]}</span>
        {since && <small>{since}</small>}
        {link && <a className="wn-open" href={link} target="_blank" rel="noopener noreferrer">Open session</a>}
      </span>
    </div>
  )
}

export default function WorkingNow({ items, blocked, running, now }: { items: WorkingItem[]; blocked: Item[]; running: number; now: number }) {
  const active = items.filter(item => item.state !== 'idle')
  const idle = items.filter(item => item.state === 'idle')
  return (
    <section className="hub-panel rise" style={{ '--i': 4 } as CSSProperties} aria-label="Working now">
      <h3><span className="dot st-working live" aria-hidden="true" />Working now <span>{running}</span></h3>
      {active.map(item => <Row key={item.id} item={item} blocked={blocked} now={now} />)}
      {idle.length > 0 && (
        <details className="wn-idle" data-working-idle>
          <summary>{idle.length} idle</summary>
          {idle.map(item => <Row key={item.id} item={item} blocked={blocked} now={now} />)}
        </details>
      )}
      {!items.length && <p className="hub-empty">Nothing is running.</p>}
    </section>
  )
}
