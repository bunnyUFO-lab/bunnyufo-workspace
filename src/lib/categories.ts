export const CATEGORY_ICONS: Record<string, string> = {
  'image-gen': '\u{1F3A8}',
  'analytics': '\u{1F4CA}',
  'research': '\u{1F50D}',
  'lead-magnet': '\u{1F9F2}',
  'game': '\u{1F3AE}',
  'dev': '\u{1F6E0}\u{FE0F}',
}

export function categoryIcon(category: string): string {
  return CATEGORY_ICONS[category] ?? '\u{1F4C1}'
}

/**
 * The presets the card icon picker offers, grouped loosely: making games, art, tools and
 * research, and states a card can be in. Any one emoji is a valid icon; these are the quick ones.
 */
export const ICON_PRESETS: string[] = [
  '\u{1F3AE}', '\u{1F579}\u{FE0F}', '\u{1F47E}', '\u{1F3B2}', '\u{2694}\u{FE0F}', '\u{1F6E1}\u{FE0F}', '\u{1F409}', '\u{1F430}',
  '\u{1F3A8}', '\u{1F58C}\u{FE0F}', '\u{1F5BC}\u{FE0F}', '\u{2728}', '\u{1F4A5}', '\u{1F525}', '\u{1F3B5}', '\u{1F3AC}',
  '\u{1F6E0}\u{FE0F}', '\u{2699}\u{FE0F}', '\u{1F9E9}', '\u{1F916}', '\u{1F9EA}', '\u{1F50D}', '\u{1F4CA}', '\u{1F4DD}',
  '\u{1F4C1}', '\u{1F4E6}', '\u{1F680}', '\u{1F41B}', '\u{2705}', '\u{2B50}', '\u{1F4A1}', '\u{1F6A7}',
]

/** The icon on a section heading: projects, categories, or the one date-sorted run. */
export function groupIcon(groupBy: 'project' | 'category' | 'date', label: string): string {
  if (groupBy === 'project') return '\u{1F3AE}'
  if (groupBy === 'date') return '\u{1F553}'
  return categoryIcon(label)
}
