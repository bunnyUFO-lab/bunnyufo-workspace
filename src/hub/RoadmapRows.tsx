import { useMemo, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent } from 'react'
import type { ProgressMap, TaskState } from '../lib/hub'
import { mapHash, projectHash } from '../lib/route'
import { FULL, UNFILED_TITLE, branchTarget, childrenOf, crumbs, rowsOf, type Resolved } from './mapBranch.ts'
import { savedBranch } from './branchMemory.ts'
import { mapMatches, savedQuery, saveQuery } from './mapSearch.ts'
import { words, type SearchRow } from './beadSearch.ts'
import { STATE_COLOR, find } from './mapState'
import SearchField from './SearchField'
import { useHubData } from './useHub'
import './roadmaps.css'

/** The Roadmap's bar when a project has roadmaps: where you are (crumbs, and the roadmaps inside this one) and the Full map / This branch toggle. One row, so it takes the project chips' place on a phone. */
export function RoadmapBar({ project, projectName, model, view }: { project: string; projectName: string; model: ProgressMap; view: Resolved }) {
  const branch = view.view === 'branch' ? view.branch : undefined
  const chain = branch ? crumbs(model, branch) : []
  const inside = branch ? childrenOf(model, branch) : []
  const strip = useRef<HTMLDivElement>(null)
  // The last crumb is the one in view; a long chain scrolls to it.
  const lastCrumb = (element: HTMLElement | null) => { if (element && strip.current) strip.current.scrollLeft = element.offsetLeft }
  const target = branchTarget(model, savedBranch(project))
  const here = chain[chain.length - 1]
  return (
    <nav className="hub-map-branchbar" aria-label="Roadmaps" data-roadmap-bar>
      <div className="rm-crumbs" ref={strip}>
        <a className="rm-crumb" href={projectHash(project)} data-crumb="project">{projectName}</a>
        {chain.slice(0, -1).map(crumb => (
          <a key={crumb.id} className="rm-crumb" href={mapHash(project, crumb.id)} data-crumb={crumb.id}><span className="rm-sep" aria-hidden="true">›</span>{crumb.title}</a>
        ))}
        {here && <span className="rm-crumb now" aria-current="location" data-crumb={here.id} ref={lastCrumb}><span className="rm-sep" aria-hidden="true">›</span>{here.title}</span>}
        {inside.length > 0 && (
          <span className="rm-inside">
            <span className="rm-label">Inside:</span>
            {inside.map(child => <a key={child.id} className="rm-crumb" href={mapHash(project, child.id)} data-inside={child.id}>{child.title}</a>)}
          </span>
        )}
      </div>
      <div className="rm-toggle" role="group" aria-label="View">
        <a href={mapHash(project, FULL)} aria-current={view.view === 'full' ? 'page' : undefined} data-roadmap-toggle="full">Full map</a>
        <a href={mapHash(project, target)} aria-current={view.view === 'branch' ? 'page' : undefined} data-roadmap-toggle="branch">This branch</a>
      </div>
    </nav>
  )
}

/** A row's dots: one per own milestone, in its state's colour. Decoration: the row's words say the count. */
function Dots({ dots }: { dots: { id: string; state: TaskState }[] }) {
  return <span className="rm-dots" aria-hidden="true">{dots.map(dot => <i key={dot.id} data-state={dot.state} style={{ '--dot': STATE_COLOR[dot.state] } as CSSProperties} />)}</span>
}

/** The nested rows under a root, each a whole link into that branch. `highlight` is the branch the viewer came from. */
export function RoadmapList({ project, model, root = FULL, highlight }: { project: string; model: ProgressMap; root?: string; highlight?: string }) {
  const rows = useMemo(() => rowsOf(model, root), [model, root])
  if (!rows.length) return <p className="hub-empty" data-roadmap-empty>No roadmaps here yet.</p>
  return (
    <ul className="rm-rows" data-roadmap-rows>
      {rows.map(row => (
        <li key={row.id} style={{ '--depth': Math.min(row.depth, 3) } as CSSProperties}>
          <a className={`rm-row${row.id === highlight ? ' from' : ''}${row.state === 'done' ? ' closed' : ''}`} href={mapHash(project, row.id)} data-roadmap-row={row.id} data-depth={row.depth}>
            <span className="rm-row-head">
              <span className="rm-row-title">{row.title}</span>
              <span className="rm-row-count">{row.dots.length ? `${row.done} of ${row.dots.length} done` : row.inside ? `${row.inside} inside` : 'no milestones yet'}</span>
              {row.id === highlight && <span className="rm-from">where you came from</span>}
            </span>
            <Dots dots={row.dots} />
          </a>
        </li>
      ))}
    </ul>
  )
}

/** The Full map: a search over the whole project, then the rows. Rooted at a branch that has no milestones of its own, it shows what is inside. */
export default function RoadmapRows({ project, model, root = FULL, search = true }: { project: string; model: ProgressMap; root?: string; search?: boolean }) {
  const [query, setQuery] = useState(savedQuery)
  const searching = search && query.trim().length > 0
  const text = useHubData<{ rows: SearchRow[] }>(searching ? `/search-text?project=${encodeURIComponent(project)}` : null)
  const matches = useMemo(() => mapMatches(model, query, searching ? text.data?.rows : undefined), [model, query, searching, text.data])
  const change = (value: string) => { setQuery(value); saveQuery(value) }
  const onKey = (event: KeyboardEvent<HTMLInputElement>) => { if (event.key === 'Escape' && query) { event.preventDefault(); change('') } }
  const where = (id: string) => { const hit = find(model, id); return hit ? (hit.milestone.roadmap ? model.roadmaps?.find(roadmap => roadmap.id === hit.milestone.roadmap)?.title : UNFILED_TITLE) : undefined }
  const titleOf = (id: string) => { const hit = find(model, id); return hit ? (hit.kind === 'm' ? hit.milestone.title : hit.kind === 'f' ? hit.feature.title : hit.task.title) : id }
  const done = !!(text.data || text.error)
  return (
    <section className="rm-full" data-roadmap-full aria-label="Roadmaps">
      {search && (
        <div className="rm-search">
          <SearchField label="Search the roadmap" placeholder="Search the roadmap" value={query} onChange={change} onKeyDown={onKey} data={{ 'data-roadmap-search': '' }} />
          {searching && <span className="rm-found" role="status" data-roadmap-count>{matches.order.length ? `${matches.order.length} ${matches.order.length === 1 ? 'match' : 'matches'}` : done ? 'No matches' : 'Searching…'}</span>}
        </div>
      )}
      {searching && words(query).length > 0
        ? (
          <ul className="rm-hits" data-roadmap-hits>
            {matches.order.map(id => (
              <li key={id}><a className="rm-hit" href={mapHash(project, id)} data-roadmap-hit={id}><span className="rm-hit-title">{titleOf(id)}</span><span className="rm-hit-where">{where(id) ?? id}</span></a></li>
            ))}
          </ul>
        )
        : <RoadmapList project={project} model={model} root={root} highlight={root === FULL ? savedBranch(project)?.branch : undefined} />}
    </section>
  )
}
