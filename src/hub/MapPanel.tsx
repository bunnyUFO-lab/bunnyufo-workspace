import { useEffect, useRef } from 'react'
import type { Item, MapCard, MapTask, ProgressMap as MapModel, Sign } from '../lib/hub'
import { safeUrl } from '../lib/hub'
import { hubHash } from '../lib/route'
import ItemRow from './ItemRow'
import { SIGN_GLYPH, SIGN_LABEL } from './signs'
import { useHubData } from './useHub'
import { SIGN_WORDS, STATE_COLOR, STATE_LABEL, find, sprintLines, tasksOf, type Found } from './mapState'
import { cardHref, closedLine, finishedLine, hasNeedsItem, noPrs, prLabel, sheetPrs, type SheetPr } from './mapSheet'

/** The signs in the legend's order, with the short word the panel counts them under. */
const SIGN_ORDER: [Sign, string][] = [
  ['working', 'working'], ['idle', 'idle'], ['new', 'not started'], ['pr', 'PR open'], ['ci-failed', 'CI failing'], ['review', 'waiting for review'], ['deployed', 'deployed'],
]

const titleOf = (found: Found) => (found.kind === 'm' ? found.milestone.title : found.kind === 'f' ? found.feature.title : found.task.title)
const idOf = (found: Found) => (found.kind === 'm' ? found.milestone.id : found.kind === 'f' ? found.feature.id : found.task.id)
const stateOf = (found: Found) => (found.kind === 'm' ? found.milestone.state : found.kind === 'f' ? found.feature.state : found.task.state)

function SignGlyphs({ signs }: { signs: Sign[] }) {
  return (
    <>
      {signs.map(sign => <span key={sign} className="hub-map-panel-sign" role="img" title={SIGN_LABEL[sign]} aria-label={SIGN_LABEL[sign]}>{SIGN_GLYPH[sign]}</span>)}
    </>
  )
}

function Summary({ text, show }: { text?: string; show: boolean }) {
  if (text) return <p className="hub-map-panel-summary" data-summary>{text}</p>
  return show ? <p className="hub-muted" data-summary>No description yet.</p> : null
}

function Library({ cards }: { cards?: MapCard[] }) {
  const rows = (cards ?? []).map(card => ({ card, href: cardHref(card) })).filter(row => row.href)
  if (!rows.length) return null
  return (
    <>
      <h4>Library</h4>
      <ul className="hub-map-panel-list plain hub-map-panel-cards" data-cards>
        {rows.map(({ card, href }) => <li key={href}><a href={href}>{card.title}</a></li>)}
      </ul>
    </>
  )
}

function PrList({ rows, showTask, empty }: { rows: SheetPr[]; showTask: boolean; empty: string }) {
  if (!rows.length) return <p className="hub-muted">{empty}</p>
  return (
    <ul className="hub-map-panel-list" data-prs>
      {rows.map(({ task, pr }, k) => {
        const url = safeUrl(pr.url)
        return (
          <li key={`${task.id}-${k}`}>
            {showTask && <span className="hub-map-panel-row-title">{task.title}</span>}
            <span className="hub-map-panel-pr" data-pr-state={pr.state}>{prLabel(pr, Boolean(url))}</span>
            {url && <a className="hub-btn" href={url} target="_blank" rel="noopener noreferrer">Open PR</a>}
          </li>
        )
      })}
    </ul>
  )
}

function TaskRows({ tasks, onOpen, inboxBeads }: { tasks: MapTask[]; onOpen: (id: string) => void; inboxBeads: ReadonlySet<string> }) {
  return (
    <ul className="hub-map-panel-list">
      {tasks.map(task => (
        <li key={task.id} className={task.state === 'done' || task.state === 'later' ? 'dim' : undefined} data-state={task.state}>
          <i className="hub-map-panel-dot" style={{ background: STATE_COLOR[task.state] }} title={STATE_LABEL[task.state]} />
          <button type="button" className="hub-map-panel-link hub-map-panel-row-title" onClick={() => onOpen(task.id)}>{task.title}</button>
          <span className="hub-id">{task.id}</span>
          <SignGlyphs signs={task.signs} />
          {task.state === 'you' && hasNeedsItem(task, inboxBeads) && <a className="hub-btn pri" href={task.ask ? hubHash('ask', task.ask) : hubHash('needs')}>Open in Needs you</a>}
        </li>
      ))}
    </ul>
  )
}

/**
 * The details of one milestone, feature or task: a side panel on a desktop, a bottom sheet on a
 * phone (hub.css). A non-modal dialog, so the map behind it stays usable and App's Escape, which
 * leaves an open dialog alone, does not also fire. It only reads and links; the model decides what it shows.
 */
