// Which part of a project's roadmaps the Roadmap shows (ws-im1.3.2): pure, so Node tests it. The drawing never learns about branches: a branch is
// the same model with only its own milestones, and a new branch is a new map (a remount), the way a new project is.
// `.ts` imports with the suffix so node can test this file.
import type { MapMilestone, MapRoadmap, ProgressMap } from '../lib/hub'
import { find } from './mapState.ts'
import { currentMilestone } from './projectPage.ts'

/** The address of the list of roadmaps, and of the row for milestones that sit in no roadmap. */
export const FULL = '~full'
export const UNFILED = '~unfiled'
export const UNFILED_TITLE = 'Not in a roadmap'

/** What the viewer last looked at, per project: the view, and the branch they were last in (kept while they look at the full map). */
export interface SavedBranch { view: 'full' | 'branch'; branch?: string }
export type Resolved = { view: 'full' } | { view: 'branch'; branch: string; node?: string }
export interface Crumb { id: string; title: string }

/** A bad stored value is none. */
export function parseSaved(raw: unknown): SavedBranch | null {
  if (!raw || typeof raw !== 'object') return null
  const { view, branch } = raw as { view?: unknown; branch?: unknown }
  if (view !== 'full' && view !== 'branch') return null
  const own = typeof branch === 'string' && branch ? branch : undefined
  if (view === 'branch' && !own) return null
  return { view, ...(own ? { branch: own } : {}) }
}

const unfiledOf = (model: Pick<ProgressMap, 'milestones'>) => model.milestones.filter(milestone => !milestone.roadmap)
const ownOf = (model: Pick<ProgressMap, 'milestones'>, id: string): MapMilestone[] => (id === UNFILED ? unfiledOf(model) : model.milestones.filter(milestone => milestone.roadmap === id))

/** The milestones a branch holds itself (not its sub-roadmaps'), in model order. */
export const ownMilestones = ownOf

/** Whether this is a branch the model has: one of its roadmaps, or the unfiled row while it has milestones. */
export function isBranch(model: ProgressMap, id: string | undefined): id is string {
  if (!id) return false
  return id === UNFILED ? unfiledOf(model).length > 0 : !!model.roadmaps?.some(roadmap => roadmap.id === id)
}

/**
 * The model with only a branch's own milestones, and the sprint bands that touch them (their milestones narrowed, empty bands dropped).
 * Own only: pulling the children's milestones back onto one line is the long single spine the rows exist to avoid.
 */
export function branchModel(model: ProgressMap, id: string): ProgressMap {
  const milestones = ownOf(model, id)
  const ids = new Set(milestones.map(milestone => milestone.id))
  const sprints = model.sprints
    .map(sprint => ({ ...sprint, milestones: sprint.milestones.filter(item => ids.has(item.id)) }))
    .filter(sprint => sprint.milestones.length > 0)
  return { ...model, milestones, sprints }
}

/** The view an address names. `~full` is the list; a roadmap id or `~unfiled` is that branch; a bead the map knows is in its milestone's branch, with the bead open; anything else is the saved view if it still exists, else the list. */
export function resolveBranch(model: ProgressMap, param: string | undefined, saved: SavedBranch | null): Resolved {
  if (param === FULL) return { view: 'full' }
  if (isBranch(model, param)) return { view: 'branch', branch: param }
  const found = param ? find(model, param) : null
  if (found) return { view: 'branch', branch: found.milestone.roadmap ?? UNFILED, node: param }
  if (saved?.view === 'branch' && isBranch(model, saved.branch)) return { view: 'branch', branch: saved.branch }
  return { view: 'full' }
}

const roadmapOf = (model: ProgressMap, id: string): MapRoadmap | undefined => model.roadmaps?.find(roadmap => roadmap.id === id)

/** The roadmaps from the top down to a branch (a cycle in `parent` ends the walk). The unfiled row is its own crumb; the full list has none. */
export function crumbs(model: ProgressMap, branch: string): Crumb[] {
  if (branch === UNFILED) return [{ id: UNFILED, title: UNFILED_TITLE }]
  const chain: Crumb[] = []
  const seen = new Set<string>()
  for (let at = roadmapOf(model, branch); at && !seen.has(at.id); at = at.parent ? roadmapOf(model, at.parent) : undefined) {
    seen.add(at.id)
    chain.unshift({ id: at.id, title: at.title })
  }
  return chain
}

