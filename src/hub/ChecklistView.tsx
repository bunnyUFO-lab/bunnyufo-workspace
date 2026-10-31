import type { Checklist } from '../lib/hub'
import { ago, safeUrl } from '../lib/hub'
import { hubHash } from '../lib/route'
import ChecklistBody from './ChecklistBody'
import { useState } from 'react'
import { takeHandoff } from './flash'
import NextNote from './NextNote'
import { goNext, useQueueOrder } from './useGoNext'
import Md from './Md'
import HubImage from './HubImage'
import { VERDICT_LABEL } from './playtest'
import { useHubData } from './useHub'
import GetHelp, { HelpAttachedNote } from './GetHelp'
import Delivery from './Delivery'
import { needsHash } from './needsFocus'

const text = (value: unknown) => (typeof value === 'string' || typeof value === 'number' ? String(value) : '')

/** One checklist on its own page: its header, the shared steps and Submit, and what became of it. */
export default function ChecklistView({ id }: { id: string }) {
  const { data: detail, error, reload, at: loadedAt } = useHubData<Checklist>(`/checklists/${encodeURIComponent(id)}`)
  const [handoff] = useState(takeHandoff)
  const queue = useQueueOrder()
  if (!detail) {
    return (
      <>
        <p className="hub-empty" role={error ? 'alert' : undefined}>{error ?? 'Loading…'}</p>
        {error && <p><a className="hub-btn" href={needsHash()}>Back to Needs you</a></p>}
      </>
    )
  }

  const card = safeUrl(detail.card)
  const submitted = detail.state === 'submitted' || detail.state === 'picked-up'

  return (
    <div className="hub-cl" data-state={detail.state}>
      {handoff && <NextNote note={handoff} />}
      <p><a className="hub-btn" href={needsHash()} data-back-top>‹ Needs you</a></p>
      <div className="hub-top">
        <h2>{text(detail.title)}</h2>
        <span><span className="hub-pill">{text(detail.project)}</span>{text(detail.bead) && <> <span className="hub-pill">{text(detail.bead)}</span></>}</span>
        <GetHelp className="hub-top-help" target={{ kind: 'checklist', id: detail.id, label: detail.kind === 'playtest' ? 'playtest' : 'checklist', title: text(detail.title) }} />
      </div>
      <p className="hub-muted">Posted {ago(detail.createdAt)}{text(detail.from?.host) ? ` from ${text(detail.from?.host)}` : ''}.</p>
      {typeof detail.context === 'string' && detail.context && <Md text={detail.context} />}
      {card && <p><a className="hub-btn" href={card} target="_blank" rel="noopener noreferrer">Open the card</a></p>}

      <ChecklistBody
        data={detail} loadedAt={loadedAt} reload={reload}
        onSubmitted={() => void goNext({ kind: 'checklist', id: detail.id, title: detail.title }, detail.kind === 'playtest' ? 'reported' : 'submitted', queue(), hubHash('checklist', detail.id))}
      />

      {submitted && detail.submit && (
        <section className="hub-panel" aria-label="Submitted" data-submitted>
          <p><b>Submitted {ago(detail.submit.at)}</b>{text(detail.submit.by) ? ` by ${text(detail.submit.by)}` : ''}.</p>
          {detail.kind === 'playtest' && detail.submit.rating && <p data-report-summary>Rating {detail.submit.rating}/5 · {VERDICT_LABEL.find(([value]) => value === detail.submit?.verdict)?.[1] ?? text(detail.submit.verdict)} · {(detail.submit.issues ?? []).length} {(detail.submit.issues ?? []).length === 1 ? 'issue' : 'issues'}</p>}
          {Array.isArray(detail.submit.issues) && detail.submit.issues.length > 0 && (
            <ul className="pt-issues">
              {detail.submit.issues.map((issue, index) => (
                <li key={index} className="pt-issue">
                  {issue.shot && <span className="hub-cl-thumb"><HubImage path={`checklists/${detail.id}/${issue.shot}`} alt={`Screenshot for issue ${index + 1}`} open /></span>}
                  <span className="pt-issue-text">{text(issue.text)}</span>
                </li>
              ))}
            </ul>
          )}
          <HelpAttachedNote chat={detail.submit.help?.chat} />
          {typeof detail.submit.note === 'string' && detail.submit.note && <p className="hub-note-text">{detail.submit.note}</p>}
          {detail.state === 'picked-up' && detail.pickup && <p className="hub-muted">Picked up {ago(detail.pickup.at)}{text(detail.pickup.host) ? ` on ${text(detail.pickup.host)}` : ''}.</p>}
        </section>
      )}
      {submitted && detail.submit && detail.delivery && !detail.pickup && <Delivery noun="checklist" project={detail.project} delivery={detail.delivery} />}
      <p><a className="hub-btn" href={needsHash()}>Back to Needs you</a></p>
    </div>
  )
}
