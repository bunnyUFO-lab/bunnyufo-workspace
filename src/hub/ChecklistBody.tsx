import { useEffect, useRef, useState } from 'react'
import type { DragEvent } from 'react'
import type { Checklist, ChecklistItem } from '../lib/hub'
import { HubError, clock, hubPost, safeUrl } from '../lib/hub'
import { host } from '../lib/host'
import HubImage from './HubImage'
import Md from './Md'
import { prepareImage, toBase64 } from './chatImages'
import { hasFiles, hasText, isTextField, pictureFiles } from '../lib/pastePictures.mjs'
import { clearTarget, getTarget, setTarget, useTarget } from './stepTarget'
import PlaytestReport from './PlaytestReport'
import { usePlaytestReport } from './playtest'
import { StepHelp } from './GetHelp'
import { useAttachHelp } from './useAttachHelp'

const SIGN_IN = 'Sign in to tick items.'
const finePointer = () => typeof matchMedia === 'function' && matchMedia('(hover: hover) and (pointer: fine)').matches
type How = 'camera' | 'paste' | 'drop'
const VERB: Record<How, string> = { camera: 'Attached to', paste: 'Pasted to', drop: 'Dropped on' }
const text = (value: unknown) => (typeof value === 'string' || typeof value === 'number' ? String(value) : '')
const plural = (count: number, one: string, many: string) => (count === 1 ? one : many)
const without = <T,>(record: Record<string, T>, key: string): Record<string, T> => Object.fromEntries(Object.entries(record).filter(([name]) => name !== key))

/** An item tapped and not yet answered: what the box shows meanwhile, and the time it shows. */
interface Pending { done: boolean; at: string }

/**
 * A checklist's steps and its Submit, phone first. Ticks are optimistic: the box and the "n of m" change at once, the
 * POST follows, and a failure puts that one item back. Submit sends the list to the agent, asking once when items are
 * still open. The Needs you card and the checklist's own view both render it; `onSubmitted` runs after Submit worked.
 */
