import type { MouseEvent } from 'react'
import { host } from '../lib/host'
import { tabEntries } from '../lib/hubNav'
import { parseHash, type NavId } from '../lib/route'
import { carryStateOnce, go, stepsBackTo } from '../lib/entries'
import Icon from './Icon'

/**
 * The Library tab from an open card goes back to the list as it was: to the Library entry this card was opened from (the filters, view,
 * search text, rows shown and scroll are kept against that entry), however many steps that is. With none behind (a link, a reload) it
 * opens the Library with the state it last had. From anywhere else it is the plain link.
 */
function leaveCard(event: MouseEvent<HTMLAnchorElement>, hash: string) {
  if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || !parseHash().id) return
  event.preventDefault()
  const steps = stepsBackTo(at => at === hash)
  if (!steps) { carryStateOnce(); go(hash); return }
  // A page inside a card's frame that navigated left extra entries in the history: the jump then lands in the frame, and the address
  // does not move. Then open the Library with the state it last had.
  // The jump has worked once the address changes (hashchange, or popstate on a path-routes host): then the fallback is off. Comparing the address
  // alone at 500 ms is not enough: a visit to the same card again within that time (Back, a link) would be taken for a jump that did not move.
  const start = window.location.hash
  const done = () => { window.clearTimeout(timer); window.removeEventListener('hashchange', moved); window.removeEventListener('popstate', moved) }
  const moved = () => { if (window.location.hash !== start) done() }
  const timer = window.setTimeout(() => { done(); if (window.location.hash === start) { carryStateOnce(); go(hash) } }, 500)
  window.addEventListener('hashchange', moved)
  window.addEventListener('popstate', moved)
  window.history.go(-steps)
}

/** The phone's bottom tabs: Today, Chat, Library, Projects, Search. Each is 44 px or more; the Needs count sits on Today. */
export default function Tabs({ lit, needsYou }: { lit: NavId | null; needsYou: number }) {
  return (
    <nav className="ui-tabs" aria-label="Main" data-tabs>
      {tabEntries(host).map(entry => (
        <a key={entry.nav} href={entry.hash} className={`ui-tab${lit === entry.nav ? ' on' : ''}`} aria-current={lit === entry.nav ? 'page' : undefined} data-nav={entry.nav}
          onClick={entry.nav === 'library' ? event => leaveCard(event, entry.hash) : undefined}>
          <Icon name={entry.nav} size={23} />
          <span>{entry.label}</span>
          {entry.nav === 'today' && needsYou > 0 && <span className="ui-count" data-hub-badge role="img" aria-label={`${needsYou} need you`}>{needsYou}</span>}
        </a>
      ))}
    </nav>
  )
}
