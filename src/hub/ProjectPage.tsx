import { useEffect, useRef, useState } from 'react'
import type { MouseEvent } from 'react'
import type { HubProject, JobsView, MapMilestone, MapTask, ProgressMap as MapModel, ProjectCards, SprintPreview, Today as TodayData } from '../lib/hub'
import { ago } from '../lib/hub'
import { host } from '../lib/host'
import { needsHref } from '../lib/needsView.mjs'
import { useScope } from '../lib/useScope'
import { hubHash, mapHash, parseProjectId, projectHash, projectNodeHash, workBoardHash } from '../lib/route'
import { swap } from '../lib/entries'
import Icon from '../ui/Icon'
import { Button } from '../ui/Controls'
import MapPanel from './MapPanel'
import { CardWriteRows } from './CardWrites'
import { useCardWrites } from './cardWriteText'
import { JobItem } from './Jobs'
import NeedsRows from './NeedsRows'
import PlanInHermes from './PlanInHermes'
import ProgressMap from './ProgressMap'
import ProjectRing from './ProjectRing'
import RoadmapRows from './RoadmapRows'
import SprintPicker, { sprintCount } from './SprintPicker'
import { sprintModel, sprintsOf } from './sprintScope.ts'
import { useHideDone } from './hideDone'
import RunsOnChip, { RUNS_ON } from './RunsOnChip'
import WorkingNow from './WorkingNow'
import { tallyOf, tallyWords } from './mapCount.ts'
import { STATE_LABEL, find } from './mapState'
import { PROJECT_TABS, TASK_PAGE, currentMilestone, orderedTasks, roadmapList, tabCounts, tabOf, tasksOfMilestone } from './projectPage.ts'
import type { ProjectTab } from './projectPage.ts'
import { openSpawn } from './spawnStore'
import { legacyRunning } from './Today'
import { todayFor } from './todayFilter.ts'
import RefreshNote from './RefreshNote'
import { useHeldHubData, useHubData, useTodayScreen } from './useHub'
import './today.css'
import './work.css'
import './jobs.css'
import './project.css'
import './cardWrites.css'

const enc = encodeURIComponent
const TAB_LABEL: Record<ProjectTab, string> = { roadmap: 'Roadmap', work: 'Work', cards: 'Cards' }

type OpenNode = (event: MouseEvent<HTMLAnchorElement>, href: string) => void

const STATE_DOT: Record<string, string> = { done: 'done', doing: 'working', you: 'needs', next: '', later: '' }

/** One task of an open milestone: its state as a dot, its title and what it is doing. The whole row opens the task's details. */
function TaskRow({ project, task, onOpen }: { project: string; task: MapTask; onOpen: OpenNode }) {
  const { sprint } = useScope()
  const href = projectNodeHash(project, task.id, sprint)
  return (
    <a role="listitem" className="ui-row pj-task" href={href} onClick={event => onOpen(event, href)} data-pp-task={task.id} data-pp-node={task.id} data-state={task.state}>
      <span className={`pj-dot ${STATE_DOT[task.state] ?? ''}`} aria-hidden="true" />
      <span className="ui-row-body">
        <b>{task.title}</b>
        <small>{task.id} · {task.state === 'later' && task.status === 'deferred' ? 'later' : STATE_LABEL[task.state]}</small>
      </span>
    </a>
  )
}

