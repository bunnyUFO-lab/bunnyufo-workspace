import { useState } from 'react'
import type { HubEvent, Item } from '../lib/hub'
import { ago, appUrl, safeUrl, sessionUrl } from '../lib/hub'
import { hubHash, reviewHash } from '../lib/route'
import { openRun } from './runStore'
import { useMarkDone } from './useMarkDone'

const EVENT_DOT: Record<string, string> = {
  'session-started': 'g', 'session-ended': 'g', blocked: 'y', 'ready-for-review': 'p', 'pr-opened': 'b', 'pr-merged': 'g',
  'ci-failed': 'r', 'ci-passed': 'g', deployed: 'b', 'ask-created': 'p', alert: 'r', 'review-done': 'g', resumed: 'g', 'checklist-created': 'p', 'checklist-submitted': 'g',
}

/** A plain click opens the run drawer; a modified click or a middle click is left to the browser (the request's own page). */
export function openFromClick(event: { button: number; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean; preventDefault: () => void }, id: string) {
  if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return
  event.preventDefault()
  openRun(id)
}

const KIND_LABEL: Record<string, string> = { ask: 'Ask', checklist: 'To do', request: 'Request', review: 'Review', blocked: 'Blocked', session: 'Running' }

const isGithub = (url: string) => { try { return new URL(url).hostname === 'github.com' } catch { return false } }

/** "Review on GitHub" for a pull request, "Open card" for a card of this site (its hash is a route), "Open link" otherwise. */
const linkLabel = (url: string) => {
  if (isGithub(url)) return 'Review on GitHub'
  try { return new URL(url).hash.startsWith('#/') ? 'Open card' : 'Open link' } catch { return 'Open link' }
}

/** The buttons of a review row: a link to the pull request, a link to the report, and Mark done. Each shows only when it can work. */
export function ReviewActions({ item, onDone, links = true }: { item: Item; onDone: () => void; links?: boolean }) {
  const url = safeUrl(item.url)
  const card = safeUrl(item.card)
  const { button, notes } = useMarkDone(item, onDone)
  return (
    <>
      <span className="hub-row-actions">
        {links && url && <a className="hub-btn" href={url} target="_blank" rel="noopener noreferrer">{linkLabel(url)}</a>}
        {links && card && <a className="hub-btn" href={card} target="_blank" rel="noopener noreferrer">Open report</a>}
        {button}
      </span>
      {notes}
    </>
  )
}

function ReviewRow({ item, meta }: { item: Item; meta: string }) {
  const [hidden, setHidden] = useState(false)
  if (hidden) return null
  return (
    <div className="hub-row review">
      <span className="hub-dot p" aria-hidden="true" />
      <a className="hub-row-text" href={reviewHash(item.id)} data-review-open>
        <span className="hub-row-title">{item.title}</span>
        <span className="hub-row-meta">{meta} <span className="hub-row-cue" aria-hidden="true">›</span></span>
      </a>
      <ReviewActions item={item} onDone={() => setHidden(true)} />
    </div>
  )
}

/** A blocked session: a button into the session when there is a real link, the desktop app's link where there is a desktop, and plain words otherwise. */
function BlockedRow({ item, meta }: { item: Item; meta: string }) {
  const [hidden, setHidden] = useState(false)
  const link = sessionUrl(item.url)
  const desk = appUrl(item.appUrl)
  const { button, notes } = useMarkDone(item, () => setHidden(true))
  if (hidden) return null
  return (
    <div className="hub-row" data-blocked>
      <span className="hub-dot y" aria-hidden="true" />
      <span className="hub-row-text">
        <span className="hub-row-title">{item.title}</span>
        <span className="hub-row-meta">{meta}</span>
      </span>
      <span className="hub-row-actions">
        {link && <a className="hub-btn pri" href={link} target="_blank" rel="noopener noreferrer" data-link="session">Open the session</a>}
        {desk && <a className="hub-btn hub-desk" href={desk} data-link="app">Open in the desktop app</a>}
        {!link && <span className="hub-muted" data-blocked-hint>{item.host ? `Open the Claude app on ${item.host}` : 'Open the Claude app'}</span>}
        {item.file && button}
      </span>
      {item.file && notes}
    </div>
  )
}

/** One row for an Item (a thing that needs you or runs) or a HubEvent (a thing that happened). */
export default function ItemRow({ item, event }: { item?: Item; event?: HubEvent }) {
  if (item) {
    const progress = item.kind === 'checklist' ? [`${item.done ?? 0} of ${item.total ?? 0}`, item.state === 'submitted' ? 'submitted' : item.state === 'picked-up' ? 'picked up' : ''].filter(Boolean).join(' · ') : ''
    const state = item.kind === 'checklist' ? progress : item.kind === 'ask' ? (item.state ?? 'open').replace('-', ' ') : item.kind === 'request' ? (item.state === 'taken' ? `taken as ${item.bead ?? 'a task'}` : 'open') : ''
    const meta = [KIND_LABEL[item.kind], item.project, state, item.kind === 'blocked' && item.host ? item.host : '', ago(item.at)].filter(Boolean).join(' · ')
    if (item.kind === 'review') return <ReviewRow item={item} meta={meta} />
    if (item.kind === 'blocked') return <BlockedRow item={item} meta={meta} />
    const body = (
      <>
        <span className={`hub-dot ${item.kind === 'session' ? 'g' : 'p'}`} aria-hidden="true" />
        <span className="hub-row-text">
          <span className="hub-row-title">{item.title}</span>
          <span className="hub-row-meta">{meta}</span>
        </span>
        {(item.kind === 'ask' || item.kind === 'checklist') && <span className="hub-btn pri">Open</span>}
      </>
    )
    if (item.kind === 'ask') return <a className="hub-row click" href={hubHash('ask', item.id)}>{body}</a>
    if (item.kind === 'checklist') return <a className="hub-row click" href={hubHash('checklist', item.id)} data-checklist-open>{body}</a>
    if (item.kind === 'request') return <a className="hub-row click" href={hubHash('request', item.id)} onClick={event => openFromClick(event, item.id)} data-request-open={item.id}>{body}</a>
    return <div className="hub-row">{body}</div>
  }
  if (!event) return null
  const meta = [event.kind.replace(/-/g, ' '), event.project, event.host].filter(Boolean).join(' · ')
  const body = (
    <>
      <span className={`hub-dot ${EVENT_DOT[event.kind] ?? 'b'}`} aria-hidden="true" />
      <span className="hub-row-text">
        <span className="hub-row-title">{event.title}</span>
        <span className="hub-row-meta">{meta}</span>
      </span>
      <span className="hub-row-time">{new Date(event.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
    </>
  )
  const eventLink = event.kind === 'blocked' ? sessionUrl(event.url) : safeUrl(event.url)
  return eventLink
    ? <a className="hub-row click" href={eventLink} target="_blank" rel="noopener noreferrer">{body}</a>
    : <div className="hub-row">{body}</div>
}
