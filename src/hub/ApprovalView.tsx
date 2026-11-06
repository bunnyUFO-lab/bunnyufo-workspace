import { useEffect, useId, useState } from 'react'
import { host } from '../lib/host'
import { ago, hubGet, hubPost } from '../lib/hub'
import type { SpawnPreset, SpawnRoute, SpawnTarget } from '../lib/hubSpawn'
import { MACHINE } from '../lib/hubSpawn'
import type { SettledVerb } from '../lib/nextItem.mjs'
import { hubHash } from '../lib/route'
import { takeHandoff } from './flash'
import NextNote from './NextNote'
import Combobox from './Combobox'
import { RunView } from './RunView'
import { cachedPresets, loadPresets } from './spawnData'
import { openSpawn } from './spawnStore'
import { autoNext, goNext, useQueueOrder } from './useGoNext'
import { hold } from './heldSend'
import SettledBar, { useSettledHere } from './SettledBar'
import { useHubData } from './useHub'
import './runs.css'
import { PageProjectChip } from './ProjectChip'

/** The parts of `GET /hub/requests/:id` this view reads. */
export interface RequestDetail {
  request: {
    id: string; project: string; text: string; title?: string; preset?: string; repo?: string; target?: string
    doneWhen?: string; agent?: string; bead?: string; model?: string; by?: string; replaces?: string; continues?: { from: string; replies: string[] }; createdAt: string; origin?: { kind: 'owner' | 'agent' | 'run'; name?: string }
  }
  state: string
  /** The repo Approve signs a request that has none of its own with: its project's tracked repo. Absent when there is none. */
  projectRepo?: string
  /** When a taken run last gave word, if that is past its limit: the request is then silent, not running. */
  stale?: string
  approved?: { target: SpawnTarget; by: string; at: string; expires: string; limits?: { minutes: number } }
  result?: { outcome: string; summary?: string; reason?: string }
  declined?: { at: string; by: string; reason?: string }
  stop?: { reason?: string }
}

const STATE_LABEL: Record<string, string> = {
  proposed: 'Waiting for you', expired: 'Expired', approved: 'Approved', taken: 'Taken', running: 'Running', stopping: 'Stopping', stopped: 'Stopped',
  asking: 'Asking you', failed: 'Failed', lost: 'Lost', done: 'Done', declined: 'Declined', open: 'Open',
}

const STARTS: Record<SpawnTarget, string> = { hermes: 'On Hermes right away', pc: 'On the PC within a few minutes', cloud: 'In the cloud', 'at-pc': 'When you start it at the PC' }

/** The menu label of a model id, as Spawn shows it (the presets are loaded by the time a request with a preset is shown). */
const modelLabel = (id: string) => { const label = cachedPresets()?.models?.find(entry => entry.id === id)?.label ?? id; return `${label} · API` }

