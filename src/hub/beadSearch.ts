// The Hub's search over Beads text: pure, so the Work board and the Roadmap (and node tests) share it.
// A row is what `GET /hub/search-text` sends for one bead.

export interface SearchRow { id: string; project: string; title: string; status: string; text: string }

/** The words of a query: trimmed, lower case, split on spaces. All of them must match. */
export function words(q: string): string[] {
  return q.trim().toLowerCase().split(/\s+/).filter(Boolean)
}

/** True when every word of the query is somewhere in the bead's id, title or text. An empty query matches. */
export function rowMatches(row: Pick<SearchRow, 'id' | 'title' | 'text'>, q: string): boolean {
  const hay = `${row.id} ${row.title} ${row.text}`.toLowerCase()
  return words(q).every(word => hay.includes(word))
}

/** About 30 characters each side of the first hit of any word of the query, with `…` where it was cut; null when nothing hits. */
export function snippetOf(text: string, q: string, side = 30): string | null {
  const low = text.toLowerCase()
  let at = -1
  let length = 0
  for (const word of words(q)) {
    const index = low.indexOf(word)
    if (index !== -1 && (at === -1 || index < at)) { at = index; length = word.length }
  }
  if (at === -1) return null
  const from = Math.max(0, at - side)
  const to = Math.min(text.length, at + length + side)
  return `${from > 0 ? '…' : ''}${text.slice(from, to).trim()}${to < text.length ? '…' : ''}`
}
