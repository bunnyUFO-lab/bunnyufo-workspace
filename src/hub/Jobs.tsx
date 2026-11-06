import { useState } from 'react'
import type { HubProject, JobListRow, JobsView } from '../lib/hub'
import { ago } from '../lib/hub'
import { hubHash } from '../lib/route'
import ProjectPicker from './ProjectPicker'
import WorkTabs from './WorkTabs'
import RefreshNote from './RefreshNote'
import { JOB_STATE, LIVE_JOB, jobTone } from './jobStates'
import { useHubData } from './useHub'
import { RUNNER_LABEL, requestStateWord } from './working'
import './jobs.css'

const RUNNING = new Set(['approved', 'taken', 'running', 'stopping', 'lost'])
const where = (runner?: string) => (runner && runner in RUNNER_LABEL ? RUNNER_LABEL[runner as keyof typeof RUNNER_LABEL] : undefined)

/** A job's row: what it is, who ran it and when, and what it delivered. The whole row opens the job's page. */
export function JobItem({ job }: { job: JobListRow }) {
  const running = RUNNING.has(job.state)
  const when = ago(running ? job.at : job.finishedAt ?? job.at)
  const meta = [job.project, job.agent, where(job.runner), when].filter(Boolean).join(' · ')   // the project and the age tell two jobs with one title apart
  const tone = job.state === 'failed' ? 'warn' : jobTone(job.state)
  return (
    <a className="jb-row" href={hubHash('request', job.id)} data-job-row={job.id} data-job-state={job.state} data-job-tone={tone}>
      <span className="jb-dot" aria-hidden="true" />
      <span className="jb-body">
        <b className="jb-title" data-job-title>{job.title}</b>
        <small className="jb-meta" data-job-meta>{meta}</small>
        <span className="jb-pills">
          {running && <span className={`jb-pill ${LIVE_JOB.has(job.state) ? 'live' : ''}`} data-job-word>{requestStateWord(job.state, job.stale, JOB_STATE)}</span>}
          {job.pills.map(pill => <span key={pill.text} className={`jb-pill ${pill.tone}`} data-job-pill>{pill.text}</span>)}
        </span>
      </span>
    </a>
  )
}

/** Work > Running and Delivered: what the owner started, each delivered one showing what it delivered instead of its log. */
export default function Jobs({ tab }: { tab?: string }) {
  const [project, setProject] = useState('')
  const { data, error, loading, at } = useHubData<JobsView>(`/jobs${project ? `?project=${encodeURIComponent(project)}` : ''}`)
  const projects = useHubData<{ projects: HubProject[] }>('/projects')
  const counts = data?.counts
  // No tab in the address: Running if anything runs, otherwise Finished.
  const shown: 'running' | 'finished' = tab === 'running' || tab === 'finished' ? tab : counts && counts.running === 0 ? 'finished' : 'running'
  const rows = (data?.jobs ?? []).filter(job => RUNNING.has(job.state) === (shown === 'running'))
  return (
    <WorkTabs tab={shown === 'running' ? 'running' : 'delivered'} running={counts?.running}>
      <div className="hub-top">
        <label className="hub-muted" htmlFor="hub-jobs-project">Project</label>
        <ProjectPicker id="hub-jobs-project" projects={projects.data?.projects ?? []} value={project || 'all'} allValue="all" onChange={id => setProject(id === 'all' ? '' : id)} alwaysList inRow local />
      </div>
      <RefreshNote error={error} hasData={!!data} at={at} />
      {!data && !error && loading && <p className="hub-empty">Loading…</p>}
      {data && !rows.length && <p className="hub-empty" data-jobs-empty>{shown === 'running' ? 'Nothing running.' : `No delivered jobs in the last ${data.window}.`}</p>}
      {rows.length > 0 && <div className="jb-list" data-jobs-list={shown}>{rows.map(job => <JobItem key={job.id} job={job} />)}</div>}
      {data && shown === 'finished' && rows.length > 0 && <p className="hub-muted jb-foot" data-jobs-foot>{data.counts.finished > rows.length ? `Newest ${rows.length} of ${data.counts.finished} delivered jobs from the last ${data.window}.` : `Jobs from the last ${data.window} are listed.`}</p>}
    </WorkTabs>
  )
}
