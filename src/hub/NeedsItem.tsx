import type { Ask, Checklist, Item } from '../lib/hub'
import { ago, appUrl, safeUrl, sessionUrl } from '../lib/hub'
import { KIND_ICON, KIND_LABEL, needsKind } from '../lib/needsKinds'
import NeedBadges from './NeedBadges'
import { metaParts } from '../lib/needsView.mjs'
import type { SettledVerb } from '../lib/nextItem.mjs'
import { reviewHash } from '../lib/route'
import AskBody from './AskBody'
import { ApprovalBody } from './ApprovalView'
import ChecklistBody from './ChecklistBody'
import HermesApprovalView from './HermesApprovalView'
import RunQuestionView from './RunQuestionView'
import PcStuckView from './PcStuckView'
import { ReviewActions } from './ItemRow'
import { nothingToDo } from './reviewText'
import { useMarkDone } from './useMarkDone'
import { itemKey, itemPage } from './needsFocus'
import { useHubData } from './useHub'
import GetHelp from './GetHelp'
import { useNotUseful } from './NotUseful'
import type { ProjectNames } from './ProjectChip'
import ProjectChip from './ProjectChip'
import type { HelpTarget } from './helpDraft'

/** What the owner did to take an item off the queue, as `onSettled` reports it. */
export type SettleVerb = SettledVerb

/** What an action can add to the note after it: plain words, and a link to what it made. */
export interface SettleExtra { detail?: string; link?: { label: string; hash: string } }

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
        {!link && <span className="hub-muted" data-blocked-hint>{item.host ? `No phone link came with this session. Open the Claude app on ${item.host}.` : 'No phone link came with this session. Open the Claude app on the computer it runs on.'}</span>}
        {item.file && <span className="sp" />}
        {item.file && button}
      </div>
      {item.file && notes && <div className="ni-b ni-notes">{notes}</div>}
    </>
  )
}

const PR_URL_RE = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)$/

/** A review's pull requests: its `prs`, else its one `url` when that is a pull request. */
const reviewPrLinks = (item: Item): string[] => (item.prs?.length ? item.prs : item.url && PR_URL_RE.test(item.url) ? [item.url] : [])

/** "PR #181" when every link is in one repository, "workspace-skills #64" when they span several. */
function prLinkLabel(url: string, all: string[]): string {
  const match = PR_URL_RE.exec(url)
  if (!match) return 'Open link'
  const repos = new Set(all.map(link => PR_URL_RE.exec(link)?.[1].toLowerCase()))
  return repos.size > 1 ? `${match[1].split('/')[1]} #${match[2]}` : `PR #${match[2]}`
}

function ReviewBody({ item, onSettled }: { item: Item; onSettled: () => void }) {
  const verdicts = item.verdicts ?? []
  const prs = reviewPrLinks(item)
  const merged = item.prsMerged ?? 0
  const allMerged = prs.length > 0 && merged >= prs.length
  return (
    <>
      <div className="ni-b">
        {item.ownerSummary && <p className="ni-owner" data-owner-summary>{item.ownerSummary}</p>}
        {item.ask && <p className="ni-ask" data-ask><b>{item.ask}</b></p>}
        {prs.length > 0 && (
          <p className="ni-prs" data-review-prs>
            {prs.map(url => <a className="hub-btn" key={url} href={url} target="_blank" rel="noopener noreferrer" data-review-pr>{prLinkLabel(url, prs)}</a>)}
          </p>
        )}
        <div className="ni-chips">
          {allMerged && <span className="ni-chip pass" data-merged="all">Merged</span>}
          {!allMerged && merged > 0 && <span className="ni-chip" data-merged="part">{merged} of {prs.length} merged</span>}
          {verdicts.map(verdict => <span key={verdict.leg} className={`ni-chip ${verdict.result}`} data-verdict={verdict.leg}>{VERDICT_LEG[verdict.leg]} {verdict.result}</span>)}
          {!!item.shots && <span className="ni-chip">{item.shots} {item.shots === 1 ? 'screenshot' : 'screenshots'}</span>}
          {!verdicts.length && !item.shots && !allMerged && (prs.length > 0 || !!item.url) && <span className="hub-muted">No results were attached. CI and the review are on the PR.</span>}
        </div>
      </div>
      <div className="ni-a">
        <ReviewActions item={item} onDone={onSettled} primary={nothingToDo(item.ask) || prs.length === 0} />
        <a className="hub-btn" href={reviewHash(item.id)} data-review-open>Details</a>
      </div>
    </>
  )
}

/**
 * One card of the Needs you list: who is asking, the four cells, and the body and actions for its kind, so an item is
 * answered where it stands. `onSettled` runs after every successful action that takes the item off the queue.
 */