export default function ChecklistBody({ data, loadedAt, reload, onSubmitted }: { data: Checklist; loadedAt: Date | null; reload: () => void; onSubmitted: () => void }) {
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
  // Pictures stored in this view: shown at once, and kept over a read that does not have them yet.
  const [uploaded, setUploaded] = useState<Record<string, string>>({})
  const [uploading, setUploading] = useState<Record<string, boolean>>({})
  // A line under the progress bar (a hint), and the line under the step that last took a picture.
  const [hint, setHint] = useState<string | null>(null)
  const [attached, setAttached] = useState<{ step: string; text: string } | null>(null)
  const [dropping, setDropping] = useState<string | null>(null)
  const target = useTarget()
  const stepsRef = useRef<HTMLElement | null>(null)
  const submitRef = useRef<HTMLElement | null>(null)
  const report = usePlaytestReport(data.id, data.state === 'open', reload)
  const attachHelp = useAttachHelp('checklist', data.id, data.state === 'open')
  const firstGuide = useRef<string | null | undefined>(undefined)

  const detail = answer && (!loadedAt || answer.time > loadedAt.getTime()) ? answer.detail : data
  const items: ChecklistItem[] = Array.isArray(detail.items) ? detail.items : []
  const isDone = (item: ChecklistItem) => pending[item.id]?.done ?? item.done
  const doneCount = items.filter(isDone).length
  const total = items.length
  const openCount = total - doneCount
  const live = detail.state === 'open'
  const playtest = detail.kind === 'playtest'
  const build = typeof detail.build === 'string' && /^https:\/\//i.test(detail.build) ? detail.build : undefined
  // The first item still to do that has a guide starts open; once the owner opens or closes anything, their choice rules.
  if (firstGuide.current === undefined) firstGuide.current = items.find(item => !item.done && item.guide)?.id ?? null
  const isExpanded = (item: ChecklistItem) => (expanded ? !!expanded[item.id] : item.id === firstGuide.current)
  const toggleExpanded = (item: ChecklistItem) => { setTarget({ checklist: detail.id, step: item.id }); setHint(null); setAttached(null); setExpanded(previous => ({ ...(previous ?? (firstGuide.current ? { [firstGuide.current]: true } : {})), [item.id]: !isExpanded(item) })) }

  async function tick(item: ChecklistItem) {
    setTarget({ checklist: detail.id, step: item.id })
    setHint(null)
    setAttached(null)
    if (!host.write) { setSignIn(true); return }
    if (!live || pending[item.id]) return
    const next = !isDone(item)
    setPending(previous => ({ ...previous, [item.id]: { done: next, at: new Date().toISOString() } }))
    setErrors(previous => without(previous, item.id))
    setProblem(null)
    try {
      const fresh = await hubPost<Checklist>(`/checklists/${encodeURIComponent(detail.id)}/items/${encodeURIComponent(item.id)}`, { done: next })
      setAnswer({ detail: fresh, time: Date.now() })
    } catch (failure) {
      if (failure instanceof HubError && failure.status === 409) reload()
      setErrors(previous => ({ ...previous, [item.id]: failure instanceof Error ? failure.message : 'That did not save.' }))
    } finally {
      setPending(previous => without(previous, item.id))
    }
  }

  async function attach(item: ChecklistItem, file: File | undefined, how: How = 'camera') {
    if (!file) return
    if (!host.write) { setSignIn(true); return }
    if (!live || uploading[item.id]) return
    setTarget({ checklist: detail.id, step: item.id })
    setHint(null)
    setAttached(null)
    setUploading(previous => ({ ...previous, [item.id]: true }))
    setErrors(previous => without(previous, item.id))
    try {
      const picture = await prepareImage(file)
      try {
        const stored = await hubPost<{ file: string }>(`/checklists/${encodeURIComponent(detail.id)}/files`, { for: item.id, image: { type: picture.type, data: await toBase64(picture.blob) } })
        setUploaded(previous => ({ ...previous, [item.id]: stored.file }))
        setAttached({ step: item.id, text: `${VERB[how]} step ${Number(item.id)}` })
      } finally {
        URL.revokeObjectURL(picture.url)
      }
    } catch (failure) {
      if (failure instanceof HubError && failure.status === 409) reload()
      setErrors(previous => ({ ...previous, [item.id]: failure instanceof Error ? failure.message : 'That picture did not save.' }))
    } finally {
      setUploading(previous => without(previous, item.id))
    }
  }

  // Ctrl+V: a picture on the clipboard goes to the step touched last, when it is on this list.
  const latest = useRef({ items, attach, report, detailId: detail.id })
  useEffect(() => { latest.current = { items, attach, report, detailId: detail.id } })
  const listening = live && host.write
  useEffect(() => {
    if (!listening) return
    const onPaste = (event: ClipboardEvent) => {
      const { items: steps, attach: put, report: issue, detailId } = latest.current
      const pictures = pictureFiles(event.clipboardData)
      if (!pictures.length || event.defaultPrevented) return
      const origin = event.target as Element | null
      if (origin?.closest?.('.excalidraw')) return
      if (isTextField(origin) && hasText(event.clipboardData)) return
      const mine = getTarget()?.checklist === detailId
      const inside = [stepsRef.current, submitRef.current].some(part => !!part && origin instanceof Node && part.contains(origin))
      if (!mine) {
        if (inside && !getTarget()) { event.preventDefault(); setHint(playtest ? 'Paste a screenshot while writing an issue.' : 'Tap a step first, then paste.') }
        return
      }
      if (playtest) {
        event.preventDefault()
        if (getTarget()?.step !== 'issue') { setHint('Paste a screenshot while writing an issue.'); return }
        setHint(pictures.length > 1 ? 'One picture per paste.' : null)
        void issue.attach(pictures[0])
        return
      }
      const step = steps.find(item => item.id === getTarget()?.step)
      if (!step) return
      event.preventDefault()
      void put(step, pictures[0], 'paste')
      if (pictures.length > 1) setHint('One picture per paste.')
    }
    document.addEventListener('paste', onPaste)
    return () => document.removeEventListener('paste', onPaste)
  }, [listening, playtest])
  useEffect(() => () => clearTarget(detail.id), [detail.id])

  // Dragging files: a step is a drop zone; anywhere else on the list only keeps the browser from opening the file.
  const canDrop = live && !playtest && host.write
  const rowDrag = (event: DragEvent, item: ChecklistItem) => {
    if (!canDrop || !hasFiles(event.dataTransfer)) return
    event.preventDefault()
    event.stopPropagation()
    if (event.type === 'drop') {
      setDropping(null)
      const pictures = pictureFiles(event.dataTransfer)
      void attach(item, pictures[0] ?? event.dataTransfer.files[0], 'drop')
      if (pictures.length > 1) setHint('One picture per drop.')
    } else setDropping(item.id)
  }
  const rowLeave = (event: DragEvent) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropping(null) }
  const guardDrag = (event: DragEvent) => {
    if (!hasFiles(event.dataTransfer)) return
    event.preventDefault()
    if (event.type === 'drop' && !playtest) { setDropping(null); setAttached(null); setHint('Drop the picture on a step.') }
  }

  async function submit() {
    if (!host.write) { setSignIn(true); return }
    if (!live || submitting) return
    if (playtest && !report.ready) return
    if (!playtest && openCount > 0 && warnedAt !== openCount) { setWarnedAt(openCount); return }
    setSubmitting(true)
    setProblem(null)
    try {
      await hubPost(`/checklists/${encodeURIComponent(detail.id)}/submit`, { ...(note.trim() ? { note: note.trim() } : {}), ...(playtest ? report.payload() : {}), ...(attachHelp.help ? { help: attachHelp.help } : {}) })
      onSubmitted()
    } catch (failure) {
      if (failure instanceof HubError && failure.status === 409) reload()
      setProblem(failure instanceof Error ? failure.message : 'That did not send.')
      setSubmitting(false)
    }
  }

  const percent = total ? Math.round((doneCount / total) * 100) : 0
  const warning = live && !playtest && warnedAt === openCount && openCount > 0
  let group: string | undefined

  const stepsSection = (
      <section className="hub-panel" aria-label={playtest ? 'What to try' : 'Steps'} ref={stepsRef} onDragOver={guardDrag} onDrop={guardDrag}>
        <p className="hub-cl-count" data-progress aria-live="polite">{doneCount} of {total} done</p>
        <div className="hub-cl-bar" role="progressbar" aria-label="Progress" aria-valuemin={0} aria-valuemax={total} aria-valuenow={doneCount}><span style={{ width: `${percent}%` }} /></div>
        {hint && <p className="hub-muted" role="status" data-paste-hint>{hint}</p>}
        {canDrop && finePointer() && <p className="hub-muted hub-cl-tip" data-paste-tip>Tip: click a step, then paste a screenshot.</p>}
        {signIn && !host.write && <p className="hub-muted" data-readonly-note>{SIGN_IN}</p>}
        {detail.state === 'cancelled' && <p className="hub-muted" data-cancelled>The agent withdrew this list.</p>}

        {items.map(item => {
          const heading = item.group && item.group !== group ? item.group : null
          group = item.group
          const done = isDone(item)
          const mark = pending[item.id]
          const link = safeUrl(item.link)
          // Any step can fail, so with Chat every step opens to its Get help link.
          const more = !!item.guide || !!link || host.chat
          const open = more && isExpanded(item)
          const labelId = `hub-cl-${detail.id}-${item.id}`
          // File names start with the step and a sortable stamp, so the greater name is the newer picture.
          const stored = [detail.evidence?.[item.id]?.file, uploaded[item.id]].filter((name): name is string => !!name).sort().pop()
          const when = done ? (mark?.at ?? item.at) : undefined
          const body = (
            <>
              <span className="hub-cl-title" id={labelId}>{text(item.text)}</span>
              {done && <span className="hub-cl-meta">done{when ? ` ${clock(when)}` : ''}</span>}
            </>
          )
          return (
            <div
              key={item.id} className={`hub-cl-item${target?.checklist === detail.id && target.step === item.id ? ' target' : ''}${dropping === item.id ? ' hub-cl-drop' : ''}`} data-item={item.id} data-done={done ? 'true' : undefined}
              onPointerDown={() => setTarget({ checklist: detail.id, step: item.id })} onFocus={() => setTarget({ checklist: detail.id, step: item.id })}
              onDragEnter={event => rowDrag(event, item)} onDragOver={event => rowDrag(event, item)} onDragLeave={rowLeave} onDrop={event => rowDrag(event, item)}
            >
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
                {stored && (
                  <span className="hub-cl-thumb" data-evidence>
                    <HubImage path={`checklists/${detail.id}/${stored}`} alt={`The picture for step ${Number(item.id)}`} open />
                  </span>
                )}
                {live && !playtest && (
                  <label className="hub-cl-cam" title={finePointer() ? 'Attach a picture, or paste one (Ctrl+V) after tapping a step' : 'Attach a photo'} data-attach aria-disabled={!!uploading[item.id] || undefined} onClick={event => { if (!host.write) { event.preventDefault(); setSignIn(true) } }}>
                    <span aria-hidden="true">{uploading[item.id] ? '…' : '📷'}</span>
                    <input
                      type="file" accept="image/jpeg,image/png,image/*" capture="environment" data-attach-input
                      aria-label={`Attach evidence for step ${Number(item.id)}`} disabled={!!uploading[item.id]}
                      onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; void attach(item, file) }}
                    />
                  </label>
                )}
              </div>
              {attached?.step === item.id && <p className="hub-muted" role="status" data-attached-note>{attached.text}</p>}
              {errors[item.id] && <p className="hub-error" role="alert" data-item-error>{errors[item.id]}</p>}
              {open && (
                <div className="hub-cl-more" id={`${labelId}-more`}>
                  {item.guide && <Md text={item.guide} copy />}
                  {link && <p><a className="hub-btn" href={link} target="_blank" rel="noopener noreferrer">Open details</a></p>}
                  <StepHelp target={{ kind: 'checklist', id: detail.id, label: 'checklist', title: text(detail.title) }} step={item.id} text={text(item.text)} note={note} />
                </div>
              )}
            </div>
          )
        })}
      </section>
  )

  const submitSection = live && (
        <section className="hub-panel hub-cl-submit" aria-label={playtest ? 'Report' : 'Submit'} ref={submitRef} onDragOver={guardDrag} onDrop={guardDrag}>
          {playtest && <PlaytestReport report={report} checklistId={detail.id} live={live} />}
          <label className="hub-field">Note to the agent (optional)
            <textarea value={note} onChange={event => setNote(event.target.value)} rows={3} maxLength={2000} disabled={submitting} />
          </label>
          {attachHelp.element}
          {warning && <p className="hub-cl-warn" role="alert" data-warning>{openCount} {plural(openCount, 'item is', 'items are')} still open. Submit anyway?</p>}
          {problem && <p className="hub-error" role="alert">{problem}</p>}
          <div className="hub-actions">
            <button
              type="button" className="hub-btn pri hub-cl-send" data-submit disabled={submitting || Object.keys(pending).length > 0 || (playtest && !report.ready)}
              aria-disabled={host.write ? undefined : true} onClick={() => void submit()}
            >{playtest ? 'Send report' : warning ? `Submit with ${openCount} open` : 'Submit'}</button>
          </div>
          {signIn && !host.write && <p className="hub-muted" data-readonly-note>{SIGN_IN}</p>}
        </section>
  )

  if (!playtest) return <>{stepsSection}{submitSection}</>
  return (
    <div className="pt" data-playtest>
      <div className="pt-left">
        {build ? <p><a className="hub-btn pri" href={build} target="_blank" rel="noopener noreferrer" data-open-build>Open build · {text(detail.platform) || 'web'}</a></p> : <p className="hub-muted">This playtest has no valid build link.</p>}
        {text(detail.lookFor) && <div className="pt-look" data-look-for><h4 className="pt-h">Look for</h4><p>{text(detail.lookFor)}</p></div>}
        <h4 className="pt-h">What to try</h4>
        {stepsSection}
      </div>
      <div className="pt-right">{submitSection}</div>
    </div>
  )
}
