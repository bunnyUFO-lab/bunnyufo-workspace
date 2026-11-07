import { useCallback, useEffect, useRef, useState } from 'react'
import { host } from '../lib/host'
import { HUB_WROTE, HubError, ago, clock, fileUrl, hubPost, safeUrl, sessionUrl } from '../lib/hub'
import type { Deliverable } from '../lib/hub'
import { MACHINE } from '../lib/hubSpawn'
import type { SpawnTarget } from '../lib/hubSpawn'
import { hubHash, projectNodeHash } from '../lib/route'
import { back } from '../lib/entries'
import type { RequestDetail } from './ApprovalView'
import Md from './Md'
import { setFocus } from './needsFocus'
import RunReply from './RunReply'
import type { LiveLine } from './runLines'
import { applyRunEvent, elapsedLabel } from './runLines'
import { streamRun } from './runStream'
import { useHubData } from './useHub'
import { usePcWake } from './usePcWake'
import type { PcWait } from '../lib/hubPc'
import { PcFix } from './PcStuckView'
import { requestStateWord } from './working'
import WakeButton from './WakeButton'
import './runs.css'

/** More of `GET /hub/requests/:id` than the approval view reads: the run files. */
interface RunDetail extends RequestDetail {
  taken?: { runner?: string; host?: string; at: string; session?: string }
  runs?: { state: string; lastAction?: string; sessionLink?: string; at: string }[]
  result?: { outcome: string; summary?: string; reason?: string; pr?: string; card?: string; usage?: Record<string, unknown>; at?: string; question?: string }
  hermesRun?: { runId: string; at: string }
  /** The result's card as a site path, when the site API found it. */
  cardHref?: string
  /** The run found nothing to change: the site API's reading of a failed result with a listed reason. */
  nothing?: boolean
  retry?: { runId: string; at: string; provider: string; model: string; reason: string }
  stop?: { reason?: string; at?: string; by?: string }
  report?: boolean
  /** What the job delivered, read by the site API (a result page only); absent when that read failed. */
  deliverables?: Deliverable[]
  /** The preset's agent, as the job list shows it. */
  agent?: string
  /** Whether the PC can start an approved PC job, from the PC's report; absent when the Hub has nothing to say. */
  pcWait?: PcWait
  /** Where an approved cloud request stands, from the site API's fire queue. */
  cloud?: CloudState
  fires?: CloudFire[]
  /** The request this one was continued as, when the owner replied after it ended. */
  continued?: { to: string; at?: string }
  /** The owner's replies, newest first; `queued` is not delivered yet (or the run ended without reading it). */
  replies?: { id: string; text: string; at: string; by?: string; delivery: 'sent' | 'queued' | 'continued'; to?: string }[]
}

interface CloudFire { at: string; ok: boolean; status?: number; session?: string; reason?: string; dryRun?: boolean }
interface CloudState { status: 'queued' | 'fired' | 'waiting' | 'fire-failed' | 'not-started'; reason?: string; next?: string; cap?: number; dryRun?: boolean }

const STATE_WORD: Record<string, string> = {
  proposed: 'Proposed', expired: 'Expired', approved: 'Approved', taken: 'Taken', running: 'Running', stopping: 'Stopping', stopped: 'Stopped',
  asking: 'Asking you', failed: 'Failed', lost: 'Lost', done: 'Done', declined: 'Declined', open: 'Open',
}
/** Why a fire failed, in words. The routine's address, token and repo name never reach this screen. */
function fireReason(reason: string | undefined): string {
  if (!reason) return 'the routine did not start'
  if (reason === 'network') return 'the routine could not be reached'
  if (reason === 'timeout') return 'the routine did not answer in time'
  if (reason === 'routine-repo-unset') return "this repo's routine is not fully set up"
  const code = /^http-(\d{3})$/.exec(reason)?.[1]
  if (!code) return 'the routine did not start'
  if (code === '401' || code === '403') return 'the routine refused the request'
  if (code === '404') return 'the routine was not found'
  return Number(code) >= 500 ? "the routine's service had an error" : `the routine answered ${code}`
}

