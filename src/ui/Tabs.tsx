import { host } from '../lib/host'
import { tabEntries } from '../lib/hubNav'
import type { NavId } from '../lib/route'
import Icon from './Icon'

/** The phone's bottom tabs: Today, Chat, Library, Projects, Search. Each is 44 px or more; the Needs count sits on Today. */
export default function Tabs({ lit, needsYou }: { lit: NavId | null; needsYou: number }) {
  return (
    <nav className="ui-tabs" aria-label="Main" data-tabs>
      {tabEntries(host).map(entry => (
        <a key={entry.nav} href={entry.hash} className={`ui-tab${lit === entry.nav ? ' on' : ''}`} aria-current={lit === entry.nav ? 'page' : undefined} data-nav={entry.nav}>
          <Icon name={entry.nav} size={23} />
          <span>{entry.label}</span>
          {entry.nav === 'today' && needsYou > 0 && <span className="ui-count" data-hub-badge role="img" aria-label={`${needsYou} need you`}>{needsYou}</span>}
        </a>
      ))}
    </nav>
  )
}
