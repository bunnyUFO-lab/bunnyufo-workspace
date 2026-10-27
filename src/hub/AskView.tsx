import { lazy, Suspense, useMemo, useState } from 'react'
import type { Ask, AskAnswer } from '../lib/hub'
import { HubError, fileUrl, hubPost } from '../lib/hub'
import { authHeaders } from '../local/client'
import type { DrawingIo } from '../components/DrawingEditor'
import { host } from '../lib/host'
import { hubHash } from '../lib/route'
import { annotationScene, blankScene, takeHandoff } from './drawing'
import HubImage from './HubImage'
import Md from './Md'
import { useHubData } from './useHub'

const DrawingEditor = lazy(() => import('../components/DrawingEditor'))

interface Attached { scene: string; png: string; optionId: string | null }
interface Editing { optionId: string | null; image?: string; w: number; h: number; scene?: string }

const STEPS: [string, string][] = [['open', 'Open'], ['answered', 'Answered'], ['picked-up', 'Picked up']]
const SIDE: Record<string, string> = { snoozed: 'Snoozed', expired: 'Expired', cancelled: 'Cancelled' }
// An Ask file is written by agents and tools, so every field here may be missing or the wrong type.
const when = (iso: unknown) => {
  const date = typeof iso === 'string' ? new Date(iso) : null
  return date && !Number.isNaN(date.getTime()) ? date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'an unknown time'
}
const text = (value: unknown) => (typeof value === 'string' || typeof value === 'number' ? String(value) : '')
const optionList = (ask: Ask): Ask['options'] => (Array.isArray(ask.options) ? ask.options.filter(item => item && typeof item === 'object' && typeof item.id === 'string') : [])

function AnswerSummary({ ask, answer }: { ask: Ask; answer: AskAnswer }) {
  const option = optionList(ask)?.find(item => item.id === answer.choice)
  return (
    <section className="hub-panel hub-answer" aria-label="The answer">
      <h3>Answer <span>by {text(answer.by) || 'someone'}{answer.via === 'discord' ? ' via Discord' : ''}, {when(answer.at)}</span></h3>
      {answer.choice && <p><b>{option ? `${option.id} · ${text(option.label)}` : text(answer.choice)}</b></p>}
      {typeof answer.note === 'string' && answer.note && <p className="hub-note-text">{answer.note}</p>}
      {answer.drawing && <HubImage className="hub-drawing" path={`asks/${ask.id}/${answer.drawing.png}`} alt="The drawing sent with the answer" />}
    </section>
  )
}