/** A time for a line that points ahead: the clock today, the weekday and clock on another day. */
function whenLabel(iso: string | undefined, now = new Date()): string {
  const date = new Date(iso ?? '')
  if (Number.isNaN(date.getTime())) return 'later'
  return date.toDateString() === now.toDateString() ? clock(iso as string) : `${date.toLocaleDateString([], { weekday: 'short' })} ${clock(iso as string)}`
}

/** The drawer's line for a cloud request, and what it can do. */
function cloudLine(cloud: CloudState, fires: CloudFire[]): { text: string; retry: boolean; session?: string } {
  const okFire = fires.find(fire => fire.ok)
  const session = sessionUrl(okFire?.session)
  switch (cloud.status) {
    case 'queued': return { text: 'Starting in the cloud…', retry: false }
    case 'waiting':
      if (cloud.reason === 'daily-cap') return { text: `Waiting: ${cloud.cap ?? 10} cloud ${(cloud.cap ?? 10) === 1 ? "run" : "runs"} today. Starts at ${whenLabel(cloud.next)}.`, retry: false }
      if (cloud.reason === 'usage-limit') return { text: `Waiting on the usage pause: cloud runs are paused after a usage limit, which is separate from today's count. Tries again at ${whenLabel(cloud.next)}.`, retry: false }
      return { text: `Could not start in the cloud yet (${fireReason(fires[0]?.reason)}). Tries again at ${whenLabel(cloud.next)}.`, retry: false }
    case 'fired': return { text: `Started in the cloud at ${okFire ? clock(okFire.at) : 'an unknown time'}`, retry: false, session }
    case 'fire-failed': return { text: `Could not start in the cloud: ${fireReason(cloud.reason ?? fires[0]?.reason)}`, retry: true }
    default: return { text: `Fired at ${okFire ? clock(okFire.at) : 'an unknown time'} but the run has not started.`, retry: true, session }
  }
}

/** The new request's id in a stop reason the cloud move wrote ("moved to the cloud: <id>"). */
const movedTo = (reason: string | undefined) => /^moved to the cloud: (\S+)$/.exec(reason ?? '')?.[1] ?? null

/** "Runs on the cloud": a machine's name in the middle of a sentence. */
const runsOn = (target: string) => (target === 'at-pc' ? 'You start it at the PC' : `Runs on ${(MACHINE[target as SpawnTarget]?.name ?? target).replace(/^The /, 'the ')}`)

/** A run's reason in words, for the timeline. */
const reasonWord = (reason: string) => (reason === 'approval-refused' ? 'the approval was not accepted' : reason)

/** A job in one of these states has a result page: the summary and what it delivered first, the log closed. */
const FINISHED = new Set(['done', 'failed', 'stopped', 'asking'])
const STOPPABLE = new Set(['approved', 'taken', 'running', 'lost', 'asking'])
const AGAIN = new Set(['expired', 'failed', 'lost'])
/** A queued reply the run will not carry on its own: the owner stopped it, it timed out or failed, or it finished before the Hub sent it. */
const sendNow = (state: string) => ['stopped', 'failed', 'lost', 'done', 'asking', 'expired'].includes(state)
const notSent = (state: string) => (state === 'stopped' ? 'not sent: the run stopped' : state === 'failed' || state === 'lost' ? 'not sent: the run failed' : 'not sent')
const LIVE_STATES = new Set(['approved', 'taken', 'running', 'stopping'])
const RUN_WORD: Record<string, string> = { started: 'Started', working: 'Working', 'turn-ended': 'Turn ended', 'usage-limit': 'Usage limit' }

const usageLine = (usage?: Record<string, unknown>) => Object.entries(usage ?? {}).filter(([, value]) => typeof value === 'number').slice(0, 4).map(([name, value]) => `${name.replace(/_/g, ' ')} ${(value as number).toLocaleString()}`).join(' · ')

