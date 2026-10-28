import { useRef, useState } from 'react'
import type { Checklist, ChecklistItem } from '../lib/hub'
import { HubError, ago, clock, hubPost, safeUrl } from '../lib/hub'
import { host } from '../lib/host'
import { hubHash } from '../lib/route'
import { setFlash } from './flash'
import Md from './Md'
import { useHubData } from './useHub'

const SIGN_IN = 'Sign in to tick items.'
const text = (value: unknown) => (typeof value === 'string' || typeof value === 'number' ? String(value) : '')
const plural = (count: number, one: string, many: string) => (count === 1 ? one : many)
const without = <T,>(record: Record<string, T>, key: string): Record<string, T> => Object.fromEntries(Object.entries(record).filter(([name]) => name !== key))

/** An item tapped and not yet answered: what the box shows meanwhile, and the time it shows. */
interface Pending { done: boolean; at: string }

/**
 * One checklist, phone first. Ticks are optimistic: the box and the "n of m" change at once, the POST follows, and a
 * failure puts that one item back. Submit sends the list to the agent, asking once when items are still open.
 */
export default function ChecklistView({ id }: { id: string }) {
  const { data, error, reload, at: loadedAt } = useHubData<Checklist>(`/checklists/${encodeURIComponent(id)}`)
  // The newest answer to a tick, kept until a later poll replaces it, so a box does not flip back between the answer and the next read.
  const [answer, setAnswer] = useState<{ detail: Checklist; time: number } | null>(null)
  const [pending, setPending] = useState<Record<string, Pending>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [expanded, setExpanded] = useState<Record<string, boolean> | null>(null)
  const [note, setNote] = useState('')
  const [warnedAt, setWarnedAt] = useState<number | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [signIn, setSignIn] = useState(false)
  const firstGuide = useRef<string | null | undefined>(undefined)

  const detail = answer && (!loadedAt || answer.time > loadedAt.getTime()) ? answer.detail : data
  if (!detail) {
    return (
      <>
        <p className="hub-empty" role={error ? 'alert' : undefined}>{error ?? 'Loading…'}</p>
        {error && <p><a className="hub-btn" href={hubHash('inbox')}>Back to the Inbox</a></p>}
      </>
    )
  }

  const items: ChecklistItem[] = Array.isArray(detail.items) ? detail.items : []
  const isDone = (item: ChecklistItem) => pending[item.id]?.done ?? item.done
  const doneCount = items.filter(isDone).length
  const total = items.length
  const openCount = total - doneCount
  const live = detail.state === 'open'
  // The first item still to do that has a guide starts open; once the owner opens or closes anything, their choice rules.
  if (firstGuide.current === undefined) firstGuide.current = items.find(item => !item.done && item.guide)?.id ?? null
  const isExpanded = (item: ChecklistItem) => (expanded ? !!expanded[item.id] : item.id === firstGuide.current)
  const toggleExpanded = (item: ChecklistItem) => setExpanded(previous => ({ ...(previous ?? (firstGuide.current ? { [firstGuide.current]: true } : {})), [item.id]: !isExpanded(item) }))

  async function tick(item: ChecklistItem) {
    if (!host.write) { setSignIn(true); return }
    if (!live || pending[item.id]) return
    const next = !isDone(item)
    setPending(previous => ({ ...previous, [item.id]: { done: next, at: new Date().toISOString() } }))
    setErrors(previous => without(previous, item.id))
    setProblem(null)
    try {
      const fresh = await hubPost<Checklist>(`/checklists/${encodeURIComponent(detail!.id)}/items/${item.id}`, { done: next })
      setAnswer({ detail: fresh, time: Date.now() })
    } catch (failure) {
      if (failure instanceof HubError && failure.status === 409) reload()
      setErrors(previous => ({ ...previous, [item.id]: failure instanceof Error ? failure.message : 'That did not save.' }))
    } finally {
      setPending(previous => without(previous, item.id))
    }
  }

  async function submit() {
    if (!host.write) { setSignIn(true); return }
    if (!live || submitting) return
    if (openCount > 0 && warnedAt !== openCount) { setWarnedAt(openCount); return }
    setSubmitting(true)
    setProblem(null)
    try {
      await hubPost(`/checklists/${encodeURIComponent(detail!.id)}/submit`, note.trim() ? { note: note.trim() } : {})
      setFlash('Submitted. The agent sees it at its next session.')
      window.location.replace(hubHash('inbox'))
    } catch (failure) {
      if (failure instanceof HubError && failure.status === 409) reload()
      setProblem(failure instanceof Error ? failure.message : 'That did not send.')
      setSubmitting(false)
    }
  }

  const card = safeUrl(detail.card)
  const percent = total ? Math.round((doneCount / total) * 100) : 0
  const warning = live && warnedAt === openCount && openCount > 0
  const submitted = detail.state === 'submitted' || detail.state === 'picked-up'
  let group: string | undefined

  return (
    <div className="hub-cl" data-state={detail.state}>
      <p><a className="hub-btn" href={hubHash('inbox')} data-back-top>‹ Inbox</a></p>
      <div className="hub-top">
        <h2>{text(detail.title)}</h2>
        <span><span className="hub-pill">{text(detail.project)}</span>{text(detail.bead) && <> <span className="hub-pill">{text(detail.bead)}</span></>}</span>
      </div>
      <p className="hub-muted">Posted {ago(detail.createdAt)}{text(detail.from?.host) ? ` from ${text(detail.from?.host)}` : ''}.</p>
      {typeof detail.context === 'string' && detail.context && <Md text={detail.context} />}
      {card && <p><a className="hub-btn" href={card} target="_blank" rel="noopener noreferrer">Open the card</a></p>}

      <section className="hub-panel" aria-label="Steps">
        <p className="hub-cl-count" data-progress aria-live="polite">{doneCount} of {total} done</p>
        <div className="hub-cl-bar" role="progressbar" aria-label="Progress" aria-valuemin={0} aria-valuemax={total} aria-valuenow={doneCount}><span style={{ width: `${percent}%` }} /></div>
        {signIn && !host.write && <p className="hub-muted" data-readonly-note>{SIGN_IN}</p>}
        {detail.state === 'cancelled' && <p className="hub-muted" data-cancelled>The agent withdrew this list.</p>}

        {items.map(item => {
          const heading = item.group && item.group !== group ? item.group : null
          group = item.group
          const done = isDone(item)
          const mark = pending[item.id]
          const link = safeUrl(item.link)
          const more = !!item.guide || !!link
          const open = more && isExpanded(item)
          const labelId = `hub-cl-${item.id}`
          const when = done ? (mark?.at ?? item.at) : undefined
          const body = (
            <>
              <span className="hub-cl-title" id={labelId}>{text(item.text)}</span>
              {done && <span className="hub-cl-meta">done{when ? ` ${clock(when)}` : ''}</span>}
            </>
          )
          return (
            <div key={item.id} className="hub-cl-item" data-item={item.id} data-done={done ? 'true' : undefined}>
              {heading && <h3 className="hub-cl-group">{heading}</h3>}
              <div className="hub-cl-line">
                <button
                  type="button" role="checkbox" aria-checked={done} aria-labelledby={labelId} className="hub-cl-box" data-box
                  disabled={!!mark || (!live && host.write)} aria-disabled={host.write ? undefined : true}
                  onClick={() => void tick(item)}
                ><span aria-hidden="true">{done ? '✓' : ''}</span></button>
                {more ? (
                  <button type="button" className="hub-cl-text" data-toggle aria-expanded={open} aria-controls={`${labelId}-more`} onClick={() => toggleExpanded(item)}>
                    {body}<span className="hub-cl-chev" aria-hidden="true">{open ? '⌄' : '›'}</span>
                  </button>
                ) : (
                  <span className="hub-cl-text plain" onClick={() => void tick(item)}>{body}</span>
                )}
              </div>
              {errors[item.id] && <p className="hub-error" role="alert" data-item-error>{errors[item.id]}</p>}
              {open && (
                <div className="hub-cl-more" id={`${labelId}-more`}>
                  {item.guide && <Md text={item.guide} copy />}
                  {link && <p><a className="hub-btn" href={link} target="_blank" rel="noopener noreferrer">Open details</a></p>}
                </div>
              )}
            </div>
          )
        })}
      </section>

      {live && (
        <section className="hub-panel hub-cl-submit" aria-label="Submit">
          <label className="hub-field">Note to the agent (optional)
            <textarea value={note} onChange={event => setNote(event.target.value)} rows={3} maxLength={2000} disabled={submitting} />
          </label>
          {warning && <p className="hub-cl-warn" role="alert" data-warning>{openCount} {plural(openCount, 'item is', 'items are')} still open. Submit anyway?</p>}
          {problem && <p className="hub-error" role="alert">{problem}</p>}
          <div className="hub-actions">
            <button
              type="button" className="hub-btn pri hub-cl-send" data-submit disabled={submitting || Object.keys(pending).length > 0}
              aria-disabled={host.write ? undefined : true} onClick={() => void submit()}
            >{warning ? `Submit with ${openCount} open` : 'Submit'}</button>
          </div>
          {signIn && !host.write && <p className="hub-muted" data-readonly-note>{SIGN_IN}</p>}
        </section>
      )}

      {submitted && detail.submit && (
        <section className="hub-panel" aria-label="Submitted" data-submitted>
          <p><b>Submitted {ago(detail.submit.at)}</b>{text(detail.submit.by) ? ` by ${text(detail.submit.by)}` : ''}.</p>
          {typeof detail.submit.note === 'string' && detail.submit.note && <p className="hub-note-text">{detail.submit.note}</p>}
          {detail.state === 'picked-up' && detail.pickup && <p className="hub-muted">Picked up {ago(detail.pickup.at)}{text(detail.pickup.host) ? ` on ${text(detail.pickup.host)}` : ''}.</p>}
        </section>
      )}
      <p><a className="hub-btn" href={hubHash('inbox')}>Back to the Inbox</a></p>
    </div>
  )
}