export default function MapPanel({ model, nodeId, onClose, onOpen }: { model: MapModel; nodeId: string; onClose: () => void; onOpen: (id: string) => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const found = find(model, nodeId)
  // What waits on you for this node's tasks (open Asks, reviews, blocked sessions), once per panel.
  const { data: inbox } = useHubData<{ items: Item[] }>('/inbox?filter=needs-you')

  useEffect(() => {
    const element = dialog.current
    if (element && !element.open) element.show()
  }, [])
  // The title takes the focus on open and on every switch, so a screen reader reads the new node.
  useEffect(() => { heading.current?.focus({ preventScroll: true }) }, [nodeId])
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  if (!found) return null
  const tasks = tasksOf(found)
  const state = stateOf(found)
  const synthetic = idOf(found).includes('~')
  const done = tasks.filter(task => task.state === 'done').length
  const sprints = sprintLines(model, found)
  const prs = sheetPrs(tasks)
  const inboxBeads = new Set((inbox?.items ?? []).flatMap(item => (item.bead ? [item.bead] : [])))
  const noun = found.kind === 'm' ? 'milestone' : 'feature'
  const ids = new Set(tasks.map(task => task.id))
  const mine = (inbox?.items ?? []).filter(item => item.bead && ids.has(item.bead))
  const elsewhere = (inbox?.items ?? []).filter(item => item.project === model.project && !(item.bead && ids.has(item.bead))).length
  const needsYou = mine.length > 0 && (
    <>
      <h4>Needs you</h4>
      {mine.map(item => <ItemRow key={`${item.kind}-${item.id}`} item={item} />)}
    </>
  )
  const more = elsewhere > 0 && <p className="hub-muted"><a href={hubHash('needs')}>{elsewhere} more for this project in Needs you</a></p>

  let body
  if (found.kind === 't') {
    const { task } = found
    const all = model.milestones.flatMap(milestone => milestone.features.flatMap(feature => feature.tasks))
    const nameOf = (id: string) => all.find(item => item.id === id)?.title ?? id
    const unlocks = all.filter(other => other.deps.includes(task.id)).map(other => other.title)
    const closed = closedLine(task)
    const words = task.signs.map(sign => (sign in SIGN_WORDS ? SIGN_WORDS[sign as keyof typeof SIGN_WORDS] : SIGN_LABEL[sign].toLowerCase()))
    body = (
      <>
        <Summary text={task.summary} show />
        {words.length > 0 && <p className="hub-muted">{words.join(' · ')}</p>}
        {task.deps.length > 0 && <p className="hub-muted">Needs first: {task.deps.map(nameOf).join(', ')}</p>}
        {unlocks.length > 0 && <p className="hub-muted">Unlocks: {unlocks.join(', ')}</p>}
        {task.sprints.length > 0 && <p className="hub-muted">Sprint: {task.sprints.join(', ')}</p>}
        <Library cards={task.cards} />
        {needsYou}
        {more}
        <h4>Pull requests</h4>
        <PrList rows={prs} showTask={false} empty={noPrs(task.state === 'done')} />
        {task.commits && task.commits.length > 0 && (
          <p className="hub-muted" data-commits>Commits: {task.commits.map((commit, k) => {
            const url = safeUrl(commit.url)
            return <span key={commit.sha}>{k > 0 && ', '}{url ? <a href={url} target="_blank" rel="noopener noreferrer">{commit.sha.slice(0, 8)}</a> : commit.sha.slice(0, 8)}</span>
          })}</p>
        )}
        {closed && <p className="hub-muted" data-closed>{closed}</p>}
        {task.state === 'you' && hasNeedsItem(task, inboxBeads) && <div className="hub-actions start"><a className="hub-btn pri" href={task.ask ? hubHash('ask', task.ask) : hubHash('needs')}>Open in Needs you</a></div>}
      </>
    )
  } else {
    const counts = SIGN_ORDER.map(([sign, word]) => ({ sign, word, count: tasks.filter(task => task.signs.includes(sign)).length })).filter(item => item.count > 0)
    const node = found.kind === 'm' ? found.milestone : found.feature
    body = (
      <>
        <Summary text={node.summary} show={!synthetic} />
        <Library cards={node.cards} />
        <h4>Sprint</h4>
        {sprints.length ? <ul className="hub-map-panel-list plain">{sprints.map(line => <li key={line}>{line}</li>)}</ul> : <p className="hub-muted">Not in a sprint.</p>}
        <h4>Signs</h4>
        {counts.length ? <ul className="hub-map-panel-list plain">{counts.map(item => <li key={item.sign}><span aria-hidden="true">{SIGN_GLYPH[item.sign]}</span> {item.count} {item.word}</li>)}</ul> : <p className="hub-muted">{state === 'done' ? finishedLine(node.closedAt) : 'No sessions, PRs or deploys yet.'}</p>}
        {needsYou}
        {more}
        <h4>Pull requests</h4>
        <PrList rows={prs} showTask empty={noPrs(state === 'done')} />
        <h4>Tasks</h4>
        {!tasks.length && <p className="hub-muted">No tasks in this {noun} yet.</p>}
        {found.kind === 'm'
          ? found.milestone.features.filter(feature => feature.tasks.length).map(feature => (
            <section key={feature.id} className="hub-map-panel-group">
              <h5>{feature.id.endsWith('~other') ? 'Not in a feature' : feature.title}</h5>
              <TaskRows tasks={feature.tasks} onOpen={onOpen} inboxBeads={inboxBeads} />
            </section>
          ))
          : tasks.length > 0 && <TaskRows tasks={tasks} onOpen={onOpen} inboxBeads={inboxBeads} />}
      </>
    )
  }

  return (
    <>
      <div className="hub-map-scrim" onClick={onClose} aria-hidden="true" />
      <dialog ref={dialog} id="hub-map-panel" className="hub-map-panel" aria-labelledby="hub-map-panel-title">
        <div className="hub-map-grab" aria-hidden="true" />
        <div className="hub-map-panel-head">
          <div className="hub-map-panel-heading">
            <h3 id="hub-map-panel-title" ref={heading} tabIndex={-1}>{titleOf(found)}</h3>
            <div className="hub-muted">
              {!synthetic && <><span className="hub-id">{idOf(found)}</span>{' · '}</>}
              <span style={{ color: STATE_COLOR[state] }}>{STATE_LABEL[state]}</span>
              {found.kind !== 't' && ` · ${done} of ${tasks.length} tasks done`}
            </div>
          </div>
          <button type="button" className="hub-map-panel-close" aria-label="Close details" onClick={onClose}>×</button>
        </div>
        {body}
      </dialog>
    </>
  )
}
