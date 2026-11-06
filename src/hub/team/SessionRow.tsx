import { ago, appUrl, sessionUrl } from '../../lib/hub'
import type { WorkingItem } from '../../lib/hubPc'

const bare = (text: string) => text.replace(/ ago$/, '')
const SESSION_STATE = { working: 'Working', 'needs-you': 'Needs you', stopping: 'Stopping', idle: 'Idle', stale: 'No word' } as const

/** A Claude Code session, compact: state, title, where it runs, and a link to open it. */
export default function SessionRow({ item }: { item: WorkingItem }) {
  const link = sessionUrl(item.url) ?? appUrl(item.appUrl)
  const where = [item.project, item.branch].filter(Boolean).join(' · ')
  const body = (
    <>
      <span className={`dot st-${item.state === 'needs-you' ? 'needs' : item.state === 'stopping' ? 'working' : item.state === 'stale' ? 'idle' : item.state}`} aria-hidden="true" />
      <span className="team-session-text">
        <b>{item.title}</b>
        <small>{[where, SESSION_STATE[item.state], `for ${bare(ago(item.since))}`].filter(Boolean).join(' · ')}</small>
      </span>
    </>
  )
  return link
    ? <li><a className="team-session" href={link} target={link.startsWith('http') ? '_blank' : undefined} rel="noopener noreferrer" aria-label={`Open session: ${item.title}`}>{body}</a></li>
    : <li><span className="team-session">{body}</span></li>
}
