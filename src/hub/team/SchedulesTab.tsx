import { useState, type ReactNode } from 'react'
import { hubHash } from '../../lib/route'
import type { ScheduleJob, ScheduleSource, ScheduleTimer, SchedulesView } from '../../lib/hubTeam'
import { List, Section, Split } from '../../ui/Layout'
import { useRoute } from './useRoute'
import {
  cadenceWords, clockBoth, GUEST_LINE, jobHash, jobSummary, modelWords, NOT_REPORTED, oldLine, onWords, promptNotes, resultWords, sourceLine, targetWords, troubled, zoneName,
} from './schedulesModel'
import './schedules.css'

/** A word for a value the host may not have sent: the value, or "Not reported". */
const orNot = (value: ReactNode) => (value === undefined || value === null || value === '' ? <span className="team-dim">{NOT_REPORTED}</span> : value)

function JobRow({ job, zone, on, now }: { job: ScheduleJob; zone: string | undefined; on: boolean; now: number }) {
  const state = onWords(job)
  const result = resultWords(job)
  const words = cadenceWords(job.schedule, zone)
  const rest = jobSummary(job, zone, now).slice(words ? 1 : 0)
  return (
    <a role="listitem" className={`ui-row sc-job${on ? ' on' : ''}${troubled(job) ? ' sc-bad' : ''}`} href={jobHash(job.name)} data-job={job.name} data-job-failed={troubled(job) ? '' : undefined} aria-current={on ? 'page' : undefined}>
      <span className="ui-row-body">
        <b>{job.name}</b>
        <small data-job-cadence>{words && <>{words} </>}<code>{job.schedule}</code></small>
        {rest.map(line => <small key={line}>{line}</small>)}
      </span>
      <span className="tk-tags">
        <span className={`ad-tag${state.on ? ' on' : ''}`} data-job-state={state.label.toLowerCase()}>{state.label}</span>
        {result.failed && <span className="ad-tag sc-fail" data-job-result="failed">Last run failed</span>}
        {(job.failureStreak ?? 0) > 0 && <span className="ad-tag sc-fail" data-job-streak>{job.failureStreak} in a row</span>}
      </span>
    </a>
  )
}

function TimerRow({ timer }: { timer: ScheduleTimer }) {
  return (
    <div role="listitem" className="ui-row sc-timer" data-timer={timer.name}>
      <span className="ui-row-body">
        <b>{timer.name}</b>
        {timer.description && <small>{timer.description}</small>}
        {timer.schedule && <small><code>{timer.schedule}</code></small>}
        {timer.lastResult && <small>Last result: {timer.lastResult}</small>}
      </span>
      <span className="tk-tags"><span className={`ad-tag${timer.enabled ? ' on' : ''}`}>{timer.enabled ? 'On' : 'Off'}</span></span>
    </div>
  )
}

/** One list: its heading, where it comes from and how old that is, then the rows, or why there are none. */
function SourceSection({ source, shown, now }: { source: ScheduleSource; shown: string | null; now: number }) {
  const warn = oldLine(source, now)
  const items = source.items
  return (
    <Section title={source.label}>
      <section className="sc-source" data-schedule-source={source.id} data-schedule-state={source.state} aria-label={source.label}>
        <p className="ad-note team-dim sc-from" data-schedule-from>{sourceLine(source, now)}</p>
        {warn && <p className="hub-banner ad-note" role="note" data-schedule-old>{warn}</p>}
        {items.length > 0 && (
          <List label={source.label}>
            {source.id === 'hermes-jobs'
              ? (items as ScheduleJob[]).map(job => <JobRow key={`${job.profile}/${job.name}`} job={job} zone={source.timezone} on={job.name === shown} now={now} />)
              : source.id === 'hermes-timers'
                ? (items as ScheduleTimer[]).map(timer => <TimerRow key={timer.name} timer={timer} />)
                : null}
          </List>
        )}
        {!items.length && source.text && <p className="hub-empty" data-schedule-empty>{source.text}</p>}
      </section>
    </Section>
  )
}

const Fact = ({ name, children, data }: { name: string; children: ReactNode; data: string }) => <div data-fact={data}><dt>{name}</dt><dd>{children}</dd></div>

