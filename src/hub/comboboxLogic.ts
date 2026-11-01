// The Combobox's pure parts: how an option matches what was typed, and how the arrow keys move the highlight.

export type ComboOption = {
  value: string
  label: string
  /** Extra words that also match (a project's id, a repo's project). */
  keywords?: string[]
  /** Stays in the list whatever was typed (an "Another repo…" row). */
  always?: boolean
}

/** Lower case, accents removed, so "Café" and "cafe" are the same word. */
export function fold(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim()
}

/** A case- and accent-insensitive substring of the label or of any keyword. An empty query matches everything. */
export function matches(option: ComboOption, query: string): boolean {
  const needle = fold(query)
  if (!needle) return true
  return [option.label, ...(option.keywords ?? [])].some(text => fold(text).includes(needle))
}

export function filterOptions(options: ComboOption[], query: string): ComboOption[] {
  return options.filter(option => option.always || matches(option, query))
}

/** Where the highlight goes for a key. -1 is "none"; Down from none lands on the first, Up from none on the last; no wrap. */
export function moveActive(active: number, count: number, key: 'ArrowDown' | 'ArrowUp' | 'Home' | 'End'): number {
  if (count <= 0) return -1
  if (key === 'Home') return 0
  if (key === 'End') return count - 1
  if (key === 'ArrowDown') return active < 0 ? 0 : Math.min(active + 1, count - 1)
  return active < 0 ? count - 1 : Math.max(active - 1, 0)
}
