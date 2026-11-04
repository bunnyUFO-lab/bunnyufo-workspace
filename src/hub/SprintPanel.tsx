import { useEffect, useState } from 'react'
import type { MapMilestone, MapSprint, SprintPreview } from '../lib/hub'
import { hubPost, safeUrl } from '../lib/hub'
import { host } from '../lib/host'
import { hubHash } from '../lib/route'
import { useHubData } from './useHub'
import { DEFAULT_TIMEBOX, TIMEBOXES, confirmLine, currentItem, endLine, itemLine, itemWord, leftWord, stoppable, timeLeft } from './sprint'
import './sprint.css'

const slug = encodeURIComponent

/** A sprint that is going or ended: item n of m, the time left, each item's state and PR, and Stop. */
function Progress({ sprint, onStop, stopping, error }: { sprint: MapSprint; onStop: (id: string) => void; stopping: boolean; error: string }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [])
  const live = currentItem(sprint)
  return (
    <>
      {sprint.ended
        ? <p data-sprint-ended={sprint.ended.reason}><strong>Sprint ended.</strong> {endLine(sprint)}</p>
        : <p data-sprint-progress>{itemLine(sprint)} · <span data-sprint-left>{timeLeft(sprint.until, now)}</span></p>}
      <ol className="hub-sprint-list" data-sprint-items>
        {sprint.items.map((item, index) => {
          const url = safeUrl(item.pr)
          return (
            <li key={item.id} data-sprint-item={item.bead} data-state={item.state}>
              <span className="hub-sprint-order">{index + 1}.</span>
              <span className="hub-sprint-title">{item.title}</span>
              <span className="hub-sprint-state" data-sprint-state>{itemWord(item.state)}</span>
              {item.state !== 'waiting' && <a className="hub-sprint-state" href={hubHash('request', item.id)} data-sprint-run>Open the run</a>}
              {url && <a className="hub-btn" href={url} target="_blank" rel="noopener noreferrer" data-sprint-pr>Open PR</a>}
            </li>
          )
        })}
      </ol>
      {!sprint.ended && live && host.write && stoppable(live.state) && (
        <div className="hub-actions start">
          <button type="button" className="hub-btn danger" disabled={stopping} onClick={() => onStop(live.id)} data-sprint-stop>Stop the sprint</button>
          <span className="hub-sprint-sub">Stops this item. No later item starts.</span>
        </div>
      )}
      {error && <p className="hub-error" role="alert" data-sprint-error>{error}</p>}
    </>
  )
}

/**
 * "Run a sprint" on a milestone's sheet (ws-im1.2.2): a chain of ordinary PC runs, one bead each, stacked PRs, questions to Needs you.
 * The sheet shows the beads in order and the ones left out with why; Start asks once, listing the beads. While it goes the sheet shows the
 * progress; Stop signs a stop on the current item, which ends the sprint. The Hub decides everything; this only asks.
 */
