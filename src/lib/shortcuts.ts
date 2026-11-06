/**
 * Every keyboard shortcut the app answers to, in the order the Ctrl+H sheet lists them. The
 * handlers live where the state does (App, Sidebar, MarkdownDocument, HtmlEditor); this is the
 * one list of what they are, so the sheet cannot promise a key nobody listens for.
 */
export interface Shortcut {
  keys: string[]
  does: string
}

export const SHORTCUT_GROUPS: { title: string; items: Shortcut[] }[] = [
  {
    title: 'Getting around',
    items: [
      { keys: ['Q'], does: 'Back from an open card, to where you came from (or Esc)' },
      { keys: ['Ctrl', 'Shift', 'F'], does: 'Search the Library, even while you are typing in a note' },
      { keys: ['/'], does: 'Search: screens, items, roadmaps and cards' },
      { keys: ['['], does: 'Show or hide the card list beside an open card' },
      { keys: ['Alt', '←'], does: 'Back one screen (the browser’s own; the Back buttons do the same)' },
    ],
  },
  {
    title: 'In the Library search',
    items: [
      { keys: ['Enter'], does: 'Open the first card in the list' },
      { keys: ['Esc'], does: 'Clear the search and leave the field' },
    ],
  },
  {
    title: 'An open card',
    items: [
      { keys: ['←', '→'], does: 'Previous / next tab' },
      { keys: ['P'], does: 'Pin or unpin it (local app)' },
      { keys: ['Ctrl', 'Shift', 'P'], does: 'Archive or restore it (local app)' },
      { keys: ['Ctrl', 'E'], does: 'Edit the note or page, or stop editing (local app)' },
      { keys: ['Ctrl', 'S'], does: 'Save what you are editing' },
      { keys: ['Ctrl', 'Shift', 'S'], does: 'Download the open page as a file' },
    ],
  },
  {
    title: 'Anywhere',
    items: [
      { keys: ['Ctrl', 'K'], does: 'Open search: go to a screen, an item, a roadmap or a card (again to close)' },
      { keys: ['Ctrl', 'H'], does: 'This list (or ?)' },
      { keys: ['Esc'], does: 'Close a dialog, or stop editing a page' },
    ],
  },
]
