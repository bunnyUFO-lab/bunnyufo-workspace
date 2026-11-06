import { useState } from 'react'
import type { MapTask } from '../lib/hub'
import { hubPost } from '../lib/hub'
import { host } from '../lib/host'
import { shortDate } from './mapSheet'

const REASON_MAX = 200

const CONFIRMED_KEY = 'buw.markConfirmed'

/** Whether this device has confirmed a closing mark before. Without usable storage the answer is no, so it always asks. */
function wasConfirmed(): boolean {
  try { return localStorage.getItem(CONFIRMED_KEY) === '1' } catch { return false }
}
function rememberConfirmed() {
  try { localStorage.setItem(CONFIRMED_KEY, '1') } catch { /* no storage: ask every time */ }
}

const PENDING_WORD = { done: 'done', 'not-needed': 'not needed', unblock: 'unblocked' }

/**
 * The owner's actions on an open task: Mark done, No longer needed (with an optional reason) and, once marked, Undo. Unblock is
 * only for a task that waits on them (`waiting`, the caller decides that, an Ask or a checklist or not). The write is a
 * create-only log the Hub shows at once; the PC applies it in Beads within minutes (a session in the project can too).
 * hubPost refreshes every Hub read after a write, so the map comes back marked and the sheet stays open.
 * `compact` is the buttons alone, for a row on Today.
 */
export default function MarkActions({ task, title, project, projectName, eligible, waiting = true, error, onError, compact = false }: { task: Pick<MapTask, 'id' | 'mark' | 'run'>; title?: string; project: string; projectName: string; eligible: boolean; waiting?: boolean; error: string; onError: (message: string) => void; compact?: boolean }) {
  const [asking, setAsking] = useState(false)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  // A closing mark (done, not needed) waits here for the first-time confirmation on this device.
  const [confirming, setConfirming] = useState<'done' | 'not-needed' | null>(null)

  function close(verdict: 'done' | 'not-needed') {
    if (wasConfirmed()) void send(verdict)
    else setConfirming(verdict)
  }

  async function send(verdict: 'done' | 'not-needed' | 'unblock' | 'undo') {
    setBusy(true)
    onError('')
    try {
      if (verdict === 'done' || verdict === 'not-needed') rememberConfirmed()
      await hubPost(`/map/${encodeURIComponent(project)}/marks`, { bead: task.id, verdict, ...(verdict === 'not-needed' && reason.trim() ? { reason: reason.trim() } : {}) })
      setAsking(false)
      setReason('')
      setConfirming(null)
    } catch (failure) {
      onError(failure instanceof Error ? failure.message : 'Could not save that.')
    } finally {
      setBusy(false)
    }
  }

  const failed = error && <p className="hub-error" role="alert">{error}</p>
  // A refusal can change what the sheet knows (an Ask appeared): the message stays, the buttons go.
  if (!task.mark && !eligible) return failed || null
  if (compact && !task.mark && !host.write) return failed || null

  if (task.mark && compact) {
    // Today's row: the item stays, muted, until the PC applies the mark; Undo is a button in the row.
    return (
      <div className="hub-map-panel-mark compact marked" data-mark-pending data-mark-verdict={task.mark.verdict}>
        <span className="hub-muted">Marked {PENDING_WORD[task.mark.verdict]}</span>
        {host.write && <button type="button" className="hub-btn" disabled={busy} onClick={() => void send('undo')} data-mark-undo>Undo</button>}
        {failed}
      </div>
    )
  }
  if (task.mark) {
    const date = shortDate(task.mark.at)
    return (
      <div className="hub-map-panel-mark" data-mark-pending data-mark-verdict={task.mark.verdict}>
        {task.mark.verdict === 'done' && task.mark.reason
          ? <p className="hub-muted" data-decided>Decided: {task.mark.reason} · the PC applies it within minutes{date ? ` (${date})` : ''}.</p>
          : <p className="hub-muted">You marked this {PENDING_WORD[task.mark.verdict]}{date ? ` on ${date}` : ''}. The PC applies it in {projectName} within minutes.{task.run && <> <span data-mark-run-note>The run keeps going. Open it to stop it.</span></>}</p>}
        {failed}
        {host.write
          ? <div className="hub-actions start"><button type="button" className="hub-btn" disabled={busy} onClick={() => void send('undo')} data-mark-undo>Undo</button></div>
          : <p className="hub-muted" data-readonly-note>Sign in to undo this.</p>}
      </div>
    )
  }
  if (!host.write) return <p className="hub-muted" data-readonly-note>Sign in to mark this.</p>
  return (
    <div className={`hub-map-panel-mark${compact ? ' compact' : ''}`} data-mark-actions>
      <div className="hub-actions start">
        {/* The main action is for an item that waits on the owner. On a job in progress it is a quiet one: it is not what the owner came to do. */}
        <button type="button" className={waiting ? 'hub-btn pri' : 'hub-btn'} disabled={busy} onClick={() => close('done')} data-mark-done>Mark done</button>
        <button type="button" className="hub-btn" disabled={busy} aria-expanded={asking} onClick={() => setAsking(value => !value)} data-mark-not-needed>No longer needed</button>
        {waiting && <button type="button" className="hub-btn" disabled={busy} onClick={() => void send('unblock')} data-mark-unblock>Unblock</button>}
      </div>
      {asking && (
        <form className="hub-map-panel-reason" onSubmit={event => { event.preventDefault(); close('not-needed') }}>
          <input type="text" value={reason} maxLength={REASON_MAX} placeholder="Why (optional)" aria-label="Why it is no longer needed (optional)" onChange={event => setReason(event.target.value)} />
          <button type="submit" className="hub-btn pri" disabled={busy} data-mark-confirm>Close it</button>
          <button type="button" className="hub-btn" disabled={busy} onClick={() => { setAsking(false); onError('') }}>Cancel</button>
        </form>
      )}
      {confirming && (
        <div className="hub-map-panel-confirm" role="alertdialog" aria-label="Confirm" data-mark-confirm-first>
          <p>This closes {title ? <strong>{title}</strong> : 'this item'} in Beads. Undo stays here until the PC applies it, within minutes.{task.run && ' A run is on it and keeps going.'}</p>
          <div className="hub-actions start">
            <button type="button" className="hub-btn pri" disabled={busy} onClick={() => void send(confirming)} data-mark-confirm-yes>Confirm</button>
            <button type="button" className="hub-btn" disabled={busy} onClick={() => setConfirming(null)} data-mark-confirm-cancel>Cancel</button>
          </div>
        </div>
      )}
      {failed}
      {!compact && waiting && <p className="hub-muted">Unblock: it doesn&apos;t wait on you; agents may pick it up.</p>}
    </div>
  )
}