export default function SprintPanel({ project, milestone }: { project: string; milestone: MapMilestone }) {
  const sprint = milestone.sprint
  const synthetic = milestone.id.includes('~')
  const preview = useHubData<SprintPreview>(synthetic ? null : `/map/${slug(project)}/sprint/${slug(milestone.id)}`)
  const [timebox, setTimebox] = useState(DEFAULT_TIMEBOX)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState('')

  if (synthetic) return null
  const going = !!sprint && !sprint.ended
  const data = preview.data

  async function start() {
    setBusy(true)
    setProblem('')
    try {
      await hubPost(`/map/${slug(project)}/sprint/${slug(milestone.id)}`, { timebox, digest: data?.digest })
      setConfirming(false)
      preview.reload()
    } catch (failure) {
      setProblem(failure instanceof Error ? failure.message : 'The sprint did not start.')
      setConfirming(false)
      preview.reload()
    } finally {
      setBusy(false)
    }
  }

  async function stop(id: string) {
    setBusy(true)
    setProblem('')
    try {
      await hubPost(`/requests/${slug(id)}/stop`, {})
      preview.reload()
    } catch (failure) {
      setProblem(failure instanceof Error ? failure.message : 'The stop did not go through.')
    } finally {
      setBusy(false)
    }
  }

  // A finished milestone has nothing to run, and a read-only host cannot start one; either still shows a sprint that happened.
  if (!sprint && (milestone.state === 'done' || (!host.write && !data))) return null

  const body = sprint ? <Progress sprint={sprint} onStop={id => void stop(id)} stopping={busy} error={problem} /> : null
  let offer = null
  if (!going && data) {
    const others = data.active && data.active.milestone !== milestone.id
    if (!data.allowed) {
      offer = <p className="hub-muted" data-sprint-not-pc>{data.why}</p>
    } else if (others) {
      offer = <p className="hub-muted" data-sprint-busy>A sprint is going on another milestone of this project. It must end first.</p>
    } else if (host.write) {
      const chosen = TIMEBOXES.find(chip => chip.minutes === timebox)
      offer = (
        <>
          <div className="hub-chips" role="group" aria-label="Timebox">
            {TIMEBOXES.map(chip => (
              <button key={chip.minutes} type="button" className={`hub-chip${chip.minutes === timebox ? ' on' : ''}`} aria-pressed={chip.minutes === timebox} data-sprint-chip={chip.minutes} onClick={() => { setTimebox(chip.minutes); setConfirming(false) }}>{chip.label}</button>
            ))}
          </div>
          {data.items.length > 0
            ? (
              <>
                <h5>Beads, in order</h5>
                <ol className="hub-sprint-list" data-sprint-plan>
                  {data.items.map((item, index) => <li key={item.id} data-sprint-plan-item={item.id}><span className="hub-sprint-order">{index + 1}.</span><span className="hub-sprint-title">{item.title}</span><span className="hub-id">{item.id}</span></li>)}
                </ol>
              </>
            )
            : <p className="hub-muted" data-sprint-empty>Nothing to run: every task here is left out.</p>}
          {data.left.length > 0 && (
            <>
              <h5>Left out</h5>
              <ul className="hub-sprint-list" data-sprint-left-out>
                {data.left.map(row => <li key={row.id} data-sprint-left-reason={row.reason}><span className="hub-sprint-title">{row.title}</span><span className="hub-sprint-why">{leftWord(row.reason, row.by)}</span></li>)}
              </ul>
            </>
          )}
          {confirming
            ? (
              <div className="hub-sprint-confirm" data-sprint-confirm>
                <p>{confirmLine(data.items.length, timebox)}</p>
                <ol className="hub-sprint-list" data-sprint-confirm-items>{data.items.map((item, index) => <li key={item.id}><span className="hub-sprint-order">{index + 1}.</span><span className="hub-sprint-title">{item.title}</span></li>)}</ol>
                <div className="hub-actions start">
                  <button type="button" className="hub-btn pri" disabled={busy || !host.approve} onClick={() => void start()} data-sprint-go>Start the sprint</button>
                  <button type="button" className="hub-btn" disabled={busy} onClick={() => setConfirming(false)} data-sprint-cancel>Cancel</button>
                </div>
              </div>
            )
            : (
              <div className="hub-actions start">
                <button type="button" className="hub-btn pri" disabled={busy || data.items.length === 0 || !host.approve} onClick={() => setConfirming(true)} data-sprint-start>Start · {chosen?.label ?? `${timebox}m`}</button>
                {!host.approve && <span className="hub-sprint-sub" data-sprint-nokey>Sign in to start a sprint.</span>}
              </div>
            )}
          {problem && <p className="hub-error" role="alert" data-sprint-error>{problem}</p>}
        </>
      )
    }
  }
  if (!body && !offer && !preview.error) return null
  return (
    <section className="hub-sprint" data-sprint>
      <h4>Run a sprint</h4>
      <p className="hub-sprint-sub">Claude · stacked PRs, questions come to Needs you</p>
      {body}
      {offer}
      {!body && !offer && preview.error && <p className="hub-error" role="alert" data-sprint-error>{preview.error}</p>}
    </section>
  )
}
