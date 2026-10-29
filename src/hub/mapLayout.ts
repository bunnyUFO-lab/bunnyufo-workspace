// The progress map's layout: where each milestone, feature and task sits on the line. A pure port
// of the prototype's layout (constants and rules unchanged); the SVG itself is drawn by
// ProgressMap.tsx from what this returns, as React elements, so a title can never become markup.
import type { MapMilestone, ProgressMap, Sign, TaskState } from '../lib/hub'

export const SPINE_Y = 230
export const LV = 78
export const TS = 92
export const BR = 40
export const HEIGHT = 470
/** Vertical layout: the gap between tasks along a branch, the gap between bands of sprints, and the radius of a feature's circle. */
export const VS = 44
export const BAND_GAP = 18
const FR = 22
/** Milestone colours cycle through these tokens (styles/tokens.css). */
export const MILESTONE_COLORS = ['var(--red)', 'var(--amber)', 'var(--blue)', 'var(--green)', 'var(--purple)', 'var(--pink)']
export const SPRINT_COLORS = ['var(--purple)', 'var(--blue)', 'var(--amber)', 'var(--green)', 'var(--pink)']

export interface Marks { working: boolean; idle: boolean; prs: number; review: number; failing: number; fresh: boolean; deployed: boolean }

export interface At { x: number; y: number }
/** Where a node's text goes. `y` is the first line's baseline; `lines` (when set) are the wrapped lines, and `step` the distance between them. */
export interface Label { x: number; y: number; anchor: 'start' | 'middle' | 'end'; lines?: string[]; step?: number }
interface Base { id: string; x: number; y: number; state: TaskState; col: string; marks: Marks; title: string; done: number; total: number; label: Label; center: At }
export interface MilestoneNode extends Base { kind: 'm'; index: number; open: boolean; countAt: At; chevronAt: At }
/** `x`, `y` is the end of the branch; `center` the middle of the circle. `elbow` is the point that does not move when the feature opens or closes. */
export interface FeatureNode extends Base { kind: 'f'; milestone: string; side: 1 | -1; open: boolean; elbow: At; countAt: At; chevronAt: At }
export interface TaskNode extends Base { kind: 't'; milestone: string; feature: string; side: 1 | -1; slot: number; signs: Sign[]; lines: string[]; up: boolean }
export type MapNode = MilestoneNode | FeatureNode | TaskNode

/** `points` run from the spine to the end of the branch. */
export interface Branch { id: string; milestone: string; points: [number, number][]; col: string; lit: boolean }
/** `rect` is the bar or pill, `labelAt` the sprint's name; `partsAt` the "4 of 7" text, drawn beside the name in the horizontal layout and left to the tooltip in the vertical one. */
export interface Band { name: string; rect: { x: number; y: number; w: number; h: number }; labelAt: At & { anchor: 'start' | 'end' }; partsAt: At | null; col: string; parts: string }
/** The stretch of the layout axis a milestone owns: from the middle of the gap before it to the middle of the gap after it. The first slot runs on to -Infinity, the last to Infinity. */
export interface Slot { id: string; from: number; to: number }
export interface Layout {
  /** The axis the spine runs along: 'x' left to right, 'y' top to bottom. */
  axis: 'x' | 'y'
  slots: Slot[]
  /** The size of the drawing. In 'y' the left side is negative: the spine is at x = 0. */
  width: number
  height: number
  spine: { from: [number, number]; to: [number, number] }
  /** The point on the spine that marks now. */
  now: At
  nodes: MapNode[]
  branches: Branch[]
  bands: Band[]
}

/** Task titles wrap at 24 characters, at the last space before that: at most two lines; the second ends in … when it would run past 24 characters. */
export function wrap(title: string): string[] {
  if (title.length <= 24) return [title]
  const cut = title.lastIndexOf(' ', 24)
  const [first, second] = cut > 0 ? [title.slice(0, cut), title.slice(cut + 1)] : [title.slice(0, 24), title.slice(24)]
  return [first, second.length > 24 ? `${second.slice(0, 23)}…` : second]
}

