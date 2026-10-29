import { lazy, Suspense } from 'react'
import type { Ask, AskAnswer } from '../lib/hub'
import { host } from '../lib/host'
import type { AskVerb } from './askAnswer'
import { optionList, text, useAskAnswer } from './askAnswer'
import HubImage from './HubImage'
import Md from './Md'

const DrawingEditor = lazy(() => import('../components/DrawingEditor'))

/**
 * One Ask's body: the context, the options, the note, the drawing and the actions. The Needs you card and the
 * Ask's own view both render it. `view` marks the Ask's own page: it adds the owner's Cancel and takes a drawing handed over from Sketch.
 */
export default function AskBody({ ask, reload, onSettled, onTaken, view = false }: {
  ask: Ask
  reload: () => void
  onSettled?: (verb: AskVerb) => void
  onTaken?: (answer: AskAnswer | null) => void
  view?: boolean
}) {
  const answer = useAskAnswer(ask, { reload, onSettled, onTaken, handoff: view })
  const { choice, setChoice, note, setNote, busy, problem, confirming, setConfirming, drawing, setDrawing, editing, setEditing, sizes, setSizes, io } = answer
  const options = optionList(ask)
  const live = ask.state === 'open' || ask.state === 'snoozed'
  const writable = host.write && live
  const canDraw = writable && ask.allowDrawing
  const hasImages = options.some(option => !!option.image)

  return (
    <>
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
              <button type="button" className="hub-btn danger" disabled={busy} onClick={() => { setConfirming(false); void answer.cancel() }}>Yes, cancel</button>
            </>
          ) : (
            <>
              {view && <button type="button" className="hub-btn" disabled={busy} onClick={() => setConfirming(true)}>Cancel</button>}
              <button type="button" className="hub-btn" disabled={busy} onClick={() => void answer.snooze()}>Snooze a day</button>
              <button type="button" className="hub-btn pri" disabled={busy || !answer.ready} onClick={() => void answer.send()}>Send answer</button>
            </>
          )}
        </div>
      )}
      {editing && io && (
        <Suspense fallback={null}>
          <DrawingEditor url="" title={editing.optionId ? `Option ${editing.optionId}` : 'Drawing'} io={io} onClose={() => setEditing(null)} />
        </Suspense>
      )}
    </>
  )
}
