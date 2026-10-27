// The progress map's layout: where each milestone, feature and task sits on the line. A pure port
// of the prototype's layout (constants and rules unchanged); the SVG itself is drawn by
// ProgressMap.tsx from what this returns, as React elements, so a title can never become markup.
import type { MapMilestone, ProgressMap, Sign, TaskState } from '../lib/hub'

export const SPINE_Y = 230
export const LV = 78
export const TS = 92
export const BR = 40
export const HEIGHT = 470
/** Milestone colours cycle through these tokens (styles/tokens.css). */
export const MILESTONE_COLORS = ['var(--red)', 'var(--amber)', 'var(--blue)', 'var(--green)', 'var(--purple)', 'var(--pink)']
export const SPRINT_COLORS = ['var(--purple)', 'var(--blue)', 'var(--amber)', 'var(--green)', 'var(--pink)']

export interface Marks { working: boolean; idle: boolean; prs: number; review: number; failing: number; fresh: boolean; deployed: boolean }

interface Base { id: string; x: number; y: number; state: TaskState; col: string; marks: Marks; title: string; done: number; total: number }
export interface MilestoneNode extends Base { kind: 'm'; index: number; open: boolean }
export interface FeatureNode extends Base { kind: 'f'; milestone: string; side: 1 | -1; open: boolean; labelX: number }
export interface TaskNode extends Base { kind: 't'; milestone: string; feature: string; side: 1 | -1; slot: number; signs: Sign[]; lines: string[]; up: boolean }
export type MapNode = MilestoneNode | FeatureNode | TaskNode

export interface Branch { id: string; milestone: string; x0: number; y0: number; x1: number; y1: number; x2: number; col: string; lit: boolean }
export interface Band { name: string; x1: number; x2: number; y: number; col: string; parts: string }
export interface Layout {
  width: number
  height: number
  spineY: number
  nowX: number
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

/**
 * @param open ids of the milestones and features that are open
 */
export function layoutMap(model: ProgressMap, open: ReadonlySet<string>, showSprints: boolean): Layout {
  let x = 120
  const nodes: MapNode[] = []
  const branches: Branch[] = []
  const milestoneX = new Map<string, number>()
  model.milestones.forEach((milestone: MapMilestone, index) => {
    const tasks = milestone.features.flatMap(feature => feature.tasks)
    const col = MILESTONE_COLORS[index % MILESTONE_COLORS.length]
    const isOpen = open.has(milestone.id)
    milestoneX.set(milestone.id, x)
    nodes.push({
      kind: 'm', id: milestone.id, title: milestone.title, x, y: SPINE_Y, state: milestone.state, col, index, open: isOpen,
      done: tasks.filter(task => task.state === 'done').length, total: tasks.length, marks: marksOf(tasks.map(task => task.signs)),
    })
    let span = Math.max(170, milestone.title.length * 7 + 30)
    if (isOpen) {
      milestone.features.forEach((feature, k) => {
        const side: 1 | -1 = k % 2 ? 1 : -1
        const level = 1 + Math.floor(k / 2)
        const bx = x + 34 + k * 22
        const by = SPINE_Y + side * level * LV
        const featureOpen = open.has(feature.id)
        const length = featureOpen ? BR + 34 + feature.tasks.length * TS : 120
        const ex = bx + BR + length
        const state = feature.state
        branches.push({ id: feature.id, milestone: milestone.id, x0: bx, y0: SPINE_Y, x1: bx + BR, y1: by, x2: ex, col, lit: state !== 'later' })
        nodes.push({
          kind: 'f', id: feature.id, milestone: milestone.id, title: feature.title, x: ex, y: by, side, state, col, open: featureOpen, labelX: bx + BR + 6,
          done: feature.tasks.filter(task => task.state === 'done').length, total: feature.tasks.length, marks: marksOf(feature.tasks.map(task => task.signs)),
        })
        if (featureOpen) {
          feature.tasks.forEach((task, slot) => {
            nodes.push({
              kind: 't', id: task.id, milestone: milestone.id, feature: feature.id, title: task.title, x: bx + BR + 36 + slot * TS, y: by, side, slot,
              state: task.state, col, signs: task.signs, lines: wrap(task.title), up: (slot % 2 === 0) === (side < 0),
              done: task.state === 'done' ? 1 : 0, total: 1, marks: marksOf([task.signs]),
            })
          })
        }
        span = Math.max(span, ex - x + (featureOpen ? 120 : 90))
      })
    }
    x += span
  })
  const width = x + 40
  const firstOpen = model.milestones.findIndex(milestone => milestone.features.some(feature => feature.tasks.some(task => task.state !== 'done')))
  let nowX = width - 40
  if (firstOpen >= 0) {
    const milestone = model.milestones[firstOpen]
    const tasks = milestone.features.flatMap(feature => feature.tasks)
    const fraction = tasks.length ? tasks.filter(task => task.state === 'done').length / tasks.length : 0
    const here = milestoneX.get(milestone.id) ?? 0
    const next = model.milestones[firstOpen + 1] ? milestoneX.get(model.milestones[firstOpen + 1].id) ?? width - 40 : width - 40
    nowX = here + fraction * (next - here) * 0.6
    // "Now" is a landmark: it never sits under the milestone's circle.
    const radius = open.has(milestone.id) ? 15 : 26
    if (Math.abs(nowX - here) <= radius + 8) nowX = here + radius + 12
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
      const left = Math.min(...xs) - 30
      // Wide enough for its own label, as the label is the point of the band.
      const needed = 24 + sprint.name.length * 6.4 + parts.length * 5.3
      bands.push({ name: sprint.name, x1: left, x2: Math.max(Math.max(...xs) + 30, left + needed), y: SPINE_Y + 70 + k * 30, col: SPRINT_COLORS[k % SPRINT_COLORS.length], parts })
    })
  }
  return { width, height: HEIGHT, spineY: SPINE_Y, nowX, nodes, branches, bands }
}