/** A milestone on the list: a ring, its title and state, and when open its tasks, 20 at a time, the open ones first. */
function MilestoneRow({ project, milestone, current, open, shown, onToggle, onMore, onOpen }: {
  project: string; milestone: MapMilestone; current: boolean; open: boolean; shown: number
  onToggle: () => void; onMore: () => void; onOpen: OpenNode
}) {
  const { sprint } = useScope()
  const tasks = open ? orderedTasks(milestone) : []
  const tally = tallyOf(tasksOfMilestone(milestone))
  const word = current ? 'Now' : milestone.state === 'done' ? 'Done' : 'Later'
  return (
    <div className={`pj-ms${open ? ' open' : ''}`} data-pp-milestone={milestone.id} data-state={milestone.state} data-open={open}>
      <button type="button" className="pj-ms-head" aria-expanded={open} onClick={onToggle} data-pp-toggle={milestone.id}>
        <ProjectRing tally={tally} />
        <span className="ui-row-body"><b>{milestone.title}</b><small data-pp-count>{word} · {tallyWords(tally)}</small></span>
        <span className="pj-chev" aria-hidden="true"><Icon name="chev" size={18} /></span>
      </button>
      {open && (
        <div className="ui-list pj-tasks" role="list" aria-label={`Tasks in ${milestone.title}`}>
          <a role="listitem" className="ui-row pj-task pj-details" href={projectNodeHash(project, milestone.id, sprint)} onClick={event => onOpen(event, projectNodeHash(project, milestone.id, sprint))} data-pp-details={milestone.id} data-pp-node={milestone.id}>
            <span className="ui-row-body"><b>Milestone details</b><small>Sprint, questions and what it holds</small></span>
            <span className="pj-chev" aria-hidden="true"><Icon name="chev" size={18} /></span>
          </a>
          {tasks.length === 0 && <p className="hub-empty">No tasks yet.</p>}
          {tasks.slice(0, shown).map(task => <TaskRow key={task.id} project={project} task={task} onOpen={onOpen} />)}
          {tasks.length > shown && (
            <button type="button" className="ui-row pj-more" role="listitem" onClick={onMore} data-pp-more={milestone.id}>
              <span className="ui-row-body"><b>Show more</b><small>{tasks.length - shown} more</small></span>
            </button>
          )}
        </div>
      )}
    </div>
  )
}

/** The Roadmap as a list. Only the milestone in hand starts open; the finished ones fold into one "Done" row. */
function RoadmapList({ project, model, onOpen }: { project: string; model: MapModel; onOpen: OpenNode }) {
  const { current, open: milestones, done } = roadmapList(model)
  const [opened, setOpened] = useState<Record<string, boolean>>({})
  const [shown, setShown] = useState<Record<string, number>>({})
  const [doneOpen, setDoneOpen] = useState(false)
  const hideDone = useHideDone()
  const isOpen = (id: string) => opened[id] ?? id === current
  const row = (milestone: MapMilestone) => (
    <MilestoneRow
      key={milestone.id} project={project} milestone={milestone} current={milestone.id === current}
      open={isOpen(milestone.id)} shown={shown[milestone.id] ?? TASK_PAGE}
      onToggle={() => setOpened(prev => ({ ...prev, [milestone.id]: !(prev[milestone.id] ?? milestone.id === current) }))}
      onMore={() => setShown(prev => ({ ...prev, [milestone.id]: (prev[milestone.id] ?? TASK_PAGE) + TASK_PAGE }))}
      onOpen={onOpen}
    />
  )
  return (
    <div className="pj-roadmap" data-pp-roadmap>
      {model.milestones.length === 0 && <p className="hub-empty">No milestones yet.</p>}
      {milestones.map(row)}
      {done.length > 0 && !hideDone && (
        <div className="pj-done" data-pp-finished data-open={doneOpen}>
          <button type="button" className="pj-ms-head pj-done-head" aria-expanded={doneOpen} onClick={() => setDoneOpen(value => !value)} data-pp-done-toggle>
            <span className="ui-row-body"><b>Done ({done.length})</b></span>
            <span className="pj-chev" aria-hidden="true"><Icon name="chev" size={18} /></span>
          </button>
          {doneOpen && done.map(row)}
        </div>
      )}
    </div>
  )
}

