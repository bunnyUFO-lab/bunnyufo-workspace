import type { CardWorkspace, WorkspaceEntity } from '../types'
import { restoreCard } from './cards'
import { reportError } from '../local/client'
import { showUndo } from './undo'

/** The first day a card deleted on `at` is more than 30 days old, when the Trash lets it go for good. Same rule as site/api/card-purge.mjs. */
export const purgeOn = (at: string) => new Date(Date.parse(`${at}T00:00:00Z`) + 31 * 86_400_000).toISOString().slice(0, 10)

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
