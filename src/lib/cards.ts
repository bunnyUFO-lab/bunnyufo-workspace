import { api } from '../local/client'
import type { WorkspaceEntity } from '../types'

/**
 * Making cards by hand, on either host: the local service writes the workspace folder, the
 * published site the cards bucket, and both answer these routes the same way (site/api/card-writes.mjs).
 */

/** Tell the board to read the card lists again now rather than at the next poll. */
const changed = () => window.dispatchEvent(new Event('bunnyufo-workspace-changed'))

export async function createCard(workspace: string, title: string, description: string): Promise<WorkspaceEntity> {
  const { card } = await api<{ card: WorkspaceEntity }>('/cards', { workspace, title, description })
  changed()
  return card
}

export async function updateCard(workspace: string, id: string, fields: { title?: string; description?: string }): Promise<WorkspaceEntity> {
  const { card } = await api<{ card: WorkspaceEntity }>('/cards/update', { workspace, id, ...fields })
  changed()
  return card
}

export type SectionKind = 'markdown' | 'drawing'

export async function addSection(workspace: string, id: string, name: string, kind: SectionKind = 'markdown'): Promise<{ step: number; path: string }> {
  const answer = await api<{ step: number; path: string }>('/cards/section', { workspace, id, name, ...(kind === 'markdown' ? {} : { kind }) })
  changed()
  return answer
}

/** Start a drawing over a picture of the card. The new tab sits right after step `after`. */
export async function annotate(workspace: string, id: string, image: string, after: number, width: number, height: number): Promise<{ step: number; path: string }> {
  const answer = await api<{ step: number; path: string }>('/cards/annotate', { workspace, id, image, after, width, height })
  changed()
  return answer
}

export interface CardText { text: string; etag: string | null }

export const readSection = (workspace: string, id: string, path: string) =>
  api<CardText>(`/cards/markdown?${new URLSearchParams({ workspace, id, path })}`)

/** Throws with `answer.current` (what the file holds now) when it changed since `base` was read. */
export const saveSection = (workspace: string, id: string, path: string, text: string, base: string | null) =>
  api<CardText>('/cards/markdown', { workspace, id, path, text, base })

/** A drawing's scene (the .excalidraw JSON). Empty text and a null etag mean the file is not there. */
export const readDrawing = (workspace: string, id: string, path: string) =>
  api<CardText>(`/cards/drawing?${new URLSearchParams({ workspace, id, path })}`)

/** Both etags: the scene's (the next save's base) and the picture's (to bust the browser's cache). */
export interface SavedDrawing { etag: string; png: string }

/** Throws with `answer.current` (the scene as it is now) when it changed since `base` was read. */
export const saveDrawing = (workspace: string, id: string, path: string, scene: string, png: string, base: string | null) =>
  api<SavedDrawing>('/cards/drawing', { workspace, id, path, scene, png, base })

/**
 * The section to open in the editor rather than the reader: set when one was just made, so a new
 * card or tab starts with the cursor in it. Read once.
 */
let editNext = ''
export const openForEditing = (workspace: string, id: string, path: string) => { editNext = `${workspace}/${id}/${path}` }
export const takeEditing = (workspace: string, id: string, path: string) => {
  if (editNext !== `${workspace}/${id}/${path}`) return false
  editNext = ''
  return true
}
