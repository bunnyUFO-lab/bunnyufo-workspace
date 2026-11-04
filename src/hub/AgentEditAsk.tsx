import { useEffect, useState } from 'react'
import type { Ask } from '../lib/hub'
import { hubGet } from '../lib/hub'
import type { AgentDetailsView, ModelRef, PersonaView } from '../lib/hubTeam'
import { text } from './askAnswer'
import { agentEditOf, profileEditOf } from './agentEditField'
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

const nameOf = (item: ModelRef) => `${item.provider} · ${item.model}`

/** A model order as plain rows: the primary, then each fallback. */
function Chain({ primary, fallbacks, field }: { primary: ModelRef | undefined; fallbacks: ModelRef[]; field: string }) {
  if (!primary) return <p className="team-dim" data-profile-ask-chain={field}>(not published)</p>
  return (
    <ol className="ad-fallbacks ae-chain" data-profile-ask-chain={field}>
      <li>{nameOf(primary)}</li>
      {fallbacks.map((item, index) => <li key={`${nameOf(item)}/${index}`}>then {nameOf(item)}</li>)}
    </ol>
  )
}

/** A profile-edit Ask: the order the Hermes host has now, and the order proposed, as plain text, with what Apply does. */
function ProfileEditAsk({ ask }: { ask: Ask }) {
  const edit = profileEditOf(ask)
  const [details, setDetails] = useState<AgentDetailsView | null>(null)
  const [failed, setFailed] = useState(false)
  const profile = edit?.profile
  useEffect(() => {
    if (!profile) return undefined
    const abort = new AbortController()
    hubGet<AgentDetailsView>(`/team/${profile === 'main' ? 'hermes' : 'briefs'}/details`, abort.signal).then(setDetails, () => { if (!abort.signal.aborted) setFailed(true) })
    return () => abort.abort()
  }, [profile])
  if (!edit) return <section className="ae-ask" data-agent-edit-ask="bad"><p>This Ask names a model change that cannot be read, so answering it changes nothing.</p></section>
  const open = ask.state === 'open' || ask.state === 'snoozed'
  const now = details?.settings
  return (
    <section className="ae-ask" data-agent-edit-ask={`profile-${edit.profile}`} aria-label="The proposed model change">
      <p className="team-dim" data-edit-ask-says><b>The request says</b>: {text(ask.question)}</p>
      {edit.why && <p data-edit-ask-why><b>Why</b>: {edit.why}</p>}
      <p>Changes the model and the fallback order of the Hermes profile <b>{edit.profile}</b>.</p>
      {failed && <p className="hub-muted" role="note">The order the host has now could not be loaded.</p>}
      <div className="ae-ask-pair">
        <div><h4>Now</h4>{details ? <Chain primary={now?.model?.provider && now.model.default ? { provider: now.model.provider, model: now.model.default } : undefined} fallbacks={now?.fallbacks ?? []} field="old" /> : <p className="team-dim" data-profile-ask-chain="old">(loading)</p>}</div>
        <div><h4>Proposed</h4><Chain primary={edit.primary} fallbacks={edit.fallbacks} field="new" /></div>
      </div>
      {open && !ask.agentEditBlocked && <p className="hub-muted" data-profile-ask-restart>Apply signs the change. The Hermes host applies it within about 5 minutes and restarts the {edit.profile} gateway: a chat or job running then stops. If anything fails, the old settings are put back.</p>}
    </section>
  )
}

/** The proposal of an agent-edit Ask in full: a persona's old and new text side by side, or a profile's old and new model order, as plain text, with the agent's own words under their label. */
export default function AgentEditAsk({ ask }: { ask: Ask }) {
  return ask.agentEdit?.op === 'profile' ? <ProfileEditAsk ask={ask} /> : <PersonaEditAsk ask={ask} />
}

function PersonaEditAsk({ ask }: { ask: Ask }) {
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
