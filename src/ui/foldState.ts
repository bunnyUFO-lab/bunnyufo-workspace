// What the user opened or closed in a list of folds, kept in this browser as JSON `{ [foldKey]: boolean }`. Pure, so a node test covers it.
// `.ts` imports with the suffix so node can read this file.

/** The stored overrides; a missing, bad or blocked store is none. Only booleans are kept. */
export function readOpen(raw: string | null): Record<string, boolean> {
  try {
    const value: unknown = raw ? JSON.parse(raw) : null
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, boolean] => typeof entry[1] === 'boolean'))
  } catch {
    return {}
  }
}

/** Whether a fold is open: what the user chose, else the fallback. */
export const foldOpen = (key: string, stored: Record<string, boolean>, fallback: boolean): boolean => (typeof stored[key] === 'boolean' ? stored[key] : fallback)
