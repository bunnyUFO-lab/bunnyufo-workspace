import { useState, type MouseEvent } from 'react'
import type { HubProject, Item, MapCard, MapTask, ProgressMap as MapModel, Sign } from '../lib/hub'
import { safeUrl } from '../lib/hub'
import { hubHash, mapHash, projectAtHash, workAtHash } from '../lib/route'
import { swap } from '../lib/entries'
import { useHasMapRoom } from '../lib/chrome'
import { useScope } from '../lib/useScope'
import TaskWindow from './TaskWindow'
import ItemRow from './ItemRow'
import { SIGN_GLYPH, SIGN_LABEL } from './signs'
import { useHubData } from './useHub'
import { SIGN_WORDS, STATE_COLOR, STATE_LABEL, find, sprintLines, tasksOf, type Found } from './mapState'
import MarkActions from './MarkActions'
import QuestionActions from './QuestionActions'
import BeadWork from './BeadWork'
import SprintPanel from './SprintPanel'
import { visible as beadWorkVisible } from './beadActions'
import { host } from '../lib/host'
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
          {task.state === 'you' && hasNeedsItem(task, inboxBeads) && <a className="hub-btn pri" href={task.ask ? hubHash('ask', task.ask) : hubHash('needs', 'all')}>Open in Needs you</a>}
        </li>
      ))}
    </ul>
  )
}

/** A plain click follows the link by replacing the window's entry, so Back returns to the screen the window was over; Ctrl, Cmd, Shift and a middle click are the browser's own. */
function showClick(event: MouseEvent<HTMLAnchorElement>, href: string) {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
  event.preventDefault()
  swap(href)
}

/** Where this node can be shown: its row on the Roadmap, its card on the Work board (a task with a real id), and the Map when there is room for one. */
function ShowLinks({ model, id, task, board, onMap }: { model: MapModel; id: string; task: boolean; board?: string; onMap: boolean }) {
  const { sprint } = useScope()
  const mapRoom = useHasMapRoom()
  const roadmap = projectAtHash(model.project, id, sprint)
  const work = task && !id.includes('~') ? workAtHash(board ?? model.project, id, sprint) : null
  const map = mapRoom && !onMap ? mapHash(model.project, id, sprint) : null
  return (
    <p className="hub-map-panel-roadmap" data-show-links>
      <a href={roadmap} onClick={event => showClick(event, roadmap)} data-show-on-roadmap>Show on roadmap</a>
      {work && <a href={work} onClick={event => showClick(event, work)} data-show-on-work>Show on Work board</a>}
      {map && <a href={map} onClick={event => showClick(event, map)} data-show-on-map>Show on map</a>}
    </p>
  )
}

/**
 * The details of one milestone, feature or task: a window centred over the dimmed screen from 900 px, a bottom sheet below (TaskWindow). It
 * is modal, so the screen behind does not move. It only reads and links; the model decides what it shows. `board` is the Work board the
 * node was opened from (an All board stays on All); `onMap` is set on the Map, which needs no link to itself.
 */
