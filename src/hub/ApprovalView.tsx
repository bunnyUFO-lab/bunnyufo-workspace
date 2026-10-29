import { useEffect, useState } from 'react'
import { host } from '../lib/host'
import type { Item } from '../lib/hub'
import { ago, hubGet, hubPost } from '../lib/hub'
import type { SpawnPreset, SpawnRoute, SpawnTarget } from '../lib/hubSpawn'
import { MACHINE } from '../lib/hubSpawn'
import type { SettledVerb } from '../lib/nextItem.mjs'
import { hubHash } from '../lib/route'
import { takeHandoff } from './flash'
import NextNote from './NextNote'
import { RunView } from './RunDrawer'
import { loadPresets } from './spawnData'
import { openSpawn } from './spawnStore'
import { goNext, useQueueOrder } from './useGoNext'
import { useHubData } from './useHub'
import './runs.css'

/** The parts of `GET /hub/requests/:id` this view reads. */
export interface RequestDetail {
  request: {
    id: string; project: string; text: string; title?: string; preset?: string; repo?: string; target?: string
    doneWhen?: string; by?: string; createdAt: string; origin?: { kind: 'owner' | 'agent' | 'run'; name?: string }
  }
  state: string
  approved?: { target: SpawnTarget; by: string; at: string; expires: string; limits?: { minutes: number } }
  result?: { outcome: string; summary?: string; reason?: string }
  declined?: { at: string; by: string; reason?: string }
  stop?: { reason?: string }
}

const STATE_LABEL: Record<string, string> = {
  proposed: 'Waiting for you', expired: 'Expired', approved: 'Approved', taken: 'Taken', running: 'Running', stopping: 'Stopping', stopped: 'Stopped',
  asking: 'Asking you', failed: 'Failed', lost: 'Lost', done: 'Done', declined: 'Declined', open: 'Open',
}

const STARTS: Record<SpawnTarget, string> = { hermes: 'On Hermes right away', pc: 'On the PC when the dispatcher next ticks', cloud: 'In the cloud', 'at-pc': 'When you start it at the PC' }

const sideEffect = (preset: SpawnPreset, repo?: string): string => {
  switch (preset.sideEffect) {
    case 'pr': return `A new branch and a PR in ${repo || 'the repo'}. No merge, no deploy.`
    case 'card': return 'One card in assistant.'
    case 'build': return 'A build and a Playtest item. Nothing is deployed.'
    case 'images': return 'Images on a card and a Design review item.'
    default: return preset.produces
  }
}

/** Who wrote it: the warning is for anything the owner did not write. */
const writtenByOther = (detail: RequestDetail) => detail.request.origin?.kind !== 'owner'
const whoWrote = (detail: RequestDetail) => detail.request.origin?.name || detail.request.by || 'an agent'