/** The link to the card a run wrote: a site link as it is, `section/folder` as the card of that folder. */
function cardLink(card: string, resolved?: string): string | undefined {
  const site = safeUrl(card)
  if (site) return site
  // The site API finds the card's id in its section (a folder is not an id, and the card may be in another section).
  if (resolved && /^\/[\w%-]+#\/[\w%.~-]+$/.test(resolved)) return resolved
  // Never the folder as a card id: it does not resolve. The card shows as not found until the server lists it.
  return undefined
}

/** The running time of one tool step, ticking each second; only this span re-renders. */
function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])
  return <span data-run-elapsed>{elapsedLabel(now - since)}</span>
}

function Live({ lines, ended }: { lines: LiveLine[]; ended: boolean }) {
  if (!lines.length) return <p className="hub-muted" data-run-waiting>{ended ? 'The run said nothing.' : 'Waiting for Hermes…'}</p>
  return (
    <div className="rd-live" data-run-live aria-live="polite">
      {lines.map((line, index) => {
        if (line.kind === 'text') return <p key={index} className="rd-text" data-run-text>{line.text}</p>
        if (line.kind === 'reply') return <p key={index} className="rd-you" data-run-you={line.state}><b>You:</b> {line.text} <span className="rd-you-s" data-run-you-state>{line.state}</span></p>
        if (line.kind === 'tool') return <p key={index} className={`rd-tool ${line.state}`} data-run-tool={line.state}><span className="rd-tool-n">{line.tool}</span> <span className="rd-tool-p">{line.preview}</span><span className="rd-tool-s">{line.state === 'running' ? <>running · <Elapsed since={line.startedAt} /></> : line.state === 'failed' ? 'failed' : 'done'}</span></p>
        return (
          <div key={index} className="rd-approval" data-run-approval>
            <b>{line.settled ? 'Hermes asked, and it is settled' : 'Hermes asks for approval'}</b>
            {line.command && <pre className="ni-mono">{line.command}</pre>}
            {line.description && <p className="hub-muted">{line.description}</p>}
            {!line.settled && <a href={hubHash('needs', 'all')} className="hub-btn" data-run-approval-link>Answer it in Needs you</a>}
          </div>
        )
      })}
    </div>
  )
}

const SITE_CARD = /^\/[\w%-]+#\/[\w%.~-]+$/
const deliverableKey = (item: Deliverable) => (item.kind === 'card' ? `card:${item.ref}` : item.kind === 'pr' ? `pr:${item.href}` : item.kind === 'task' ? `task:${item.project}/${item.id}` : `${item.kind}:${item.id}`)

/** The card and PR of a result, for a page whose deliverables did not come with the detail. */
function fallbackDeliverables(card: string | undefined, cardHref: string | undefined, pr: string | undefined): Deliverable[] {
  const out: Deliverable[] = []
  if (card) out.push({ kind: 'card', ref: card, section: card.includes('/') ? card.split('/')[0] : '', ...(cardHref ? { href: cardHref } : {}) })
  if (pr) out.push({ kind: 'pr', href: pr, label: 'Pull request' })
  return out
}

const KIND_WORD: Record<string, string> = { ask: 'Ask', checklist: 'Checklist', job: 'Job' }

