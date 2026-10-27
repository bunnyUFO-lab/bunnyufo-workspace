// Where the page on screen lives outside the app: its source on the forge, its path on this
// disk, and the same card on the published site. All three follow the card's own workspace,
// because the grid holds cards from every workspace at once.
import type { WorkspaceCard } from '../types'
import { entityHash } from './route'

/** A browsable https URL from either form a repo is stored in (https or git@host:owner/repo). */
function repoWebUrl(repo: string | null | undefined): string | null {
  if (!repo) return null
  const ssh = /^git@([^:]+):(.+?)(?:\.git)?$/.exec(repo.trim())
  const url = (ssh ? `https://${ssh[1]}/${ssh[2]}` : repo.trim().replace(/\.git$/, '')).replace(/\/+$/, '')
  return /^https?:\/\//.test(url) ? url : null
}

/**
 * The card file on the forge, for a workspace that still keeps one. The local app takes the repo
 * from the registry, a published site from its own entry in sites.json. Null when the card's
 * workspace has no repo — the starter examples, and any workspace that publishes to the bucket
 * alone, which is the usual case now.
 */
export function repoFileUrl(card: WorkspaceCard, file: string): string | null {
  const repo = repoWebUrl(card.workspace.repo)
  if (!repo || !file) return null
  // HEAD follows the repository's default branch, which is all the registry knows.
  const ref = card.workspace.branch || 'HEAD'
  // Workspaces are no longer one per repository: several sections share one, each in its own
  // folder, so the card's folder alone pointed at a path that is not in the repository at all.
  const inside = (card.workspace.repoPath ?? '').replace(/^\/+|\/+$/g, '')
  const path = [...(inside ? inside.split('/') : []), ...`${card.folder}/${file}`.split('/')]
    .map(encodeURIComponent)
    .join('/')
  return `${repo}/blob/${ref}/${path}`
}

/** The same card on the published site. Local app only: on a site you are already looking at it. */
export function publishedCardUrl(card: WorkspaceCard, step: number): string | null {
  const site = card.workspace.site
  return site ? `${site.replace(/\/+$/, '')}${entityHash(card.id, step)}` : null
}
