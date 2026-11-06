import type { HubProject } from '../lib/hub'
import { useIsDesktop } from '../lib/chrome'
import { hubHash, projectHash, type HubRoute } from '../lib/route'
import Icon from '../ui/Icon'
import { Section, Split } from '../ui/Layout'
import TopBar from '../ui/TopBar'
import ProjectPage from './ProjectPage.tsx' // the extension: projectPage.ts differs from this file's name only in casing
import ProjectRing from './ProjectRing'
import { listed } from './projectPage.ts'
import RefreshNote from './RefreshNote'
import { todayFor } from './todayFilter.ts'
import { useHubData, useTodayScreen } from './useHub'
import './project.css'

/** What the Projects list needs of each project beyond its name: done of all, and the milestone in hand (`GET /hub/project-summary`). */
export interface ProjectSummary { id: string; done: number; total: number; now: string | null }

function ProjectRow({ project, summary, needs, running, on }: { project: HubProject; summary?: ProjectSummary; needs: number; running: number; on: boolean }) {
  return (
    <a role="listitem" className={`ui-row pj-row${on ? ' on' : ''}`} href={projectHash(project.id)} data-project-row={project.id} aria-current={on ? 'page' : undefined}>
      {summary ? <ProjectRing tally={{ done: summary.done, later: 0, total: summary.total }} /> : <span className="pp-ring" aria-hidden="true" />}
      <span className="ui-row-body">
        <b>{project.name}</b>
        <small className="pj-now" data-project-now>{summary ? (summary.now ?? (summary.total ? 'Everything is done' : 'No tasks yet')) : project.beads ? '' : 'No Beads copy yet'}</small>
        <span className="pj-pills">
          {needs > 0 && <span className="pj-pill warn" data-project-needs>{needs} {needs === 1 ? 'needs' : 'need'} you</span>}
          {running > 0 && <span className="pj-pill live" data-project-running>{running} running</span>}
          {needs === 0 && running === 0 && <span className="pj-pill" data-project-quiet>Quiet</span>}
        </span>
      </span>
      <span className="pj-chev" aria-hidden="true"><Icon name="chev" size={18} /></span>
    </a>
  )
}

/** Projects, as a list: a ring, the milestone in hand, and what needs you or runs. A phone also gets Work and Team under it. */
export function ProjectsList({ current }: { current?: string }) {
  const all = useHubData<{ projects: HubProject[] }>('/projects')
  const summary = useHubData<{ projects: ProjectSummary[] }>('/project-summary')
  const today = useTodayScreen().data
  const projects = listed(all.data?.projects ?? [])
  const byId = new Map((summary.data?.projects ?? []).map(row => [row.id, row]))
  const desktop = useIsDesktop()
  const working = today?.working ? today.working.filter(item => item.state !== 'idle' && item.state !== 'stale').length : today?.counts.running
  return (
    <>
      <TopBar title="Projects" />
      <div className="pj-scroll" data-projects-list>
        <RefreshNote error={all.error} hasData={!!all.data} at={all.at} />
        {!all.data && !all.error && all.loading && <p className="hub-empty">Loading…</p>}
        {all.data && !projects.length && <p className="hub-empty" data-projects-empty>No projects yet. A project appears once an agent session pushes a Beads copy or writes to the Hub.</p>}
        {projects.length > 0 && (
          <div className="ui-list" role="list" aria-label="Projects">
            {projects.map(project => {
              const mine = today ? todayFor(today, project.id).data : null
              return <ProjectRow key={project.id} project={project} summary={byId.get(project.id)} needs={mine?.counts.needsYou ?? 0} running={mine?.counts.running ?? 0} on={project.id === current} />
            })}
          </div>
        )}
        {!desktop && (
          <Section>
            <div className="pj-tiles" data-projects-tiles>
              <a className="pj-tile" href={hubHash('work')} data-nav-tile="work"><b><Icon name="work" size={18} />Work</b><small>{working ?? 0} running</small></a>
              <a className="pj-tile" href={hubHash('team')} data-nav-tile="team"><b><Icon name="team" size={18} />Team</b><small>Agents and skills</small></a>
            </div>
          </Section>
        )}
      </div>
    </>
  )
}

/**
 * `#/~hub/project` and `#/~hub/map`: the Projects list, and a project beside it. A phone shows one at a time (the list with no id, the
 * project with one); from 900 px the list stays on the left, and with no id the first project is open on the right.
 */
export default function ProjectsScreen({ route }: { route: HubRoute }) {
  const desktop = useIsDesktop()
  const all = useHubData<{ projects: HubProject[] }>('/projects')
  const wanted = route.id?.split('/')[0] || undefined
  const first = desktop ? listed(all.data?.projects ?? [])[0]?.id : undefined
  const open = wanted ?? first
  return (
    <Split
      list={<ProjectsList current={open} />}
      detail={open ? <ProjectPage key={open} route={wanted ? route.id : undefined} project={open} view={route.screen === 'map' ? 'map' : 'list'} /> : undefined}
      empty="Pick a project from the list."
    />
  )
}