export default function MapPanel({ model, nodeId, onClose, onOpen, hiddenBy, board, onMap = false }: { model: MapModel; nodeId: string; onClose: () => void; onOpen: (id: string) => void; board?: string; onMap?: boolean; /** Set when the Roadmap's filter hides this node: what the filter is, and how to show everything. */ hiddenBy?: { filter: string; onShowAll: () => void } }) {
  const found = find(model, nodeId)
  // What waits on you for this node's tasks (open Asks, reviews, blocked sessions), once per panel.
  const { data: inbox } = useHubData<{ items: Item[] }>('/inbox?filter=needs-you')
  // A refusal from the Hub, kept with the node it was for so it does not follow the owner to another one.
  const [markFailure, setMarkFailure] = useState<{ id: string; message: string }>({ id: '', message: '' })
  const { data: projects } = useHubData<{ projects: HubProject[] }>('/projects')

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
  const more = elsewhere > 0 && <p className="hub-muted"><a href={hubHash('needs', 'all')}>{elsewhere} more for this project in Needs you</a></p>

  let body
  if (found.kind === 't') {
    const { task } = found
    const all = model.milestones.flatMap(milestone => milestone.features.flatMap(feature => feature.tasks))
    const nameOf = (id: string) => all.find(item => item.id === id)?.title ?? id
    const unlocks = all.filter(other => other.deps.includes(task.id)).map(other => other.title)
    const resolving = model.wayfinder?.open.find(item => item.id === task.id)
    const closed = closedLine(task)
    const words = task.signs.map(sign => (sign in SIGN_WORDS ? SIGN_WORDS[sign as keyof typeof SIGN_WORDS] : SIGN_LABEL[sign].toLowerCase()))
    body = (
      <>
        {(task.state === 'you' || task.mark) && (
          <div className="hub-map-panel-needed" data-whats-needed>
            <h4>What&apos;s needed</h4>
            {task.ask
              ? <div className="hub-actions start"><a className="hub-btn pri" href={hubHash('ask', task.ask)} data-needed-link="ask">Open the Ask</a></div>
              : task.checklist
                ? <div className="hub-actions start"><a className="hub-btn pri" href={hubHash('checklist', task.checklist)} data-needed-link="checklist">Open the checklist</a></div>
                : hasNeedsItem(task, inboxBeads)
                  ? <div className="hub-actions start"><a className="hub-btn pri" href={hubHash('needs', 'all')} data-needed-link="needs">Open in Needs you</a></div>
                  : task.state === 'you' && <p className="hub-map-panel-nothing" data-nothing-asked><span aria-hidden="true">⚠</span> Nothing asked yet: no Ask or checklist says what you need to do.</p>}
            <MarkActions
              task={task} title={task.title} project={model.project} projectName={projects?.projects.find(item => item.id === model.project)?.name ?? model.project}
              eligible={task.state !== 'done'} waiting={task.state === 'you'} error={markFailure.id === nodeId ? markFailure.message : ''} onError={message => setMarkFailure({ id: nodeId, message })}
            />
          </div>
        )}
        <Summary text={task.summary} show />
        {resolving && model.wayfinder && (
          <div className="hub-map-panel-resolve" data-resolve>
            <h4>Resolve</h4>
            <QuestionActions project={model.project} repoName={projects?.projects.find(item => item.id === model.project)?.name ?? model.project} wayfinder={model.wayfinder} item={resolving} layout="sheet" />
          </div>
        )}
        {(beadWorkVisible(task, resolving, host.write) || (host.write && !resolving && task.run)) && <BeadWork key={task.id} task={task} project={model.project} />}
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
        {/* Any other open task: Mark done and No longer needed (the PC applies them within minutes). Unblock is only for a task that waits on you. */}
        {!(task.state === 'you' || task.mark) && task.state !== 'done' && (
          <div className="hub-map-panel-needed" data-mark-open>
            <MarkActions
              task={task} title={task.title} project={model.project} projectName={projects?.projects.find(item => item.id === model.project)?.name ?? model.project}
              eligible waiting={false} error={markFailure.id === nodeId ? markFailure.message : ''} onError={message => setMarkFailure({ id: nodeId, message })}
            />
          </div>
        )}
        {!(task.state === 'you' || task.mark) && task.state === 'done' && markFailure.id === nodeId && markFailure.message && <p className="hub-error" role="alert">{markFailure.message}</p>}
      </>
    )
  } else {
    const counts = SIGN_ORDER.map(([sign, word]) => ({ sign, word, count: tasks.filter(task => task.signs.includes(sign)).length })).filter(item => item.count > 0)
    const node = found.kind === 'm' ? found.milestone : found.feature
    body = (
      <>
        <Summary text={node.summary} show={!synthetic} />
        <Library cards={node.cards} />
        {found.kind === 'm' && <SprintPanel project={model.project} milestone={found.milestone} />}
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
              <h5>{feature.id.endsWith('~other') || feature.id.includes('~') ? 'Not in a feature' : <button type="button" className="hub-map-panel-link" onClick={() => onOpen(feature.id)} data-open-feature={feature.id}>{feature.title}</button>}</h5>
              <TaskRows tasks={feature.tasks} onOpen={onOpen} inboxBeads={inboxBeads} />
            </section>
          ))
          : tasks.length > 0 && <TaskRows tasks={tasks} onOpen={onOpen} inboxBeads={inboxBeads} />}
      </>
    )
  }

  const sprintNames = found.kind === 't' ? found.task.sprints : [...new Set(tasks.flatMap(task => task.sprints))]
  const status = (
    <div className="hub-muted" data-sheet-status>
      {!synthetic && <><span className="hub-id">{idOf(found)}</span>{' · '}</>}
      <span style={{ color: STATE_COLOR[state] }}>{STATE_LABEL[state]}</span>
      {found.kind !== 't' && ` · ${tasks.length ? `${done} of ${tasks.length} tasks done` : 'No tasks yet'}`}
      {sprintNames.length > 0 && ` · ${sprintNames.length === 1 ? 'Sprint' : 'Sprints'}: ${sprintNames.join(', ')}`}
    </div>
  )
  return (
    <TaskWindow title={titleOf(found)} status={status} switchKey={nodeId} onClose={onClose}>
      <ShowLinks model={model} id={idOf(found)} task={found.kind === 't'} board={board} onMap={onMap} />
      {hiddenBy && (
        <p className="hub-muted hub-map-panel-hidden" data-hidden-by-filter>Hidden by your filter ({hiddenBy.filter}) · <button type="button" className="hub-link-btn" onClick={hiddenBy.onShowAll}>Show all</button></p>
      )}
      {body}
    </TaskWindow>
  )
}
