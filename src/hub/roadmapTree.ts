// The Roadmap as an accordion (ws-cl0.16.7), the parts with no screen in them: the tree of roadmaps, milestones and tasks, what starts open, what a
// search or a link to a row opens, and what is kept of the person's own opening and closing. Pure, so a node test covers it.
// `.ts` imports with the suffix so node can read this file.
import type { MapMilestone, MapTask, ProgressMap, TaskState } from '../lib/hub.ts'
import { UNFILED, UNFILED_TITLE, childrenOf, ownMilestones } from './mapBranch.ts'
import { tallyOf, type Tally } from './mapCount.ts'
import type { MapMatches } from './mapSearch.ts'
import { find } from './mapState.ts'
import { currentMilestone, orderTasks, tasksOfMilestone } from './projectPage.ts'
import { roll } from './sprintScope.ts'

export interface MsNode {
  kind: 'm'; key: string; id: string; title: string; state: TaskState; tally: Tally
  /** The milestone the work is in: its sub line starts with "Now". */
  current: boolean
  /** The tasks to list, open ones first, after Hide completed or a search. */
  tasks: MapTask[]
  /** Every task of the milestone, finished ones too (the tally counts these). */
  all: number
  /** The "Milestone details" row: always, except while a search matched only features or tasks of it. */
  details: boolean
}
export interface RmNode { kind: 'r'; key: string; id: string; title: string; state: TaskState; tally: Tally; children: TNode[] }
export type TNode = RmNode | MsNode

export const rmKey = (id: string) => `r/${id}`
export const msKey = (id: string) => `m/${id}`

export interface TreeOptions {
  hideDone: boolean
  /** The nodes a search matched: only they and what holds them are listed, and Hide completed does not apply. */
  matches?: MapMatches | null
  /** Ids that stay listed whatever Hide completed says (the row a link points at). */
  keep?: ReadonlySet<string>
}

export interface Tree { roots: TNode[]; /** The milestone the work is in (its key), when there is one. */ current?: string }

/** The milestone the list starts on: the current one, else the first that is not done (as the list always did). */
export function startMilestone(model: Pick<ProgressMap, 'milestones'>): MapMilestone | undefined {
  return currentMilestone(model) ?? model.milestones.find(milestone => milestone.state !== 'done')
}

const finished = (node: TNode) => node.state === 'done'
/** Open first, then finished, each in model order (the sort is stable). */
const openFirst = (nodes: TNode[]) => [...nodes.filter(node => !finished(node)), ...nodes.filter(finished)]

/** Build the tree of a model (the whole project, or a sprint's own, which has no roadmaps). */
export function buildTree(model: ProgressMap, options: TreeOptions): Tree {
  const { hideDone, matches, keep } = options
  const start = startMilestone(model)
  const searching = !!matches
  const seen = new Set<string>()

  const milestone = (source: MapMilestone): MsNode | null => {
    const everyTask = tasksOfMilestone(source)
    const own = matches?.ids.has(source.id) ?? false
    let tasks: MapTask[]
    if (matches) {
      if (!matches.lit.has(source.id)) return null
      const picked = new Set<string>()
      for (const feature of source.features) {
        const featureHit = matches.ids.has(feature.id)
        for (const task of feature.tasks) if (featureHit || matches.ids.has(task.id)) picked.add(task.id)
      }
      tasks = orderTasks(everyTask.filter(task => picked.has(task.id)))
    } else {
      const wanted = keep?.has(source.id) || source.features.some(feature => keep?.has(feature.id))
      if (hideDone && source.state === 'done' && !wanted && !everyTask.some(task => keep?.has(task.id))) return null
      tasks = orderTasks(hideDone ? everyTask.filter(task => task.state !== 'done' || keep?.has(task.id)) : everyTask)
    }
    return {
      kind: 'm', key: msKey(source.id), id: source.id, title: source.title, state: source.state, tally: tallyOf(everyTask),
      current: !searching && start?.id === source.id, tasks, all: everyTask.length,
      details: !matches || own,
    }
  }

  const roadmapNode = (id: string, title: string, state: TaskState, milestones: MapMilestone[], inside: ReturnType<typeof childrenOf>): RmNode | null => {
    if (seen.has(id)) return null
    seen.add(id)
    const kids: TNode[] = []
    for (const item of milestones) { const node = milestone(item); if (node) kids.push(node) }
    for (const child of inside) {
      const node = roadmapNode(child.id, child.title, child.state, ownMilestones(model, child.id), childrenOf(model, child.id))
      if (node) kids.push(node)
    }
    // The tally counts everything below, whatever Hide completed or a search leaves out.
    const walked = new Set<string>()
    const below = (idv: string): MapMilestone[] => {
      if (walked.has(idv)) return []
      walked.add(idv)
      return [...ownMilestones(model, idv), ...childrenOf(model, idv).flatMap(item => below(item.id))]
    }
    const tally = tallyOf(below(id).flatMap(tasksOfMilestone))
    if (matches && kids.length === 0) return null
    if (!matches && hideDone && state === 'done' && !keep?.has(id) && kids.length === 0) return null
    return { kind: 'r', key: rmKey(id), id, title, state, tally, children: openFirst(kids) }
  }

  const roots: TNode[] = []
  if (model.roadmaps?.length) {
    const tops: TNode[] = []
    for (const top of childrenOf(model)) {
      const node = roadmapNode(top.id, top.title, top.state, ownMilestones(model, top.id), childrenOf(model, top.id))
      if (node) tops.push(node)
    }
    const unfiled = ownMilestones(model, UNFILED)
    if (unfiled.length) {
      const node = roadmapNode(UNFILED, UNFILED_TITLE, roll(unfiled.map(item => item.state)), unfiled, [])
      if (node) tops.push(node)
    }
    roots.push(...openFirst(tops))
  } else {
    const list: TNode[] = []
    for (const item of model.milestones) { const node = milestone(item); if (node) list.push(node) }
    roots.push(...openFirst(list))
  }
  return { roots, ...(start && !searching ? { current: msKey(start.id) } : {}) }
}

