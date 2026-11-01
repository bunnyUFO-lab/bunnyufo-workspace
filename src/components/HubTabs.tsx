import { useEffect, useState } from 'react'
import { host } from '../lib/host'
import { HUB_SHORT, chatNote, hubGroups, hubRows } from '../lib/hubNav'
import { homeLink, hubHash, type HubScreen } from '../lib/route'

/**
 * The tabs the phone's bar shows, then More. Team is listed ahead of its screen: it joins the bar when
 * `hubRows` offers it. The rest of the Hub (Sketch, Chat), Library and Search are under More, under the
 * same group headings as the sidebar.
 */
const TABS: string[] = ['today', 'needs', 'work', 'team', 'map']

/**
 * The Hub on a phone: a bottom bar, one tap from Home and from any Hub screen, so the menu does not
 * have to be opened. Hidden by the stylesheet above 640 px and by App while a card is open. It is small
 * and eager on purpose (the Hub screens are a lazy chunk); the rows come from lib/hubNav.
 */
export default function HubTabs({ screen, needsYou, onHome, onSearch }: { screen: HubScreen | null; needsYou: number; onHome: () => void; onSearch: () => void }) {
  const all = hubRows(host)
  const rows = all.filter(([key]) => TABS.includes(key))
  const more = all.filter(([key]) => !TABS.includes(key))
  const moreGroups = hubGroups(host)
    .map(group => ({ ...group, rows: group.rows.filter(([key]) => key === 'library' || !TABS.includes(key)) }))
    .filter(group => group.rows.length > 0)
  // The sheet is open for the screen it was opened on, so it shuts by itself on any move.
  const [openOn, setOpenOn] = useState<{ screen: HubScreen | null } | null>(null)
  const sheet = openOn !== null && openOn.screen === screen
  const setSheet = (next: boolean) => setOpenOn(next ? { screen } : null)
  // On Home (no screen) the Library is open, and it lives under More, so More is the lit tab there too.
  const inMore = screen === null || more.some(([key]) => key === screen)
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
          {key === 'needs' && needsYou > 0 && <span className="hub-tab-badge" data-hub-tab-badge>{needsYou}</span>}
        </a>
      ))}
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
          {moreGroups.map(group => (
            <div key={group.id} role="group" aria-labelledby={`hub-more-${group.id}`} data-hub-more-group={group.id}>
              <div className="hub-more-heading" id={`hub-more-${group.id}`}>{group.label}</div>
              {group.rows.map(([key, label, icon]) => key === 'library' ? (
                <a key={key} {...homeLink(() => { setOpenOn(null); onHome() })} role="menuitem" className={screen === null ? 'active' : undefined} aria-current={screen === null ? 'page' : undefined} data-hub-more="library">
                  <span aria-hidden="true">{icon}</span> Library
                </a>
              ) : (
                <a key={key} href={hubHash(key)} role="menuitem" className={screen === key ? 'active' : undefined} aria-current={screen === key ? 'page' : undefined} data-hub-more={key}>
                  <span aria-hidden="true">{icon}</span> {label}
                </a>
              ))}
            </div>
          ))}
          {chatNote(host) && <p className="hub-more-note" data-hub-chat-note>{chatNote(host)}</p>}
          <button type="button" role="menuitem" className="hub-more-search" data-hub-more-search onClick={() => { setOpenOn(null); onSearch() }}>
            <span aria-hidden="true">⌕</span> Search
          </button>
        </div>
      )}
    </nav>
  )
}
