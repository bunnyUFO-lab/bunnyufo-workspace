import { useState } from 'react'
import type { Ask, AskAnswer } from '../lib/hub'
import { hubHash } from '../lib/route'
import { takeHandoff } from './flash'
import NextNote from './NextNote'
import { autoNext, goNext, useQueueOrder } from './useGoNext'
import SettledBar, { useSettledHere } from './SettledBar'
import AskBody from './AskBody'
import { VERDICTS, decisionList, optionList, text, when } from './askAnswer'
import HubImage from './HubImage'
import RefreshNote from './RefreshNote'
import { useHubData } from './useHub'
import GetHelp, { HelpAttachedNote } from './GetHelp'
import Delivery from './Delivery'
import { needsHash } from './needsFocus'
import { PageProjectChip } from './ProjectChip'
import NeedBadges from './NeedBadges'

const STEPS: [string, string][] = [['open', 'Open'], ['answered', 'Answered'], ['picked-up', 'Picked up']]
const SIDE: Record<string, string> = { snoozed: 'Snoozed', expired: 'Expired', cancelled: 'Cancelled' }

function AnswerSummary({ ask, answer }: { ask: Ask; answer: AskAnswer }) {
  const option = optionList(ask)?.find(item => item.id === answer.choice)
  return (
    <section className="hub-panel hub-answer" aria-label="The answer">
      <h3>Answer <span>by {text(answer.by) || 'someone'}{answer.via === 'discord' ? ' via Discord' : ''}, {when(answer.at)}</span></h3>
      {decisionList(ask).length > 0 && answer.decisions && (
        <ul className="dr-summary" data-decisions-answer>
          {decisionList(ask).map(item => {
            const given = answer.decisions?.[item.id]
            return given && <li key={item.id}><b>{VERDICTS.find(([verdict]) => verdict === given.verdict)?.[1] ?? text(given.verdict)}</b> · {text(item.text)}{text(given.note) ? ` (${text(given.note)})` : ''}</li>
          })}
        </ul>
      )}
      {answer.choice && <p><b>{option ? `${option.id} · ${text(option.label)}` : text(answer.choice)}</b></p>}
      {typeof answer.note === 'string' && answer.note && <p className="hub-note-text">{answer.note}</p>}
      <HelpAttachedNote chat={answer.help?.chat} />
      {Array.isArray(answer.pictures) && answer.pictures.length > 0 && (
        <div className="hub-tray" data-answer-pictures>
          {answer.pictures.map((name, index) => <span className="hub-tray-item" key={name}><HubImage path={`asks/${ask.id}/${name}`} alt={`Picture ${index + 1} sent with the answer`} open /></span>)}
        </div>
      )}
      {answer.drawing && <HubImage className="hub-drawing" path={`asks/${ask.id}/${answer.drawing.png}`} alt="The drawing sent with the answer" />}
    </section>
  )
}

