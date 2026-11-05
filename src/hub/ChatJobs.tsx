import { useState } from 'react'
import type { ChatJob, ChatJobResult } from '../lib/hub'
import { HubError, hubPost } from '../lib/hub'
import { MACHINE } from '../lib/hubSpawn'
import { host } from '../lib/host'
import { hubHash } from '../lib/route'
import { JOB_STATE, MAX_ONE_TAP, estimateOf, jobTone } from './jobStates'

const cardLink = (job: ChatJob) => (job.finish?.cardHref && /^\/[\w%-]+#\/[\w%.~-]+$/.test(job.finish.cardHref) ? job.finish.cardHref : undefined)
const PR_URL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/

/** What the approval page shows besides the text: the project, the repo and model it would run with, the time limit and the cost. */
function facts(job: ChatJob): string {
  return [
    `Project ${job.project}`,
    job.repo ? `Repo ${job.repo}` : '',
    job.model ? `Model ${job.model} · API` : '',
    job.minutes ? `Up to ${job.minutes} minutes` : '',
    job.estimate?.cost ?? '',
  ].filter(Boolean).join(' · ')
}

function JobRow({ job, result, busy, onApprove }: { job: ChatJob; result?: ChatJobResult; busy: boolean; onApprove?: () => void }) {
  const machine = job.runsOn ? MACHINE[job.runsOn]?.name : undefined
  const meta = [job.agent, machine, job.produces].filter(Boolean).join(' · ')
  const card = cardLink(job)
  const pr = job.finish?.pr && PR_URL.test(job.finish.pr) ? job.finish.pr : undefined
  const done = job.state === 'done' || job.state === 'failed'
  return (
    <div className="hub-job" data-job-row={job.id} data-job-state={job.state} data-job-tone={jobTone(job.state)}>
      <span className="hub-job-dot" aria-hidden="true" />
      <div className="hub-job-body">
        <a className="hub-job-title" href={hubHash('request', job.id)} data-job-title>{job.title}</a>
        {meta && <span className="hub-muted hub-job-meta" data-job-meta>{meta}</span>}
        <span className="hub-muted hub-job-meta" data-job-facts>{facts(job)}</span>
        <span className="hub-job-state" data-job-status>{JOB_STATE[job.state] ?? job.state}{job.stale ? ' · quiet for a while' : ''}{job.nothing ? ' · nothing to do' : ''}</span>
        <details className="hub-job-read" data-job-read>
          <summary>Read the job</summary>
          <pre className="hub-job-text">{job.text}</pre>
          {job.doneWhen && <p className="hub-muted hub-job-done" data-job-done-when>Done when: {job.doneWhen}</p>}
        </details>
        {done && (card || pr) && (
          <div className="hub-job-links">
            {card && <a className="hub-btn" href={card} data-job-card>Open the card</a>}
            {pr && <a className="hub-btn" href={pr} target="_blank" rel="noopener noreferrer" data-job-pr>Open the PR</a>}
          </div>
        )}
        {job.state === 'proposed' && !job.approvable && (
          <div className="hub-job-why" data-job-why>
            <span className="hub-muted">{job.why ?? 'Open it to approve.'}</span>
            <a className="hub-btn" href={hubHash('request', job.id)} data-job-open>Open</a>
          </div>
        )}
        {job.state === 'proposed' && job.approvable && (
          <div className="hub-job-links">
            {onApprove && <button type="button" className="hub-btn pri" disabled={busy} onClick={onApprove} data-job-approve>Approve</button>}
            <a className="hub-btn hub-job-change" href={hubHash('request', job.id)} data-job-change>Change</a>
          </div>
        )}
        {result?.ok && result.waiting && <span className="hub-muted hub-job-note" data-job-waiting>{result.waiting}</span>}
        {result && !result.ok && <span className="hub-error hub-job-error" role="alert" data-job-error>{result.error ?? 'It could not be approved.'}</span>}
      </div>
    </div>
  )
}

/**
 * The jobs a reply named: one row each. One tap approves the ready proposals when there are 2 or 3 of them, with their estimated cost
 * written above the button; with 4 or more there is no one tap and each row has its own Approve. The tap posts the ids on screen (the server
 * never widens the list), and each row then shows its own result. Helpers are another block (`Delegates`); the two never mix.
 */
export default function JobsCard({ conversation, ids, jobs, onChanged }: { conversation: string; ids: string[]; jobs: ChatJob[]; onChanged: () => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [results, setResults] = useState<Record<string, ChatJobResult>>({})
  const rows = ids.map(id => jobs.find(job => job.id === id)).filter((job): job is ChatJob => !!job)
  if (!rows.length) return null
  const ready = rows.filter(job => job.state === 'proposed' && job.approvable)
  const proposed = rows.filter(job => job.state === 'proposed')
  const many = ready.length > MAX_ONE_TAP
  const verified = proposed.length > 0 && proposed.every(job => job.verified && !job.flag)
  const canApprove = host.write && host.approve
  const approve = async (list: ChatJob[]) => {
    setBusy(true)
    setError('')
    try {
      const answer = await hubPost<{ results: ChatJobResult[] }>(`/chat/${encodeURIComponent(conversation)}/jobs/approve`, { ids: list.map(job => job.id) })
      setResults(current => ({ ...current, ...Object.fromEntries(answer.results.map(item => [item.id, item])) }))
    } catch (failure) {
      setError(failure instanceof HubError || failure instanceof Error ? failure.message : 'It could not be approved.')
    } finally {
      setBusy(false)
      onChanged()
    }
  }
  return (
    <div className="hub-jobs" data-chat-jobs role="group" aria-label="Jobs Hermes proposed">
      <span className="hub-jobs-head">Jobs</span>
      {proposed.length > 0 && (verified
        ? <p className="hub-muted hub-jobs-note" data-jobs-written>Written by hermes, not by you. Read it before approving.</p>
        : <p className="hub-muted hub-jobs-note" data-jobs-written data-unverified>Written by an agent, not by you. The Hub could not confirm every one came from Hermes in this reply. Read each before approving.</p>)}
      {rows.map(job => <JobRow key={job.id} job={job} result={results[job.id]} busy={busy} onApprove={many && canApprove ? () => void approve([job]) : undefined} />)}
      {many && <p className="hub-muted" data-jobs-many>Hermes proposed more than {MAX_ONE_TAP}. Approve them one at a time, or open each one.</p>}
      {ready.length > 1 && !many && canApprove && (
        <div className="hub-jobs-a">
          <button type="button" className="hub-btn pri" disabled={busy} onClick={() => void approve(ready)} data-jobs-approve>Approve all {ready.length}</button>
          {estimateOf(ready) && <span className="hub-muted hub-jobs-cost" data-jobs-estimate>Estimated for all {ready.length}: {estimateOf(ready)}</span>}
        </div>
      )}
      {ready.length === 1 && canApprove && (
        <div className="hub-jobs-a">
          <button type="button" className="hub-btn pri" disabled={busy} onClick={() => void approve(ready)} data-jobs-approve>Approve</button>
          {estimateOf(ready) && <span className="hub-muted hub-jobs-cost" data-jobs-estimate>Estimated: {estimateOf(ready)}</span>}
        </div>
      )}
      {ready.length > 0 && host.write && !host.approve && <p className="hub-muted" data-jobs-off>{host.approveReason ?? 'Approving needs a signed-in session on a host that can sign.'}</p>}
      {error && <p className="hub-error" role="alert" data-jobs-error>{error}</p>}
    </div>
  )
}