export default function AskView({ id }: { id: string }) {
  const { data: ask, error, reload } = useHubData<Ask>(`/asks/${encodeURIComponent(id)}`)
  const [choice, setChoice] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [taken, setTaken] = useState<AskAnswer | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [drawing, setDrawing] = useState<Attached | null>(() => { const handed = takeHandoff(); return handed ? { ...handed, optionId: null } : null })
  const [editing, setEditing] = useState<Editing | null>(null)
  const [sizes, setSizes] = useState<Record<string, { w: number; h: number }>>({})

  const askId = ask?.id
  const io = useMemo<DrawingIo | null>(() => (editing && askId ? {
    load: async () => ({ text: editing.scene ?? (editing.image ? annotationScene(editing.image, editing.w, editing.h) : blankScene()), etag: null }),
    save: async (scene, png) => {
      setDrawing({ scene, png, optionId: editing.optionId })
      if (editing.optionId) setChoice(editing.optionId)
      return { etag: null }
    },
    background: async name => {
      const response = await fetch(fileUrl(`asks/${askId}/${name}`), { headers: authHeaders() })
      if (!response.ok) throw new Error(`${response.status}`)
      return response.blob()
    },
  } : null), [editing, askId])

  if (!ask) return <p className="hub-empty">{error ?? 'Loading…'}</p>
  const options = optionList(ask) ?? []
  const from = { tool: text(ask.from?.tool), host: text(ask.from?.host) }
  const live = ask.state === 'open' || ask.state === 'snoozed'
  const writable = host.write && live
  const ready = !!choice || note.trim().length > 0 || !!drawing
  const canDraw = writable && ask.allowDrawing
  const hasImages = options.some(option => !!option.image)

  const act = async (run: () => Promise<unknown>) => {
    setBusy(true)
    setProblem(null)
    try {
      await run()
      reload()
    } catch (failure) {
      if (failure instanceof HubError && failure.status === 409) {
        const existing = (failure.body?.answer ?? null) as AskAnswer | null
        setTaken(existing)
        setProblem(existing ? `Already answered by ${existing.by} at ${when(existing.at)}.` : failure.message)
        reload()
      } else {
        setProblem(failure instanceof Error ? failure.message : 'That did not work.')
      }
    } finally {
      setBusy(false)
    }
  }

  const stepIndex = STEPS.findIndex(([key]) => key === (ask.state === 'snoozed' ? 'open' : ask.state))
  const answer = ask.answer ?? taken

  return (
    <>
      <div className="hub-top">
        <h2>{text(ask.question)}</h2>
        <span><span className="hub-pill">{text(ask.project)}</span>{text(ask.bead) && <> <span className="hub-pill">{text(ask.bead)}</span></>}</span>
      </div>
      <ol className="hub-steps" aria-label="State">
        {STEPS.map(([key, label], index) => (
          <li key={key} className={index < stepIndex ? 'past' : index === stepIndex ? 'on' : ''} aria-current={index === stepIndex ? 'step' : undefined}>{label}</li>
        ))}
        {ask.requirePasskey === true && <li className="tag" title="This Ask is answered in the Hub with a passkey, never from Discord">Passkey only</li>}
        {SIDE[ask.state] && <li className="side on">{SIDE[ask.state]}{ask.state === 'snoozed' && ask.snoozedUntil ? ` until ${when(ask.snoozedUntil)}` : ''}</li>}
      </ol>
      <section className="hub-panel">
        <p className="hub-muted">{from.tool || from.host ? `From ${from.tool || 'an agent'}${from.host ? ` on ${from.host}` : ''}, ` : 'From an unknown sender, '}{when(ask.createdAt)}.</p>
        {typeof ask.context === 'string' && ask.context && <Md text={ask.context} />}
        {options.length > 0 && (
          <div className="hub-options" role="radiogroup" aria-label="Options">
            {options.map(option => (
              <div key={option.id} className={`hub-option${choice === option.id || ask.answer?.choice === option.id ? ' sel' : ''}`} data-option={option.id}>
                <button
                  type="button" role="radio" aria-checked={choice === option.id} disabled={!writable} aria-disabled={writable ? undefined : true} title={writable ? undefined : 'Sign in to answer'}
                  className="hub-option-pick" onClick={() => setChoice(option.id)}
                >
                  {typeof option.image === 'string' && option.image && (
                    <span className="hub-thumb">
                      <HubImage
                        path={`asks/${ask.id}/${option.image}`} alt={`Option ${option.id}: ${text(option.label)}`}
                        onLoad={event => { const { naturalWidth: w, naturalHeight: h } = event.currentTarget; setSizes(previous => (previous[option.id]?.w === w ? previous : { ...previous, [option.id]: { w, h } })) }}
                      />
                    </span>
                  )}
                  <span className="hub-option-label"><b>{option.id}</b> · {text(option.label)}</span>
                </button>
                {canDraw && option.image && (
                  <button
                    type="button" className="hub-option-draw" aria-label={`Draw on option ${option.id}`} title="Draw on this picture"
                    onClick={() => setEditing({ optionId: option.id, image: option.image, w: sizes[option.id]?.w ?? 1024, h: sizes[option.id]?.h ?? 768, scene: drawing?.optionId === option.id ? drawing.scene : undefined })}
                  >✎</button>
                )}
              </div>
            ))}
          </div>
        )}
        {!host.write && live && <p className="hub-muted" data-readonly-note>You can read this Ask here. To answer it, open it on the signed-in site.</p>}
        {ask.allowNote && writable && (
          <label className="hub-field">Note to the agent (optional)
            <textarea value={note} onChange={event => setNote(event.target.value)} rows={3} maxLength={4000} />
          </label>
        )}
        {canDraw && !hasImages && !drawing && (
          <p><button type="button" className="hub-btn" onClick={() => setEditing({ optionId: null, w: 1024, h: 768 })}>Draw instead</button></p>
        )}
        {drawing && (
          <div className="hub-attached" data-attached>
            <img className="hub-attached-img" src={`data:image/png;base64,${drawing.png}`} alt="Your drawing" />
            <span>Drawing attached{drawing.optionId ? ` to option ${drawing.optionId}` : ''}</span>
            <button type="button" className="hub-btn" aria-label="Remove the drawing" onClick={() => setDrawing(null)}>✕</button>
          </div>
        )}
        {problem && <p className="hub-error" role="alert">{problem}</p>}
        {writable && (
          <div className="hub-actions">
            {confirming ? (
              <>
                <span className="hub-muted">Cancel this Ask?</span>
                <button type="button" className="hub-btn" onClick={() => setConfirming(false)}>Keep it</button>
                <button type="button" className="hub-btn danger" disabled={busy} onClick={() => { setConfirming(false); void act(() => hubPost(`/asks/${encodeURIComponent(ask.id)}/cancel`)) }}>Yes, cancel</button>
              </>
            ) : (
              <>
                <button type="button" className="hub-btn" disabled={busy} onClick={() => setConfirming(true)}>Cancel</button>
                <button type="button" className="hub-btn" disabled={busy} onClick={() => void act(() => hubPost(`/asks/${encodeURIComponent(ask.id)}/snooze`, { hours: 1 }))}>Snooze 1 h</button>
                <button
                  type="button" className="hub-btn pri" disabled={busy || !ready}
                  onClick={() => void act(() => hubPost(`/asks/${encodeURIComponent(ask.id)}/answer`, { ...(choice ? { choice } : {}), ...(note.trim() ? { note: note.trim() } : {}), ...(drawing ? { drawing: { scene: drawing.scene, png: drawing.png } } : {}) }))}
                >Send answer</button>
              </>
            )}
          </div>
        )}
      </section>
      {editing && io && (
        <Suspense fallback={null}>
          <DrawingEditor url="" title={editing.optionId ? `Option ${editing.optionId}` : 'Drawing'} io={io} onClose={() => setEditing(null)} />
        </Suspense>
      )}
      {answer && <AnswerSummary ask={ask} answer={answer} />}
      {ask.pickup && <p className="hub-muted">Picked up {when(ask.pickup.at)}{text(ask.pickup.host) ? ` on ${text(ask.pickup.host)}` : ''}{text(ask.pickup.bead) ? ` as ${text(ask.pickup.bead)}` : ''}.</p>}
      <p><a className="hub-btn" href={hubHash('inbox', 'asks')}>Back to the Inbox</a></p>
    </>
  )
}
