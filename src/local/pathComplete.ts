import { api } from './client'
import type { Folder } from './types'

// Shell-style Tab completion of the last folder name in a typed path: a unique
// match gets a trailing separator, several matches complete their common prefix.
// Returns null when the text has no separator to complete from.
export async function completeFolder(typed: string): Promise<{ value: string; matches: string[] } | null> {
  const cut = Math.max(typed.lastIndexOf('/'), typed.lastIndexOf('\\'))
  if (cut < 0) return null
  const folder = typed.slice(0, cut + 1), partial = typed.slice(cut + 1).toLowerCase()
  const listing = await api<Folder>(`/files?path=${encodeURIComponent(folder)}&mode=all`).catch(() => null)
  const matches = (listing?.entries || []).filter(entry => entry.directory && entry.name.toLowerCase().startsWith(partial)).map(entry => entry.name)
  if (!matches.length) return { value: typed, matches }
  let common = matches[0]
  for (const name of matches) while (!name.toLowerCase().startsWith(common.toLowerCase())) common = common.slice(0, -1)
  return { value: folder + common + (matches.length === 1 ? typed[cut] : ''), matches }
}

export const matchSummary = (matches: string[]) => matches.length === 1 ? '' : matches.length ? matches.slice(0, 12).join('   ') + (matches.length > 12 ? '   …' : '') : 'No matching folder.'