const marksOf = (signsList: Sign[][]): Marks => ({
  working: signsList.some(signs => signs.includes('working')),
  idle: signsList.some(signs => signs.includes('idle')),
  prs: signsList.filter(signs => signs.includes('pr')).length,
  review: signsList.filter(signs => signs.includes('review')).length,
  failing: signsList.filter(signs => signs.includes('ci-failed')).length,
  fresh: signsList.some(signs => signs.includes('new')),
  deployed: signsList.some(signs => signs.includes('deployed')),
})

const clip = (text: string, length: number) => (text.length > length ? `${text.slice(0, length - 1)}…` : text)

/** Rough width of a line of text of the drawn size: bold 12 px titles and 10.5 px task labels. */
const textWidth = (lines: string[], size: number) => Math.max(0, ...lines.map(line => line.length)) * size

/**
 * @param open ids of the milestones and features that are open
 * @param axis 'x': the spine runs left to right, titles and labels sit above and below it. 'y': it runs top to bottom, text stays horizontal and sits beside it.
 */
export function layoutMap(model: ProgressMap, open: ReadonlySet<string>, showSprints: boolean, axis: 'x' | 'y' = 'x'): Layout {
  const vertical = axis === 'y'
  /** Where the next milestone starts along the spine. */
  let x = vertical ? 60 : 120
  const nodes: MapNode[] = []
  const branches: Branch[] = []
  /** Where each milestone sits along the spine, and (vertical) where its features end. */
  const milestoneX = new Map<string, number>()
  const milestoneEnd = new Map<string, number>()
  model.milestones.forEach((milestone: MapMilestone, index) => {
    const tasks = milestone.features.flatMap(feature => feature.tasks)
    const col = MILESTONE_COLORS[index % MILESTONE_COLORS.length]
    const isOpen = open.has(milestone.id)
    const radius = isOpen ? 15 : 26
    milestoneX.set(milestone.id, x)
    const mx = vertical ? 0 : x
    const my = vertical ? x : SPINE_Y
    const titleLines = vertical ? wrap(milestone.title) : [milestone.title]
    nodes.push({
      kind: 'm', id: milestone.id, title: milestone.title, x: mx, y: my, state: milestone.state, col, index, open: isOpen,
      done: tasks.filter(task => task.state === 'done').length, total: tasks.length, marks: marksOf(tasks.map(task => task.signs)),
      center: { x: mx, y: my },
      label: vertical
        ? { x: radius + 10, y: my + 4 - (titleLines.length - 1) * 7, anchor: 'start', lines: titleLines, step: 14 }
        : { x: mx, y: my + (isOpen ? 34 : index % 2 ? 48 : -38), anchor: 'middle' },
      countAt: { x: mx, y: my + 4 },
      chevronAt: { x: mx - radius - 16, y: my },
    })
    let span = vertical ? 100 : Math.max(170, milestone.title.length * 7 + 30)
    // Vertical: the next feature's band starts here.
    let cursor = x + radius + 20
    if (isOpen) {
      milestone.features.forEach((feature, k) => {
        const side: 1 | -1 = k % 2 ? 1 : -1
        const featureOpen = open.has(feature.id)
        const state = feature.state
        const featureMarks = marksOf(feature.tasks.map(task => task.signs))
        const featureDone = feature.tasks.filter(task => task.state === 'done').length
        if (vertical) {
          // The branch leaves the spine, steps out BR and runs down; the circle hangs at its end, text goes outside it.
          const y0 = cursor
          const y1 = y0 + BR
          const y2 = y1 + (featureOpen ? 28 + feature.tasks.length * VS : 8)
          const bx = side * BR
          const cy = y2 + FR
          const lines = wrap(feature.title)
          branches.push({ id: feature.id, milestone: milestone.id, points: [[0, y0], [bx, y1], [bx, y2]], col, lit: state !== 'later' })
          nodes.push({
            kind: 'f', id: feature.id, milestone: milestone.id, title: feature.title, x: bx, y: y2, side, state, col, open: featureOpen,
            done: featureDone, total: feature.tasks.length, marks: featureMarks,
            center: { x: bx, y: cy }, elbow: { x: bx, y: y1 },
            label: { x: bx + side * (FR + 8), y: cy + 4 - (lines.length - 1) * 7, anchor: side < 0 ? 'end' : 'start', lines, step: 14 },
            countAt: { x: bx, y: cy + 4 }, chevronAt: { x: bx, y: cy + FR + 14 },
          })
          if (featureOpen) {
            feature.tasks.forEach((task, slot) => {
              const ty = y1 + 28 + slot * VS
              const taskLines = wrap(task.title)
              nodes.push({
                kind: 't', id: task.id, milestone: milestone.id, feature: feature.id, title: task.title, x: bx, y: ty, side, slot,
                state: task.state, col, signs: task.signs, lines: taskLines, up: false,
                done: task.state === 'done' ? 1 : 0, total: 1, marks: marksOf([task.signs]),
                center: { x: bx, y: ty },
                label: { x: bx + side * 16, y: ty + 4 - (taskLines.length - 1) * 6, anchor: side < 0 ? 'end' : 'start', lines: taskLines, step: 12 },
              })
            })
          }
          cursor = cy + FR + 24
          return
        }
        const level = 1 + Math.floor(k / 2)
        const bx = x + 34 + k * 22
        const by = SPINE_Y + side * level * LV
        const length = featureOpen ? BR + 34 + feature.tasks.length * TS : 120
        const ex = bx + BR + length
        branches.push({ id: feature.id, milestone: milestone.id, points: [[bx, SPINE_Y], [bx + BR, by], [ex, by]], col, lit: state !== 'later' })
        const cx = ex + FR
        nodes.push({
          kind: 'f', id: feature.id, milestone: milestone.id, title: feature.title, x: ex, y: by, side, state, col, open: featureOpen,
          done: featureDone, total: feature.tasks.length, marks: featureMarks,
          center: { x: cx, y: by }, elbow: { x: bx + BR, y: by },
          label: featureOpen ? { x: cx + FR + 8, y: by + 4, anchor: 'start' } : { x: bx + BR + 6, y: by + (side < 0 ? -10 : 18), anchor: 'start' },
          countAt: { x: cx, y: by + 4 }, chevronAt: { x: cx, y: by + side * (FR + 16) },
        })
        if (featureOpen) {
          feature.tasks.forEach((task, slot) => {
            const tx = bx + BR + 36 + slot * TS
            const lines = wrap(task.title)
            const up = (slot % 2 === 0) === (side < 0)
            const ty = up ? by - 22 : by + 32
            nodes.push({
              kind: 't', id: task.id, milestone: milestone.id, feature: feature.id, title: task.title, x: tx, y: by, side, slot,
              state: task.state, col, signs: task.signs, lines, up,
              done: task.state === 'done' ? 1 : 0, total: 1, marks: marksOf([task.signs]),
              center: { x: tx, y: by },
              label: { x: tx, y: up ? ty - (lines.length - 1) * 12 : ty, anchor: 'middle', lines, step: 12 },
            })
          })
        }
        span = Math.max(span, ex - x + (featureOpen ? 120 : 90))
      })
      // Clear of the last feature's chevron, which sits under its circle and would meet the next milestone's chevron.
      if (vertical) span = Math.max(span, cursor - x + 36)
    }
    milestoneEnd.set(milestone.id, vertical && isOpen ? cursor : x + 30)
    x += span
  })
  const end = x + 40
  const firstOpen = model.milestones.findIndex(milestone => milestone.features.some(feature => feature.tasks.some(task => task.state !== 'done')))
  let nowAlong = end - 40
  if (firstOpen >= 0) {
    const milestone = model.milestones[firstOpen]
    const tasks = milestone.features.flatMap(feature => feature.tasks)
    const fraction = tasks.length ? tasks.filter(task => task.state === 'done').length / tasks.length : 0
    const here = milestoneX.get(milestone.id) ?? 0
    const next = model.milestones[firstOpen + 1] ? milestoneX.get(model.milestones[firstOpen + 1].id) ?? end - 40 : end - 40
    nowAlong = here + fraction * (next - here) * 0.6
    // "Now" is a landmark: it never sits under the milestone's circle. Vertical, its pill also clears the title's second line.
    const radius = open.has(milestone.id) ? 15 : 26
    if (vertical) {
      if (Math.abs(nowAlong - here) <= radius + 16) nowAlong = here + radius + 20
    } else if (Math.abs(nowAlong - here) <= radius + 8) nowAlong = here + radius + 12
  }
  const bands: Band[] = []
  if (showSprints) {
    model.sprints.forEach((sprint, k) => {
      const xs = sprint.milestones.map(item => milestoneX.get(item.id)).filter((value): value is number => typeof value === 'number')
      if (!xs.length) return
      const parts = sprint.milestones.map(item => {
        const milestone = model.milestones.find(candidate => candidate.id === item.id)
        return `${item.count} of ${item.total} tasks of ${clip(milestone?.title ?? item.id, 18)}`
      }).join(' · ')
      if (vertical) {
        // A thin bar left of the spine over its milestones' stretch, the name above it; the "4 of 7" parts stay in the tooltip.
        const ends = sprint.milestones.map(item => milestoneEnd.get(item.id)).filter((value): value is number => typeof value === 'number')
        const top = Math.min(...xs) - 30
        const bar = -62 - k * BAND_GAP
        bands.push({
          name: sprint.name, rect: { x: bar - 4, y: top, w: 8, h: Math.max(...ends) - top }, labelAt: { x: bar + 4, y: top - 6, anchor: 'end' }, partsAt: null,
          col: SPRINT_COLORS[k % SPRINT_COLORS.length], parts,
        })
        return
      }
      const left = Math.min(...xs) - 30
      // Wide enough for its own label, as the label is the point of the band.
      const needed = 24 + sprint.name.length * 6.4 + parts.length * 5.3
      const right = Math.max(Math.max(...xs) + 30, left + needed)
      const by = SPINE_Y + 70 + k * 30
      bands.push({
        name: sprint.name, rect: { x: left, y: by, w: right - left, h: 22 }, labelAt: { x: left + 10, y: by + 15, anchor: 'start' },
        partsAt: { x: left + 12 + sprint.name.length * 6.4 + 10, y: by + 15 },
        col: SPRINT_COLORS[k % SPRINT_COLORS.length], parts,
      })
    })
  }
  const starts = model.milestones.map(milestone => milestoneX.get(milestone.id) ?? 0)
  const slots = model.milestones.map((milestone, index): Slot => ({
    id: milestone.id,
    from: index === 0 ? -Infinity : starts[index] - 40,
    to: index === starts.length - 1 ? Infinity : starts[index + 1] - 40,
  }))
  if (!vertical) {
    return {
      axis: 'x', slots, width: end, height: HEIGHT, spine: { from: [16, SPINE_Y], to: [end - 14, SPINE_Y] }, now: { x: nowAlong, y: SPINE_Y },
      nodes, branches, bands,
    }
  }
  // The drawing is as wide as the text and circles reach on both sides of the spine.
  let left = 0
  let right = 0
  for (const node of nodes) {
    const size = node.kind === 't' ? 5.6 : 6.8
    const reach = node.label.lines ? textWidth(node.label.lines, size) : 0
    const from = node.label.anchor === 'end' ? node.label.x - reach : node.label.x
    const to = node.label.anchor === 'end' ? node.label.x : node.label.x + reach
    left = Math.min(left, from, node.kind === 'm' ? node.chevronAt.x - 20 : node.center.x - FR)
    right = Math.max(right, to, node.kind === 'm' ? 0 : node.center.x + FR)
  }
  for (const band of bands) left = Math.min(left, band.labelAt.x - band.name.length * 6.4, band.rect.x)
  return {
    axis: 'y', slots, width: right - left, height: end, spine: { from: [0, 16], to: [0, end - 14] }, now: { x: 0, y: nowAlong },
    nodes, branches, bands,
  }
}
