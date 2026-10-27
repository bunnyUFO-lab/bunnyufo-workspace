/**
 * Which workspace the published site is showing.
 *
 * The local app reads the user's registry through its service. A published site asks its data service instead:
 * `/sites.json` lists the sections the cards bucket holds, and each one's files are served under its own base
 * (`/w/<id>/…`), straight from the bucket. The first path segment picks the active one, so `/magic-loops` and
 * `/bunnylink` are ordinary links and the browser's back button works.
 *
 * Without `/sites.json` nothing changes: one workspace served at `/workspace/…`, exactly as before. That is the
 * local preview (`npm run dev`) and any site published before this existed.
 */
export interface Site {
  /** Short id, and the first path segment: "magic-loops". */
  id: string
  /** Shown in the switcher: "Magic Loops". */
  name: string
  /** Where this workspace's files are served, without a trailing slash: "/w/magic-loops-workspace". */
  base: string
  /** A repository and ref, for a section that still keeps one; a bucket-served section has neither. */
  repo?: string
  /** Where this workspace sits inside that repository: "sections/agent-plans". Empty or absent
   * when it is the repository's root, which is how every workspace was published before sections. */
  path?: string
  branch?: string
  sha?: string
  /** When the section's card list was last uploaded. */
  publishedAt?: string
  /** Holds data, not cards (the inbox): served, but never listed in the switcher or picked as the default. */
  hidden?: boolean
}

export interface Sites {
  sites: Site[]
  active: Site | null
  /** A first path segment no published workspace claims, e.g. /sprite-studio before it was listed. */
  unknownId: string | null
}

const FALLBACK: Sites = { sites: [], active: null, unknownId: null }
let loaded: Promise<Sites> | null = null

/** The first path segment, or "" at the root. */
export function pathId(pathname = window.location.pathname) {
  return decodeURIComponent(pathname.split('/').filter(Boolean)[0] || '')
}

/** Loaded once per page: the site list never changes without a publish. */
export function sites(): Promise<Sites> {
  loaded ??= (async () => {
    try {
      const res = await fetch('/sites.json', { cache: 'no-store' })
      if (!res.ok) return FALLBACK
      const list = (await res.json()) as Site[]
      if (!Array.isArray(list) || !list.length) return FALLBACK
      const id = pathId()
      const match = list.find(s => s.id === id)
      // Say so rather than quietly showing a different workspace: an id that is not in the list means
      // that workspace has not published here yet, and its cards are not the ones on screen.
      if (id && !match) return { sites: list, active: null, unknownId: id }
      return { sites: list, active: match ?? list.find(s => !s.hidden) ?? list[0], unknownId: null }   // no id at all: the root shows the first visible one
    } catch {
      return FALLBACK                                  // no list published: single-workspace site
    }
  })()
  return loaded
}

/**
 * Where this page's workspace files live. Resolved before the app renders (see main.tsx) so that everything after
 * it can stay synchronous — card URLs are built in a lot of places.
 */
export let contentBase = '/workspace'
export let activeSite: Site | null = null
export let allSites: Site[] = []
/** Set when the address names a workspace this site does not serve; the app shows that instead of cards. */
export let unknownSiteId: string | null = null

export async function resolveSite() {
  const { sites: list, active, unknownId } = await sites()
  allSites = list.filter(site => !site.hidden)
  activeSite = active
  unknownSiteId = unknownId
  if (active) contentBase = active.base
  return active
}

/** The address of a workspace on this site, for the switcher's links. */
export const siteHref = (site: Site) => `/${site.id}`

/**
 * The path for a project filter: `/magic-loops`, or `/` for every project. The filter is the
 * first path segment on a published site, so a filtered view can be linked and the back
 * button moves between them.
 */
export const projectPath = (id: string) => (id ? `/${encodeURIComponent(id)}` : '/')
