import { useEffect, useState } from 'react'
import type { CSSProperties } from 'react'
import type { HubProject, MapMilestone, ProgressMap as MapModel, ProjectCards, SprintPreview, Today as TodayData } from '../lib/hub'
import { ago } from '../lib/hub'
import { host } from '../lib/host'
import ItemMenu from '../components/ItemMenu'
import { useIsPhone } from '../lib/chrome'
import { needsHref } from '../lib/needsView.mjs'
import { hubHash, mapHash, parseProjectId, projectHash } from '../lib/route'
import { CardWriteRows } from './CardWrites'
import { useCardWrites } from './cardWriteText'
import NeedsRows from './NeedsRows'
import PlanInHermes from './PlanInHermes'
import ProjectPicker from './ProjectPicker'
import RoadmapRows from './RoadmapRows'
import RunsOnChip, { RUNS_ON } from './RunsOnChip'
import WorkingNow from './WorkingNow'
import { isLaterOnly, tallyFraction, tallyWords } from './mapCount.ts'
import type { Tally } from './mapCount.ts'
import { STATE_COLOR, STATE_LABEL } from './mapState'
import { PROJECT_TABS, currentMilestone, milestoneRow, moreCount, phoneTabs, tabCounts, tabOf } from './projectPage.ts'
import type { ProjectTab } from './projectPage.ts'
import { openSpawn } from './spawnStore'
import { legacyRunning } from './Today'
import { todayFor } from './todayFilter.ts'
import RefreshNote from './RefreshNote'
import { useHeldHubData, useHubData, useTodayScreen } from './useHub'
import { useProject } from './useProject'
import './today.css'
import './project.css'
import './cardWrites.css'

const enc = encodeURIComponent
const TAB_LABEL: Record<ProjectTab, string> = { roadmap: 'Roadmap', running: 'Running', needs: 'Needs you', library: 'Library' }
const WIDE = '(min-width: 1000px)'

function setHash(hash: string) { window.location.hash = hash }

function useWide() {
  const [wide, setWide] = useState(() => typeof window.matchMedia === 'function' && window.matchMedia(WIDE).matches)
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined
    const query = window.matchMedia(WIDE)
    const update = () => setWide(query.matches)
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])
  return wide
}

/** The ring of a milestone: the done part of everything it holds, and `done/total` inside. */
function Ring({ tally }: { tally: Tally }) {
  const r = 21
  const length = 2 * Math.PI * r
  const colour = isLaterOnly(tally) ? 'var(--text-muted)' : 'var(--green)'
  return (
    <svg className="pp-ring" viewBox="0 0 52 52" aria-hidden="true">
      <circle cx="26" cy="26" r={r} fill="none" stroke="var(--line)" strokeWidth="5" />
      {tallyFraction(tally) > 0 && <circle cx="26" cy="26" r={r} fill="none" stroke={colour} strokeWidth="5" strokeLinecap="round" strokeDasharray={`${length * tallyFraction(tally)} ${length}`} transform="rotate(-90 26 26)" />}
      <text x="26" y="26" textAnchor="middle" dominantBaseline="central">{tally.done}/{tally.total}</text>
    </svg>
  )
}

function MilestoneRow({ project, milestone }: { project: string; milestone: MapMilestone }) {
  const { tally, chips, more } = milestoneRow(milestone)
  return (
    <li className="pp-ms" data-pp-milestone={milestone.id} data-state={milestone.state}>
      <Ring tally={tally} />
      <div className="pp-ms-body">
        <a className="pp-ms-title" href={mapHash(project, milestone.id)}>{milestone.title}</a>
        <span className="pp-ms-count" data-pp-count>{tallyWords(tally)}</span>
        {chips.length > 0 && (
          <span className="pp-chips">
            {chips.map(task => (
              <a key={task.id} className="pp-chip" href={mapHash(project, task.id)} style={{ '--chip': STATE_COLOR[task.state] } as CSSProperties} data-pp-task={task.id} data-state={task.state} title={task.title}>{task.id} {STATE_LABEL[task.state]}</a>
            ))}
            {more > 0 && <span className="pp-chip more">+{more}</span>}
          </span>
        )}
      </div>
    </li>
  )
}

/** The Roadmap tab: one row per milestone, from the same read as the map. */
function RoadmapTab({ project, model, error, loading, at }: { project: string; model: MapModel | null; error: string | null; loading: boolean; at: Date | null }) {
  if (!model) return error ? <RefreshNote error={error} hasData={false} at={null} /> : loading ? <p className="hub-empty">Loading…</p> : null
  return <><RefreshNote error={error} hasData at={at} /><RoadmapBody project={project} model={model} /></>
}

