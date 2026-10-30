import { useState } from 'react'
import type { MapTask } from '../lib/hub'
import { hubPost } from '../lib/hub'
import { host } from '../lib/host'
import { shortDate } from './mapSheet'

const REASON_MAX = 200

/**
 * The owner's actions on a yellow task that has no Ask and nothing in Needs you (the caller decides that):
 * Mark done, No longer needed (with an optional reason) and, once marked, Undo. The write is a create-only
 * log the Hub shows at once; an agent closes the issue in Beads the next time it works in the project.
 * hubPost refreshes every Hub read after a write, so the map comes back marked and the sheet stays open.
 */
export default function MarkActions({ task, project, projectName, eligible, error, onError }: { task: MapTask; project: string; projectName: string; eligible: boolean; error: string; onError: (message: string) => void }) {
  const [asking, setAsking] = useState(false)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)

  async function send(verdict: 'done' | 'not-needed' | 'undo') {
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

  if (task.mark) {
    const date = shortDate(task.mark.at)
    return (
      <div className="hub-map-panel-mark" data-mark-pending>
        <p className="hub-muted">You marked this {task.mark.verdict === 'not-needed' ? 'not needed' : 'done'}{date ? ` on ${date}` : ''}. Beads closes it the next time an agent works in {projectName}.</p>
        {failed}
        <div className="hub-actions start"><button type="button" className="hub-btn" disabled={busy} onClick={() => void send('undo')} data-mark-undo>Undo</button></div>
      </div>
    )
  }
  if (!host.write) return <p className="hub-muted" data-readonly-note>Sign in to mark this.</p>
  return (
    <div className="hub-map-panel-mark" data-mark-actions>
      <div className="hub-actions start">
        <button type="button" className="hub-btn pri" disabled={busy} onClick={() => void send('done')} data-mark-done>Mark done</button>
        <button type="button" className="hub-btn" disabled={busy} aria-expanded={asking} onClick={() => setAsking(value => !value)} data-mark-not-needed>No longer needed</button>
      </div>
      {asking && (
        <form className="hub-map-panel-reason" onSubmit={event => { event.preventDefault(); void send('not-needed') }}>
          <input type="text" value={reason} maxLength={REASON_MAX} placeholder="Why (optional)" aria-label="Why it is no longer needed (optional)" onChange={event => setReason(event.target.value)} />
          <button type="submit" className="hub-btn pri" disabled={busy} data-mark-confirm>Close it</button>
          <button type="button" className="hub-btn" disabled={busy} onClick={() => { setAsking(false); onError('') }}>Cancel</button>
        </form>
      )}
      {failed}
      <p className="hub-muted">Closes it in Beads the next time an agent works in {projectName}.</p>
    </div>
  )
}
