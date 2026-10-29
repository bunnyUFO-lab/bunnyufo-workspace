import { useState } from 'react'
import type { Item } from '../lib/hub'
import { fileUrl, hubPost } from '../lib/hub'
import { host } from '../lib/host'
import type { SettleExtra, SettleVerb } from './NeedsItem'
import { authHeaders } from '../local/client'
import Md from './Md'

/**
 * A Hermes run that ended by asking the owner something. The question, what the run wrote before it (collapsed, read
 * from its report.md when opened), an answer box, "Answer and run again" (starts a follow-up run that carries the question
 * and the answer) and "Close" (stops the request).
 */
export default function RunQuestionView({ item, onSettled }: { item: Item; onSettled: (verb: SettleVerb, extra?: SettleExtra) => void }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState<'answer' | 'close' | null>(null)
  const [error, setError] = useState('')
  const [report, setReport] = useState<string | null>(null)
  const id = encodeURIComponent(item.id)

  async function loadReport(open: boolean) {
    if (!open || report !== null) return
    try {
      const response = await fetch(fileUrl(`requests/${item.id}/report.md`), { headers: authHeaders() })
      setReport(response.ok ? await response.text() : '')
    } catch {
      setReport('')
    }
  }

  async function send(kind: 'answer' | 'close') {
    if (!host.write) { setError('Sign in to answer.'); return }
    setBusy(kind)
    setError('')
    try {
      if (kind === 'close') {
        await hubPost(`/requests/${id}/stop`, { reason: 'Closed without an answer' })
        onSettled('cancelled')
        return
      }
      // The answer started a follow-up run (or, when it could not start yet, left a proposal): say which, and link to it.
      const made = await hubPost<{ id: string; state?: string; waiting?: string }>(`/requests/${id}/answer-run`, { text: text.trim() })
      const proposed = made.state === 'proposed'
      const detail = proposed ? `the follow-up waits for your approval${made.waiting ? ` (${made.waiting})` : ''}` : `the follow-up run started${made.waiting ? ` (${made.waiting})` : ''}`
      onSettled('answered', { detail, link: { label: proposed ? 'Open the follow-up' : 'Watch the follow-up', hash: `#/~hub/request/${encodeURIComponent(made.id)}` } })
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not send that.')
      setBusy(null)
    }
  }

  return (
    <>
      <div className="ni-b" data-run-question>
        <p className="ni-ask" data-run-question-text>{item.question}</p>
        <details onToggle={event => loadReport((event.currentTarget as HTMLDetailsElement).open)}>
          <summary>What the run wrote before it asked</summary>
          {report === null ? <p className="hub-muted">Loading…</p> : report ? <Md text={report} /> : <p className="hub-muted">No report was kept.</p>}
        </details>
        <label className="ni-field" style={{ display: 'block', marginTop: 12 }}>
          <span className="hub-muted" style={{ display: 'block', marginBottom: 4 }}>Your answer</span>
          <textarea style={{ display: 'block', width: '100%', boxSizing: 'border-box', font: 'inherit', padding: 8 }} value={text} maxLength={2000} rows={3} onChange={event => setText(event.target.value)} data-run-answer />
        </label>
      </div>
      <div className="ni-a">
        <button type="button" className="hub-btn pri" disabled={busy !== null || !text.trim()} onClick={() => send('answer')} data-run-send>Answer and run again</button>
        <button type="button" className="hub-btn" disabled={busy !== null} onClick={() => send('close')} data-run-close>Close</button>
        {error && <span className="hub-error" role="alert">{error}</span>}
      </div>
    </>
  )
}
