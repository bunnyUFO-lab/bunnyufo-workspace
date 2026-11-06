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
  const group = (id: 'top' | 'work' | 'foot') => entries.filter(entry => entry.group === id).map(item)
  return (
    <nav className="ui-rail" aria-label="Main" data-rail>
      <div className="ui-brand"><BrandLogo size={30} animated={false} /><span>Workspace</span></div>
      {group('top')}
      <div className="ui-railgap" />
      {group('work')}
      <div className="ui-railfoot">{group('foot')}</div>
    </nav>
  )
}
