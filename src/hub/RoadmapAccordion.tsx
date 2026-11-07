import { useDeferredValue, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent, MouseEvent } from 'react'
import type { MapTask, ProgressMap as MapModel, Sign } from '../lib/hub'
import { remember } from '../lib/hub'
import { useEntryMemo } from '../lib/entries'
import { mapHash, projectAtHash, projectNodeHash } from '../lib/route'
import { Fold, List } from '../ui/Layout'
import { foldOpen, readOpen } from '../ui/foldState.ts'
import Icon from '../ui/Icon'
import { words, type SearchRow } from './beadSearch.ts'
import { useHideDone, writeHideDone } from './hideDone'
import { tallyWords } from './mapCount.ts'
import { mapMatches } from './mapSearch.ts'
import { STATE_LABEL } from './mapState'
import ProjectRing from './ProjectRing'
import SearchField from './SearchField'
import { SIGN_GLYPH, SIGN_LABEL } from './signs'
import { TASK_PAGE } from './projectPage.ts'
import { buildTree, keepFor, keysOf, pageSize, pruneOpen, resolveTarget, startOpen, storeKey, subLine, walk, type MsNode, type RmNode, type Target, type TNode } from './roadmapTree.ts'
import { useHubData } from './useHub'

type OpenNode = (event: MouseEvent<HTMLAnchorElement>, href: string) => void

const STATE_DOT: Record<string, string> = { done: 'done', doing: 'working', you: 'needs', next: '', later: '' }

interface Ctx {
  project: string
  sprint?: string
  mapRoom: boolean
  searching: boolean
  /** The row an `at` address names, marked until the address changes. */
  target: Target | null
  isOpen: (key: string) => boolean
  toggle: (key: string) => void
  shown: Record<string, number>
  more: (key: string, by: number) => void
  onOpen: OpenNode
}

function TaskRow({ task, ctx }: { task: MapTask; ctx: Ctx }) {
  const href = projectNodeHash(ctx.project, task.id, ctx.sprint)
  const here = ctx.target?.task === task.id
  const state = task.state === 'later' && task.status === 'deferred' ? 'later' : STATE_LABEL[task.state]
  return (
    <a role="listitem" className={`ui-row pj-task${task.state === 'done' ? ' dim' : ''}`} href={href} onClick={event => ctx.onOpen(event, href)} data-pp-task={task.id} data-pp-node={task.id} data-state={task.state} data-roadmap-at={here ? '' : undefined} aria-current={here ? 'true' : undefined}>
      <span className={`pj-dot ${STATE_DOT[task.state] ?? ''}`} aria-hidden="true" />
      <span className="ui-row-body"><b>{task.title}</b><small>{task.id} · {state}</small></span>
      {task.signs.length > 0 && <span className="pj-signs">{task.signs.map(sign => <span key={sign} className="pj-sign" role="img" title={SIGN_LABEL[sign as Sign]} aria-label={SIGN_LABEL[sign as Sign]}>{SIGN_GLYPH[sign as Sign]}</span>)}</span>}
    </a>
  )
}

function Milestone({ node, ctx, level }: { node: MsNode; ctx: Ctx; level: 3 | 4 }) {
  const open = ctx.isOpen(node.key)
  const href = projectNodeHash(ctx.project, node.id, ctx.sprint)
  const here = ctx.target?.kind === 'milestone' && ctx.target.id === node.id
  const asked = ctx.shown[node.key] ?? TASK_PAGE
  const size = open ? pageSize(node.tasks, asked, TASK_PAGE, ctx.target?.task) : 0
  const left = node.tasks.length - size
  const data: Record<string, string> = { 'data-pp-milestone': node.id, 'data-state': node.state, 'data-open': String(open) }
  if (here) { data['data-roadmap-at'] = ''; data['aria-current'] = 'true' }
  return (
    <Fold
      level={level} title={node.title} sub={<span data-pp-count>{subLine({ now: node.current, state: node.state, stateWord: STATE_LABEL[node.state], tally: tallyWords(node.tally) })}</span>}
      end={<ProjectRing tally={node.tally} />} open={open} onToggle={ctx.searching ? undefined : () => ctx.toggle(node.key)} data={data}
    >
      <List label={`Tasks in ${node.title}`}>
        {node.details && (
          <a role="listitem" className="ui-row pj-task pj-details" href={href} onClick={event => ctx.onOpen(event, href)} data-pp-details={node.id} data-pp-node={node.id}>
            <span className="ui-row-body"><b>Milestone details</b><small>Sprint, questions and what it holds</small></span>
            <span className="pj-chev" aria-hidden="true"><Icon name="chev" size={18} /></span>
          </a>
        )}
        {node.tasks.length === 0 && !ctx.searching && <p className="hub-empty">{node.all ? 'Nothing left to do here.' : 'No tasks yet.'}</p>}
        {node.tasks.slice(0, size).map(task => <TaskRow key={task.id} task={task} ctx={ctx} />)}
        {left > 0 && (
          <>
            <button type="button" className="ui-row pj-more" role="listitem" onClick={() => ctx.more(node.key, TASK_PAGE)} data-pp-more={node.id}>
              <span className="ui-row-body"><b>Show more</b><small>{left} more</small></span>
            </button>
            <button type="button" className="ui-row pj-more" role="listitem" onClick={() => ctx.more(node.key, left)} data-pp-all={node.id}>
              <span className="ui-row-body"><b>Show all {node.tasks.length}</b></span>
            </button>
          </>
        )}
      </List>
    </Fold>
  )
}

