import type { Item } from '../lib/hub'
import { hubHash, reviewHash } from '../lib/route'

// The item a screen should open on: Today's rows set it, the Needs you list takes it once the list has loaded.
// The key is `<item.kind>-<item.id>`, the same one the list uses for its cards.
let key = ''
export const setFocus = (value: string) => { key = value }
export const takeFocus = () => { const value = key; key = ''; return value }

/** The key of an item's card in the list, and of the card a screen should open on. */
export const itemKey = (item: Item) => `${item.kind}-${item.id}`

/** The page of an item that has one of its own. */
export function itemPage(item: Item): string | undefined {
  if (item.kind === 'ask') return hubHash('ask', item.id)
  if (item.kind === 'checklist') return hubHash('checklist', item.id)
  if (item.kind === 'review') return reviewHash(item.id)
  return undefined
}
