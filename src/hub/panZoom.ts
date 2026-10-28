// The pure part of the progress map's pan and zoom: a view is where the content sits in the box
// (translate x, y in px, scale k). Nothing here touches the DOM, so the rules can be tested alone.
export interface View { x: number; y: number; k: number }
export interface Size { w: number; h: number }
export interface Limits { kMin: number; kMax: number }

export const K_MAX = 4
/** The map's first view and Fit may enlarge a small map up to this scale. */
export const FIT_MAX = 2
/** How much of the content must stay inside the box on each axis, so it can never be lost off screen. */
export const KEEP = 80

export const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value))

/** The scale that shows all of the content in the box, never enlarging past `max` (1 unless told otherwise). */
export function fitScale(content: Size, box: Size, max = 1): number {
  if (!content.w || !content.h || !box.w || !box.h) return 1
  return Math.min(box.w / content.w, box.h / content.h, max)
}

/** You can zoom out a little past "everything visible", but never to a speck. */
export function limitsFor(content: Size, box: Size): Limits {
  return { kMin: Math.min(0.9 * fitScale(content, box), 0.5), kMax: K_MAX }
}

/** All of the content, centred in the box. */
export function fitView(content: Size, box: Size, max = 1): View {
  const k = fitScale(content, box, max)
  return { k, x: (box.w - content.w * k) / 2, y: (box.h - content.h * k) / 2 }
}

/** Keep at least KEEP px of the content inside the box on each axis (less when the content is smaller than that). */
export function clampView(view: View, content: Size, box: Size, limits: Limits): View {
  const k = clamp(view.k, limits.kMin, limits.kMax)
  const keepX = Math.min(KEEP, content.w * k, box.w)
  const keepY = Math.min(KEEP, content.h * k, box.h)
  return {
    k,
    x: clamp(view.x, keepX - content.w * k, box.w - keepX),
    y: clamp(view.y, keepY - content.h * k, box.h - keepY),
  }
}

/** Scale by a factor, keeping the content point under `point` (box coordinates) where it is. The scale is limited; the pan is not. */
export function zoomAround(view: View, point: { x: number; y: number }, factor: number, limits: Limits): View {
  const k = clamp(view.k * factor, limits.kMin, limits.kMax)
  const ratio = k / view.k
  return { k, x: point.x - (point.x - view.x) * ratio, y: point.y - (point.y - view.y) * ratio }
}

/** The view that puts a content point at a box point, at scale k. */
export function viewAt(content: { x: number; y: number }, at: { x: number; y: number }, k: number): View {
  return { k, x: at.x - content.x * k, y: at.y - content.y * k }
}

/** The view that puts a content point in the middle of a free rectangle of the box. */
export function centreOn(content: { x: number; y: number }, free: { x: number; y: number; w: number; h: number }, k: number): View {
  return viewAt(content, { x: free.x + free.w / 2, y: free.y + free.h / 2 }, k)
}

/** The view where the content point `point` sits at the same box point as in `before`, after the content changed. */
export function keepPoint(before: View, oldPoint: { x: number; y: number }, newPoint: { x: number; y: number }): View {
  return { k: before.k, x: before.x + (oldPoint.x - newPoint.x) * before.k, y: before.y + (oldPoint.y - newPoint.y) * before.k }
}

export const viewString = (view: View) => `translate3d(${view.x}px, ${view.y}px, 0) scale(${view.k})`
export const dataView = (view: View) => `${view.x.toFixed(2)},${view.y.toFixed(2)},${view.k.toFixed(2)}`
