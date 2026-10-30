import type { CardWorkspace, WorkspaceEntity } from '../types'
import { restoreCard } from './cards'
import { reportError } from '../local/client'
import { showUndo } from './undo'

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