/** The roadmaps directly inside one, in order; for `~full` (or nothing) the top ones, those with no parent the model knows. */
export function childrenOf(model: ProgressMap, id?: string): MapRoadmap[] {
  const known = new Set((model.roadmaps ?? []).map(roadmap => roadmap.id))
  const top = !id || id === FULL
  return (model.roadmaps ?? []).filter(roadmap => (top ? !roadmap.parent || !known.has(roadmap.parent) : roadmap.parent === id))
}

/** A branch's own milestones as dots: their id, title and state. */
export const milestoneDots = (model: ProgressMap, id: string): { id: string; title: string; state: MapMilestone['state'] }[] => ownOf(model, id).map(({ id: key, title, state }) => ({ id: key, title, state }))

export interface RoadmapRow { id: string; title: string; state: MapMilestone['state']; depth: number; dots: ReturnType<typeof milestoneDots>; done: number; inside: number }

/** The rows under a root, nested and flat: each roadmap, then the ones inside it one level deeper. At the full list the unfiled row comes last, only when it has milestones. */
export function rowsOf(model: ProgressMap, root: string = FULL): RoadmapRow[] {
  const rows: RoadmapRow[] = []
  const seen = new Set<string>()
  const add = (roadmap: { id: string; title: string; state: MapMilestone['state'] }, depth: number) => {
    const dots = milestoneDots(model, roadmap.id)
    const inside = childrenOf(model, roadmap.id).length
    rows.push({ id: roadmap.id, title: roadmap.title, state: roadmap.state, depth, dots, done: dots.filter(dot => dot.state === 'done').length, inside })
    if (seen.has(roadmap.id)) return
    seen.add(roadmap.id)
    for (const child of childrenOf(model, roadmap.id)) if (!seen.has(child.id)) add(child, depth + 1)
  }
  for (const roadmap of childrenOf(model, root)) add(roadmap, 0)
  if (root === FULL && unfiledOf(model).length) {
    const dots = milestoneDots(model, UNFILED)
    rows.push({ id: UNFILED, title: UNFILED_TITLE, state: 'later', depth: 0, dots, done: dots.filter(dot => dot.state === 'done').length, inside: 0 })
  }
  return rows
}

/** A row as drawn: `names` are the milestones listed under it. */
export type VisibleRow = RoadmapRow & { names: ReturnType<typeof milestoneDots> }

/**
 * The rows to draw, with the milestones to list under each. A row that is not done lists its milestones by name; a finished row lists none
 * (it keeps its dots). With `hideDone` on, a finished row goes unless something inside it is open (a roadmap below it that is not done), and a
 * finished milestone leaves the names. `rows` are in `rowsOf` order, so a row's inside is the deeper rows right after it.
 */
export function visibleRows(rows: RoadmapRow[], hideDone: boolean): VisibleRow[] {
  const open = (row: RoadmapRow) => row.state !== 'done' || row.dots.some(dot => dot.state !== 'done')
  const insideOpen = (index: number) => {
    for (let at = index + 1; at < rows.length && rows[at].depth > rows[index].depth; at++) if (open(rows[at])) return true
    return false
  }
  const out: VisibleRow[] = []
  rows.forEach((row, index) => {
    const finished = row.state === 'done'
    if (hideDone && finished && !insideOpen(index)) return
    const names = finished ? [] : hideDone ? row.dots.filter(dot => dot.state !== 'done') : row.dots
    out.push({ ...row, names })
  })
  return out
}

/** Where "This branch" goes from the full list: the branch last in, else the one the current milestone is in, else the first roadmap. */
export function branchTarget(model: ProgressMap, saved: SavedBranch | null): string {
  if (isBranch(model, saved?.branch)) return saved?.branch as string
  const current = currentMilestone(model)
  if (current) return current.roadmap ?? UNFILED
  return model.roadmaps?.[0]?.id ?? UNFILED
}
