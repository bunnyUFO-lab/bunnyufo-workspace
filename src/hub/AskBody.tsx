import { lazy, Suspense } from 'react'
import type { Ask, AskAnswer } from '../lib/hub'
import { host } from '../lib/host'
import type { AskVerb } from './askAnswer'
import AvatarNote from './AvatarNote'
import { isSheetCheck } from './avatarAsk'
import { VERDICTS, imageName, optionList, text, useAskAnswer } from './askAnswer'
import HubImage from './HubImage'
import Md from './Md'
import { useAttachHelp } from './useAttachHelp'

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
  const live0 = ask.state === 'open' || ask.state === 'snoozed'
  const attachHelp = useAttachHelp('ask', ask.id, live0)
  const answer = useAskAnswer(ask, { reload, onSettled, onTaken, handoff: view, help: attachHelp.help })
  const { choice, setChoice, note, setNote, busy, problem, notice, confirming, setConfirming, drawing, setDrawing, editing, setEditing, sizes, setSizes, io, kind, decisions, verdicts } = answer
  const options = optionList(ask)
  const sheetCheck = isSheetCheck(ask)
  const live = ask.state === 'open' || ask.state === 'snoozed'
  const writable = host.write && live
  const canDraw = writable && ask.allowDrawing
  const hasImages = !sheetCheck && options.some(option => !!option.image)
  const image = sheetCheck ? '' : imageName(ask)
  const pick = kind === 'pick'
  const noteField = ask.allowNote && writable && (
    <label className="hub-field">{kind ? 'Summary note (optional)' : 'Note to the agent (optional)'}
      <textarea value={note} onChange={event => setNote(event.target.value)} rows={3} maxLength={4000} />
    </label>
  )
  const picture = image && (
    <div className="dr-pic" data-design-image>
      <span className="hub-thumb dr-thumb">
        <HubImage
          path={`asks/${ask.id}/${image}`} alt={`The design: ${text(ask.question)}`} open
          onLoad={event => { const { naturalWidth: w, naturalHeight: h } = event.currentTarget; setSizes(previous => (previous.image?.w === w ? previous : { ...previous, image: { w, h } })) }}
        />
      </span>
      {canDraw && (
        <div className="dr-tools">
          <button type="button" className="hub-btn" data-annotate onClick={() => setEditing({ optionId: null, image, w: sizes.image?.w ?? 1024, h: sizes.image?.h ?? 768, scene: drawing?.optionId === null ? drawing.scene : undefined })}>✎ Annotate</button>
          {drawing && <button type="button" className="hub-btn" data-clear-drawing onClick={() => setDrawing(null)}>Clear</button>}
        </div>
      )}
    </div>
  )
  const decisionRows = decisions.length > 0 && (
    <div className="dr-decisions" role="list" aria-label="Decisions">
      {decisions.map(item => {
        const stored = ask.answer?.decisions?.[item.id]
        const given = verdicts[item.id] ?? (stored ? { verdict: stored.verdict, note: text(stored.note) } : undefined)
        return (
          <div key={item.id} className="dr-row" role="listitem" data-decision={item.id} data-verdict={given?.verdict}>
            <p className="dr-text" id={`dr-${ask.id}-${item.id}`}>{text(item.text)}</p>
            {text(item.detail) && <p className="dr-detail">{text(item.detail)}</p>}
            <div className="dr-seg" role="group" aria-labelledby={`dr-${ask.id}-${item.id}`}>
              {VERDICTS.map(([verdict, label]) => (
                <button
                  key={verdict} type="button" className="dr-pill" data-verdict-btn={verdict} aria-pressed={given?.verdict === verdict}
                  disabled={!writable} aria-disabled={writable ? undefined : true} title={writable ? undefined : 'Sign in to answer'}
                  onClick={() => answer.setVerdict(item.id, verdict)}
                >{label}</button>
              ))}
            </div>
            {given?.verdict === 'change' && (live ? (
              <input
                className="dr-note" type="text" maxLength={1000} value={given.note} placeholder="What should change?" aria-label={`What should change: ${text(item.text)}`}
                onChange={event => answer.setVerdictNote(item.id, event.target.value)}
              />
            ) : given.note && <p className="dr-detail">{given.note}</p>)}
          </div>
        )
      })}
    </div>
  )

  return (
    <>
      {typeof ask.context === 'string' && ask.context && <Md text={ask.context} />}
      <AvatarNote ask={ask} />
      {(picture || decisionRows) && (
        <div className="dr" data-design>
          {picture}
          <div className="dr-side">
            {decisionRows}
            {noteField}
          </div>
        </div>
      )}
      {options.length > 0 && (
        <div className={`hub-options${pick ? ' pick' : ''}`} role="radiogroup" aria-label="Options">
          {options.map(option => (
            <div key={option.id} className={`hub-option${choice === option.id || ask.answer?.choice === option.id ? ' sel' : ''}`} data-option={option.id}>
              <button
                type="button" role="radio" aria-checked={choice === option.id} disabled={!writable} aria-disabled={writable ? undefined : true} title={writable ? undefined : 'Sign in to answer'}
                className="hub-option-pick" onClick={() => setChoice(option.id)}
              >
                {!sheetCheck && typeof option.image === 'string' && option.image && (
                  <span className="hub-thumb">
                    <HubImage
                      path={`asks/${ask.id}/${option.image}`} alt={`Option ${option.id}: ${text(option.label)}`}
                      onLoad={event => { const { naturalWidth: w, naturalHeight: h } = event.currentTarget; setSizes(previous => (previous[option.id]?.w === w ? previous : { ...previous, [option.id]: { w, h } })) }}
                    />
                  </span>
                )}
                <span className="hub-option-label"><b>{option.id}</b> · {text(option.label)}</span>
                {pick && <span className="dr-use">{choice === option.id ? 'Chosen' : 'Use this one'}</span>}
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
      {!(picture || decisionRows) && noteField}
      {canDraw && !hasImages && !image && !drawing && (
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
      {notice && <p className="hub-muted" role="status" data-avatar-notice>{notice}</p>}
      {writable && attachHelp.element}
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
              <button type="button" className="hub-btn pri" data-send disabled={busy || !answer.ready} onClick={() => void answer.send()}>{pick ? 'Send pick' : kind ? 'Send review' : 'Send answer'}</button>
            </>
          )}
        </div>
      )}
      {editing && io && (
        <Suspense fallback={null}>
          <DrawingEditor url="" title={editing.optionId ? `Option ${editing.optionId}` : editing.image ? 'Annotate' : 'Drawing'} io={io} onClose={() => setEditing(null)} />
        </Suspense>
      )}
    </>
  )
}
