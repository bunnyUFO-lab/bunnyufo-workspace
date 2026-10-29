import type { Ask, Checklist, Item } from '../lib/hub'
import { ago, appUrl, safeUrl, sessionUrl } from '../lib/hub'
import { KIND_ICON, KIND_LABEL, needsKind } from '../lib/needsKinds'
import type { SettledVerb } from '../lib/nextItem.mjs'
import { reviewHash } from '../lib/route'
import AskBody from './AskBody'
import { ApprovalBody } from './ApprovalView'
import ChecklistBody from './ChecklistBody'
import HermesApprovalView from './HermesApprovalView'
import { ReviewActions } from './ItemRow'
import { useMarkDone } from './useMarkDone'
import { itemKey, itemPage } from './needsFocus'
import { useHubData } from './useHub'

/** What the owner did to take an item off the queue, as `onSettled` reports it. */
export type SettleVerb = SettledVerb

const VERDICT_LEG: Record<string, string> = { smoke: 'Smoke', review: 'Review', qa: 'QA' }

function Icon({ paths }: { paths: string }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" dangerouslySetInnerHTML={{ __html: paths }} />
}

function BlockedBody({ item, onSettled }: { item: Item; onSettled: () => void }) {
  const link = sessionUrl(item.url)
  const desk = appUrl(item.appUrl)
  const { button, notes } = useMarkDone(item, onSettled)
  return (
    <>
      <div className="ni-b">{item.summary ? <pre className="ni-mono">{item.summary}</pre> : <p className="hub-muted">The session gave no details.</p>}</div>
      <div className="ni-a" data-blocked>
        {link && <a className="hub-btn pri" href={link} target="_blank" rel="noopener noreferrer" data-link="session">Open the session</a>}
        {desk && <a className="hub-btn hub-desk" href={desk} data-link="app">Open in the desktop app</a>}
        {!link && <span className="hub-muted" data-blocked-hint>{item.host ? `Open the Claude app on ${item.host}` : 'Open the Claude app'}</span>}
        {item.file && <span className="sp" />}
        {item.file && button}
      </div>
      {item.file && notes && <div className="ni-b ni-notes">{notes}</div>}
    </>
  )
}

function ReviewBody({ item, onSettled }: { item: Item; onSettled: () => void }) {
  const verdicts = item.verdicts ?? []
  return (
    <>
      <div className="ni-b">
        <div className="ni-chips">
          {verdicts.map(verdict => <span key={verdict.leg} className={`ni-chip ${verdict.result}`} data-verdict={verdict.leg}>{VERDICT_LEG[verdict.leg]} {verdict.result}</span>)}
          {!!item.shots && <span className="ni-chip">{item.shots} {item.shots === 1 ? 'screenshot' : 'screenshots'}</span>}
          {!verdicts.length && !item.shots && <span className="hub-muted">No test results came with this review.</span>}
        </div>
      </div>
      <div className="ni-a">
        <ReviewActions item={item} onDone={onSettled} />
        <a className="hub-btn" href={reviewHash(item.id)} data-review-open>Details</a>
      </div>
    </>
  )
}

/**
 * One card of the Needs you list: who is asking, the four cells, and the body and actions for its kind, so an item is
 * answered where it stands. `onSettled` runs after every successful action that takes the item off the queue.
 */
export default function NeedsItem({ item, at, reload, onSettled, leaving = false }: {
  item: Item
  /** When the list last arrived: a checklist body keeps its own newer tick answer until then. */
  at: Date | null
  reload: () => void
  onSettled: (item: Item, verb: SettleVerb) => void
  leaving?: boolean
}) {
  const kind = needsKind(item)
  const needsDetail = !item.detail && (item.kind === 'ask' || item.kind === 'checklist')
  const fetched = useHubData<Ask | Checklist>(needsDetail ? `/${item.kind === 'ask' ? 'asks' : 'checklists'}/${encodeURIComponent(item.id)}` : null)
  const detail = item.detail ?? fetched.data
  const info = item.describe
  const page = itemPage(item)
  const link = safeUrl(page)
  const key = itemKey(item)
  const who = info?.who || item.host || ''
  const meta = [who, `asked ${ago(item.at)}`, item.bead ?? item.project].filter(Boolean)
  const cells: [string, string | undefined][] = [['What', info?.what], ['State', info?.state], ['Next action', info?.next], ['Blocker', info?.blocker]]

  return (
    <div className={`ni${leaving ? ' leaving' : ''}`} data-need={key} data-kind={kind} aria-hidden={leaving ? true : undefined}>
      <article className="ni-card" aria-labelledby={`ni-${key}`}>
        <header className="ni-h">
          <span className="kind"><Icon paths={KIND_ICON[kind]} /></span>
          <div className="ni-hm">
            <h3 className="ni-t" id={`ni-${key}`} tabIndex={-1}>{page ? <a href={page}>{item.title}</a> : item.title}</h3>
            <div className="ni-meta"><span className="ni-chip">{item.kind === 'hermes-approval' ? 'Hermes approval' : KIND_LABEL[kind]}</span>{meta.map(part => <span key={part}>{part}</span>)}</div>
          </div>
        </header>
        {info && (
          <dl className="four" data-four>
            {cells.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
          </dl>
        )}
        {item.kind === 'ask' && (detail
          ? <div className="ni-b"><AskBody ask={detail as Ask} reload={reload} onSettled={verb => onSettled(item, verb)} /></div>
          : <div className="ni-b"><p className="hub-muted">{fetched.error ?? 'Loading…'}</p>{link && <a className="hub-btn" href={link}>Open</a>}</div>)}
        {item.kind === 'checklist' && (detail
          ? <div className="ni-b"><ChecklistBody data={detail as Checklist} loadedAt={at} reload={reload} onSubmitted={() => onSettled(item, kind === 'playtest' ? 'reported' : 'submitted')} /></div>
          : <div className="ni-b"><p className="hub-muted">{fetched.error ?? 'Loading…'}</p></div>)}
        {item.kind === 'approval' && <ApprovalBody id={item.id} onSettled={verb => onSettled(item, verb)} />}
        {item.kind === 'review' && <ReviewBody item={item} onSettled={() => onSettled(item, 'done')} />}
        {item.kind === 'blocked' && <BlockedBody item={item} onSettled={() => onSettled(item, 'done')} />}
        {item.kind === 'hermes-approval' && <HermesApprovalView item={item} onSettled={() => onSettled(item, 'done')} />}
      </article>
    </div>
  )
}
