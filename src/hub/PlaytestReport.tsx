import { useState } from 'react'
import type { DragEvent } from 'react'
import { host } from '../lib/host'
import { hasFiles, pictureFiles } from '../lib/pastePictures.mjs'
import { setTarget } from './stepTarget'
import HubImage from './HubImage'
import { MAX_ISSUES, VERDICT_LABEL } from './playtest'
import type { usePlaytestReport } from './playtest'

/** The right column of a playtest: stars, issues with an add row, and the verdict. */
export default function PlaytestReport({ report, checklistId, live }: { report: ReturnType<typeof usePlaytestReport>; checklistId: string; live: boolean }) {
  const { rating, setRating, verdict, setVerdict, issues, draft, setDraft, shot, setShot, uploading, problem } = report
  const can = live && host.write
  const [over, setOver] = useState(false)
  const touch = () => setTarget({ checklist: checklistId, step: 'issue' })
  const onDrag = (event: DragEvent) => {
    if (!hasFiles(event.dataTransfer)) return
    event.preventDefault()
    event.stopPropagation()
    if (event.type !== 'drop') { setOver(true); return }
    setOver(false)
    touch()
    void report.attach(pictureFiles(event.dataTransfer)[0] ?? event.dataTransfer.files[0])
  }
  return (
    <div className="pt-report" data-playtest-report>
      <div className="pt-block">
        <h4 className="pt-h" id={`pt-rating-${checklistId}`}>Rating</h4>
        <div className="pt-stars" role="group" aria-labelledby={`pt-rating-${checklistId}`}>
          {[1, 2, 3, 4, 5].map(value => (
            <button
              key={value} type="button" className="pt-star" data-star={value} aria-pressed={rating === value} aria-label={`${value} of 5`}
              disabled={!can} data-on={value <= rating ? 'true' : undefined} onClick={() => setRating(value)}
            ><span aria-hidden="true">{value <= rating ? '★' : '☆'}</span></button>
          ))}
        </div>
      </div>

      <div className="pt-block">
        <h4 className="pt-h">Issues {issues.length > 0 && <span className="hub-muted">({issues.length})</span>}</h4>
        {issues.length > 0 && (
          <ul className="pt-issues" data-issues>
            {issues.map((issue, index) => (
              <li key={`${index}-${issue.text}`} className="pt-issue" data-issue>
                {issue.shot && <span className="hub-cl-thumb" data-issue-shot><HubImage path={`checklists/${checklistId}/${issue.shot}`} alt={`Screenshot for issue ${index + 1}`} open /></span>}
                <span className="pt-issue-text">{issue.text}</span>
                {can && <button type="button" className="hub-btn pt-x" aria-label={`Remove issue ${index + 1}`} onClick={() => report.remove(index)}>✕</button>}
              </li>
            ))}
          </ul>
        )}
        {can && issues.length < MAX_ISSUES && (
          <div
            className={`pt-add${over ? ' hub-cl-drop' : ''}`} data-issue-row onPointerDown={touch} onFocus={touch}
            onDragEnter={onDrag} onDragOver={onDrag} onDrop={onDrag} onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(false) }}
          >
            <input
              className="pt-input" type="text" maxLength={500} value={draft} placeholder="What went wrong?" aria-label="Describe an issue" data-issue-input
              onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); report.add() } }}
            />
            <label className="hub-cl-cam" title="Attach a screenshot" data-attach-shot aria-disabled={uploading || undefined}>
              <span aria-hidden="true">{uploading ? '…' : '📷'}</span>
              <input
                type="file" accept="image/jpeg,image/png,image/*" aria-label="Attach a screenshot to this issue" disabled={uploading} data-shot-input
                onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; void report.attach(file) }}
              />
            </label>
            <button type="button" className="hub-btn" data-add-issue disabled={!draft.trim()} onClick={() => report.add()}>Add</button>
          </div>
        )}
        {shot && can && (
          <p className="pt-pending" data-pending-shot>
            <span className="hub-cl-thumb"><HubImage path={`checklists/${checklistId}/${shot}`} alt="The screenshot for the next issue" /></span>
            <span className="hub-muted">Screenshot ready for the next issue</span>
            <button type="button" className="hub-btn pt-x" aria-label="Remove the screenshot" onClick={() => setShot(null)}>✕</button>
          </p>
        )}
        {problem && <p className="hub-error" role="alert">{problem}</p>}
      </div>

      <div className="pt-block">
        <h4 className="pt-h" id={`pt-verdict-${checklistId}`}>Verdict</h4>
        <div className="dr-seg pt-verdict" role="group" aria-labelledby={`pt-verdict-${checklistId}`}>
          {VERDICT_LABEL.map(([value, label]) => (
            <button key={value} type="button" className="dr-pill" data-verdict-btn={value} aria-pressed={verdict === value} disabled={!can} onClick={() => setVerdict(value)}>{label}</button>
          ))}
        </div>
      </div>
    </div>
  )
}
