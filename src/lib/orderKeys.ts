// The saved order's shape and the two functions that read it, with nothing to import: the Library's model and its tests read them without a browser.

export interface Order {
  projects: string[]
  sections: string[]
  /** Card keys (`workspace/id`) per section, under `${groupBy}:${label}`. */
  cards: Record<string, string[]>
}

/** The key a card has in a saved order: card ids are only unique inside a workspace. */
export const cardKey = (card: { id: string; workspace: { id: string } }) => `${card.workspace.id}/${card.id}`

/**
 * `items` in the saved order. What the order has never heard of keeps its own order and goes first
 * for cards (a card that was just touched belongs at the top) or last for projects (a new project
 * should not take the number key you were used to).
 */
export function applyOrder<T>(items: T[], keyOf: (item: T) => string, saved: string[] | undefined, unknown: 'first' | 'last'): T[] {
  if (!saved?.length) return items
  const rank = new Map(saved.map((key, index) => [key, index]))
  const known = items.filter(item => rank.has(keyOf(item))).sort((a, b) => rank.get(keyOf(a))! - rank.get(keyOf(b))!)
  const rest = items.filter(item => !rank.has(keyOf(item)))
  return unknown === 'first' ? [...rest, ...known] : [...known, ...rest]
}

/** `list` with `key` taken out and put beside `target`. Returns it unchanged when either is missing. */
