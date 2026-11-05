import { useState } from 'react'
import type { ChatJob, ChatJobResult } from '../lib/hub'
import { HubError, hubPost, safeUrl } from '../lib/hub'
import { MACHINE } from '../lib/hubSpawn'
import { host } from '../lib/host'
import { hubHash } from '../lib/route'

import { JOB_STATE, jobTone } from './jobStates'

const cardLink = (job: ChatJob) => (job.finish?.cardHref && /^\/[\w%-]+#\/[\w%.~-]+$/.test(job.finish.cardHref) ? job.finish.cardHref : undefined)

function JobRow({ job, result }: { job: ChatJob; result?: ChatJobResult }) {
  const machine = job.runsOn ? MACHINE[job.runsOn]?.name : undefined
  const meta = [job.agent, machine, job.produces].filter(Boolean).join(' · ')
  const card = cardLink(job)
  const pr = safeUrl(job.finish?.pr)
  const done = job.state === 'done' || job.state === 'failed'
  return (
    <div className="hub-job" data-job-row={job.id} data-job-state={job.state} data-job-tone={jobTone(job.state)}>
      <span className="hub-job-dot" aria-hidden="true" />
      <div className="hub-job-body">
        <a className="hub-job-title" href={hubHash('request', job.id)} data-job-title>{job.title}</a>
        {meta && <span className="hub-muted hub-job-meta" data-job-meta>{meta}</span>}
        <span className="hub-job-state" data-job-status>{JOB_STATE[job.state] ?? job.state}{job.stale ? ' · quiet for a while' : ''}{job.nothing ? ' · nothing to do' : ''}</span>
        <details className="hub-job-read" data-job-read>
          <summary>Read the job</summary>
          <pre className="hub-job-text">{job.text}</pre>
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
        {job.state === 'proposed' && job.approvable && <a className="hub-btn hub-job-change" href={hubHash('request', job.id)} data-job-change>Change</a>}
        {result?.ok && result.waiting && <span className="hub-muted hub-job-note" data-job-waiting>{result.waiting}</span>}
        {result && !result.ok && <span className="hub-error hub-job-error" role="alert" data-job-error>{result.error ?? 'It could not be approved.'}</span>}
      </div>
    </div>
  )
}

/**
 * The jobs a reply named: one row each, with Approve all for the proposals that can be signed from here. The tap posts the ids on screen
 * (the server never widens the list), and each row then shows its own result. Helpers are another block (`Delegates`); the two never mix.
 */
export default function JobsCard({ conversation, ids, jobs, onChanged }: { conversation: string; ids: string[]; jobs: ChatJob[]; onChanged: () => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [results, setResults] = useState<Record<string, ChatJobResult>>({})
  const rows = ids.map(id => jobs.find(job => job.id === id)).filter((job): job is ChatJob => !!job)
  if (!rows.length) return null
  const ready = rows.filter(job => job.state === 'proposed' && job.approvable)
  const waiting = rows.some(job => job.state === 'proposed')
  const approve = async () => {
    setBusy(true)
    setError('')
    try {
      const answer = await hubPost<{ results: ChatJobResult[] }>(`/chat/${encodeURIComponent(conversation)}/jobs/approve`, { ids: ready.map(job => job.id) })
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
      {waiting && <p className="hub-muted hub-jobs-note" data-jobs-written>Written by hermes, not by you. Read it before approving.</p>}
      {rows.map(job => <JobRow key={job.id} job={job} result={results[job.id]} />)}
      {ready.length > 0 && host.write && host.approve && (
        <div className="hub-jobs-a">
          <button type="button" className="hub-btn pri" disabled={busy} onClick={() => void approve()} data-jobs-approve>{ready.length === 1 ? 'Approve' : `Approve all ${ready.length}`}</button>
        </div>
      )}
      {ready.length > 0 && host.write && !host.approve && <p className="hub-muted" data-jobs-off>{host.approveReason ?? 'Approving needs a signed-in session on a host that can sign.'}</p>}
      {error && <p className="hub-error" role="alert" data-jobs-error>{error}</p>}
    </div>
  )
}