function RoadmapBody({ project, model }: { project: string; model: MapModel }) {
  if (!model.meta) return <p className="hub-empty">No Beads copy yet. It appears after the next agent session in this repo.</p>
  // A project with roadmaps lists them, nested; a row opens that roadmap's map.
  if (model.roadmaps?.length) {
    return (
      <>
        <div data-pp-roadmap-rows><RoadmapRows project={project} model={model} search={false} /></div>
        <p className="pp-foot"><a className="pp-link" href={mapHash(project)} data-pp-open-map>Open the Roadmap ›</a></p>
      </>
    )
  }
  const open = model.milestones.filter(milestone => milestone.state !== 'done')
  const finished = model.milestones.filter(milestone => milestone.state === 'done')
  return (
    <>
      {model.milestones.length === 0 && <p className="hub-empty">No milestones yet.</p>}
      {open.length > 0 && <ul className="pp-list" data-pp-roadmap>{open.map(milestone => <MilestoneRow key={milestone.id} project={project} milestone={milestone} />)}</ul>}
      {finished.length > 0 && (
        <details className="pp-finished" data-pp-finished>
          <summary>{finished.length} finished</summary>
          <ul className="pp-list">{finished.map(milestone => <MilestoneRow key={milestone.id} project={project} milestone={milestone} />)}</ul>
        </details>
      )}
      <p className="pp-foot"><a className="pp-link" href={mapHash(project)} data-pp-open-map>Open the Roadmap ›</a></p>
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

function LibraryTab({ project }: { project: string }) {
  const { data, error, loading, at } = useHubData<ProjectCards>(`/project-cards?project=${enc(project)}`)
  if (!data) return error ? <RefreshNote error={error} hasData={false} at={null} /> : loading ? <p className="hub-empty">Loading…</p> : null
  const note = <RefreshNote error={error} hasData at={at} />
  if (!data.section) return <>{note}<p className="hub-empty" data-pp-no-library>No Library section for this project.</p></>
  const cards = data.cards.filter(card => SAFE_CARD.test(card.href))
  return (
    <section className="hub-panel" aria-label="Library">
      {note}
      {data.agents !== undefined && (data.agents
        ? <p className="cw-agents-line" data-pp-agents="on">Agents may add cards here. <a href={hubHash('team')}>Change this in Team ›</a></p>
        : <p className="cw-agents-line" data-pp-agents="off">Agents may not write here</p>)}
      {cards.length
        ? <ul className="pp-cards" data-pp-cards>{cards.map(card => <li key={card.href}><a href={card.href} data-pp-card>{card.title}</a>{card.updated && ago(card.updated) && <small>{ago(card.updated)}</small>}</li>)}</ul>
        : <p className="hub-empty">No cards in this section yet.</p>}
      <AgentWrites section={data.section} />
      <p className="pp-foot"><a className="pp-link" href={`/${enc(data.section)}`} data-pp-open-section>Open the Library section ›</a></p>
    </section>
  )
}

interface SprintAction { hidden?: boolean; link?: { href: string; label: string }; note?: string }

/** The sprint button: the milestone it would run on and the server's answer for it (the same read as that milestone's sheet), `why` included. */
function useSprintAction(project: string, model: MapModel | null): SprintAction {
  const milestone = model ? currentMilestone(model) : undefined
  const going = !!milestone?.sprint && !milestone.sprint.ended
  const preview = useHubData<SprintPreview>(host.write && milestone ? `/map/${enc(project)}/sprint/${enc(milestone.id)}` : null)
  if (!model) return {}
  // A visitor who cannot start one sees a sprint that is going, and nothing else.
  if (!host.write) return going && milestone ? { link: { href: mapHash(project, milestone.id), label: 'Sprint running ›' } } : { hidden: true }
  if (!milestone) return { note: 'No open milestone to sprint on.' }
  if (preview.error && !preview.data) return { note: preview.error }
  if (!preview.data) return {}
  if (!preview.data.allowed) return { note: preview.data.why }
  return { link: { href: mapHash(project, milestone.id), label: going ? 'Sprint running ›' : 'Run a sprint…' } }
}

function Actions({ project, name, model, runsOn }: { project: string; name: string; model: MapModel | null; runsOn: HubProject['runsOn'] }) {
  const sprint = useSprintAction(project, model)
  const rule = runsOn && runsOn !== 'pc' ? RUNS_ON[runsOn].rule : ''
  return (
    <>
      <div className="pp-actions" data-project-actions>
        <PlanInHermes project={project} projectName={name} selected={null} action="plan" />
        {host.write && <button type="button" className="hub-btn" data-project-action="build" onClick={() => openSpawn({ project, preset: 'code-task' })}>Build it…</button>}
        {!sprint.hidden && (sprint.link
          ? <a className="hub-btn" href={sprint.link.href} data-project-action="sprint">{sprint.link.label}</a>
          : <button type="button" className="hub-btn" disabled data-project-action="sprint" aria-describedby={sprint.note ? 'pp-sprint-note' : undefined}>Run a sprint…</button>)}
      </div>
      {!host.write && <p className="hub-muted pp-note" data-project-note="build">Sign in to ask an agent to do something.</p>}
      {sprint.note && <p className="hub-muted pp-note" id="pp-sprint-note" data-project-note="sprint">{sprint.note}</p>}
      {rule && <p className="hub-muted pp-note" data-project-note="runs-on">{rule}</p>}
    </>
  )
}

/**
 * One page per project (`#/~hub/project[/<id>[/<tab>]]`): name, where it runs, the three buttons, the project chips and four tabs. It links
 * into the Roadmap, Work and Needs you; it does not replace them.
 */
export default function ProjectPage({ route }: { route?: string }) {
  const { project: wanted, tab: rawTab } = parseProjectId(route)
  const tab = tabOf(rawTab)
  const all = useHubData<{ projects: HubProject[] }>('/projects')
  const known = !wanted || !all.data || all.data.projects.some(item => item.id === wanted)
  // useProject would fall back to another project for an id the list does not have; the page says so instead.
  const { list, project, early } = useProject(known ? wanted : undefined)
  const today = useTodayScreen().data
  const target = project ?? early
  const { data: model, error, loading, at: modelAt } = useHeldHubData<MapModel>(known && target ? `/map/${enc(target)}` : null, !!project)
  const wide = useWide()
  const phone = useIsPhone()
  const go = (id: string) => setHash(projectHash(id, tab))

  if (!known) {
    return (
      <div className="pp today" data-project-page="">
        <h2 className="pp-title">Project</h2>
        <p className="hub-empty" data-project-missing>No project called {wanted}.</p>
        <ProjectPicker id="hub-project-page" projects={list} value="" onChange={go} href={id => projectHash(id)} oneRow />
      </div>
    )
  }
  if (!project) return <p className="hub-empty">{all.error ?? (all.loading ? 'Loading…' : 'No projects yet. A project appears once an agent session pushes a Beads copy or writes to the Hub.')}</p>
  const item = all.data?.projects.find(row => row.id === project)
  const name = item?.name ?? project
  const counts = today ? tabCounts(today, project) : null
  const numbered = (key: ProjectTab) => (key === 'running' && counts ? ` (${counts.running})` : key === 'needs' && counts ? ` (${counts.needs})` : '')
  const running = today && (() => {
    const { data } = todayFor(today, project)
    return <WorkingNow items={data.working ?? legacyRunning(data)} blocked={data.needsYou} running={data.counts.running} now={new Date(data.at).getTime()} />
  })()
  const { row, more } = phone ? phoneTabs(tab) : { row: PROJECT_TABS, more: [] }
  const tablist = (
    <div className="wk-tabs pp-tabs" role="tablist" aria-label="Project">
      {row.map(key => (
        <a key={key} role="tab" className={`wk-tab${key === tab ? ' on' : ''}`} href={projectHash(project, key)} aria-selected={key === tab} data-project-tab={key}>{TAB_LABEL[key]}{numbered(key)}</a>
      ))}
    </div>
  )
  const hidden = more.map(key => TAB_LABEL[key] + numbered(key))
  const held = moreCount(more, counts)
  const side = wide && tab === 'roadmap' && running
  return (
    <div className="pp today" data-project-page={project}>
      <header className="pp-head">
        <div className="pp-name">
          <div className="today-eyebrow">Project</div>
          <h2 className="pp-title">{name}</h2>
          <RunsOnChip key={project} runsOn={item?.runsOn} />
        </div>
        <div className="pp-do">
          <Actions key={project} project={project} name={name} model={model} runsOn={item?.runsOn} />
        </div>
      </header>
      <ProjectPicker id="hub-project-page" projects={list} value={project} onChange={go} href={id => projectHash(id, tab)} oneRow />
      {phone ? (
        <div className="pp-tabs-row" data-pp-tabs-row>
          {tablist}
          <ItemMenu
            label={`More project tabs: ${hidden.join(', ')}`}
            className="pp-more"
            items={more.map((key, index) => ({ label: hidden[index], onSelect: () => { window.location.hash = projectHash(project, key) } }))}
          >
            More{held > 0 ? ` (${held})` : ''} <span aria-hidden="true">▾</span>
          </ItemMenu>
        </div>
      ) : tablist}
      <div className="pp-body" data-tab={tab} data-side={side ? 'true' : undefined}>
        <div className="pp-main" role="tabpanel" aria-label={TAB_LABEL[tab]}>
          {tab === 'roadmap' && <RoadmapTab project={project} model={model} error={error} loading={loading} at={modelAt} />}
          {tab === 'running' && (running || <p className="hub-empty">Loading…</p>)}
          {tab === 'needs' && <NeedsTab project={project} name={name} today={today} />}
          {tab === 'library' && <LibraryTab project={project} />}
        </div>
        {side && <aside className="pp-side" data-pp-side>{running}<p className="hub-muted">Open the Running tab for logs and stop.</p></aside>}
      </div>
    </div>
  )
}