export default function NeedsItem({ item, at, reload, onSettled, leaving = false, names = null, filter = 'all' }: {
  item: Item
  /** When the list last arrived: a checklist body keeps its own newer tick answer until then. */
  at: Date | null
  reload: () => void
  onSettled: (item: Item, verb: SettleVerb, extra?: SettleExtra) => void
  leaving?: boolean
  /** Display names of the projects, by id. */
  names?: ProjectNames | null
  /** The kind chip the list is on: the project chip's link keeps it. */
  filter?: string
}) {
  const kind = needsKind(item)
  const needsDetail = !item.detail && (item.kind === 'ask' || item.kind === 'checklist')
  const fetched = useHubData<Ask | Checklist>(needsDetail ? `/${item.kind === 'ask' ? 'asks' : 'checklists'}/${encodeURIComponent(item.id)}` : null)
  const detail = item.detail ?? fetched.data
  const info = item.describe
  const page = itemPage(item)
  const link = safeUrl(page)
  const key = itemKey(item)
  // An approval is a signed request: chat does not sit between the owner and a signature. Unstick is a blocked event.
  const helpKind = item.kind === 'ask' || item.kind === 'checklist' || item.kind === 'review' || item.kind === 'blocked' ? item.kind : null
  const help: HelpTarget | null = helpKind && kind !== 'approval' ? { kind: helpKind, id: item.id, label: KIND_LABEL[kind].toLowerCase(), title: item.title } : null
  const notUseful = useNotUseful(item, () => onSettled(item, 'not-useful', { detail: 'Filed for the sprint' }))
  const who = info?.who || item.host || ''
  const meta = metaParts({ project: item.project, who, asked: `asked ${ago(item.at)}`, bead: item.bead, names })
  const cells: [string, string | undefined][] = [['What', info?.what], ['State', info?.state], ['Next action', info?.next], ['Blocker', info?.blocker]]

  return (
    <div className={`ni${leaving ? ' leaving' : ''}`} data-need={key} data-kind={kind} aria-hidden={leaving ? true : undefined}>
      <article className="ni-card" aria-labelledby={`ni-${key}`}>
        <header className="ni-h">
          <span className="kind"><Icon paths={KIND_ICON[kind]} /></span>
          <div className="ni-hm">
            <h3 className="ni-t" id={`ni-${key}`} tabIndex={-1}>{page ? <a href={page}>{item.title}</a> : item.title}</h3>
            <div className="ni-meta"><NeedBadges item={item} />{meta.map(part => part.kind === 'project' ? <ProjectChip key="project" id={part.id} names={names} filter={filter} /> : <span key={part.text}>{part.text}</span>)}</div>
          </div>
          {(help || notUseful.button) && <div className="ni-ha">{help && <GetHelp target={help} />}{notUseful.button}</div>}
        </header>
        {notUseful.panel}
        {info && (
          <dl className="four" data-four>
            {cells.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
          </dl>
        )}
        {item.kind === 'ask' && (detail
          ? <div className="ni-b"><AskBody ask={detail as Ask} reload={reload} onSettled={(verb, said) => onSettled(item, verb, said ? { detail: said } : undefined)} /></div>
          : <div className="ni-b"><p className="hub-muted">{fetched.error ?? 'Loading…'}</p>{link && <a className="hub-btn" href={link}>Open</a>}</div>)}
        {item.kind === 'checklist' && (detail
          ? <div className="ni-b"><ChecklistBody data={detail as Checklist} loadedAt={at} reload={reload} onSubmitted={() => onSettled(item, kind === 'playtest' ? 'reported' : 'submitted')} /></div>
          : <div className="ni-b"><p className="hub-muted">{fetched.error ?? 'Loading…'}</p></div>)}
        {item.kind === 'approval' && <ApprovalBody id={item.id} onSettled={verb => onSettled(item, verb)} />}
        {item.kind === 'review' && <ReviewBody item={item} onSettled={() => onSettled(item, 'done')} />}
        {item.kind === 'blocked' && <BlockedBody item={item} onSettled={() => onSettled(item, 'done')} />}
        {item.kind === 'hermes-approval' && <HermesApprovalView item={item} onSettled={(verb, extra) => onSettled(item, verb, extra)} />}
        {item.kind === 'run-question' && <RunQuestionView item={item} onSettled={(verb, extra) => onSettled(item, verb, extra)} />}
        {item.kind === 'pc-stuck' && <PcStuckView item={item} onSettled={(verb, extra) => onSettled(item, verb, extra)} />}
      </article>
    </div>
  )
}
