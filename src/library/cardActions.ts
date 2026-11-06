// The writes a card's row and keys make. Each goes to the service or the site's write API and tells the lists to reload.
import type { WorkspaceCard } from '../types'
import { api, reportError } from '../local/client'

const changed = () => window.dispatchEvent(new Event('bunnyufo-workspace-changed'))

async function write(path: string, body: Record<string, unknown>) {
  try {
    await api(path, body)
    changed()
  } catch (error) {
    reportError(error)
  }
}

const named = (card: WorkspaceCard) => ({ id: card.id, workspace: card.workspace.id })

export const setArchived = (card: WorkspaceCard, archived: boolean) => write('/workspace/status', { ...named(card), status: archived ? 'archived' : 'active' })
export const setPinned = (card: WorkspaceCard, pinned: boolean) => write('/workspace/pin', { ...named(card), pinned })
/** The card's icon: card state like a pin, so no card file changes. '' goes back to the card's own. */
export const setIcon = (card: WorkspaceCard, emoji: string) => write('/workspace/icon', { ...named(card), emoji })

/**
 * Putting a pin in a new place. Each card stores its own position, because the list mixes workspaces and no single workspace.json
 * could hold the order of all of them; the service writes the new list in one go, one file per workspace it touches.
 */
export function movePin(card: WorkspaceCard, list: WorkspaceCard[], at: number) {
  const others = list.filter(e => !(e.id === card.id && e.workspace.id === card.workspace.id))
  const next = [...others]
  next.splice(Math.max(0, Math.min(at, others.length)), 0, card)
  // One request for the whole list: a move touches several cards, and writing them one by one left it half-sorted in between.
  return write('/workspace/pins', { list: next.map(named) })
}