/** The Roadmap list: one row per milestone, from the same read as the map. A project with roadmaps lists them, nested, as it did. */
function RoadmapTab({ project, model, sprint, error, loading, at, onOpen }: { project: string; model: MapModel | null; /** The sprint's own map, when one is on. */ sprint?: MapModel; error: string | null; loading: boolean; at: Date | null; onOpen: OpenNode }) {
  if (!model) return error ? <RefreshNote error={error} hasData={false} at={null} /> : loading ? <p className="hub-empty">Loading…</p> : null
  return (
    <>
      <RefreshNote error={error} hasData at={at} />
      {!model.meta
        ? <p className="hub-empty">No Beads copy yet. It appears after the next agent session in this repo.</p>
        : sprint
          ? (sprint.milestones.length
            ? <RoadmapList project={project} model={sprint} onOpen={onOpen} />
            : <p className="hub-empty" data-pp-sprint-empty>No tasks in this sprint. <a className="pp-link" href={projectHash(project)} data-pp-sprint-clear>Show the whole roadmap ›</a></p>)
        : model.roadmaps?.length
          ? <div data-pp-roadmap-rows><RoadmapRows project={project} model={model} search={false} /></div>
          : <RoadmapList project={project} model={model} onOpen={onOpen} />}
    </>
  )
}

function NeedsTab({ project, name, today }: { project: string; name: string; today: TodayData | null }) {
  if (!today) return <p className="hub-empty">Loading…</p>
  const { data } = todayFor(today, project)
  const href = needsHref('all', project)
  return (
    <section className="hub-panel" aria-label="Needs you">
      {data.needsYou.length
        ? <NeedsRows items={data.needsYou} href={href} />
        : <p className="hub-empty">Nothing for {name} waits on you.</p>}
      <p className="pp-foot"><a className="pp-link" href={href} data-pp-all-needs>All in Needs you ›</a></p>
    </section>
  )
}

/** A card link is a site path (`/<section>#/<card>`), nothing else (the same rule as Working now's card chips). */
const SAFE_CARD = /^\/[\w%-]+#\/[\w%.~-]+$/

/** The newest agent writes in the project's section: who added what, and Revert. Nothing when there are none. */
function AgentWrites({ section }: { section: string }) {
  const [older, setOlder] = useState(false)
  const recent = useCardWrites(section, undefined, 10)
  const all = useCardWrites(section, undefined, undefined, true, older)
  const data = older && all.data ? all.data : recent.data
  if (!data?.groups.length) return null
  return (
    <div className="cw-writes" data-pp-agent-writes>
      <h3>Agent writes</h3>
      <CardWriteRows section={section} groups={data.groups} showCard />
      {!older && data.more && <p className="pp-foot"><button type="button" className="cw-btn" onClick={() => setOlder(true)} data-cw-older>Show older</button></p>}
    </div>
  )
}

/** The project's card section id, from the same read as the Cards tab. */
function useCardSection(project: string, on: boolean) {
  return useHubData<ProjectCards>(on ? `/project-cards?project=${enc(project)}` : null)
}

function CardsTab({ project }: { project: string }) {
  const { data, error, loading, at } = useCardSection(project, true)
  if (!data) return error ? <RefreshNote error={error} hasData={false} at={null} /> : loading ? <p className="hub-empty">Loading…</p> : null
  const note = <RefreshNote error={error} hasData at={at} />
  if (!data.section) return <>{note}<p className="hub-empty" data-pp-no-library>This project has no cards yet, because it has no Library section. A section is a Library folder with the project&apos;s name: <a href={hubHash('library')} data-pp-library-link>open the Library</a> to see what exists, or ask an agent to start a card for it.</p></>
  const cards = data.cards.filter(card => SAFE_CARD.test(card.href))
  return (
    <section className="hub-panel" aria-label="Cards">
      {note}
      {data.agents !== undefined && (data.agents
        ? <p className="cw-agents-line" data-pp-agents="on">Agents may add cards here. <a href={hubHash('team')}>Change this in Team ›</a></p>
        : <p className="cw-agents-line" data-pp-agents="off">Agents may not write here</p>)}
      {cards.length
        ? <ul className="pp-cards" data-pp-cards>{cards.map(card => <li key={card.href}><a href={card.href} data-pp-card>{card.title}</a>{card.updated && ago(card.updated) && <small>{ago(card.updated)}</small>}</li>)}</ul>
        : <p className="hub-empty">No cards in this section yet.</p>}
      <p className="pp-foot"><a className="pp-link" href={`/${enc(data.section)}`} data-pp-open-section>Open the Library section ›</a></p>
    </section>
  )
}

