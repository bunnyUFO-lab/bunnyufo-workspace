import type { CardWorkspace, WorkspaceEntity } from '../types'
import { purgeTrash, restoreCard } from './cards'
import { reportError } from '../local/client'
import { showUndo } from './undo'
import { canManage } from './library'

/** The first day a card deleted on `at` is more than 30 days old, when the Trash lets it go for good. Same rule as site/api/card-purge.mjs. */
export const purgeOn = (at: string): string | null => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(at)
  if (!match) return null
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])]
  const ms = Date.UTC(year, month - 1, day)
  const back = new Date(ms)
  if (back.getUTCFullYear() !== year || back.getUTCMonth() !== month - 1 || back.getUTCDate() !== day) return null
  const purge = new Date(ms + 31 * 86_400_000)
  return purge.getUTCFullYear() > 9999 ? null : purge.toISOString().slice(0, 10)
}

export interface TrashEntry { workspace: CardWorkspace; id: string; at: string; entity: WorkspaceEntity }

/** The deleted cards of these workspaces, newest first. */
export function trashOf(workspaces: CardWorkspace[]): TrashEntry[] {
  const out: TrashEntry[] = []
  for (const workspace of workspaces) {
    for (const [id, record] of Object.entries(workspace.retired ?? {})) {
      if (record.kind === 'deleted' && record.entity) out.push({ workspace, id, at: record.at, entity: record.entity })
    }
  }
  return out.sort((a, b) => b.at.localeCompare(a.at))
}

/** Restore one deleted card. Used by the Trash list and by the notice on a deleted card's own link. */
export async function restore(entry: { workspace: CardWorkspace; id: string; entity: WorkspaceEntity }) {
  try {
    await restoreCard(entry.workspace.id, entry.id)
    showUndo(`Restored “${entry.entity.title}” in ${entry.workspace.name}`)
  } catch (problem) { reportError(problem) }
}

/**
 * Ask the site to empty what is due, in every workspace in view that has a Trash or removed tabs. Fire and forget:
 * a refusal (read-only, the development copy) is nothing to show, and nothing is sent where nothing is waiting.
 */
export function purgeDue(workspaces: CardWorkspace[], cards: { workspace: CardWorkspace; removedTabs?: unknown[] }[]) {
  for (const workspace of workspaces) {
    if (!canManage(workspace)) continue
    const waiting = Object.values(workspace.retired ?? {}).some(record => record.kind === 'deleted' || (record.kind === 'purged' && record.pending))
      || cards.some(card => card.workspace.id === workspace.id && card.removedTabs?.length)
    if (waiting) void purgeTrash(workspace.id).catch(() => { /* not allowed here */ })
  }
}
