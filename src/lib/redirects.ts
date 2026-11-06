// Old addresses and wrong ones, mapped to the address that shows the right screen. Pure: no `window`, so a node test covers
// the whole table. The caller rewrites with `swap` (lib/entries), which adds no history entry.
import { HUB_ALIASES, HUB_SCREENS } from './route.ts'
import { withoutOverlay } from './entries.ts'

export interface RedirectInput {
  pathname: string
  /** `location.hash`, with its `#`, or ''. */
  hash: string
  /** The host has a Hub (lib/host). */
  hub: boolean
  routes: 'hash' | 'path'
  /** The first render of the page, where an empty address means "the home screen" rather than "Back to the cards". */
  first?: boolean
  /** A sheet is open in memory. A `/~o` tail with none (a reload) is dropped. */
  overlayOpen?: boolean
}

const TODAY = '#/~hub/today'
const LIBRARY = '#/~hub/library'
const SCREENS: readonly string[] = HUB_SCREENS

/**
 * The address to rewrite to, or null when this one stands. A string is a hash (`#/~hub/today`), or a path and a hash
 * (`/<section>#/~hub/library`) where the path changes too.
 */
export function canonicalAddress(input: RedirectInput): string | null {
  const { pathname, hub, routes, first = false, overlayOpen = false } = input
  const tail = /(?:\/~o)+$/.exec(input.hash)?.[0] ?? ''
  const keepTail = tail && overlayOpen ? tail : ''
  const hash = withoutOverlay(input.hash)
  const dropped = tail !== keepTail
  const result = (value: string) => value + keepTail

  if (!hash || hash === '#' || hash === '#/') {
    if (!hub) return dropped ? (hash || '#/') : null
    const section = routes === 'path' && pathname.split('/').some(Boolean)
    // A section's own page, filtered: the Library with that chip on. The root is Today, where nothing asked for the cards.
    if (section) return `${pathname}${LIBRARY}`
    return first && !hash ? result(TODAY) : result(LIBRARY)
  }

  const match = /^#\/?~hub(?:\/([^/?#]*))?(?:\/(.*))?$/.exec(hash)
  if (match) {
    const raw = match[1] ?? ''
    const rest = match[2] ?? ''
    const screen = Object.prototype.hasOwnProperty.call(HUB_ALIASES, raw) ? HUB_ALIASES[raw] : raw
    if (!SCREENS.includes(screen)) return result(TODAY)
    const tailPath = rest ? `/${rest}` : ''
    if (screen === 'map' && !rest) return result('#/~hub/project')
    if (screen === 'project') {
      const [id, tab, ...more] = rest.split('/')
      if (id && (tab === 'running' || tab === 'needs')) return result(`#/~hub/project/${id}/work${more.length ? `/${more.join('/')}` : ''}`)
      if (id && tab === 'library') return result(`#/~hub/project/${id}/cards${more.length ? `/${more.join('/')}` : ''}`)
    }
    const next = `#/~hub/${screen}${tailPath}`
    return next !== hash || dropped ? result(next) : null
  }

  return dropped ? hash : null
}
