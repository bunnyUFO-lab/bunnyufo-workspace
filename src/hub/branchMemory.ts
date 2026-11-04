// The view the Roadmap last showed for each project, so a reload and a bare `#/~hub/map/<project>` open it again. Blocked storage is no memory.
import { parseSaved, type SavedBranch } from './mapBranch.ts'

const BRANCH_KEY = 'hub-map-branch'

export function savedBranch(project: string): SavedBranch | null {
  try {
    const all = JSON.parse(localStorage.getItem(BRANCH_KEY) ?? '{}') as Record<string, unknown>
    return parseSaved(all?.[project])
  } catch { return null }
}

/** Seeing the full list keeps the branch last visited, so "This branch" and the highlighted row know where the viewer came from. */
export function saveBranch(project: string, next: SavedBranch): void {
  try {
    const raw = JSON.parse(localStorage.getItem(BRANCH_KEY) ?? '{}')
    const all: Record<string, unknown> = raw && typeof raw === 'object' ? raw : {}
    const kept = next.view === 'full' ? { view: 'full', ...(parseSaved(all[project])?.branch ? { branch: parseSaved(all[project])?.branch } : {}) } : next
    localStorage.setItem(BRANCH_KEY, JSON.stringify({ ...all, [project]: kept }))
  } catch { /* blocked storage: the full list opens next time */ }
}
