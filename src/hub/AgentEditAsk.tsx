import { useEffect, useState } from 'react'
import type { Ask } from '../lib/hub'
import { hubGet } from '../lib/hub'
import type { PersonaView } from '../lib/hubTeam'
import { text } from './askAnswer'
import { agentEditOf } from './agentEditField'
import './team/agentDetails.css'

function Pair({ label, old, next, field, note = '' }: { label: string; old: string | undefined; next: string | undefined; field: string; note?: string }) {
  if (next === undefined) return <p className="team-dim" data-edit-ask-same={field}>{label}: unchanged{note}.</p>
  return (
    <div className="ae-ask-pair" data-edit-ask-field={field}>
      <div><h4>{label}: now</h4><pre className="ad-pre" data-edit-ask-old={field}>{old === undefined ? '(loading)' : old}</pre></div>
      <div><h4>{label}: proposed</h4><pre className="ad-pre" data-edit-ask-new={field}>{next}</pre></div>
    </div>
  )
}

/** The proposal of an agent-edit Ask in full: the old and the new text side by side as plain text, with the agent's own words under their label. */
export default function AgentEditAsk({ ask }: { ask: Ask }) {
  const edit = agentEditOf(ask)
  const [view, setView] = useState<PersonaView | null>(null)
  const [failed, setFailed] = useState(false)
  const agent = edit?.agent
  useEffect(() => {
    if (!agent) return undefined
    const abort = new AbortController()
    hubGet<PersonaView>(`/team/${encodeURIComponent(agent)}/persona`, abort.signal).then(setView, () => { if (!abort.signal.aborted) setFailed(true) })
    return () => abort.abort()
  }, [agent])
  if (ask.agentEdit === undefined) return null
  if (!edit) return <section className="ae-ask" data-agent-edit-ask="bad"><p>This Ask names an edit that cannot be read, so answering it changes nothing.</p></section>
  const open = ask.state === 'open' || ask.state === 'snoozed'
  return (
    <section className="ae-ask" data-agent-edit-ask={edit.agent} aria-label="The proposed edit">
      <p className="team-dim" data-edit-ask-says><b>The agent says</b>: {text(ask.question)}</p>
      {edit.why && <p data-edit-ask-why><b>Why</b>: {edit.why}</p>}
      <p>Changes the chat persona of <b>{edit.agent}</b>.</p>
      {failed && <p className="hub-muted" role="note">The text it has now could not be loaded.</p>}
      <Pair label="Role line" field="role" old={view?.current.role} next={edit.role} />
      <Pair label="Prompt" field="prompt" old={view?.current.prompt} next={edit.prompt} note={edit.role !== undefined && edit.role !== view?.current.role ? ', except that the role in its first line changes to the new role line' : ''} />
      <Pair label="Chat model" field="model" old={view ? view.models.find(item => item.id === view.current.model)?.label ?? view.current.model : undefined} next={edit.model === undefined ? undefined : view?.models.find(item => item.id === edit.model)?.label ?? edit.model} />
      {open && !ask.agentEditBlocked && view && view.current.version !== edit.base && <p className="hub-muted" role="note" data-edit-ask-stale>The persona changed after this edit was written, so Apply would be refused.</p>}
      {open && !ask.agentEditBlocked && <p className="hub-muted">Apply saves one new version you can revert. Nothing changes if you leave it.</p>}
    </section>
  )
}