function Roadmap({ node, ctx, depth }: { node: RmNode; ctx: Ctx; depth: number }) {
  const open = ctx.isOpen(node.key)
  const here = ctx.target?.kind === 'roadmap' && ctx.target.id === node.id
  const data: Record<string, string> = { 'data-roadmap-row': node.id, 'data-depth': String(depth), 'data-state': node.state }
  if (here) { data['data-roadmap-at'] = ''; data['aria-current'] = 'true' }
  return (
    <Fold
      level={depth === 0 ? 3 : 4} title={node.title} sub={subLine({ state: node.state, stateWord: STATE_LABEL[node.state], tally: tallyWords(node.tally) })}
      end={<ProjectRing tally={node.tally} />} open={open} onToggle={ctx.searching ? undefined : () => ctx.toggle(node.key)} data={data}
    >
      {ctx.mapRoom && !ctx.searching && <p className="pj-map-link"><a className="pp-link" href={mapHash(ctx.project, node.id, ctx.sprint)} data-roadmap-map={node.id}>Map of this roadmap ›</a></p>}
      <Nodes nodes={node.children} ctx={ctx} depth={depth + 1} />
    </Fold>
  )
}

function Nodes({ nodes, ctx, depth }: { nodes: TNode[]; ctx: Ctx; depth: number }) {
  return (
    <>
      {nodes.map(node => (node.kind === 'r' ? <Roadmap key={node.key} node={node} ctx={ctx} depth={depth} /> : <Milestone key={node.key} node={node} ctx={ctx} level={depth === 0 ? 3 : 4} />))}
    </>
  )
}

/**
 * The Roadmap as an accordion: roadmaps (nested), milestones, then tasks, each a Fold. The current milestone starts open; what the person opens or
 * closes is kept per project (and per sprint) in this browser. A search shows its matches opened without writing that; an `at` address opens the
 * folds above a row for now (not kept) and marks it. The parent keys it on the project and the sprint.
 */
