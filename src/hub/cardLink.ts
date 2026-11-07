// A link in a reply that points at a card on this site. Pure, so node --test can import it.

const NOT_A_SECTION = new Set(['w', 'api', 'assets'])
// The SAFE_CARD shape, tightened to refuse "~" (hub routes and the overlay; card ids cannot hold it), with an optional step number.
const CARD_HASH = /^#\/[\w%.-]+(?:\/\d+)?$/

/**
 * The card a link opens, when it is one on this page's site: `/<section>#/<card>` or `/<section>#/<card>/<step>`.
 * `href` comes back relative, so the local app can explain that a section cannot be opened there. Null for anything else.
 */
export function cardLinkOf(href: string | undefined, pageHref: string): { href: string; card: string } | null {
  if (!href) return null
  let url: URL
  let page: URL
  try { url = new URL(href, pageHref); page = new URL(pageHref) } catch { return null }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (url.origin !== page.origin) return null
  if (url.username || url.password || url.search) return null
  if (!/^\/[a-z0-9-]+$/i.test(url.pathname) || NOT_A_SECTION.has(url.pathname.slice(1).toLowerCase())) return null
  if (!CARD_HASH.test(url.hash)) return null
  let card: string
  try { card = decodeURIComponent(url.hash.slice(2).split('/')[0]) } catch { return null }
  return { href: url.pathname + url.hash, card }
}
