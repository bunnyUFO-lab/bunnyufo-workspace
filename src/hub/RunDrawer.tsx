import { useCallback, useEffect, useRef, useState } from 'react'
import { host } from '../lib/host'
import { HUB_WROTE, HubError, ago, clock, fileUrl, hubPost, safeUrl, sessionUrl } from '../lib/hub'
import { MACHINE } from '../lib/hubSpawn'
import type { SpawnTarget } from '../lib/hubSpawn'
import { entityHash, hubHash } from '../lib/route'
import type { RequestDetail } from './ApprovalView'
import Md from './Md'
import { setFocus } from './needsFocus'
import { RUN_EVENT, takeRun } from './runStore'
import type { LiveLine } from './runLines'
import { applyRunEvent, elapsedLabel } from './runLines'
import { streamRun } from './runStream'
import { useHubData } from './useHub'
import './runs.css'

/** More of `GET /hub/requests/:id` than the approval view reads: the run files. */
interface RunDetail extends RequestDetail {
  taken?: { runner?: string; host?: string; at: string; session?: string }
  runs?: { state: string; lastAction?: string; sessionLink?: string; at: string }[]
  result?: { outcome: string; summary?: string; reason?: string; pr?: string; card?: string; usage?: Record<string, unknown>; at?: string; question?: string }
  hermesRun?: { runId: string; at: string }
  retry?: { runId: string; at: string; provider: string; model: string; reason: string }
  stop?: { reason?: string; at?: string; by?: string }
  report?: boolean
  /** Where an approved cloud request stands, from the site API's fire queue. */
  cloud?: CloudState
  fires?: CloudFire[]
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
  const session = safeUrl(okFire?.session)
  switch (cloud.status) {
    case 'queued': return { text: 'Starting in the cloud…', retry: false }
    case 'waiting':
      if (cloud.reason === 'daily-cap') return { text: `Waiting: ${cloud.cap ?? 10} cloud ${(cloud.cap ?? 10) === 1 ? "run" : "runs"} today. Starts at ${whenLabel(cloud.next)}.`, retry: false }
      if (cloud.reason === 'usage-limit') return { text: `Waiting: cloud usage limit. Tries again at ${whenLabel(cloud.next)}.`, retry: false }
      return { text: `Could not start in the cloud yet (${fireReason(fires[0]?.reason)}). Tries again at ${whenLabel(cloud.next)}.`, retry: false }
    case 'fired': return { text: `Started in the cloud at ${okFire ? clock(okFire.at) : 'an unknown time'}`, retry: false, session }
    case 'fire-failed': return { text: `Could not start in the cloud: ${fireReason(cloud.reason ?? fires[0]?.reason)}`, retry: true }
    default: return { text: `Fired at ${okFire ? clock(okFire.at) : 'an unknown time'} but the run has not started.`, retry: true, session }
  }
}

const STOPPABLE = new Set(['approved', 'taken', 'running', 'lost', 'asking'])
const AGAIN = new Set(['expired', 'failed', 'lost'])
const LIVE_STATES = new Set(['approved', 'taken', 'running', 'stopping'])
const RUN_WORD: Record<string, string> = { started: 'Started', working: 'Working', 'turn-ended': 'Turn ended', 'usage-limit': 'Usage limit' }

const usageLine = (usage?: Record<string, unknown>) => Object.entries(usage ?? {}).filter(([, value]) => typeof value === 'number').slice(0, 4).map(([name, value]) => `${name.replace(/_/g, ' ')} ${(value as number).toLocaleString()}`).join(' · ')

/** The link to the card a run wrote: a site link as it is, `section/folder` as the card of that folder. */
function cardLink(card: string): string | undefined {
  const site = safeUrl(card)
  if (site) return site
  const folder = /^[\w-]+\/([\w.-]+)$/.exec(card)?.[1]
  return folder ? entityHash(folder) : undefined
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
        if (line.kind === 'tool') return <p key={index} className={`rd-tool ${line.state}`} data-run-tool={line.state}><span className="rd-tool-n">{line.tool}</span> <span className="rd-tool-p">{line.preview}</span><span className="rd-tool-s">{line.state === 'running' ? <>running · <Elapsed since={line.startedAt} /></> : line.state === 'failed' ? 'failed' : 'done'}</span></p>
        return (
          <div key={index} className="rd-approval" data-run-approval>
            <b>{line.settled ? 'Hermes asked, and it is settled' : 'Hermes asks for approval'}</b>
            {line.command && <pre className="ni-mono">{line.command}</pre>}
            {line.description && <p className="hub-muted">{line.description}</p>}
            {!line.settled && <a href={hubHash('needs')} className="hub-btn" data-run-approval-link>Answer it in Needs you</a>}
          </div>
        )
      })}
    </div>
  )
}

