import type { Item } from '../lib/hub'
import { ago } from '../lib/hub'
import { KIND_ICON, itemLabel, needsKind } from '../lib/needsKinds'
import { itemKey, itemPage, setFocus } from './needsFocus'
import { useHeld } from './heldSend'
import './today.css'

export const ICON_ARROW = '<path d="M5 12h14M13 6l6 6-6 6"/>'

export function Icon({ paths }: { paths: string }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" dangerouslySetInnerHTML={{ __html: paths }} />
}

const titleCase = (text: string) => text.replace(/[-_]+/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase())
const who = (item: Item) => item.by ?? titleCase(item.project ?? '')

/**
 * The `.nrow` rows of the Needs you panel (Today shows the first three, a project's page all of them). A row opens the item's own page,
 * or for an item with none (a blocked session) `href` with the item in focus. A row Undo just brought back flashes.
 */
export default function NeedsRows({ items, href, pages = false }: { items: Item[]; href: string; /** Today opens each item's own page; a project's page keeps the list with the item in focus. */ pages?: boolean }) {
  const held = useHeld()
  return (
    <>
      {items.map(item => {
        const kind = needsKind(item)
        return (
          <a key={itemKey(item)} className={`nrow${held.restored === itemKey(item) ? ' flash' : ''}`} href={(pages && itemPage(item)) || href} data-nrow={kind} onClick={() => setFocus(itemKey(item))}>
            <span className="kind"><Icon paths={KIND_ICON[kind]} /></span>
            <span className="nrow-text">
              <b>{item.title}</b>
              <small>{[itemLabel(item), who(item), ago(item.at)].filter(Boolean).join(' · ')}</small>
            </span>
            <span className="nrow-go"><Icon paths={ICON_ARROW} /></span>
          </a>
        )
      })}
    </>
  )
}
