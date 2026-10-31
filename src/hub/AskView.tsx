import { useState } from 'react'
import { ago, type Ask, type AskAnswer, type AskDelivery } from '../lib/hub'
import { hubHash } from '../lib/route'
import { takeHandoff } from './flash'
import NextNote from './NextNote'
import { goNext, useQueueOrder } from './useGoNext'
import AskBody from './AskBody'
import { VERDICTS, decisionList, optionList, text, when } from './askAnswer'
import HubImage from './HubImage'
import { useHubData } from './useHub'
import GetHelp, { HelpAttachedNote } from './GetHelp'

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
      {answer.drawing && <HubImage className="hub-drawing" path={`asks/${ask.id}/${answer.drawing.png}`} alt="The drawing sent with the answer" />}
    </section>
  )
}

const HOW: Record<string, string> = {
  woke: 'woke it',
  turn: 'during its work',
  'next-session': "at the next session's start",
  start: "at the next session's start",
  prompt: 'when you typed',
}

/** Where the answer went, as the session's own mod reported it ("reported by <host>": these files are not the owner's). */
function Delivery({ ask, delivery }: { ask: Ask; delivery: AskDelivery }) {
  const folder = text(delivery.folder) || 'an agent session'
  const host = text(delivery.host)
  const on = host ? ` on ${host}` : ''
  const link = text(delivery.appUrl) || text(delivery.url)
  let body
  if (delivery.state === 'delivered') {
    body = <>Reached session {folder}{on} {typeof delivery.at === 'string' ? ago(delivery.at) : ''}: {HOW[delivery.how ?? ''] ?? 'delivered'}.</>
  } else if (delivery.state === 'watching') {
    body = <>Session {folder}{on} is watching; it checks every minute.{link && <> <a className="hub-btn" href={link} data-delivery-open>Open the session</a></>}</>
  } else if (delivery.state === 'stale') {
    body = <>Not delivered after {delivery.minutes ?? 0} minutes. The session may be closed. Open it, or start a session in {folder}: it gets the answer at its start.{link && <> <a className="hub-btn" href={link} data-delivery-open>Open the session</a></>}</>
  } else {
    body = <>No session is watching this Ask. The next session in project {text(ask.project)} gets it when it starts.</>
  }
  return <p className="hub-muted hub-delivery" data-delivery={delivery.state} title="Reported by the session's computer, not by you">{body}{host && delivery.state !== 'none' && <span className="hub-delivery-by"> (reported by {host})</span>}</p>
}

/** One Ask on its own page: its state, the shared answer body, and what became of it. */
export default function AskView({ id }: { id: string }) {
  const { data: ask, error, reload } = useHubData<Ask>(`/asks/${encodeURIComponent(id)}`)
  const [taken, setTaken] = useState<AskAnswer | null>(null)
  const [handoff] = useState(takeHandoff)
  const queue = useQueueOrder()

  if (!ask) return <p className="hub-empty">{error ?? 'Loading…'}</p>
  const from = { tool: text(ask.from?.tool), host: text(ask.from?.host) }
  const stepIndex = STEPS.findIndex(([key]) => key === (ask.state === 'snoozed' ? 'open' : ask.state))
  const answer = ask.answer ?? taken

  return (
    <>
      {handoff && <NextNote note={handoff} />}
      <div className="hub-top">
        <h2>{text(ask.question)}</h2>
        <span><span className="hub-pill">{text(ask.project)}</span>{text(ask.bead) && <> <span className="hub-pill">{text(ask.bead)}</span></>}</span>
        <GetHelp className="hub-top-help" target={{ kind: 'ask', id: ask.id, label: ask.decisions || ask.image ? 'design review' : 'question', title: text(ask.question) }} />
      </div>
      <ol className="hub-steps" aria-label="State">
        {STEPS.map(([key, label], index) => (
          <li key={key} className={index < stepIndex ? 'past' : index === stepIndex ? 'on' : ''} aria-current={index === stepIndex ? 'step' : undefined}>{label}</li>
        ))}
        {ask.requirePasskey === true && <li className="tag" title="This Ask is answered in the Hub with a passkey, never from Discord">Passkey only</li>}
        {ask.rerun && typeof ask.rerun === 'object' && <li className="tag" title="Answering this Ask runs the work again on the Gaming PC">Runs again</li>}
        {SIDE[ask.state] && <li className="side on">{SIDE[ask.state]}{ask.state === 'snoozed' && ask.snoozedUntil ? ` until ${when(ask.snoozedUntil)}` : ''}</li>}
      </ol>
      <section className="hub-panel">
        <p className="hub-muted">{from.tool || from.host ? `From ${from.tool || 'an agent'}${from.host ? ` on ${from.host}` : ''}, ` : 'From an unknown sender, '}{when(ask.createdAt)}.</p>
        <AskBody ask={ask} reload={reload} onTaken={setTaken} onSettled={verb => void goNext({ kind: 'ask', id: ask.id, title: ask.question }, verb, queue(), hubHash('ask', ask.id))} view />
      </section>
      {answer && <AnswerSummary ask={ask} answer={answer} />}
      {answer && ask.delivery && !ask.pickup && <Delivery ask={ask} delivery={ask.delivery} />}
      {ask.pickup && <p className="hub-muted">Picked up {when(ask.pickup.at)}{text(ask.pickup.host) ? ` on ${text(ask.pickup.host)}` : ''}{text(ask.pickup.bead) ? ` as ${text(ask.pickup.bead)}` : ''}.</p>}
      <p><a className="hub-btn" href={hubHash('needs')}>Back to Needs you</a></p>
    </>
  )
}
