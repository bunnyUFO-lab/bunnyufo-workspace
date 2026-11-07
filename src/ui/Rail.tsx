import { Fragment } from 'react'
import { host } from '../lib/host'
import { navEntries } from '../lib/hubNav'
import type { NavId } from '../lib/route'
import BrandLogo from '../components/BrandLogo'
import Icon from './Icon'

const mac = () => /Mac|iPhone|iPad/.test(navigator.platform)

/** The desktop's left rail (900 px and up): the mockup's order. The Needs count sits on Today. */
export default function Rail({ lit, needsYou }: { lit: NavId | null; needsYou: number }) {
  const entries = navEntries(host)
  const item = (entry: (typeof entries)[number]) => (
    <a key={entry.nav} href={entry.hash} className={`ui-navitem${lit === entry.nav ? ' on' : ''}`} aria-current={lit === entry.nav ? 'page' : undefined} data-nav={entry.nav}>
      <Icon name={entry.nav} size={20} />
      <span>{entry.label}</span>
      {entry.nav === 'search' && <kbd>{mac() ? '⌘K' : 'Ctrl K'}</kbd>}
      {entry.nav === 'today' && needsYou > 0 && <span className="ui-count" data-hub-badge role="img" aria-label={`${needsYou} need you`}>{needsYou}</span>}
    </a>
  )
  // Top, work and foot are three groups in one list with a gap between: Sketch and Settings follow Team instead of sinking to the window's foot. A group a host lacks (no Hub: no work group) is left out, so two gaps never meet.
  const groups = (['top', 'work', 'foot'] as const).map(id => entries.filter(entry => entry.group === id)).filter(list => list.length)
  return (
    <nav className="ui-rail" aria-label="Main" data-rail>
      <div className="ui-brand"><BrandLogo size={30} animated={false} /><span>Workspace</span></div>
      {groups.map((list, at) => (
        <Fragment key={list[0].group}>
          {at > 0 && <div className="ui-railgap" />}
          {list.map(item)}
        </Fragment>
      ))}
    </nav>
  )
}