const sideEffect = (preset: SpawnPreset, repo?: string): string => {
  switch (preset.sideEffect) {
    case 'pr': return `A new branch and a PR in ${repo || 'the repo'}. No merge, no deploy.`
    case 'card': return "One card in the project's section, or in assistant."
    case 'asks': return "One Ask per question in Needs you, and sometimes a card in the project's section, or in assistant. It closes nothing."
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
  const [pickedRepo, setPickedRepo] = useState('')
  const [known, setKnown] = useState<{ repo: string; project?: string }[]>([])
  const repoId = useId()

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
  // A cloud run with no repo of its own and none on its project asks for one here, so Approve never ends in an error with nothing to do.
  const needsRepo = target === 'cloud' && !request.repo && !detail.projectRepo
  const canSign = host.approve && !atPc && !(needsRepo && !pickedRepo)
  useEffect(() => {
    if (!needsRepo) return
    const controller = new AbortController()
    hubGet<{ repos: { repo: string; project?: string }[] }>('/presets/repos', controller.signal).then(answer => setKnown(answer?.repos ?? []), () => { /* no list: the PC is still the way out */ })
    return () => controller.abort()
  }, [needsRepo])

  const run = async (work: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try { await work() } catch (failure) { setError(failure instanceof Error ? failure.message : 'It did not work.') } finally { setBusy(false) }
  }
  // Approve and Decline wait seven seconds with Undo, then make the one write they always made: the signing path is the same POST.
  const key = `${state === 'proposed' ? 'approval' : 'request'}-${id}`
  const heldTitle = (request.title ?? request.text).slice(0, 90)
  const approve = () => {
    setError(null)
    const path = `/requests/${encodeURIComponent(id)}/${expired ? 'again' : 'approve'}`
    const body = { target, ...(needsRepo && pickedRepo ? { repo: pickedRepo } : {}) }
    if (hold({ key, title: heldTitle, verb: 'Approved', send: keepalive => hubPost(path, body, undefined, false, keepalive) })) onSettled('approved')
  }
  const decline = () => {
    setError(null)
    const body = reason.trim() ? { reason: reason.trim() } : {}
    if (hold({ key, title: heldTitle, verb: 'Declined', send: keepalive => hubPost(`/requests/${encodeURIComponent(id)}/decline`, body, undefined, false, keepalive) })) onSettled('declined')
  }
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
  const edit = () => openSpawn({ edit: { id, project: request.project, preset: preset.id, text: request.text, target, ...(request.repo ? { repo: request.repo } : {}), ...(request.doneWhen ? { doneWhen: request.doneWhen } : {}), ...(request.agent ? { agent: request.agent } : {}), ...(request.model ? { model: request.model } : {}) } })

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
          {needsRepo && host.write && (
            <div className="ap-repo" data-approval-repo-box>
              <label htmlFor={repoId}>Repo for the cloud run</label>
              <Combobox id={repoId} value={pickedRepo} options={[{ value: '', label: 'Pick a repo' }, ...known.map(item => ({ value: item.repo, label: item.repo, keywords: item.project ? [item.project] : [] }))]} onChange={setPickedRepo} openLabel="Show repositories" inputAttrs={{ 'data-approval-repo': '' }} />
              <span className="sp-faint">Or run it on the PC.</span>
            </div>
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
        {host.write && !atPc && <button type="button" className="hub-btn pri" disabled={busy || !canSign} onClick={approve} data-approval-approve>{expired ? 'Approve again' : 'Approve'}</button>}
        {host.write && <button type="button" className="hub-btn" disabled={busy} onClick={edit} data-approval-edit>Edit</button>}
        {host.write && !declining && <button type="button" className="hub-btn danger" disabled={busy} onClick={() => setDeclining(true)} data-approval-decline>Decline</button>}
        {host.write && declining && (
          <>
            <button type="button" className="hub-btn danger" disabled={busy} onClick={decline} data-approval-decline-send>Send decline</button>
            <button type="button" className="hub-btn" disabled={busy} onClick={() => setDeclining(false)}>Keep</button>
          </>
        )}
        {host.write && atPc && <><span className="sp" /><button type="button" className="hub-btn" disabled={busy} onClick={() => void markDone()} data-approval-done>Mark done</button></>}
      </div>
      {host.write && !atPc && !host.approve && <p className="hub-muted" data-approval-reason-off>{host.approveReason ?? 'Approving needs a signed-in session on a host that can sign.'}</p>}
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
      {stop?.reason && <p>{/^moved to the cloud: /.test(stop.reason) ? 'Moved to the cloud.' : `Stopped: ${stop.reason}`}</p>}
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
        {actionable && writtenByOther(detail) && <p className="ap-warn" role="note" data-approval-warning>Written by {whoWrote(detail)}, not by you. Read it before approving.</p>}
        <div className="ni-chips">
          {preset && <span className="ni-chip" data-approval-preset>{preset.label}</span>}
          <span className={`ni-chip ap-state-chip ${state}`} data-approval-state>{STATE_LABEL[state] ?? state}</span>
          {request.by && <span className="hub-muted">asked by {request.by}, {ago(request.createdAt)}</span>}
        </div>
        <p className="ap-text" data-approval-text>{request.text}</p>
        {request.doneWhen && <p className="hub-muted">Done when: {request.doneWhen}</p>}
        {request.model && <p className="hub-muted" data-approval-model>Model: {modelLabel(request.model)}</p>}
        {!actionable && page && <RunView id={id} page onGone={next => { window.location.hash = hubHash('request', next) }} />}
        {!actionable && !page && <RequestState detail={detail} />}
        {loadError && <p className="hub-error" role="alert">{loadError}</p>}
      </div>
      {/* A sprint item is signed by its sprint (the Hub does it), never by a tap here. */}
      {actionable && preset && request.preset !== 'sprint-item' && <div className="ni-b ap-rest"><ApprovalActions detail={detail} preset={preset} onSettled={onSettled} /></div>}
    </>
  )
}

/** `#/~hub/request/<id>`: one request on its own page. This is where a #needs-you ping lands. */
export default function ApprovalView({ id }: { id: string }) {
  const { data: detail, error } = useHubData<RequestDetail>(`/requests/${encodeURIComponent(id)}`)
  const [handoff] = useState(takeHandoff)
  const queue = useQueueOrder()
  const title = detail ? (detail.request.title ?? detail.request.text.slice(0, 80)) : ''
  const kind: 'approval' | 'request' = detail?.state === 'proposed' ? 'approval' : 'request'
  const here = useSettledHere(`${kind}-${id}`)
  const settle = (verb: SettledVerb) => {
    if (verb === 'done') { window.location.assign(hubHash('needs')); return }
    // The answer is held (or sent) and the page stays on the request, unless the owner asked for the next item after every answer.
    here.settle(verb, queue())
    if (autoNext()) void goNext({ kind, id, title }, verb, queue(), hubHash('request', id))
  }
  if (!detail) return <p className="hub-empty">{error ?? 'Loading…'}</p>
  return (
    <>
      {handoff && <NextNote note={handoff} />}
      <div className="hub-top">
        <h2>{title}</h2>
        <span><PageProjectChip id={detail.request.project} /> <span className="hub-pill" data-request-id>{detail.request.id}</span></span>
      </div>
      <SettledBar itemKey={`${kind}-${id}`} kind={kind} id={id} title={title} verb={here.verb} phase={here.phase} backHash={hubHash('request', id)} order={here.order} />
      {/* Kept mounted while held, so Undo finds the page as it was left. */}
      <section className="hub-panel ap-page" aria-label="Request" hidden={here.covered}>
        <ApprovalBody id={id} onSettled={settle} page />
      </section>
    </>
  )
}
