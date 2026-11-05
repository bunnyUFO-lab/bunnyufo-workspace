import type { CardWriteGroup, CardWrites } from '../lib/hub'
import { useHubData } from './useHub'

/** `Added a tab` becomes `added a tab`; a mix of files reads `wrote 3 files`. */
export const verb = (title: string) => (/^(Added|Changed) /.test(title) ? title.charAt(0).toLowerCase() + title.slice(1) : `wrote ${title}`)

/** What Yes will do, in words, for the kinds of file the write holds. */
export function willDo(group: CardWriteGroup): string {
  const kinds = new Set(group.files.map(file => file.kind))
  const parts: string[] = []
  if (kinds.has('edit')) parts.push('Puts the old text back')
  if (kinds.has('new-tab')) parts.push('Takes the tab off (you can bring it back with +)')
  if (kinds.has('new-card') || !parts.length) parts.push('Puts the card in the Trash (restorable for 30 days)')
  return parts.join('; ')
}

/** The rows of a section, or of one card folder; `limit` caps the groups. Every Hub write reloads them (useHubData). */
export function useCardWrites(section: string, folder?: string, limit?: number) {
  const query = `section=${encodeURIComponent(section)}${folder ? `&folder=${encodeURIComponent(folder)}` : ''}${limit ? `&limit=${limit}` : ''}`
  return useHubData<CardWrites>(`/card-writes?${query}`)
}