export default function RoadmapAccordion({ project, model, scoped, sprint, at, mapRoom, onOpen }: {
  project: string; model: MapModel; /** The sprint's own map, when one is on. */ scoped?: MapModel; sprint?: string; /** The bead or roadmap an `at` address names. */ at?: string; mapRoom: boolean; onOpen: OpenNode
}) {
  const shownModel = scoped ?? model
  const hideDone = useHideDone()
  const [query, setQuery] = useEntryMemo('roadmap-query', '')
  const deferred = useDeferredValue(query)
  const searching = words(deferred).length > 0
  const text = useHubData<{ rows: SearchRow[] }>(searching ? `/search-text?project=${encodeURIComponent(project)}` : null)
  const matches = useMemo(() => (searching ? mapMatches(shownModel, deferred, text.data?.rows) : null), [searching, shownModel, deferred, text.data])

  // The row an address names, when there is one and no search is looking at something else.
  const target = useMemo(() => (searching ? null : resolveTarget(shownModel, at)), [searching, shownModel, at])
  const outside = !searching && !!at && !target && !!scoped && !!resolveTarget(model, at)
  const keep = useMemo(() => keepFor(target), [target])
  const base = useMemo(() => buildTree(shownModel, { hideDone, keep }), [shownModel, hideDone, keep])
  const tree = useMemo(() => (matches ? buildTree(shownModel, { hideDone, matches }) : base), [matches, shownModel, hideDone, base])
  const start = useMemo(() => startOpen(base, !!sprint), [base, sprint])
  const keys = useMemo(() => keysOf(base.roots), [base])

  const store = storeKey(project, sprint)
  const [stored, setStored] = useState<Record<string, boolean>>(() => readOpen(remember(store)))
  // Folds opened for now by an address: not stored. Set while drawing when the address changes, so the row shows in the same frame.
  const [reveal, setReveal] = useState<{ at: string; keys: Set<string> }>({ at: '', keys: new Set() })
  const revealKey = target ? `${at}` : ''
  if (reveal.at !== revealKey) setReveal({ at: revealKey, keys: new Set(target?.reveal ?? []) })
  const [shown, setShown] = useState<Record<string, number>>({})

  const isOpen = (key: string) => searching || reveal.keys.has(key) || foldOpen(key, stored, start.has(key))
  const write = (next: Record<string, boolean>) => {
    const kept = pruneOpen(next, start, keys)
    setStored(kept)
    remember(store, JSON.stringify(kept))
  }
  const toggle = (key: string) => {
    const now = isOpen(key)
    if (reveal.keys.has(key)) { const rest = new Set(reveal.keys); rest.delete(key); setReveal({ at: reveal.at, keys: rest }) }
    write({ ...stored, [key]: !now })
  }
  const setAll = (value: boolean) => {
    const next: Record<string, boolean> = {}
    walk(base.roots, node => { next[node.key] = value })
    if (!value) setReveal({ at: reveal.at, keys: new Set() })
    write(next)
  }

  const ctx: Ctx = {
    project, sprint, mapRoom, searching, target, isOpen, toggle, shown, onOpen,
    more: (key, by) => setShown(value => ({ ...value, [key]: (value[key] ?? TASK_PAGE) + by })),
  }
  const count = matches?.order.length ?? 0
  const loaded = !!(text.data || text.error)
  const onKey = (event: KeyboardEvent<HTMLInputElement>) => { if (event.key === 'Escape' && query) { event.preventDefault(); setQuery('') } }

  // Once per address, when its row exists: bring it to the middle of the screen and give it the focus.
  const landed = useRef('')
  useLayoutEffect(() => {
    if (!target || landed.current === revealKey) return
    const row = document.querySelector<HTMLElement>('[data-roadmap-at]')
    if (!row) return
    landed.current = revealKey
    // A milestone or roadmap is a whole section, which can be taller than the screen: it is the head that goes to the middle.
    const focusable = row.matches('a, button') ? row : row.querySelector<HTMLElement>('.ui-fold-head') ?? row
    focusable.scrollIntoView({ block: 'center' })
    focusable.focus({ preventScroll: true })
  })

  const none = tree.roots.length === 0
  const everythingDone = hideDone && !searching && none && shownModel.milestones.length > 0
  return (
    <div className="pj-roadmap" data-pp-roadmap>
      <div className="pj-tools">
        <div className="pj-search"><SearchField label="Search the roadmap" placeholder="Search the roadmap" value={query} onChange={setQuery} onKeyDown={onKey} data={{ 'data-roadmap-list-search': '' }} /></div>
        {!searching && (
          <div className="pj-fold-all">
            <button type="button" className="hub-btn" data-roadmap-expand onClick={() => setAll(true)}>Expand all</button>
            <button type="button" className="hub-btn" data-roadmap-collapse onClick={() => setAll(false)}>Collapse all</button>
          </div>
        )}
      </div>
      {searching && <p className="hub-muted pj-found" role="status" data-roadmap-list-count>{count ? `${count} ${count === 1 ? 'match' : 'matches'}` : loaded ? 'No matches' : 'Searching…'}</p>}
      {outside && at && (
        <p className="hub-muted" data-roadmap-outside role="status">Not in this sprint. <a className="pp-link" href={projectAtHash(project, at)} data-roadmap-outside-link>Show it in the whole roadmap ›</a></p>
      )}
      {shownModel.milestones.length === 0 && <p className="hub-empty">No milestones yet.</p>}
      {everythingDone && <p className="hub-empty" data-pp-all-done>Everything here is done. <button type="button" className="hub-btn" data-pp-show-done onClick={() => writeHideDone(false)}>Show completed</button></p>}
      <Nodes nodes={tree.roots} ctx={ctx} depth={0} />
    </div>
  )
}