/** One Ask on its own page: its state, the shared answer body, and what became of it. */
export default function AskView({ id }: { id: string }) {
  const { data: ask, error, reload, at } = useHubData<Ask>(`/asks/${encodeURIComponent(id)}`)
  const [taken, setTaken] = useState<AskAnswer | null>(null)
  const [handoff] = useState(takeHandoff)
  const queue = useQueueOrder()
  const here = useSettledHere(`ask-${id}`)

  if (!ask) return <p className="hub-empty">{error ?? 'Loading…'}</p>
  const from = { tool: text(ask.from?.tool), host: text(ask.from?.host) }
  const stepIndex = STEPS.findIndex(([key]) => key === (ask.state === 'snoozed' ? 'open' : ask.state))
  const answer = ask.answer ?? taken
  const isPlan = Array.isArray(ask.changes) && ask.changes.length > 0

  return (
    <>
      <RefreshNote error={error} hasData at={at} />
      {handoff && <NextNote note={handoff} />}
      <div className="hub-top">
        <h2>{text(ask.question)}</h2>
        <span><PageProjectChip id={text(ask.project)} />{text(ask.bead) && <> <span className="hub-pill">{text(ask.bead)}</span></>} <span className="nb-inline" data-page-badges><NeedBadges item={{ kind: 'ask', id: ask.id, title: ask.question, at: ask.createdAt, design: !!(ask.decisions || ask.image) || undefined, subtype: ask.subtype, kindInferred: ask.kindInferred }} /></span></span>
        <GetHelp className="hub-top-help" target={{ kind: 'ask', id: ask.id, label: ask.decisions || ask.image ? 'design review' : 'question', title: text(ask.question) }} />
      </div>
      <ol className="hub-steps" aria-label="State">
        {STEPS.map(([key, label], index) => (
          <li key={key} className={index < stepIndex ? 'past' : index === stepIndex ? 'on' : ''} aria-current={index === stepIndex ? 'step' : undefined}>{label}</li>
        ))}
        {ask.requirePasskey === true && <li className="tag" title="This Ask is answered in the Hub with a passkey, never from Discord">Passkey only</li>}
        {ask.rerun && typeof ask.rerun === 'object' && !ask.rerunBlocked && <li className="tag" title="Answering this Ask runs the work again on the Gaming PC">Runs again</li>}
        {Array.isArray(ask.rerun?.allow) && ask.rerun.allow.length > 0 && !ask.rerunBlocked && <li className="tag" title="The Allow option adds these rules to the project's PC allow list">Allows on PC</li>}
        {ask.agentEdit && typeof ask.agentEdit === 'object' && <li className="tag" data-agent-edit-tag title={ask.agentEdit.op === 'profile' ? 'Applying this Ask changes the model a Hermes profile runs on' : 'Applying this Ask changes the text a chat with an agent starts from'}>{ask.agentEdit.op === 'profile' ? 'Changes a model' : 'Changes a persona'}</li>}
        {SIDE[ask.state] && <li className="side on">{SIDE[ask.state]}{ask.state === 'snoozed' && ask.snoozedUntil ? ` until ${when(ask.snoozedUntil)}` : ''}</li>}
      </ol>
      {ask.rerunBlocked && <p className="hub-muted" role="note" data-rerun-blocked>This Ask asks to run something again. Answering it starts nothing: {text(ask.rerunBlocked)}</p>}
      {ask.agentEditBlocked && <p className="hub-muted" role="note" data-agent-edit-blocked>This Ask proposes an edit. Answering it changes nothing: {text(ask.agentEditBlocked)}</p>}
      <SettledBar itemKey={`ask-${ask.id}`} kind="ask" id={ask.id} title={text(ask.question)} verb={here.verb} phase={here.phase} backHash={hubHash('ask', ask.id)} order={here.order} />
      {/* Kept mounted while the answer is held, so Undo finds the form as it was left. */}
      <section className="hub-panel" hidden={here.covered}>
        <p className="hub-muted">{from.tool || from.host ? `From ${from.tool || 'an agent'}${from.host ? ` on ${from.host}` : ''}, ` : 'From an unknown sender, '}{when(ask.createdAt)}.</p>
        <AskBody ask={ask} reload={reload} onTaken={setTaken} onSettled={(verb, detail) => { here.settle(verb, queue()); if (autoNext()) void goNext({ kind: 'ask', id: ask.id, title: ask.question }, verb, queue(), hubHash('ask', ask.id), detail) }} view />
      </section>
      {answer && <AnswerSummary ask={ask} answer={answer} />}
      {answer && isPlan && !ask.pickup && !ask.cancel && <p className="hub-muted" data-plan-state="waiting">Approved. It&apos;s applied within a minute or two, and the PC doesn&apos;t need to be on.</p>}
      {answer && ask.delivery && !isPlan && !ask.pickup && <Delivery noun="Ask" project={ask.project} delivery={ask.delivery} />}
      {ask.pickup && isPlan && <p className="hub-muted" data-plan-state="applied">Applied {when(ask.pickup.at)}.</p>}
      {ask.pickup && !isPlan && <p className="hub-muted">Picked up {when(ask.pickup.at)}{text(ask.pickup.host) ? ` on ${text(ask.pickup.host)}` : ''}{text(ask.pickup.bead) ? ` as ${text(ask.pickup.bead)}` : ''}.</p>}
      <p><a className="hub-btn" href={needsHash()}>Back to Needs you</a></p>
    </>
  )
}
