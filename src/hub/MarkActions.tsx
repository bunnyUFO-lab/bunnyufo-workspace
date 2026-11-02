import { useState } from 'react'
import type { MapTask } from '../lib/hub'
import { hubPost } from '../lib/hub'
import { host } from '../lib/host'
import { shortDate } from './mapSheet'

const REASON_MAX = 200

const PENDING_WORD = { done: 'done', 'not-needed': 'not needed', unblock: 'unblocked' }

/**
 * The owner's actions on a task that waits on them (the caller decides that, an Ask or a checklist or not):
 * Mark done, No longer needed (with an optional reason), Unblock and, once marked, Undo. The write is a
 * create-only log the Hub shows at once; a session in the project applies it in Beads when it starts there.
 * hubPost refreshes every Hub read after a write, so the map comes back marked and the sheet stays open.
 * `compact` is the buttons alone, for a row on Today.
 */
export default function MarkActions({ task, project, projectName, eligible, error, onError, compact = false }: { task: Pick<MapTask, 'id' | 'mark'>; project: string; projectName: string; eligible: boolean; error: string; onError: (message: string) => void; compact?: boolean }) {
  const [asking, setAsking] = useState(false)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)

  async function send(verdict: 'done' | 'not-needed' | 'unblock' | 'undo') {
    setBusy(true)
    onError('')
    try {
      await hubPost(`/map/${encodeURIComponent(project)}/marks`, { bead: task.id, verdict, ...(verdict === 'not-needed' && reason.trim() ? { reason: reason.trim() } : {}) })
      setAsking(false)
      setReason('')
    } catch (failure) {
      onError(failure instanceof Error ? failure.message : 'Could not save that.')
    } finally {
      setBusy(false)
    }
  }

  const failed = error && <p className="hub-error" role="alert">{error}</p>
  // A refusal can change what the sheet knows (an Ask appeared): the message stays, the buttons go.
  if (!task.mark && !eligible) return failed || null
  if (compact && (task.mark || !host.write)) return failed || null

  if (task.mark) {
    const date = shortDate(task.mark.at)
    return (
      <div className="hub-map-panel-mark" data-mark-pending data-mark-verdict={task.mark.verdict}>
        <p className="hub-muted">You marked this {PENDING_WORD[task.mark.verdict]}{date ? ` on ${date}` : ''}. A session in {projectName} applies it when it starts there.</p>
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
        <button type="button" className="hub-btn pri" disabled={busy} onClick={() => void send('done')} data-mark-done>Mark done</button>
        <button type="button" className="hub-btn" disabled={busy} aria-expanded={asking} onClick={() => setAsking(value => !value)} data-mark-not-needed>No longer needed</button>
        <button type="button" className="hub-btn" disabled={busy} onClick={() => void send('unblock')} data-mark-unblock>Unblock</button>
      </div>
      {asking && (
        <form className="hub-map-panel-reason" onSubmit={event => { event.preventDefault(); void send('not-needed') }}>
          <input type="text" value={reason} maxLength={REASON_MAX} placeholder="Why (optional)" aria-label="Why it is no longer needed (optional)" onChange={event => setReason(event.target.value)} />
          <button type="submit" className="hub-btn pri" disabled={busy} data-mark-confirm>Close it</button>
          <button type="button" className="hub-btn" disabled={busy} onClick={() => { setAsking(false); onError('') }}>Cancel</button>
        </form>
      )}
      {failed}
      {!compact && <p className="hub-muted">Unblock: it doesn&apos;t wait on you; agents may pick it up.</p>}
    </div>
  )
}