/** One thing a job delivered, with a button that opens it. A card shows the section it is in, a PR opens in a new tab. */
function DeliverableCard({ item }: { item: Deliverable }) {
  if (item.kind === 'card') {
    const href = item.href && SITE_CARD.test(item.href) ? item.href : undefined
    return (
      <div className="rd-dl" data-run-deliverable="card">
        <b>{item.title ?? item.ref.split('/').pop()}</b>
        <span className="hub-muted">Card{item.section ? ` · ${item.section}` : ''}</span>
        {href ? <div className="rd-links"><a className="hub-btn pri" href={href} data-run-card>Open</a></div> : <span className="hub-muted" data-run-card-missing>Card not found yet: {item.ref.split('/').pop()}</span>}
      </div>
    )
  }
  if (item.kind === 'pr') {
    const href = safeUrl(item.href)
    return (
      <div className="rd-dl" data-run-deliverable="pr">
        <b>{item.label}</b>
        <span className="hub-muted">Pull request</span>
        {href && <div className="rd-links"><a className="hub-btn pri" href={href} target="_blank" rel="noopener noreferrer" data-run-pr>Open the PR</a></div>}
      </div>
    )
  }
  if (item.kind === 'task') {
    return (
      <div className="rd-dl" data-run-deliverable="task" data-task-id={item.id}>
        <b>{item.title ?? item.id}</b>
        <span className="hub-muted">Task · <span className="hub-id" data-run-task-id>{item.id}</span></span>
        <div className="rd-links"><a className="hub-btn pri" href={projectNodeHash(item.project, item.id)} data-run-task>Open</a></div>
      </div>
    )
  }
  const href = item.kind === 'ask' ? hubHash('ask', item.id) : item.kind === 'checklist' ? hubHash('checklist', item.id) : hubHash('request', item.id)
  return (
    <div className="rd-dl" data-run-deliverable={item.kind}>
      <b>{item.title}</b>
      <span className="hub-muted">{KIND_WORD[item.kind]} · {item.state.replace(/-/g, ' ')}</span>
      <div className="rd-links"><a className="hub-btn pri" href={href} data-run-open-item>Open</a></div>
    </div>
  )
}

/**
 * One request's run, as the body of the drawer and as a page (`#/~hub/request/<id>` for a request past approval): its
 * state, a timeline, the live lines of a Hermes run while it goes, and the result. `onGone` runs when Approve again makes a
 * new request, with its id.
 */