function ApprovalActions({ detail, preset, onSettled }: { detail: RequestDetail; preset: SpawnPreset; onSettled: (verb: SettledVerb) => void }) {
  const { request, state } = detail
  const id = request.id
  const [route, setRoute] = useState<SpawnRoute | null>(null)
  const [choice, setChoice] = useState<SpawnTarget | ''>('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [declining, setDeclining] = useState(false)
  const [reason, setReason] = useState('')
  const [copied, setCopied] = useState<string | null>(null)
  const [brief, setBrief] = useState<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    const query = new URLSearchParams({ preset: preset.id, project: request.project })
    if (request.repo) query.set('repo', request.repo)
    hubGet<SpawnRoute>(`/presets/route?${query}`, controller.signal).then(setRoute, () => { /* the proposal's own target is shown */ })
    return () => controller.abort()
  }, [preset.id, request.project, request.repo])

  const proposed = (request.target ?? route?.target ?? preset.targets[0]) as SpawnTarget
  const target: SpawnTarget = choice || (state === 'expired' ? detail.approved?.target : undefined) || proposed
  const atPc = target === 'at-pc'
  const machine = MACHINE[target]
  const why = choice ? 'you chose it' : route && route.target === target ? route.why : request.target === target ? 'proposed with the request' : ''
  const expired = state === 'expired'
  const canSign = host.approve && !atPc

  const run = async (work: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try { await work() } catch (failure) { setError(failure instanceof Error ? failure.message : 'It did not work.') } finally { setBusy(false) }
  }
  const approve = () => run(async () => {
    await hubPost(`/requests/${encodeURIComponent(id)}/${expired ? 'again' : 'approve'}`, { target })
    onSettled('approved')
  })
  const decline = () => run(async () => {
    await hubPost(`/requests/${encodeURIComponent(id)}/decline`, reason.trim() ? { reason: reason.trim() } : {})
    onSettled('declined')
  })
  const markDone = () => run(async () => {
    await hubPost(`/requests/${encodeURIComponent(id)}/done`, {})
    onSettled('done')
  })
  const copy = () => run(async () => {
    const answer = await hubGet<{ brief: string }>(`/presets/brief?request=${encodeURIComponent(id)}`)
    try {
      await navigator.clipboard.writeText(answer.brief)
      setCopied('Prompt copied.')
      setBrief(null)
    } catch {
      setCopied('Copy it from here.')
      setBrief(answer.brief)
    }
  })
  const edit = () => openSpawn({ edit: { id, project: request.project, preset: preset.id, text: request.text, target, ...(request.repo ? { repo: request.repo } : {}), ...(request.doneWhen ? { doneWhen: request.doneWhen } : {}) } })

  return (
    <>
      <dl className="ap-facts" data-approval-facts>
        <div><dt>Runs on</dt><dd>
          <span data-approval-machine>{machine.name}</span>{why && <span className="sp-faint"> · {why}</span>}
          {host.write && preset.targets.length > 1 && (
            <select className="ap-pick" aria-label="Change where it runs" value={choice} onChange={event => setChoice(event.target.value as SpawnTarget | '')} data-approval-target>
              <option value="">As proposed</option>
              {preset.targets.map(item => <option key={item} value={item}>{MACHINE[item].name}</option>)}
            </select>
          )}
        </dd></div>
        <div><dt>Side effects</dt><dd data-approval-effect>{sideEffect(preset, request.repo)}</dd></div>
        <div><dt>Time limit</dt><dd>Up to {detail.approved?.limits?.minutes ?? preset.minutes} minutes</dd></div>
        <div><dt>Starts</dt><dd data-approval-starts>{STARTS[target]}</dd></div>
      </dl>
      {expired && <p className="hub-muted" data-approval-expired>The approval ran out{detail.approved?.expires ? ` ${ago(detail.approved.expires)}` : ''}. Approve it again to start it.</p>}
      {error && <p className="hub-error" role="alert" data-approval-error>{error}</p>}
      {host.write && declining && (
        <label className="hub-field" data-approval-decline-box>Why? (optional)
          <input value={reason} onChange={event => setReason(event.target.value)} maxLength={400} autoComplete="off" data-approval-reason />
        </label>
      )}
      {brief && <pre className="ni-mono" data-approval-brief>{brief}</pre>}
      <div className="ni-a ap-actions" data-approval-actions>
        {!host.write && <span className="hub-muted" data-readonly-note>Sign in to approve this.</span>}
        {host.write && atPc && <button type="button" className="hub-btn pri" disabled={busy} onClick={() => void copy()} data-approval-copy>Copy prompt</button>}
        {host.write && !atPc && <button type="button" className="hub-btn pri" disabled={busy || !canSign} onClick={() => void approve()} data-approval-approve>{expired ? 'Approve again' : 'Approve'}</button>}
        {host.write && <button type="button" className="hub-btn" disabled={busy} onClick={edit} data-approval-edit>Edit</button>}
        {host.write && !declining && <button type="button" className="hub-btn danger" disabled={busy} onClick={() => setDeclining(true)} data-approval-decline>Decline</button>}
        {host.write && declining && (
          <>
            <button type="button" className="hub-btn danger" disabled={busy} onClick={() => void decline()} data-approval-decline-send>Send decline</button>
            <button type="button" className="hub-btn" disabled={busy} onClick={() => setDeclining(false)}>Keep</button>
          </>
        )}
        {host.write && atPc && <><span className="sp" /><button type="button" className="hub-btn" disabled={busy} onClick={() => void markDone()} data-approval-done>Mark done</button></>}
      </div>
      {host.write && !atPc && !canSign && <p className="hub-muted" data-approval-reason-off>{host.approveReason ?? 'Approving needs a signed-in session on a host that can sign.'}</p>}
      {copied && <p className="hub-muted" role="status" data-approval-copied>{copied}</p>}
    </>
  )
}

