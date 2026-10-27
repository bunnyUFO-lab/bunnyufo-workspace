import { useState } from 'react'
import type { HubEvent, Item } from '../lib/hub'
import { ago, appUrl, hubPost, safeUrl, sessionUrl } from '../lib/hub'
import { host } from '../lib/host'
import { hubHash } from '../lib/route'

const EVENT_DOT: Record<string, string> = {
  'session-started': 'g', 'session-ended': 'g', blocked: 'y', 'ready-for-review': 'p', 'pr-opened': 'b', 'pr-merged': 'g',
  'ci-failed': 'r', 'ci-passed': 'g', deployed: 'b', 'ask-created': 'p', alert: 'r', 'review-done': 'g', resumed: 'g',
}

const KIND_LABEL: Record<string, string> = { ask: 'Ask', request: 'Request', review: 'Review', blocked: 'Blocked', session: 'Running' }

const isGithub = (url: string) => { try { return new URL(url).hostname === 'github.com' } catch { return false } }

/** The buttons of a review row: a link to the pull request, a link to the report, and Mark done. Each shows only when it can work. */
function ReviewActions({ item, onDone }: { item: Item; onDone: () => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [note, setNote] = useState(false)
  const url = safeUrl(item.url)
  const card = safeUrl(item.card)
  async function done() {
    if (!host.write) { setNote(true); return }
    setBusy(true)
    setError('')
    try {
      await hubPost(`/reviews/${encodeURIComponent(item.id)}/done`)
      onDone()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not mark this done.')
      setBusy(false)
    }
  }
  return (
    <>
      <span className="hub-row-actions">
        {url && <a className="hub-btn" href={url} target="_blank" rel="noopener noreferrer">{isGithub(url) ? 'Review on GitHub' : 'Open link'}</a>}
        {card && <a className="hub-btn" href={card} target="_blank" rel="noopener noreferrer">Open report</a>}
        <button type="button" className="hub-btn pri" disabled={busy} aria-disabled={host.write ? undefined : 'true'} onClick={done}>Mark done</button>
      </span>
      {error && <p className="hub-error" role="alert">{error}</p>}
      {note && <p className="hub-muted" data-readonly-note>Sign in to mark this done.</p>}
    </>
  )
}

function ReviewRow({ item, meta }: { item: Item; meta: string }) {
  const [hidden, setHidden] = useState(false)
  if (hidden) return null
  return (
    <div className="hub-row review">
      <span className="hub-dot p" aria-hidden="true" />
      <span className="hub-row-text">
        <span className="hub-row-title">{item.title}</span>
        <span className="hub-row-meta">{meta}</span>
      </span>
      <ReviewActions item={item} onDone={() => setHidden(true)} />
    </div>
  )
}

/** A blocked session: a button into the session when there is a real link, the desktop app's link where there is a desktop, and plain words otherwise. */
function BlockedRow({ item, meta }: { item: Item; meta: string }) {
  const link = sessionUrl(item.url)
  const desk = appUrl(item.appUrl)
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
      </span>
    </div>
  )
}

/** One row for an Item (a thing that needs you or runs) or a HubEvent (a thing that happened). */
export default function ItemRow({ item, event }: { item?: Item; event?: HubEvent }) {
  if (item) {
    const state = item.kind === 'ask' ? (item.state ?? 'open').replace('-', ' ') : item.kind === 'request' ? (item.state === 'taken' ? `taken as ${item.bead ?? 'a task'}` : 'open') : ''
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
        {item.kind === 'ask' && <span className="hub-btn pri">Open</span>}
      </>
    )
    if (item.kind === 'ask') return <a className="hub-row click" href={hubHash('ask', item.id)}>{body}</a>
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
