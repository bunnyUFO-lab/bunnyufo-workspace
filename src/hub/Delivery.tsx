import { ago, type AskDelivery } from '../lib/hub'
import { text } from './askAnswer'

const HOW: Record<string, string> = {
  woke: 'woke it',
  turn: 'during its work',
  'next-session': "at the next session's start",
  start: "at the next session's start",
  prompt: 'when you typed',
}

/** Where the answer went, as the session's own mod reported it ("reported by <host>": these files are not the owner's). */
/** `noun` is what was answered: 'Ask' or 'checklist'. */
export default function Delivery({ noun, project, delivery }: { noun: string; project: string; delivery: AskDelivery }) {
  // A start or next-session hand-over has no watch file, so the folder can be unknown.
  const folder = text(delivery.folder)
  const who = folder ? `session ${folder}` : 'an agent session'
  const host = text(delivery.host)
  const on = host ? ` on ${host}` : ''
  const link = text(delivery.appUrl) || text(delivery.url)
  let body
  if (delivery.state === 'delivered') {
    body = <>Reached {who}{on} {typeof delivery.at === 'string' ? ago(delivery.at) : ''}: {HOW[delivery.how ?? ''] ?? 'delivered'}.</>
  } else if (delivery.state === 'watching') {
    body = <>{folder ? 'Session' : 'An agent session'}{folder && ` ${folder}`}{on} is watching; it checks every minute.{link && <> <a className="hub-btn" href={link} data-delivery-open>Open the session</a></>}</>
  } else if (delivery.state === 'stale') {
    body = <>Not delivered after {delivery.minutes ?? 0} minutes. The session may be closed. Open it, or start a session in {folder || 'its repository'}: it gets the answer at its start.{link && <> <a className="hub-btn" href={link} data-delivery-open>Open the session</a></>}</>
  } else {
    body = <>No session is watching this {noun}. The next session in project {text(project)} gets it when it starts.</>
  }
  return <p className="hub-muted hub-delivery" data-delivery={delivery.state} title="Reported by the session's computer, not by you">{body}{host && delivery.state !== 'none' && <span className="hub-delivery-by"> (reported by {host})</span>}</p>
}