export function RunView({ id, onGone, page = false }: { id: string; onGone?: (id: string) => void; /** On the request's own page, which already shows the title, text, id and project. */ page?: boolean }) {
  const { data: detail, error, reload } = useHubData<RunDetail>(`/requests/${encodeURIComponent(id)}`)
  const [lines, setLines] = useState<LiveLine[]>([])
  const [ended, setEnded] = useState(false)
  const [report, setReport] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [confirmStop, setConfirmStop] = useState(false)
  // A copy made by the cloud move names the request it replaces; that one's stop says it was moved.
  const replaces = detail?.request.replaces
  const { data: older } = useHubData<RunDetail>(replaces ? `/requests/${encodeURIComponent(replaces)}` : null)
  const state = detail?.state ?? ''
  const hasRun = !!detail?.hermesRun
  const hasResult = !!detail?.result
  const hasReport = !!detail?.report

  // Tell the other screens (Work, Today, the Needs you badge) when this request moves to another state: the drawer hears of it
  // first, from the stream. Only a change fires, so the refetch that follows does not.
  const seenState = useRef<string | null>(null)
  useEffect(() => {
    if (!state) return
    if (seenState.current !== null && seenState.current !== state) window.dispatchEvent(new Event(HUB_WROTE))
    seenState.current = state
  }, [state])

  // Follow the run while it goes. Closing the view (or leaving the page) closes the stream.
  const live = hasRun && !hasResult && LIVE_STATES.has(state)
  useEffect(() => {
    if (!live) return undefined
    const controller = new AbortController()
    let wait = 0
    let timer = 0
    // Follow until the request reaches a terminal state (this effect ends when `live` turns false). A stream that ends or drops
    // is opened again after a pause that grows to 15 s; the server replays what it buffered, so each connection starts the list again.
    const follow = () => {
      let fresh = true
      streamRun(id, event => {
        wait = 0
        if (event.event === 'state') { reload(); return }
        const restart = fresh
        fresh = false
        setLines(current => applyRunEvent(restart ? [] : current, event))
      }, controller.signal).then(() => { setEnded(true); reload() }, (failure: unknown) => { if ((failure as { name?: string }).name !== 'AbortError') setEnded(true) })
        .finally(() => {
          if (controller.signal.aborted) return
          wait = Math.min(wait === 0 ? 1000 : wait * 2, 15_000)
          timer = window.setTimeout(follow, wait)
        })
    }
    follow()
    return () => { controller.abort(); window.clearTimeout(timer) }
  }, [live, id, reload])

  useEffect(() => {
    if (!hasReport) return undefined
    const controller = new AbortController()
    fetch(fileUrl(`requests/${id}/report.md`), { signal: controller.signal }).then(response => (response.ok ? response.text() : ''), () => '').then(text => setReport(text))
    return () => controller.abort()
  }, [hasReport, id])

  const act = useCallback(async (work: () => Promise<void>) => {
    setBusy(true)
    setProblem(null)
    try { await work(); window.dispatchEvent(new Event(HUB_WROTE)) } catch (failure) { setProblem(failure instanceof HubError || failure instanceof Error ? failure.message : 'It did not work.') } finally { setBusy(false); reload() }
  }, [reload])

  if (!detail) return <p className="hub-muted">{error ?? 'Loading…'}</p>
  const { request, approved, taken, runs = [], result, retry, stop, cloud, fires = [], replies = [] } = detail
  const movedId = movedTo(stop?.reason)
  const cloudShown = cloud && state === 'approved' ? cloudLine(cloud, fires) : null
  const dry = !!cloud?.dryRun || fires.some(fire => fire.dryRun)
  const target = (approved?.target ?? request.target) as SpawnTarget | undefined
  const by = approved ? (approved.by === 'policy' ? 'Signed by policy' : `Approved by ${approved.by}`) : null
  const stoppable = STOPPABLE.has(state) && host.write && !!approved
  // A sprint item is signed by its sprint only: a copy made here would be a lone run outside the chain, so it has no Approve again.
  const again = AGAIN.has(state) && host.write && request.preset !== 'sprint-item'
  const cardHref = result?.card ? cardLink(result.card, detail?.cardHref) : undefined
  const prHref = safeUrl(result?.pr)

  const timeline = (
    <>
      <h4 className="rd-h">Timeline</h4>
      <ol className="rd-timeline" data-run-timeline>
        {detail.continued && <li data-step="continued"><b>Continued as</b> → <a href={hubHash('request', detail.continued.to)} data-run-continued>{detail.continued.to}</a>{detail.continued.at ? ` · ${clock(detail.continued.at)}` : ''}</li>}
        {stop && <li data-step="stop"><b>{movedId ? 'Moved' : 'Stop'}</b> {movedId ? 'to the cloud' : stop.reason ?? 'stopped'}{stop.at ? ` · ${clock(stop.at)}` : ''}</li>}
        {result && <li data-step="result"><b>{result.outcome === 'failed' ? 'Failed' : 'Finished'}</b> {result.outcome}{result.reason ? ` (${reasonWord(result.reason)})` : ''}{result.at ? ` · ${clock(result.at)}` : ''}</li>}
        {runs.map(run => (
          <li key={run.at} data-step="run"><b>{RUN_WORD[run.state] ?? run.state}</b> {run.lastAction ?? ''} · {clock(run.at)}{sessionUrl(run.sessionLink) && <> · <a href={sessionUrl(run.sessionLink)} target="_blank" rel="noopener noreferrer">Open session</a></>}</li>
        ))}
        {fires.map(fire => (
          <li key={fire.at + String(fire.ok)} data-step="fire"><b>{fire.ok ? 'Fired' : 'Fire failed'}</b> {fire.ok ? 'in the cloud' : fireReason(fire.reason)} · {clock(fire.at)}{fire.dryRun ? ' (dev: nothing was sent)' : ''}{fire.ok && sessionUrl(fire.session) && <> · <a href={sessionUrl(fire.session)} target="_blank" rel="noopener noreferrer">Open session</a></>}</li>
        ))}
        {replies.map(row => (
          <li key={row.id} data-step="reply" data-reply-delivery={row.delivery}>
            <b>You:</b> {row.text} · {row.delivery === 'continued' && row.to
              ? <>sent as the next run → <a href={hubHash('request', row.to)} data-run-reply-to>{row.to}</a></>
              : row.delivery === 'sent' ? 'sent'
                : <span data-run-reply-queued>{sendNow(state) ? <>{notSent(state)}{host.write && <> <button type="button" className="hub-btn" disabled={busy} onClick={() => void act(async () => {
                  const made = await hubPost<{ id: string }>(`/requests/${encodeURIComponent(id)}/reply`, { text: row.text })
                  onGone?.(made.id)
                })} data-run-send-now>Send it now</button></>}</> : 'queued; it goes out as the next run when this one ends'}</span>}
          </li>
        ))}
        {taken && <li data-step="taken"><b>Taken</b> by {taken.runner ?? taken.host ?? 'a runner'}{taken.host && taken.runner ? ` on ${taken.host}` : ''} · {clock(taken.at)}</li>}
        {approved && <li data-step="approved"><b data-run-by>{by}</b> · {clock(approved.at)}</li>}
        {request.continues && <li data-step="continues"><b>Continues</b> ← <a href={hubHash('request', request.continues.from)} data-run-continues>{request.continues.from}</a></li>}
        <li data-step="created"><b>Written</b> by {request.by ?? 'someone'} · {ago(request.createdAt)}</li>
      </ol>
    </>
  )
  const liveBlock = (
    <>
      {(live || lines.length > 0) && (
        <>
          <h4 className="rd-h">Run</h4>
          <Live lines={lines} ended={ended} />
        </>
      )}
    </>
  )
  // A job that is still going shows its log open, under the timeline; a delivered one keeps the same log closed under what it delivered.
  const liveFold = (live || lines.length > 0) && (
    <details className="rd-did rd-livelog" data-run-livelog open>
      <summary>Live log</summary>
      <Live lines={lines} ended={ended} />
    </details>
  )
  const resultBlock = (
    <>
      {result && (result.outcome !== 'question' || result.summary) && (
        <>
          <h4 className="rd-h">Result</h4>
          <div className="rd-result" data-run-result>
            {detail?.nothing && <p data-run-nothing><b>Done, nothing to change.</b></p>}
            {result.reason === 'approval-refused'
              && <p data-run-refused>The cloud run did not accept the approval, so it did not start. Approve it again to make a new one.</p>}
            {result.summary && <p>{result.summary}</p>}
            {result.outcome === 'unknown' && <p className="hub-muted">Hermes forgot this run, so its outcome is not known. Check the card, if there is one.</p>}
            <div className="rd-links">
              {prHref && <a className="hub-btn" href={prHref} target="_blank" rel="noopener noreferrer" data-run-pr>Open the PR</a>}
              {cardHref && <a className="hub-btn" href={cardHref} data-run-card>Open the card</a>}
              {!cardHref && result?.card && <span className="hub-muted" data-run-card-missing>Card not found yet: {result.card.split('/').pop()}</span>}
            </div>
            {usageLine(result.usage) && <p className="hub-muted" data-run-usage>{usageLine(result.usage)}</p>}
          </div>
          {hasReport && report && <div className="rd-report" data-run-report><Md text={report} /></div>}
        </>
      )}
    </>
  )
  const delivered = !!result && FINISHED.has(state)
  const dlist: Deliverable[] = detail.deliverables ?? fallbackDeliverables(result?.card, cardHref, prHref)
  const agent = detail.agent
  const where = taken?.runner ?? target
  const kind = [agent, where && where !== 'at-pc' ? (MACHINE[where as SpawnTarget]?.name ?? where) : ''].filter(Boolean).join(' · ')
  // A failed job leads with why it failed, from the record's own words; with none the page says so instead of staying quiet.
  const failed = state === 'failed'
  // A run that never started carries the raw error in its summary (it can be a program message): the owner reads a plain lead, the detail is under What it did.
  const startFailed = result?.reason === 'start-failed'
  const whyFailed = startFailed ? 'The run could not start.' : result?.summary?.trim() || stop?.reason?.trim() || 'Hermes gave no reason.'
  // "What it did" holds the run's own record: a job that delivered nothing and ran nothing (a failure, a stop, nothing to change) would open it on bookkeeping only.
  const didSomething = dlist.length > 0 || runs.length > 0 || fires.length > 0 || replies.length > 0 || lines.length > 0 || !!detail.continued || (startFailed && !!result?.summary) || !!usageLine(result?.usage) || (hasReport && !!report)
  const failure = (
    <>
      <h4 className="rd-h">Why it failed</h4>
      <div className="rd-result rd-failure" data-run-result data-run-failure>
        {/* A refused approval has a plain sentence of its own: it comes first, the server's words follow it. */}
        {result?.reason === 'approval-refused'
          && <p data-run-refused>The cloud run did not accept the approval, so it did not start. Approve it again to make a new one.</p>}
        <p data-run-failure-text>{whyFailed}</p>
      </div>
    </>
  )
  const found = result && (failed ? failure : (
    <>
      <h4 className="rd-h">What it found</h4>
      <div className="rd-result" data-run-result>
        {detail.nothing && <p data-run-nothing><b>Done, nothing to change.</b></p>}
        {result.reason === 'approval-refused'
          && <p data-run-refused>The cloud run did not accept the approval, so it did not start. Approve it again to make a new one.</p>}
        {result.summary && <p data-run-summary>{result.summary}</p>}
        {result.outcome === 'unknown' && <p className="hub-muted">Hermes forgot this run, so its outcome is not known. Check the card, if there is one.</p>}
      </div>
    </>
  ))
  const deliverablesBlock = (
    <>
      {/* A failed job with nothing to open has no Deliverables block at all: the failure above is the whole answer. */}
      {(dlist.length > 0 || !failed) && <h4 className="rd-h">What it delivered</h4>}
      {(dlist.length > 0 || !failed) && <div className="rd-dls" data-run-deliverables>
        {dlist.map(item => <DeliverableCard key={deliverableKey(item)} item={item} />)}
        {!dlist.length && (
          <p className="hub-muted" data-run-no-deliverables>
            {detail.nothing ? 'Done, nothing to change.' : 'This job delivered nothing you can open.'}
          </p>
        )}
      </div>}
      {request.bead && <p className="hub-muted rd-from" data-run-from-task>From task <a href={projectNodeHash(request.project, request.bead)}>{request.bead}</a></p>}
    </>
  )
  return (
    <div className="rd" data-run-view={id} data-run-state={state}>
      <div className="rd-head">
        {!page && <span className="hub-id" data-run-id>{request.id}</span>}
        {!page && request.preset && <span className="ni-chip" data-run-preset>{request.preset.replace(/-/g, ' ')}</span>}
        <span className={`ni-chip rd-state ${detail.stale ? 'stale' : state}`} data-run-state-chip>{requestStateWord(state, detail.stale, STATE_WORD)}</span>
        {delivered && kind && <span className="ni-chip" data-run-agent>{kind}</span>}
        {page && <a className="rd-back" href={hubHash('jobs', delivered || failed ? 'finished' : 'running')} onClick={event => { event.preventDefault(); back(hubHash('jobs', delivered || failed ? 'finished' : 'running')) }} data-run-back>← Work</a>}
      </div>
      {!page && <h3 className="rd-title">{request.title ?? request.text.slice(0, 80)}</h3>}
      {!page && <p className="rd-body" data-run-request-text>{request.text}</p>}
      {movedId && <p className="rd-note" data-run-moved>Moved to the cloud → <a href={hubHash('request', movedId)}>{movedId}</a></p>}
      {!movedId && older && movedTo(older.stop?.reason) === id && <p className="rd-note" data-run-moved-from>Moved from the PC · <a href={hubHash('request', older.request.id)}>{older.request.id}</a></p>}
      {target && <p className="hub-muted" data-run-target>{runsOn(target)}{!page && request.doneWhen ? ` · done when: ${request.doneWhen}` : ''}</p>}
      {state === 'approved' && target === 'pc' && <PcStart wait={detail.pcWait} />}
      {cloudShown && (
        <div className="rd-cloud" data-run-cloud={cloud?.status} data-cloud-reason={cloud?.reason}>
          <p>{cloudShown.text}{dry && <span className="hub-muted" data-run-dry> (dev: nothing was sent)</span>}</p>
          <div className="rd-links">
            {cloudShown.session && <a className="hub-btn" href={cloudShown.session} target="_blank" rel="noopener noreferrer" data-run-session>Open session</a>}
            {cloudShown.retry && host.write && <button type="button" className="hub-btn pri" disabled={busy} onClick={() => void act(async () => { await hubPost(`/requests/${encodeURIComponent(id)}/fire`, {}) })} data-run-fire-retry>Retry</button>}
          </div>
        </div>
      )}
      {retry && <p className="rd-note" data-run-retry>Codex quota reached; retried on Anthropic.</p>}
      {state === 'asking' && (
        <div className="rd-ask" data-run-asking>
          <b>The run ended with a question</b>
          {result?.question && <p>{result.question}</p>}
          <a className="hub-btn pri" href={hubHash('needs', 'question')} onClick={() => setFocus(`run-question-${id}`)} data-run-answer-link>Answer</a>
        </div>
      )}

      {delivered ? (
        <>
          {found}
          {deliverablesBlock}
        </>
      ) : (
        <>
          {failed && !result && failure}
          {timeline}
          {liveFold}
          {resultBlock}
        </>
      )}

      <RunReply id={id} state={state} target={target} approved={!!approved} hasRun={hasRun} continuedTo={detail.continued?.to} onGone={onGone} onSent={reload} />
      {delivered && didSomething && (
        <details className="rd-did" data-run-did>
          <summary>Live log</summary>
          {startFailed && result?.summary && <p className="hub-muted" data-run-failure-detail>{result.summary}</p>}
          {timeline}
          {liveBlock}
          {usageLine(result?.usage) && <p className="hub-muted" data-run-usage>{usageLine(result?.usage)}</p>}
          {hasReport && report && <div className="rd-report" data-run-report><Md text={report} /></div>}
        </details>
      )}
      {problem && <p className="hub-error" role="alert" data-run-error>{problem}</p>}
      {(stoppable || again) && (
        <div className="ni-a rd-foot">
          {stoppable && !confirmStop && <button type="button" className="hub-btn danger" disabled={busy || state === 'stopping'} onClick={() => setConfirmStop(true)} data-run-stop>{state === 'asking' ? 'Stop this job' : 'Stop'}</button>}
          {stoppable && confirmStop && (
            <span className="rd-confirm" role="group" aria-label="Stop this job?" data-run-stop-ask>
              <span>Stop this job?</span>
              <button type="button" className="hub-btn danger" disabled={busy} onClick={() => void act(async () => { try { await hubPost(`/requests/${encodeURIComponent(id)}/stop`, {}) } finally { setConfirmStop(false) } })} data-run-stop-confirm>Yes, stop it</button>
              <button type="button" className="hub-btn" disabled={busy} onClick={() => setConfirmStop(false)} data-run-stop-cancel>Keep going</button>
            </span>
          )}
          {again && <button type="button" className="hub-btn pri" disabled={busy} onClick={() => void act(async () => {
            const made = await hubPost<{ id: string }>(`/requests/${encodeURIComponent(id)}/again`, { target })
            onGone?.(made.id)
          })} data-run-again>Approve again</button>}
        </div>
      )}
      {state === 'stopping' && <p className="hub-muted" role="status" data-run-stopping>Stopping…</p>}
    </div>
  )
}

/**
 * An approved PC request starts at the watcher's next tick, within a few minutes, unless the Hub knows better from the PC's report: then it
 * says why it will not start (with the command to fix it), or what it is waiting for. When the PC reads as asleep or off, it can be woken from here.
 */
function PcStart({ wait }: { wait?: PcWait }) {
  const wake = usePcWake()
  const blocked = wait?.state === 'blocked' || wait?.state === 'stuck'
  return (
    <div className="rd-pc" data-run-pc-start>
      {blocked && <p data-run-pc-blocked={wait.cause}>{wait.text}</p>}
      {blocked && <PcFix wait={wait} />}
      {wait?.state === 'wait' && <p data-run-pc-wait={wait.kind}>{wait.text}</p>}
      {!blocked && wait?.state !== 'wait' && <p>Starts on the PC within a few minutes.</p>}
      <WakeButton wake={wake} />
    </div>
  )
}
