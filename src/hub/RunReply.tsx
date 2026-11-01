import { useState } from 'react'
import type { KeyboardEvent } from 'react'
import { host } from '../lib/host'
import { HubError, hubPost } from '../lib/hub'
import { hubHash } from '../lib/route'

/** The longest reply the Hub takes (`REQUEST_LIMITS.reply`). */
const REPLY_MAX = 2000

/** The states with no reply box at all: Approve, Approve again and Decline already cover them. */
const NO_BOX = new Set(['proposed', 'declined', 'expired', 'lost', 'open', ''])
/** The states where an ended Hermes job takes a reply. */
const CAN_REPLY = new Set(['done', 'failed', 'asking', 'stopped', 'running'])

interface ReplyGate {
  /** Why the box is off, in words; null when it takes a reply. */
  reason: string | null
  /** The request the reply moved on to, when this one was already continued. */
  continuedTo?: string
}

/** Whether the reply box shows for this request and, if it is shown but off, why. Null: no box. */
function replyGate({ state, target, approved, hasRun, continuedTo, canWrite }: {
  state: string; target?: string; approved: boolean; hasRun: boolean; continuedTo?: string; canWrite: boolean
}): ReplyGate | null {
  if (NO_BOX.has(state) || !approved) return null
  if (target !== 'hermes') return { reason: 'Replies go to Hermes jobs. A PC or cloud run can’t take a message yet.' }
  if (continuedTo) return { reason: 'Continued as', continuedTo }
  // Stopped or failed before Hermes ever ran: nothing to continue (Approve again covers it).
  if ((state === 'stopped' || state === 'failed') && !hasRun) return null
  if (!canWrite) return { reason: 'Sign in to reply.' }
  if (state === 'approved' || (state === 'taken' && !hasRun)) return { reason: 'You can reply once Hermes has started.' }
  if (state === 'stopping') return { reason: 'Stopping. Reply after it has stopped.' }
  if (!CAN_REPLY.has(state)) return { reason: 'You can reply once the run has ended.' }
  if (state === 'running' && !hasRun) return { reason: 'You can reply once Hermes has started.' }
  return { reason: null }
}

/**
 * The reply box of a Hermes job on the request page and in the drawer: the Chat composer's markup and classes. After the run
 * has ended a reply starts a continuation (a new request); `onGone` opens it. The box is shown off, with its reason, wherever a
 * person would look for it.
 */
export default function RunReply({ id, state, target, approved, hasRun, continuedTo, onGone, onSent }: {
  id: string; state: string; target?: string; approved: boolean; hasRun: boolean; continuedTo?: string; onGone?: (id: string) => void; onSent?: () => void
}) {
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const gate = replyGate({ state, target, approved, hasRun, continuedTo, canWrite: host.write })
  if (!gate) return null
  const off = gate.reason !== null
  const text = draft.trim()
  const canSend = !off && !busy && text.length > 0

  const send = async () => {
    if (!canSend) return
    setBusy(true)
    setProblem(null)
    try {
      setNote(null)
      const made = await hubPost<{ id: string; delivery?: 'sent' | 'queued'; reason?: string }>(`/requests/${encodeURIComponent(id)}/reply`, { text })
      setDraft('')
      // While the run goes the answer says how it was delivered (the line appears from the stream); after the end it is a new request.
      if (made.delivery) {
        if (made.delivery === 'queued') setNote(`${made.reason ?? 'Hermes could not take it now.'} It goes out as the next run when this one ends.`)
        onSent?.()
      } else onGone?.(made.id)
    } catch (failure) {
      setProblem(failure instanceof HubError || failure instanceof Error ? failure.message : 'It did not work.')
    } finally { setBusy(false) }
  }
  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
    event.preventDefault()
    void send()
  }

  return (
    <div className="rd-reply" data-run-reply data-reply-off={off ? '' : undefined}>
      <div className="hub-compose">
        <textarea
          value={draft} rows={2} maxLength={REPLY_MAX} placeholder="Reply to Hermes" aria-label="Reply to Hermes" disabled={off || busy}
          aria-describedby={off ? `reply-why-${id}` : undefined}
          onChange={event => setDraft(event.target.value)} onKeyDown={onKey} data-reply-input
        />
        <button type="button" className="hub-btn pri" disabled={!canSend} onClick={() => void send()} data-reply-send>Send</button>
      </div>
      {off && (
        <p className="hub-muted rd-reply-why" id={`reply-why-${id}`} data-reply-reason>
          {gate.continuedTo
            ? <>Continued as <a href={hubHash('request', gate.continuedTo)} data-reply-continued>{gate.continuedTo}</a>. Reply there.</>
            : gate.reason}
        </p>
      )}
      {note && <p className="hub-muted rd-reply-why" role="status" data-reply-note>{note}</p>}
      {problem && <p className="hub-error" role="alert" data-reply-error>{problem}</p>}
    </div>
  )
}