/** Work: what waits on you, what runs, the project's jobs, and what agents wrote to its Library section. */
function WorkTab({ project, name, today, sprint }: { project: string; name: string; today: TodayData | null; /** The sprint in the address, which the rest of this tab does not filter by. */ sprint?: { name: string; label: string } }) {
  const jobs = useHubData<JobsView>(`/jobs?project=${enc(project)}`)
  const cards = useCardSection(project, true).data
  const running = today && (() => {
    const { data } = todayFor(today, project)
    return <WorkingNow items={data.working ?? legacyRunning(data)} blocked={data.needsYou} running={data.counts.running} now={new Date(data.at).getTime()} />
  })()
  const rows = (jobs.data?.jobs ?? []).slice(0, 10)
  return (
    <div className="pj-work" data-pp-work>
      {sprint && <p className="pp-foot"><a className="pp-link" href={workBoardHash(project, sprint.name)} data-pp-sprint-board>Open {sprint.label} on the board ›</a></p>}
      <NeedsTab project={project} name={name} today={today} />
      {running}
      <section className="hub-panel" aria-label="Jobs" data-pp-jobs>
        <h3>Jobs</h3>
        <RefreshNote error={jobs.error} hasData={!!jobs.data} at={jobs.at} />
        {!jobs.data && !jobs.error && jobs.loading && <p className="hub-empty">Loading…</p>}
        {jobs.data && !rows.length && <p className="hub-empty" data-pp-no-jobs>No jobs yet.</p>}
        {rows.length > 0 && <div className="jb-list">{rows.map(job => <JobItem key={job.id} job={job} />)}</div>}
        <p className="pp-foot"><a className="pp-link" href={hubHash('jobs')} data-pp-all-jobs>All jobs in Work ›</a></p>
      </section>
      {cards?.section && <AgentWrites section={cards.section} />}
    </div>
  )
}

interface SprintAction { hidden?: boolean; link?: { href: string; label: string }; note?: string }

/** The sprint button: the milestone it would run on and the server's answer for it (the same read as that milestone's sheet), `why` included. */
function useSprintAction(project: string, model: MapModel | null): SprintAction {
  const { sprint } = useScope()
  const milestone = model ? currentMilestone(model) : undefined
  const going = !!milestone?.sprint && !milestone.sprint.ended
  const preview = useHubData<SprintPreview>(host.write && milestone ? `/map/${enc(project)}/sprint/${enc(milestone.id)}` : null)
  if (!model) return {}
  // A visitor who cannot start one sees a sprint that is going, and nothing else.
  if (!host.write) return going && milestone ? { link: { href: projectNodeHash(project, milestone.id, sprint), label: 'Sprint running ›' } } : { hidden: true }
  if (!milestone) return { note: 'No open milestone to sprint on.' }
  if (preview.error && !preview.data) return { note: preview.error }
  if (!preview.data) return {}
  if (!preview.data.allowed) return { note: preview.data.why }
  return { link: { href: projectNodeHash(project, milestone.id, sprint), label: going ? 'Sprint running ›' : 'Run sprint' } }
}

/** Now: the milestone the work is in, with Run sprint. */
function NowBlock({ project, model, runsOn, onOpen }: { project: string; model: MapModel | null; runsOn: HubProject['runsOn']; onOpen: OpenNode }) {
  const sprint = useSprintAction(project, model)
  const milestone = model ? currentMilestone(model) : undefined
  const rule = runsOn && runsOn !== 'pc' ? RUNS_ON[runsOn].rule : ''
  if (!model?.meta) return null
  return (
    <>
      <div className="pj-now-block" data-project-now-block>
        <span className="ui-row-body"><small>Now</small><b data-pp-now>{milestone?.title ?? 'Nothing open'}</b></span>
        {!sprint.hidden && (sprint.link
          ? <a className="ui-btn sm primary" href={sprint.link.href} onClick={event => onOpen(event, sprint.link!.href)} data-project-action="sprint">{sprint.link.label}</a>
          : null)}
      </div>
      {sprint.note && <p className="hub-muted pp-note" id="pp-sprint-note" data-project-note="sprint">{sprint.note}</p>}
      {rule && <p className="hub-muted pp-note" data-project-note="runs-on">{rule}</p>}
    </>
  )
}