/** What a request that is no longer waiting for approval shows: its state, who signed it, and how it ended. Run details arrive with the run drawer. */
function RequestState({ detail }: { detail: RequestDetail }) {
  const { approved, result, declined, stop } = detail
  const by = approved ? (approved.by === 'policy' ? 'Signed by policy' : `Approved by ${approved.by}`) : null
  return (
    <div className="ap-state" data-request-state={detail.state}>
      <p>{by}{approved ? ` · ${MACHINE[approved.target]?.name ?? approved.target}` : ''}{approved?.at ? ` · ${ago(approved.at)}` : ''}</p>
      {declined && <p>Declined by {declined.by}{declined.reason ? `: ${declined.reason}` : ''}.</p>}
      {stop?.reason && <p>Stopped: {stop.reason}</p>}
      {result && <p>{result.summary ?? `Outcome: ${result.outcome}`}{result.reason ? ` (${result.reason})` : ''}</p>}
    </div>
  )
}

/**
 * The body of a request an owner may act on, shared by the Needs you card and the request's own page. A proposal or an
 * expired approval shows Approve, Edit and Decline; other states show the state view. `onSettled` runs after Approve,
 * Decline and Mark done.
 */
export function ApprovalBody({ id, onSettled, page = false }: { id: string; onSettled: (verb: SettledVerb) => void; page?: boolean }) {
  const { data: detail, error } = useHubData<RequestDetail>(`/requests/${encodeURIComponent(id)}`)
  const [preset, setPreset] = useState<SpawnPreset | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const name = detail?.request.preset
  useEffect(() => {
    if (!name) return
    loadPresets().then(list => setPreset(list.presets.find(item => item.id === name) ?? null), failure => setLoadError(failure instanceof Error ? failure.message : 'Presets did not load.'))
  }, [name])
  if (!detail) return <div className="ni-b"><p className="hub-muted">{error ?? 'Loading…'}</p></div>
  const { request, state } = detail
  const actionable = (state === 'proposed' || state === 'expired') && !!request.preset
  return (
    <>
      <div className="ni-b ap-body" data-approval-body>
        {writtenByOther(detail) && <p className="ap-warn" role="note" data-approval-warning>Written by {whoWrote(detail)}, not by you. Read it before approving.</p>}
        <div className="ni-chips">
          {preset && <span className="ni-chip" data-approval-preset>{preset.label}</span>}
          <span className="ni-chip">{request.project}</span>
          <span className={`ni-chip ap-state-chip ${state}`} data-approval-state>{STATE_LABEL[state] ?? state}</span>
          {request.by && <span className="hub-muted">asked by {request.by}, {ago(request.createdAt)}</span>}
        </div>
        <p className="ap-text" data-approval-text>{request.text}</p>
        {request.doneWhen && <p className="hub-muted">Done when: {request.doneWhen}</p>}
        {!actionable && page && <RunView id={id} onGone={next => { window.location.hash = hubHash('request', next) }} />}
        {!actionable && !page && <RequestState detail={detail} />}
        {loadError && <p className="hub-error" role="alert">{loadError}</p>}
      </div>
      {actionable && preset && <div className="ni-b ap-rest"><ApprovalActions detail={detail} preset={preset} onSettled={onSettled} /></div>}
    </>
  )
}

/** `#/~hub/request/<id>`: one request on its own page. This is where a #needs-you ping lands. */
export default function ApprovalView({ id }: { id: string }) {
  const { data: detail, error } = useHubData<RequestDetail>(`/requests/${encodeURIComponent(id)}`)
  const [handoff] = useState(takeHandoff)
  const queue = useQueueOrder()
  const title = detail ? (detail.request.title ?? detail.request.text.slice(0, 80)) : ''
  const settle = (verb: SettledVerb) => {
    const kind: Item['kind'] = detail?.state === 'proposed' ? 'approval' : 'request'
    if (verb === 'done') { window.location.assign(hubHash('needs')); return }
    void goNext({ kind, id, title }, verb, queue(), hubHash('request', id))
  }
  if (!detail) return <p className="hub-empty">{error ?? 'Loading…'}</p>
  return (
    <>
      {handoff && <NextNote note={handoff} />}
      <div className="hub-top">
        <h2>{title}</h2>
        <span><span className="hub-pill">{detail.request.project}</span> <span className="hub-pill">{detail.request.id}</span></span>
      </div>
      <section className="hub-panel ap-page" aria-label="Request">
        <ApprovalBody id={id} onSettled={settle} page />
      </section>
    </>
  )
}
