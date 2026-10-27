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
      { keys: ['Q'], does: 'Back to the cards, clearing the search (or Esc)' },
      { keys: ['Ctrl', 'Shift', 'F'], does: 'Open the menu and search it, even while you are typing in a note' },
      { keys: ['/'], does: 'Search with the menu left as it is (hidden stays hidden; matches fill the board)' },
      { keys: ['['], does: 'Show or hide the menu' },
      { keys: ['1–9'], does: 'Show one project' },
      { keys: ['0'], does: 'Show every project’s live cards (or Alt+A, even while searching)' },
      { keys: ['Shift', 'A'], does: 'Archived cards instead of live ones, and back' },
      { keys: ['Shift', 'R'], does: 'Recent: every card in one run, newest first, and back' },
      { keys: ['Alt', '←'], does: 'Back to the card or view before (the browser’s own)' },
    ],
  },
  {
    title: 'The menu, without the search box',
    items: [
      { keys: ['J', 'K'], does: 'Step down / up through the headings and cards (↑ ↓ once you are in the list)' },
      { keys: ['Enter'], does: 'Open the card, or fold or open the heading' },
      { keys: ['Alt', '↑↓'], does: 'Move the card or heading one place' },
      { keys: ['Drag'], does: 'Reorder cards, projects and headings; drop a card on Pinned to pin it' },
    ],
  },
  {
    title: 'In the search box',
    items: [
      { keys: ['↑', '↓'], does: 'Move through the sections and cards in the list' },
      { keys: ['Enter'], does: 'Open the card (the first one if you have not moved)' },
      { keys: ['Space'], does: 'On a section heading: fold or open it' },
      { keys: ['Tab'], does: 'Next project (Shift+Tab: previous)' },
      { keys: ['Esc'], does: 'Clear the search and leave the box' },
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
      { keys: ['Ctrl', 'H'], does: 'This list (or ?)' },
      { keys: ['Esc'], does: 'Close a dialog, or stop editing a page' },
    ],
  },
]
