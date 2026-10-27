import type { HubEvent, Item } from '../lib/hub'
import { ago, safeUrl } from '../lib/hub'
import { hubHash } from '../lib/route'

const EVENT_DOT: Record<string, string> = {
  'session-started': 'g', 'session-ended': 'g', blocked: 'y', 'ready-for-review': 'p', 'pr-opened': 'b', 'pr-merged': 'g',
  'ci-failed': 'r', 'ci-passed': 'g', deployed: 'b', 'ask-created': 'p', alert: 'r',
}

const KIND_LABEL: Record<string, string> = { ask: 'Ask', request: 'Request', review: 'Review', blocked: 'Blocked', session: 'Running' }

/** One row for an Item (a thing that needs you or runs) or a HubEvent (a thing that happened). */
export default function ItemRow({ item, event }: { item?: Item; event?: HubEvent }) {
  if (item) {
    const state = item.kind === 'ask' ? (item.state ?? 'open').replace('-', ' ') : item.kind === 'request' ? (item.state === 'taken' ? `taken as ${item.bead ?? 'a task'}` : 'open') : ''
    const meta = [KIND_LABEL[item.kind], item.project, state, item.kind === 'blocked' && item.host ? item.host : '', ago(item.at)].filter(Boolean).join(' · ')
    const body = (
      <>
        <span className={`hub-dot ${item.kind === 'session' ? 'g' : item.kind === 'blocked' ? 'y' : 'p'}`} aria-hidden="true" />
        <span className="hub-row-text">
          <span className="hub-row-title">{item.title}</span>
          <span className="hub-row-meta">{meta}</span>
        </span>
        {item.kind === 'ask' && <span className="hub-btn pri">Open</span>}
        {item.kind === 'review' && <span className="hub-btn">Review on GitHub</span>}
        {item.kind === 'blocked' && <span className="hub-btn">Answer in the Claude app</span>}
      </>
    )
    if (item.kind === 'ask') return <a className="hub-row click" href={hubHash('ask', item.id)}>{body}</a>
    const link = safeUrl(item.url)
    if ((item.kind === 'review' || item.kind === 'blocked') && link) return <a className="hub-row click" href={link} target="_blank" rel="noopener noreferrer">{body}</a>
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
  const eventLink = safeUrl(event.url)
  return eventLink
    ? <a className="hub-row click" href={eventLink} target="_blank" rel="noopener noreferrer">{body}</a>
    : <div className="hub-row">{body}</div>
}