/**
 * One project (`#/~hub/project/<id>[/<tab>[/<node>]]`, and `#/~hub/map/<id>[/<node>]` for its Map): the name, Plan in Hermes and New job, and three
 * tabs (Roadmap, Work, Cards). The Roadmap is a list with a Map one tap away, and the switch between them swaps the address, adding no history
 * entry. A milestone or task opens its details over the list (the Roadmap's panel, as a Work card does), so closing returns to the list.
 */
export default function ProjectPage({ project: wanted, route, view, sprint }: { project: string; route?: string; view: 'list' | 'map'; /** `?sprint=`: the Roadmap narrows to it. */ sprint?: string }) {
  const { tab: rawTab, node: listNode } = parseProjectId(route)
  const mapNode = view === 'map' ? route?.split('/').slice(1).join('/') || undefined : undefined
  const tab = view === 'map' ? 'roadmap' : tabOf(rawTab)
  const node = view === 'map' ? mapNode : listNode
  const all = useHubData<{ projects: HubProject[] }>('/projects')
  const known = !all.data || all.data.projects.some(item => item.id === wanted)
  const project = all.data && known ? wanted : undefined
  const today = useTodayScreen().data
  const hideDone = useHideDone()
  // The model is asked for as soon as the address names the project, but not shown until the list says the project exists: the server answers 200 for any valid id.
  const { data: model, error, loading, at: modelAt } = useHeldHubData<MapModel>(known ? `/map/${enc(wanted)}` : null, !!project)
  // The details of a milestone or task: the Roadmap's panel over the list. Close returns to the list, one step back when this page pushed
  // the address, else a replace (a shared link); `pushed` is cleared whenever the sheet goes away.
  const shown = view === 'list' && tab === 'roadmap' && node && project && model && find(model, node) ? node : undefined
  const pushed = useRef(false)
  const lastNode = useRef<string | null>(null)
  const openNode: OpenNode = (event, href) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    if (node) { event.preventDefault(); swap(href); return }
    pushed.current = true
  }
  const closeNode = () => {
    if (pushed.current) { pushed.current = false; window.history.back() } else swap(projectHash(project, undefined, sprint))
  }
  const openRelated = (id: string) => { if (project) swap(projectNodeHash(project, id, sprint)) }
  // Whatever closes the sheet (the button, the scrim, Escape, Back), focus goes back to the row that opened it.
  useEffect(() => {
    if (node) { lastNode.current = node; return }
    pushed.current = false
    const id = lastNode.current
    lastNode.current = null
    if (id) document.querySelector<HTMLElement>(`[data-pp-node="${CSS.escape(id)}"]`)?.focus({ preventScroll: true })
  }, [node])

  if (!known) {
    return (
      <div className="pp today" data-project-page="">
        <h2 className="pp-title">Project</h2>
        <p className="hub-empty" data-project-missing>No project called {wanted}. <a className="pp-link" href={hubHash('project')}>All projects ›</a></p>
      </div>
    )
  }
  if (!project) return <p className="hub-empty">{all.error ?? 'Loading…'}</p>
  const item = all.data?.projects.find(row => row.id === project)
  const name = item?.name ?? project
  const counts = today ? tabCounts(today, project) : null
  // With a sprint on, the Roadmap, Now and the header's count read the sprint's own map; the sheet and `find` keep the whole one.
  const scoped = sprint && model?.meta ? sprintModel(model, sprint) : undefined
  // Hide completed also leaves finished sprints out of the picker, except the one in the address.
  const sprintsAll = model?.meta ? sprintsOf(model) : []
  const sprints = sprintsAll.filter(row => !hideDone || row.done < row.total || row.name === sprint)
  const sprintRow = sprint ? sprints.find(row => row.name === sprint) : undefined
  const done = model?.meta ? tallyOf((scoped ?? model).milestones.flatMap(tasksOfMilestone)) : null
  const mapShown = view === 'map'
  const pickSprint = (name: string) => swap(view === 'map' ? mapHash(project, undefined, name || undefined) : projectHash(project, undefined, name || undefined))
  const switchTo = (to: 'list' | 'map') => { if (to !== view) swap(to === 'map' ? mapHash(project, undefined, sprint) : projectHash(project, undefined, sprint)) }
  return (
    <div className="pp today" data-project-page={project} data-view={view} data-sheet={shown ? '' : undefined} data-map-node={view === 'map' && node && project && model && find(model, node) ? '' : undefined}>
      <header className="pp-head">
        <div className="pp-name">
          <h2 className="pp-title" data-project-title>{name}</h2>
          <RunsOnChip key={project} runsOn={item?.runsOn} />
        </div>
        {!mapShown && done && <p className="pp-sub" data-project-done>{done.done} of {done.total} tasks done.</p>}
        {!mapShown && (
          <div className="pp-actions" data-project-actions>
            <PlanInHermes project={project} projectName={name} selected={null} action="plan" />
            {host.write && <Button small data-project-action="build" data-spawn-open onClick={() => openSpawn({ project, preset: 'code-task' })}>New job</Button>}
          </div>
        )}
      </header>
      <div className="pp-nav">
      <nav className="ui-seg ui-seg-tabs pp-tabs" role="tablist" aria-label="Project" data-project-tabs>
        {PROJECT_TABS.map(key => (
          <a key={key} role="tab" href={projectHash(project, key, sprint)} className={key === tab ? 'on' : undefined} aria-selected={key === tab} data-project-tab={key}>
            {TAB_LABEL[key]}{key === 'work' && counts && counts.needs > 0 ? <small>{counts.needs}</small> : null}
          </a>
        ))}
      </nav>
      {tab === 'roadmap' && (
        <div className="ui-seg pp-switch" role="group" aria-label="Roadmap view" data-roadmap-switch>
          <button type="button" className={view === 'list' ? 'on' : undefined} aria-pressed={view === 'list'} onClick={() => switchTo('list')} data-roadmap-view="list">List</button>
          <button type="button" className={view === 'map' ? 'on' : undefined} aria-pressed={view === 'map'} onClick={() => switchTo('map')} data-roadmap-view="map">Map</button>
        </div>
      )}
      </div>
      {tab === 'roadmap' && model?.meta && (sprintsAll.length > 0 || sprint) && (
        <div className="pp-sprint" data-pp-sprint-row>
          <SprintPicker id="hub-project-sprint" sprints={sprints} value={sprint ?? ''} onChange={pickSprint} className="cb-bar pp-sprint-pick" />
          {sprint && sprintRow && <span className="pp-sprint-count" data-pp-sprint-count>{sprintCount(sprintRow)}</span>}
          {sprint && <a className="pp-link" href={workBoardHash(project, sprint)} data-pp-sprint-board>Open on the board ›</a>}
        </div>
      )}
      {mapShown
        ? (
          <ProgressMap key={project} project={project} name={name} nodeId={node} model={scoped ?? model} panelModel={scoped ? model ?? undefined : undefined} error={error} loading={loading} at={modelAt} />
        )
        : (
          <div className="pp-body" data-tab={tab}>
            <div className="pp-main" role="tabpanel" aria-label={TAB_LABEL[tab]}>
              {tab === 'roadmap' && <NowBlock project={project} model={scoped ?? model} runsOn={item?.runsOn} onOpen={openNode} />}
              {tab === 'roadmap' && <RoadmapTab project={project} model={model} sprint={scoped} error={error} loading={loading} at={modelAt} onOpen={openNode} />}
              {tab === 'work' && <WorkTab project={project} name={name} today={today} sprint={sprint ? { name: sprint, label: sprintRow?.title ?? sprint } : undefined} />}
              {tab === 'cards' && <CardsTab project={project} />}
            </div>
          </div>
        )}
      {shown && model && (
        <div className="wk-sheet">
          <MapPanel model={model} nodeId={shown} onClose={closeNode} onOpen={openRelated} headerExtra={<p className="hub-map-panel-roadmap"><a href={mapHash(project, shown, sprint)} data-show-on-roadmap>Show on map</a></p>} />
        </div>
      )}
    </div>
  )
}