/**
 * One request's run, as the body of the drawer and as a page (`#/~hub/request/<id>` for a request past approval): its
 * state, a timeline, the live lines of a Hermes run while it goes, and the result. `onGone` runs when Approve again makes a
 * new request, with its id.
 */
export function RunView({ id, onGone }: { id: string; onGone?: (id: string) => void }) {
  const { data: detail, error, reload } = useHubData<RunDetail>(`/requests/${encodeURIComponent(id)}`)
  const [lines, setLines] = useState<LiveLine[]>([])
  const [ended, setEnded] = useState(false)
  const [report, setReport] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
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
    try { await work() } catch (failure) { setProblem(failure instanceof HubError || failure instanceof Error ? failure.message : 'It did not work.') } finally { setBusy(false); reload() }
  }, [reload])

  if (!detail) return <p className="hub-muted">{error ?? 'Loading…'}</p>
  const { request, approved, taken, runs = [], result, retry, stop, cloud, fires = [] } = detail
  const cloudShown = cloud && state === 'approved' ? cloudLine(cloud, fires) : null
  const dry = !!cloud?.dryRun || fires.some(fire => fire.dryRun)
  const target = (approved?.target ?? request.target) as SpawnTarget | undefined
  const by = approved ? (approved.by === 'policy' ? 'Signed by policy' : `Approved by ${approved.by}`) : null
  const stoppable = STOPPABLE.has(state) && host.write && !!approved
  const again = AGAIN.has(state) && host.write
  const cardHref = result?.card ? cardLink(result.card) : undefined
  const prHref = safeUrl(result?.pr)

  return (
    <div className="rd" data-run-view={id} data-run-state={state}>
      <div className="rd-head">
        <span className="hub-id" data-run-id>{request.id}</span>
        {request.preset && <span className="ni-chip" data-run-preset>{request.preset.replace(/-/g, ' ')}</span>}
        <span className={`ni-chip rd-state ${state}`} data-run-state-chip>{STATE_WORD[state] ?? state}</span>
      </div>
      <h3 className="rd-title">{request.title ?? request.text.slice(0, 80)}</h3>
      <p className="rd-body" data-run-request-text>{request.text}</p>
      {target && <p className="hub-muted" data-run-target>Runs on {MACHINE[target]?.name ?? target}{request.doneWhen ? ` · done when: ${request.doneWhen}` : ''}</p>}
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

      <h4 className="rd-h">Timeline</h4>
      <ol className="rd-timeline" data-run-timeline>
        {stop && <li data-step="stop"><b>Stop</b> {stop.reason ?? 'stopped'}{stop.at ? ` · ${clock(stop.at)}` : ''}</li>}
        {result && <li data-step="result"><b>{result.outcome === 'failed' ? 'Failed' : 'Finished'}</b> {result.outcome}{result.reason ? ` (${result.reason})` : ''}{result.at ? ` · ${clock(result.at)}` : ''}</li>}
        {runs.map(run => (
          <li key={run.at} data-step="run"><b>{RUN_WORD[run.state] ?? run.state}</b> {run.lastAction ?? ''} · {clock(run.at)}{sessionUrl(run.sessionLink) && <> · <a href={sessionUrl(run.sessionLink)} target="_blank" rel="noopener noreferrer">Open session</a></>}</li>
        ))}
        {fires.map(fire => (
          <li key={fire.at + String(fire.ok)} data-step="fire"><b>{fire.ok ? 'Fired' : 'Fire failed'}</b> {fire.ok ? 'in the cloud' : fireReason(fire.reason)} · {clock(fire.at)}{fire.dryRun ? ' (dev: nothing was sent)' : ''}{fire.ok && safeUrl(fire.session) && <> · <a href={safeUrl(fire.session)} target="_blank" rel="noopener noreferrer">Open session</a></>}</li>
        ))}
        {taken && <li data-step="taken"><b>Taken</b> by {taken.runner ?? taken.host ?? 'a runner'}{taken.host && taken.runner ? ` on ${taken.host}` : ''} · {clock(taken.at)}</li>}
        {approved && <li data-step="approved"><b data-run-by>{by}</b> · {clock(approved.at)}</li>}
        <li data-step="created"><b>Written</b> by {request.by ?? 'someone'} · {ago(request.createdAt)}</li>
      </ol>

      {(live || lines.length > 0) && (
        <>
          <h4 className="rd-h">Run</h4>
          <Live lines={lines} ended={ended} />
        </>
      )}

      {result && (result.outcome !== 'question' || result.summary) && (
        <>
          <h4 className="rd-h">Result</h4>
          <div className="rd-result" data-run-result>
            {result.summary && <p>{result.summary}</p>}
            {result.outcome === 'unknown' && <p className="hub-muted">Hermes forgot this run, so its outcome is not known. Check the card, if there is one.</p>}
            <div className="rd-links">
              {prHref && <a className="hub-btn" href={prHref} target="_blank" rel="noopener noreferrer" data-run-pr>Open the PR</a>}
              {cardHref && <a className="hub-btn" href={cardHref} data-run-card>Open the card</a>}
            </div>
            {usageLine(result.usage) && <p className="hub-muted" data-run-usage>{usageLine(result.usage)}</p>}
          </div>
          {hasReport && report && <div className="rd-report" data-run-report><Md text={report} /></div>}
        </>
      )}

      {problem && <p className="hub-error" role="alert" data-run-error>{problem}</p>}
      {(stoppable || again) && (
        <div className="ni-a rd-foot">
          {stoppable && <button type="button" className="hub-btn danger" disabled={busy || state === 'stopping'} onClick={() => void act(async () => { await hubPost(`/requests/${encodeURIComponent(id)}/stop`, {}) })} data-run-stop>Stop</button>}
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

/** The drawer: a side panel on a desktop and a bottom sheet on a phone (runs.css). A modal dialog, so Escape and the focus trap come with it. */
function RunDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [shown, setShown] = useState(id)
  useEffect(() => {
    const node = dialog.current
    if (node && !node.open) node.showModal()
    node?.querySelector<HTMLElement>('.rd-close')?.focus()
  }, [])
  return (
    <dialog ref={dialog} className="run-drawer" aria-labelledby="run-drawer-title" data-run-drawer onClose={onClose} onClick={event => { if (event.target === dialog.current) dialog.current?.close() }}>
      <div className="sp-head">
        <h2 id="run-drawer-title">Run</h2>
        <a className="hub-btn rd-page" href={hubHash('request', shown)} onClick={() => dialog.current?.close()}>Open as a page</a>
        <button type="button" className="hub-btn sp-x rd-close" aria-label="Close" onClick={() => dialog.current?.close()}>×</button>
      </div>
      <div className="sp-body"><RunView key={shown} id={shown} onGone={setShown} /></div>
    </dialog>
  )
}

/** Mounted once in the Hub screen: opens the drawer when `openRun` is called, and gives the focus back to what opened it. */
export default function RunDrawerHost() {
  const [id, setId] = useState<string | null>(null)
  const opener = useRef<HTMLElement | null>(null)
  useEffect(() => {
    const open = () => {
      const next = takeRun()
      if (!next) return
      if (!(document.activeElement instanceof HTMLElement && document.activeElement.closest('dialog'))) opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
      setId(next)
    }
    window.addEventListener(RUN_EVENT, open)
    return () => window.removeEventListener(RUN_EVENT, open)
  }, [])
  const showing = !!id
  useEffect(() => {
    if (showing) return
    const back = opener.current
    opener.current = null
    if (back && document.contains(back)) back.focus({ preventScroll: true })
  }, [showing])
  return id ? <RunDrawer key={id} id={id} onClose={() => setId(null)} /> : null
}
