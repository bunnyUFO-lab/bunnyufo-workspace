import type { CSSProperties } from 'react'
import type { Item } from '../lib/hub'
import { appUrl as safeApp, sessionUrl } from '../lib/hub'
import type { WorkingItem } from '../lib/hubPc'
import { hubHash, mapHash } from '../lib/route'
import { AgentSprite } from './team/AgentSprite'
import { defaultSprite } from './team/sprites'
import { stateOf } from './team/spriteState'
import { openFromClick } from './ItemRow'
import { RUNNER_LABEL, STATE_DOT, duration, presetLabel, runStateLabel } from './working'
import './working.css'

const SPRITE = defaultSprite('claude', 'Claude Code')
const HERMES_SPRITE = defaultSprite('hermes', 'Hermes')

/** A needs-you row opens its blocked item; without a match it opens the list. */
function needsHref(item: WorkingItem, blocked: Item[]) {
  const match = blocked.find(entry => entry.kind === 'blocked' && entry.session === item.id)
  return hubHash('needs', match ? match.file ?? match.id : undefined)
}

function Row({ item, blocked, now }: { item: WorkingItem; blocked: Item[]; now: number }) {
  const link = sessionUrl(item.url) ?? safeApp(item.appUrl)
  const where = [item.project, item.branch].filter(Boolean).join(' · ')
  const stale = item.state === 'stale'
  const since = stale ? '' : duration(item.since, now)
  const isRun = item.source === 'run'
  const runHref = item.request ? hubHash('request', item.request) : ''
  const sprite = item.agent === 'hermes' ? HERMES_SPRITE : SPRITE
  const name = item.agent === 'hermes' ? 'Hermes' : 'Claude Code'
  const what = isRun ? [item.preset ? presetLabel(item.preset) : '', item.project].filter(Boolean).join(' · ') : where
  const title = item.state === 'needs-you' && !isRun
    ? <a href={needsHref(item, blocked)}>{item.title}</a>
    : runHref && isRun ? <a href={runHref} onClick={event => openFromClick(event, item.request as string)} data-run-open={item.request}>{item.title}</a> : item.title
  return (
    <div className={`wn-row wn-${item.state}`} data-working={item.state} data-source={item.source}>
      <span className="wn-sprite"><AgentSprite sprite={sprite} size={32} name={name} state={stateOf({ status: item.state === 'idle' || item.state === 'stale' ? 'idle' : item.state === 'stopping' ? 'working' : item.state, now })} /></span>
      <span className="wn-text">
        <b>{title}</b>
        <small>
          {what}
          {item.bead && <>{what ? ' · ' : ''}{item.project ? <a className="wn-bead" href={mapHash(item.project, item.bead)}>{item.bead}</a> : <span className="wn-bead">{item.bead}</span>}</>}
        </small>
      </span>
      <span className="wn-meta">
        <span className="wn-state"><span className={`dot st-${STATE_DOT[item.state]}${item.state === 'working' ? ' live' : ''}`} aria-hidden="true" />{runStateLabel(item, now)}</span>
        {item.runner && <span className="wn-runner" data-runner={item.runner}>{RUNNER_LABEL[item.runner]}</span>}
        {since && <small>{since}</small>}
        {!isRun && item.request && <a className="wn-open" href={runHref} onClick={event => openFromClick(event, item.request as string)} data-run-open={item.request}>Open run</a>}
        {link && <a className="wn-open" href={link} target="_blank" rel="noopener noreferrer">Open session</a>}
      </span>
    </div>
  )
}

export default function WorkingNow({ items, blocked, running, now }: { items: WorkingItem[]; blocked: Item[]; running: number; now: number }) {
  const active = items.filter(item => item.state !== 'idle' && item.state !== 'stale')
  const stale = items.filter(item => item.state === 'stale')
  const idle = items.filter(item => item.state === 'idle')
  return (
    <section className="hub-panel rise" style={{ '--i': 4 } as CSSProperties} aria-label="Working now">
      <h3><span className="dot st-working live" aria-hidden="true" />Working now <span>{running}</span></h3>
      {active.map(item => <Row key={item.id} item={item} blocked={blocked} now={now} />)}
      {stale.map(item => <Row key={item.id} item={item} blocked={blocked} now={now} />)}
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
