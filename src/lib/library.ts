import { createContext, useContext } from 'react'
import type { CardWorkspace, WorkspaceCard } from '../types'
import { host } from './host'

/** Every workspace and card on screen, for the menus that need to offer the others (categories, move targets). */
export interface LibraryData { workspaces: CardWorkspace[]; cards: WorkspaceCard[] }

export const LibraryContext = createContext<LibraryData>({ workspaces: [], cards: [] })
export const useLibrary = () => useContext(LibraryContext)

/** Cards and categories can be changed here, and not in the starter examples that ship with the app. */
export const canManage = (workspace: CardWorkspace) => host.cards && host.write && !workspace.builtin

/** The categories of one workspace as the Library shows them (`other` for a card with none), most used first. */
export function categoriesOf(cards: WorkspaceCard[], workspace: string): { label: string; count: number }[] {
  const counts = new Map<string, number>()
  for (const card of cards) if (card.workspace.id === workspace) counts.set(card.category || 'other', (counts.get(card.category || 'other') ?? 0) + 1)
  return [...counts].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
}