/** One Hermes job, all of it: where it posts, the model, the times, the last result and the whole prompt. Read only. */
function JobPage({ job, source }: { job: ScheduleJob | null; source: ScheduleSource | undefined }) {
  const back = <a className="team-details-link sc-back" href={hubHash('team', 'schedules')} data-schedule-back>All schedules</a>
  if (!job || !source) return <div className="team-detail tk-page" data-job-page="">{back}<p className="hub-empty" data-job-gone>This job is not in the Hermes host&apos;s export.</p></div>
  const zone = source.timezone
  const state = onWords(job)
  const result = resultWords(job)
  const model = modelWords(job, source.profileModels?.[job.profile])
  const words = cadenceWords(job.schedule, zone)
  const time = (iso: string | undefined) => (iso ? clockBoth(iso, zone) : null)
  const notes = promptNotes(job)
  return (
    <div className="team-detail tk-page" data-job-page={job.name}>
      {back}
      <header className="tk-head">
        <h2>{job.name}</h2>
        <span className="tk-tags">
          <span className={`ad-tag${state.on ? ' on' : ''}`}>{state.label}</span>
          {result.failed && <span className="ad-tag sc-fail">Last run failed</span>}
          {(job.failureStreak ?? 0) > 0 && <span className="ad-tag sc-fail">{job.failureStreak} failed in a row</span>}
        </span>
        <p className="team-dim">{words || 'Runs on the schedule below.'}</p>
      </header>
      <section className="ad-section" aria-labelledby="sc-when">
        <h3 id="sc-when">When it runs</h3>
        <dl className="ad-list">
          <Fact name="Schedule" data="schedule"><code>{job.schedule}</code>{zone && <span className="team-dim"> in {zoneName(zone)} time ({zone})</span>}</Fact>
          <Fact name="Next run" data="next">{orNot(time(job.nextRunAt))}</Fact>
          <Fact name="Last run" data="last">{orNot(time(job.lastRunAt) ?? (job.lastStatus === undefined ? 'No run yet' : null))}</Fact>
          <Fact name="Last result" data="result">{orNot(result.label)}</Fact>
          <Fact name="Last error" data="error">{job.lastError || job.lastDeliveryError ? <>{job.lastError && <span>{job.lastError}</span>}{job.lastDeliveryError && <span className="sc-line">Delivery: {job.lastDeliveryError}</span>}</> : orNot(job.lastStatus === undefined ? '' : 'None')}</Fact>
          <Fact name="Failures in a row" data="streak">{orNot(job.failureStreak)}</Fact>
          <Fact name="Runs done" data="runs">{orNot(job.runsDone)}</Fact>
        </dl>
      </section>
      <section className="ad-section" aria-labelledby="sc-how">
        <h3 id="sc-how">How it runs</h3>
        <dl className="ad-list">
          <Fact name="Posts to" data="posts">{job.postsTo === undefined ? orNot('') : targetWords(job.postsTo)}</Fact>
          <Fact name="Failures go to" data="failures">{job.failuresTo === undefined ? orNot('') : targetWords(job.failuresTo)}</Fact>
          <Fact name="Model" data="model">{model.text}{model.model && <code>{model.model}</code>}{model.pinned && job.provider && <span className="team-dim"> ({job.provider})</span>}</Fact>
          <Fact name="Pre-run script" data="script">{job.script ? <><code>{job.script}</code><span className="team-dim"> runs first and its output goes to the job.</span></> : <span className="team-dim">None</span>}</Fact>
        </dl>
      </section>
      <section className="ad-section" aria-labelledby="sc-prompt" data-job-prompt-section>
        <h3 id="sc-prompt">Prompt</h3>
        <pre className="ad-pre sc-prompt" data-job-prompt>{job.prompt || '(empty)'}</pre>
        {notes.map(note => <p key={note} className="ad-note team-dim" data-job-prompt-note>{note}</p>)}
      </section>
    </div>
  )
}

/**
 * Team's third half: everything that runs on a schedule, from the settings export the Hermes host publishes. The Hermes jobs show all they
 * have; the other lists say "not reporting" until their data arrives. Read only. `head` is the Team heading and tabs, `page` the job whose
 * address is open (null on the list).
 */
export default function SchedulesTab({ page, head, desktop }: { page: { source: 'hermes'; name: string } | null; head: ReactNode; desktop: boolean }) {
  const load = useRoute<SchedulesView>('/schedules')
  const data = load.data
  const guest = load.status === 401
  const [now] = useState(() => Date.now())
  const jobs = data?.sources.find(source => source.id === 'hermes-jobs')
  const items = (jobs?.items ?? []) as ScheduleJob[]
  // Beside the list (900 px and up) the open job, else the first; on a phone only an address shows a job.
  const shown = page?.name ?? (desktop ? items[0]?.name ?? null : null)

  const list = (
    <div className="team-pane tk-pane sc-pane">
      {!desktop && head}
      {guest && <p className="hub-empty" role="status" data-schedules-signin>{GUEST_LINE}</p>}
      {!data && !guest && <p className={load.error ? 'hub-error' : 'hub-empty'} role={load.error ? 'alert' : undefined}>{load.error ?? 'Loading…'}</p>}
      {data && (
        <>
          <p className="ad-note team-dim" data-schedules-copy>{data.note}</p>
          {data.sources.map(source => <SourceSection key={source.id} source={source} shown={shown} now={now} />)}
        </>
      )}
    </div>
  )
  const detail = page && !data
    ? <div className="team-detail">{guest ? <p className="hub-empty">{GUEST_LINE}</p> : <p className={load.error ? 'hub-error' : 'hub-empty'}>{load.error ?? 'Loading…'}</p>}</div>
    : data && shown !== null ? <JobPage job={items.find(job => job.name === shown) ?? null} source={jobs} /> : undefined
  const split = <Split list={list} empty="Pick a job from the list." detail={detail} />
  return desktop ? <div className="tk-shell"><div className="tk-top">{head}</div>{split}</div> : split
}
