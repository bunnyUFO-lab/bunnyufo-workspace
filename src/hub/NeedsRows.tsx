import type { Item } from '../lib/hub'
import { ago } from '../lib/hub'
import { KIND_ICON, itemLabel, needsKind } from '../lib/needsKinds'
import { itemKey, setFocus } from './needsFocus'
import './today.css'

export const ICON_ARROW = '<path d="M5 12h14M13 6l6 6-6 6"/>'

export function Icon({ paths }: { paths: string }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" dangerouslySetInnerHTML={{ __html: paths }} />
}

const titleCase = (text: string) => text.replace(/[-_]+/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase())
const who = (item: Item) => item.by ?? titleCase(item.project ?? '')

/** The `.nrow` rows of the Needs you panel (Today shows the first three, a project's page all of them). A row opens `href` and flashes its item there. */
export default function NeedsRows({ items, href }: { items: Item[]; href: string }) {
  return (
    <>
      {items.map(item => {
        const kind = needsKind(item)
        return (
          <a key={itemKey(item)} className="nrow" href={href} data-nrow={kind} onClick={() => setFocus(itemKey(item))}>
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
