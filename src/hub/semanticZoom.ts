// Semantic zoom for the progress map: as you zoom in, the milestone and then the feature under the
// pointer open; as you zoom out, what zoom opened folds again. Pure: no DOM, so the rules can be
// tested alone. The scale `k` is the on-screen size of the drawn text (font sizes are fixed per level).
import type { Branch, Layout, MapNode } from './mapLayout'

/** Zooming in opens a milestone at this scale, and zooming out folds it below FOLD_M. The gap is the hysteresis. */
export const OPEN_M = 1.5
export const FOLD_M = 1.2
/** The same for a feature: its tasks. */
export const OPEN_F = 2.2
export const FOLD_F = 1.8

export interface Point { x: number; y: number }

/**
 * A node's point that does not move when it opens or closes: a milestone's centre, a feature's elbow
 * (its circle sits at the end of the branch and jumps when the feature opens; the elbow stays and
 * the tasks fan out from it), a task's centre.
 */
export function stableOf(node: MapNode): Point {
  return node.kind === 'f' ? { ...node.elbow } : { x: node.x, y: node.y }
}

/** Distance from a point to the segment a-b. */
export function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const length = dx * dx + dy * dy
  const t = length ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length)) : 0
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
}

/** Distance from a point to a branch's polyline (its corners run from the spine to its end). */
export function distanceToBranch(p: Point, branch: Branch): number {
  const points = branch.points.map(([x, y]): Point => ({ x, y }))
  let best = Infinity
  for (let i = 1; i < points.length; i += 1) best = Math.min(best, distanceToSegment(p, points[i - 1], points[i]))
  return best
}

export interface StepInput {
  layout: Layout
  open: ReadonlySet<string>
  auto: ReadonlySet<string>
  /** The scale after the zoom. */
  k: number
  dir: 1 | -1
  /** The pointer, in layout (content) coordinates. */
  at: Point
  /** Ids that must stay as they are: the ancestors of the node whose panel is open. */
  keep: ReadonlySet<string>
}
export interface StepResult { open: Set<string>; auto: Set<string>; anchor: string }

/** The milestone whose slot holds the pointer. */
export function slotAt(layout: Layout, at: Point): string | null {
  const along = layout.axis === 'x' ? at.x : at.y
  return layout.slots.find(slot => along >= slot.from && along < slot.to)?.id ?? null
}

/**
 * One zoom step. Zooming in opens at most one thing, the milestone under the pointer and then, once
 * it is open, the feature nearest the pointer. Zooming out folds what zoom opened, never what the
 * user opened with a chevron or Expand all. `null`: nothing changes.
 */
export function zoomStep({ layout, open, auto, k, dir, at, keep }: StepInput): StepResult | null {
  const nodes = new Map(layout.nodes.map(node => [node.id, node]))
  if (dir === 1) {
    const milestone = slotAt(layout, at)
    if (!milestone) return null
    if (!open.has(milestone)) {
      if (k < OPEN_M) return null
      return { open: new Set(open).add(milestone), auto: new Set(auto).add(milestone), anchor: milestone }
    }
    if (k < OPEN_F) return null
    let best: string | null = null
    let near = Infinity
    for (const branch of layout.branches) {
      if (branch.milestone !== milestone) continue
      const distance = distanceToBranch(at, branch)
      if (distance < near) { near = distance; best = branch.id }
    }
    if (!best || open.has(best)) return null
    return { open: new Set(open).add(best), auto: new Set(auto).add(best), anchor: best }
  }

  const nextOpen = new Set(open)
  const nextAuto = new Set(auto)
  const foldFeatures = k < FOLD_F
  const foldMilestones = k < FOLD_M
  let features = false
  let milestones = false
  // FOLD_M is below FOLD_F, so a milestone fold folds the features zoom opened inside it as well;
  // features the user opened stay in `open`, drawn again with the milestone.
  for (const id of auto) {
    if (keep.has(id)) continue
    const node = nodes.get(id)
    if (node?.kind === 'm' ? foldMilestones : foldFeatures) {
      nextOpen.delete(id)
      nextAuto.delete(id)
      if (node?.kind === 'm') milestones = true
      else features = true
    }
  }
  if (!milestones && !features) return null
  // Hold still the surviving node of that level nearest the pointer.
  const kind = milestones ? 'm' : 'f'
  let anchor: string | null = null
  let near = Infinity
  for (const node of layout.nodes) {
    if (node.kind === 't' || node.kind !== kind) continue
    if (node.kind === 'f' && !nextOpen.has(node.milestone)) continue
    const point = stableOf(node)
    const distance = Math.hypot(point.x - at.x, point.y - at.y)
    if (distance < near) { near = distance; anchor = node.id }
  }
  return anchor ? { open: nextOpen, auto: nextAuto, anchor } : null
}