/** Every node of a tree, parents before children. */
export function walk(roots: TNode[], visit: (node: TNode, parent?: RmNode) => void, parent?: RmNode) {
  for (const node of roots) {
    visit(node, parent)
    if (node.kind === 'r') walk(node.children, visit, node)
  }
}

/** The keys of every fold in the tree. */
export function keysOf(roots: TNode[]): Set<string> {
  const keys = new Set<string>()
  walk(roots, node => keys.add(node.key))
  return keys
}

/** The keys that start open: the current milestone and the roadmaps above it, none when nothing is open. With a sprint on, every fold starts open. */
export function startOpen(tree: Tree, all: boolean): Set<string> {
  const open = new Set<string>()
  if (all) { walk(tree.roots, node => open.add(node.key)); return open }
  if (!tree.current) return open
  const chain: string[] = []
  const find = (nodes: TNode[], trail: string[]): boolean => {
    for (const node of nodes) {
      if (node.key === tree.current) { chain.push(...trail, node.key); return true }
      if (node.kind === 'r' && find(node.children, [...trail, node.key])) return true
    }
    return false
  }
  find(tree.roots, [])
  for (const key of chain) open.add(key)
  return open
}

/** The overrides to store: only keys that differ from where they start, and that the tree still has. A new current milestone therefore opens by itself. */
export function pruneOpen(stored: Record<string, boolean>, start: ReadonlySet<string>, keys: ReadonlySet<string>): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  for (const [key, value] of Object.entries(stored)) if (keys.has(key) && value !== start.has(key)) out[key] = value
  return out
}

/** The keys under which the open state is stored in this browser, for the project and, with a sprint on, its own. */
export const storeKey = (project: string, sprint?: string) => `hub.roadmap.open.${project}${sprint ? `.${sprint}` : ''}`

export interface Target {
  /** The row the link is to: a task, a milestone or a roadmap. */
  id: string
  kind: 'task' | 'milestone' | 'roadmap'
  /** The folds to open so the row shows. They are not stored. */
  reveal: string[]
  /** The task, when the row is one (it must be on the page of tasks). */
  task?: string
  /** The milestone a task or feature is in. */
  milestone?: string
}

/**
 * What an `at` address names, in this model. A bead the model knows opens its milestone and the roadmaps above it; a feature is shown on its
 * milestone; a roadmap id or `~unfiled` is that roadmap's row; `~full`, nothing and an unknown id name nothing.
 */
export function resolveTarget(model: ProgressMap, param: string | undefined): Target | null {
  if (!param) return null
  const above = (roadmap: string | undefined): string[] => {
    const keys: string[] = []
    const seen = new Set<string>()
    for (let at = roadmap; at && !seen.has(at); ) {
      seen.add(at)
      keys.unshift(rmKey(at))
      at = at === UNFILED ? undefined : model.roadmaps?.find(item => item.id === at)?.parent
    }
    return keys
  }
  const hasRoadmaps = !!model.roadmaps?.length
  const roadmapOf = (item: MapMilestone) => (hasRoadmaps ? item.roadmap ?? UNFILED : undefined)
  if (param === UNFILED) return hasRoadmaps && ownMilestones(model, UNFILED).length ? { id: UNFILED, kind: 'roadmap', reveal: [] } : null
  const roadmap = model.roadmaps?.find(item => item.id === param)
  if (roadmap) return { id: roadmap.id, kind: 'roadmap', reveal: above(roadmap.parent) }
  const hit = find(model, param)
  if (!hit) return null
  const trail = above(roadmapOf(hit.milestone))
  if (hit.kind === 'm') return { id: hit.milestone.id, kind: 'milestone', reveal: trail }
  if (hit.kind === 'f') return { id: hit.milestone.id, kind: 'milestone', reveal: [...trail, msKey(hit.milestone.id)], milestone: hit.milestone.id }
  return { id: hit.task.id, kind: 'task', reveal: [...trail, msKey(hit.milestone.id)], task: hit.task.id, milestone: hit.milestone.id }
}

/** The ids Hide completed must not remove for a target: the row itself and, for a task or feature, its milestone. */
export function keepFor(target: Target | null): Set<string> {
  const keep = new Set<string>()
  if (target) { keep.add(target.id); if (target.milestone) keep.add(target.milestone) }
  return keep
}

/** How many tasks of a milestone to list: the pages asked for, grown to the page that holds the target. */
export function pageSize(tasks: readonly MapTask[], asked: number, page: number, target?: string): number {
  const at = target ? tasks.findIndex(task => task.id === target) : -1
  return at < 0 ? asked : Math.max(asked, Math.ceil((at + 1) / page) * page)
}

/** "in progress · 12 of 40 done": the state word (left out when done, since the tally says it) and the tally. */
export function subLine(parts: { now?: boolean; state: TaskState; stateWord: string; tally: string }): string {
  return [parts.now ? 'Now' : '', parts.state === 'done' ? '' : parts.stateWord, parts.tally].filter(Boolean).join(' · ')
}
