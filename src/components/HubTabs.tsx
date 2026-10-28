import { useEffect, useState } from 'react'
import { host } from '../lib/host'
import { HUB_SHORT, hubRows } from '../lib/hubNav'
import { hubHash, type HubScreen } from '../lib/route'

/** The tabs the phone's bar shows, six at most with Cards and More. The rest of the Hub (Board, Activity, Sketch) is under More. */
const TABS: HubScreen[] = ['today', 'inbox', 'map', 'chat']

/**
 * The Hub on a phone: a bottom bar, one tap from Home and from any Hub screen, so the menu does not
 * have to be opened. Hidden by the stylesheet above 640 px and by App while a card is open. It is small
 * and eager on purpose (the Hub screens are a lazy chunk); the rows come from lib/hubNav.
 */
export default function HubTabs({ screen, needsYou, onHome }: { screen: HubScreen | null; needsYou: number; onHome: () => void }) {
  const all = hubRows(host)
  const rows = all.filter(([key]) => TABS.includes(key))
  const more = all.filter(([key]) => !TABS.includes(key))
  // The sheet is open for the screen it was opened on, so it shuts by itself on any move.
  const [openOn, setOpenOn] = useState<{ screen: HubScreen | null } | null>(null)
  const sheet = openOn !== null && openOn.screen === screen
  const setSheet = (next: boolean) => setOpenOn(next ? { screen } : null)
  const inMore = screen !== null && more.some(([key]) => key === screen)
  useEffect(() => {
    if (!sheet) return undefined
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpenOn(null) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [sheet])
  return (
    <nav className="hub-tabs" aria-label="Hub">
      {rows.map(([key, label, icon]) => (
        <a key={key} href={hubHash(key)} className={`hub-tab${screen === key ? ' active' : ''}`} aria-current={screen === key ? 'page' : undefined} data-hub-tab={key}>
          <span className="hub-tab-icon" aria-hidden="true">{icon}</span>
          <span className="hub-tab-label">{HUB_SHORT[key] ?? label}</span>
          {key === 'inbox' && needsYou > 0 && <span className="hub-tab-badge" data-hub-tab-badge>{needsYou}</span>}
        </a>
      ))}
      <a
        href={window.location.pathname + window.location.search}
        className={`hub-tab${screen === null ? ' active' : ''}`}
        aria-current={screen === null ? 'page' : undefined}
        data-hub-tab="cards"
        onClick={event => { event.preventDefault(); onHome() }}
      >
        <span className="hub-tab-icon" aria-hidden="true">▤</span>
        <span className="hub-tab-label">Cards</span>
      </a>
      <button
        type="button"
        className={`hub-tab${inMore ? ' active' : ''}`}
        aria-expanded={sheet}
        aria-haspopup="true"
        data-hub-tab="more"
        onClick={() => setSheet(!sheet)}
      >
        <span className="hub-tab-icon" aria-hidden="true">⋯</span>
        <span className="hub-tab-label">More</span>
      </button>
      {sheet && (
        <div className="hub-more" role="menu" aria-label="More of the Hub">
          {more.map(([key, label, icon]) => (
            <a key={key} href={hubHash(key)} role="menuitem" className={screen === key ? 'active' : undefined} aria-current={screen === key ? 'page' : undefined} data-hub-more={key}>
              <span aria-hidden="true">{icon}</span> {label}
            </a>
          ))}
        </div>
      )}
    </nav>
  )
}
