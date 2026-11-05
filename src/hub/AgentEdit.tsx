import { useCallback, useEffect, useState } from 'react'
import { ago, HubError, hubGet, hubPost } from '../lib/hub'
import { hubHash } from '../lib/route'
import { host } from '../lib/host'
import type { AgentDetailsView, ModelRef, PersonaVersion, PersonaView, ProfileChange, TeamAgent, TeamView } from '../lib/hubTeam'
import { isOpus, opusNote } from './agentEditField'
import './team/agentDetails.css'

const LIMITS = { role: 200, prompt: 8000, note: 200 }

interface Draft { role: string; prompt: string; model: string; note: string }
const draftOf = (view: PersonaView): Draft => ({ role: view.current.role, prompt: view.current.prompt, model: view.current.model, note: '' })

/** One version in the list: when, who, why, the whole text closed under a summary, and the button that takes it back. */
function VersionRow({ version, current, models, busy, onRevert }: { version: PersonaVersion; current: boolean; models: PersonaView['models']; busy: boolean; onRevert: (version: PersonaVersion) => void }) {
  const isApp = version.id === 'default'
  const first = version.retired ? 'Retired' : version.default ? "Back to the app's text" : version.created ? 'Created' : version.revertOf ? 'Reverted' : version.fromAsk ? 'Agent edit' : 'Edited'
  const who = isApp ? "The app's own text" : [first, version.at ? ago(version.at) : '', version.by && `by ${version.by}`].filter(Boolean).join(' · ')
  const model = models.find(item => item.id === version.model)?.label ?? version.model
  // The retirement has no text and nothing to go back to: Bring back on the Team screen reverts to the version before it.
  if (version.retired) {
    return (
      <li className="ae-version" data-version={version.id} data-current={current ? '' : undefined} data-retired-version>
        <div className="ae-version-head"><span className="ae-version-who">{who}</span>{current && <span className="ad-tag on" data-version-current>Current</span>}</div>
      </li>
    )
  }
  return (
    <li className="ae-version" data-version={version.id} data-current={current ? '' : undefined}>
      <div className="ae-version-head">
        <span className="ae-version-who">{who}</span>
        {current && <span className="ad-tag on" data-version-current>Current</span>}
        {!current && (
          <button type="button" className="hub-btn" disabled={busy} onClick={() => onRevert(version)} data-revert={version.id}>{isApp || version.default ? "Back to the app's text" : 'Revert'}</button>
        )}
      </div>
      {version.note && <p className="ae-version-note team-dim">{version.note}</p>}
      <details className="ad-prompt">
        <summary><span className="ad-prompt-title">The text of this version</span></summary>
        <p className="ae-version-meta team-dim">Role: {version.role} · Chat model: {model}</p>
        <pre className="ad-pre">{version.prompt}</pre>
      </details>
    </li>
  )
}

/** A persona the owner made leaves the Team and the Talk to menu when retired. Nothing is deleted: Bring back on the Team screen returns it. */
function RetireSection({ agent }: { agent: TeamAgent }) {
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const retire = async () => {
    setBusy(true)
    setError(null)
    try {
      await hubPost(`/team/${encodeURIComponent(agent.id)}/persona/retire`, {})
      window.location.hash = hubHash('team')
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : 'That did not work.')
      setBusy(false)
    }
  }
  return (
    <section className="ad-section" aria-labelledby="ae-retire" data-edit-retire>
      <h3 id="ae-retire">Retire</h3>
      {asking ? (
        <>
          <p data-retire-confirm>It leaves the Team and the Talk to menu. Old chats keep working.</p>
          {error && <p className="hub-error" role="alert" data-retire-error>{error}</p>}
          <div className="ae-actions">
            <button type="button" className="hub-btn pri" disabled={busy} onClick={() => { void retire() }} data-retire-yes>Retire {agent.name}</button>
            <button type="button" className="hub-btn" disabled={busy} onClick={() => setAsking(false)} data-retire-no>Keep it</button>
          </div>
        </>
      ) : (
        <div className="ae-actions"><button type="button" className="hub-btn" onClick={() => setAsking(true)} data-retire-open>Retire this persona</button></div>
      )}
    </section>
  )
}

/** The role line, prompt and chat model of an agent's persona, with its versions. */
function PersonaEdit({ id }: { id: string }) {
  const [view, setView] = useState<PersonaView | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<number | null>(null)
  const [stale, setStale] = useState(false)
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState<string | null>(null)

  /** Shows a view from the server. `keep` leaves what was typed as it is (after a 409) and only moves the base. */
  const show = useCallback((next: PersonaView, keep: boolean) => {
    setView(next)
    setDraft(previous => (keep && previous ? previous : draftOf(next)))
    setError(null)
    setStale(false)
  }, [])
  const refuse = useCallback((problem: unknown) => {
    if ((problem as { name?: string }).name === 'AbortError') return
    setStatus(problem instanceof HubError ? problem.status : 0)
    setError(problem instanceof Error ? problem.message : 'Could not load this.')
  }, [])
  useEffect(() => {
    const controller = new AbortController()
    hubGet<PersonaView>(`/team/${encodeURIComponent(id)}/persona`, controller.signal).then(next => show(next, false), refuse)
    return () => controller.abort()
  }, [id, show, refuse])
  const reload = () => { hubGet<PersonaView>(`/team/${encodeURIComponent(id)}/persona`).then(next => show(next, true), refuse) }

  if (!view || !draft) {
    return status === 401
      ? <p className="hub-empty" role="status" data-edit-signin>Sign in to edit this agent.</p>
      : <p className={error ? 'hub-error' : 'hub-empty'} role={error ? 'alert' : undefined}>{error ?? 'Loading…'}</p>
  }

  const changed = draft.role !== view.current.role || draft.prompt !== view.current.prompt || draft.model !== view.current.model
  const invalid = !draft.role.trim() || !draft.prompt.trim() || draft.role.length > LIMITS.role || draft.prompt.length > LIMITS.prompt
  const apply = (next: PersonaView, message: string) => { setView(next); setDraft(draftOf(next)); setSaved(message); setError(null); setStale(false) }
  const fail = (problem: unknown) => {
    setSaved(null)
    if (problem instanceof HubError && problem.status === 409) { setStale(true); setError(problem.message); return }
    setError(problem instanceof Error ? problem.message : 'That did not work.')
  }

  const save = async () => {
    setBusy(true)
    setSaved(null)
    setError(null)
    try {
      const result = await hubPost<PersonaView>(`/team/${encodeURIComponent(id)}/persona`, { role: draft.role, prompt: draft.prompt, model: draft.model, ...(draft.note.trim() ? { note: draft.note.trim() } : {}), base: view.current.version })
      apply(result, 'Saved. Chats use this text from their next message.')
    } catch (problem) { fail(problem) } finally { setBusy(false) }
  }
  const revert = async (version: PersonaVersion) => {
    setBusy(true)
    setSaved(null)
    setError(null)
    try {
      const result = await hubPost<PersonaView>(`/team/${encodeURIComponent(id)}/persona/revert`, { to: version.id, base: view.current.version })
      apply(result, version.id === 'default' ? "Back to the app's text. Chats use it from their next message." : 'Reverted. Chats use this text from their next message.')
    } catch (problem) { fail(problem) } finally { setBusy(false) }
  }

  return (
    <>
      <form className="ad-section ae-form" onSubmit={event => { event.preventDefault(); if (changed && !invalid && !busy) void save() }} data-edit-form>
        <label className="ae-field">
          <span>Role line</span>
          <input type="text" value={draft.role} maxLength={LIMITS.role} onChange={event => setDraft({ ...draft, role: event.target.value })} data-edit-role />
          <small className="team-dim">One line on the Team card. When you leave the prompt as it is, the role in its first line changes too.</small>
        </label>
        <label className="ae-field">
          <span>Prompt</span>
          <textarea value={draft.prompt} rows={16} maxLength={LIMITS.prompt} onChange={event => setDraft({ ...draft, prompt: event.target.value })} data-edit-prompt />
          <small className="team-dim">{draft.prompt.length} of {LIMITS.prompt} characters. Sent to Hermes as the first line of each turn.</small>
        </label>
        <label className="ae-field">
          <span>Chat model</span>
          <select value={draft.model} onChange={event => setDraft({ ...draft, model: event.target.value })} data-edit-model>
            {view.models.map(model => <option key={model.id} value={model.id}>{model.label} · {model.note}</option>)}
          </select>
          <small className="team-dim" data-edit-model-note>Chat only. Jobs use the profile&apos;s model.</small>
        </label>
        <label className="ae-field">
          <span>Note (optional)</span>
          <input type="text" value={draft.note} maxLength={LIMITS.note} placeholder="Why you changed it" onChange={event => setDraft({ ...draft, note: event.target.value })} data-edit-note />
        </label>
        {error && (
          <p className="hub-error" role="alert" data-edit-error>
            {error}{stale && <> What you typed is kept. <button type="button" className="hub-btn" onClick={reload} data-edit-reload>Reload the versions</button></>}
          </p>
        )}
        {saved && <p className="hub-muted" role="status" data-edit-saved>{saved}</p>}
        <div className="ae-actions">
          <button type="submit" className="hub-btn pri" disabled={!changed || invalid || busy} data-edit-save>Save</button>
          {changed && <button type="button" className="hub-btn" disabled={busy} onClick={() => setDraft(draftOf(view))} data-edit-discard>Discard changes</button>}
        </div>
      </form>
      <section className="ad-section" aria-labelledby="ae-versions" data-edit-versions>
        <h3 id="ae-versions">Versions</h3>
        <ul className="ae-versions">
          {view.versions.map((version, index) => <VersionRow key={version.id} version={version} current={index === 0} models={view.models} busy={busy} onRevert={item => { void revert(item) }} />)}
        </ul>
      </section>
    </>
  )
}

const MAX_FALLBACKS = 4
const same = (a: ModelRef, b: ModelRef) => a.provider === b.provider && a.model === b.model
const refName = (item: ModelRef) => `${item.provider} · ${item.model}`
const STATE_WORDS: Record<ProfileChange['state'], string> = { waiting: 'Waiting for the host', applied: 'Applied, not in an export yet', live: 'Live', failed: 'Failed', late: 'Not picked up' }
/** "claude-sonnet-5-5, then gpt-6-sol" */
const chainText = (set: { provider: string; model: string; fallbacks: ModelRef[] }) => [set.model, ...set.fallbacks.map(item => item.model)].join(', then ')

/** One row of the changes list: when, the order it asked for, and where it stands. */
function ChangeRow({ change }: { change: ProfileChange }) {
  return (
    <li className="ae-version" data-profile-change={change.id} data-state={change.state}>
      <div className="ae-version-head">
        <span className="ae-version-who">{chainText(change.to)}</span>
        <span className={`ad-tag${change.state === 'live' ? ' on' : ''}`} data-change-state>{STATE_WORDS[change.state]}</span>
      </div>
      <p className="ae-version-note team-dim">Asked {ago(change.at)} by {change.by}. Before: {chainText(change.from)}.{change.reason ? ` ${change.reason}.` : ''}</p>
    </li>
  )
}

/** The model of a Hermes profile and the order of its fallbacks. "Send for approval" opens an Ask only the owner's passkey answers; the Hermes host applies it. */
function ProfileEdit({ agent, team }: { agent: TeamAgent; team: TeamAgent[] }) {
  const profile = agent.profile
  const [view, setView] = useState<AgentDetailsView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [primary, setPrimary] = useState<ModelRef | null>(null)
  const [chain, setChain] = useState<ModelRef[]>([])
  const [why, setWhy] = useState('')
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState<string | null>(null)

  const load = useCallback((signal?: AbortSignal) => hubGet<AgentDetailsView>(`/team/${encodeURIComponent(agent.id)}/details`, signal).then(next => {
    setView(next)
    const model = next.settings?.model
    setPrimary(previous => previous ?? (model?.provider && model.default ? { provider: model.provider, model: model.default } : null))
    setChain(previous => (previous.length ? previous : next.settings?.fallbacks.map(item => ({ provider: item.provider, model: item.model })) ?? []))
  }, problem => { if ((problem as { name?: string }).name !== 'AbortError') setError(problem instanceof Error ? problem.message : 'Could not load this.') }), [agent.id])
  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
    return () => controller.abort()
  }, [load])

  const shared = team.filter(item => item.profile === profile).map(item => item.name)
  const heading = <><h3 id="ae-profile">Model and fallbacks</h3><p className="team-dim" data-profile-shared>Profile {profile}. Shared by {shared.length > 1 ? `${shared.slice(0, -1).join(', ')} and ${shared[shared.length - 1]}` : shared.join('')}</p></>
  if (!view) return <section className="ad-section" aria-labelledby="ae-profile" data-edit-profile={profile}>{heading}<p className={error ? 'hub-error' : 'hub-empty'} role={error ? 'alert' : undefined}>{error ?? 'Loading…'}</p></section>

  const settings = view.settings
  const options = settings?.modelOptions ?? []
  const current = settings?.model?.provider && settings.model.default ? { provider: settings.model.provider, model: settings.model.default } : null
  const nowChain = settings?.fallbacks ?? []
  // The select shows what the host offers, and also what is set now when the host no longer offers it (marked), so a row never goes blank.
  const choices: { ref: ModelRef; label: string }[] = options.map(ref => ({ ref, label: refName(ref) }))
  const billed = (ref: ModelRef, label: string) => (isOpus(ref.model) ? `${label} · billed through the API` : label)
  for (const ref of [current, ...chain, ...nowChain, primary]) if (ref && !choices.some(choice => same(choice.ref, ref))) choices.push({ ref, label: `${refName(ref)} (not offered now)` })
  const opusNoteText = opusNote(primary, chain)
  const indexOf = (ref: ModelRef | null) => String(choices.findIndex(choice => ref && same(choice.ref, ref)))
  const waiting = view.change?.state === 'waiting'
  const fresh = view.freshness.state === 'fresh'
  const noList = options.length === 0
  const changed = !!primary && !!current && (!same(primary, current) || chain.length !== nowChain.length || chain.some((item, index) => !same(item, nowChain[index])))
  const off = noList ? 'The Hermes host has not published its model list yet.' : !fresh ? 'The last export from the Hermes host is old, so its settings may have changed. Changing the model is off until a new one arrives.' : waiting ? 'A change is already waiting for the Hermes host.' : null
  const unused = options.filter(ref => !(primary && same(ref, primary)) && !chain.some(item => same(item, ref)))
  // "Add a fallback" is a default pick in the owner's hand, so it never adds Opus; choosing Opus in a row's select is the deliberate step.
  const addable = unused.find(ref => !isOpus(ref.model))
  const move = (index: number, by: -1 | 1) => setChain(list => { const next = [...list]; [next[index], next[index + by]] = [next[index + by], next[index]]; return next })

  const send = async () => {
    if (!primary) return
    setBusy(true)
    setError(null)
    setSent(null)
    try {
      const made = await hubPost<{ ask: string }>(`/team/${encodeURIComponent(agent.id)}/profile-change`, { primary, fallbacks: chain, ...(why.trim() ? { why: why.trim() } : {}) })
      setSent(made.ask)
      setWhy('')
      await load()
    } catch (problem) { setError(problem instanceof Error ? problem.message : 'That did not work.') } finally { setBusy(false) }
  }

  return (
    <section className="ad-section" aria-labelledby="ae-profile" data-edit-profile={profile}>
      {heading}
      {profile === 'briefs' && <p className="team-dim" data-profile-briefs>The three weekly jobs are pinned to Sonnet and do not follow this.</p>}
      {off && <p className="hub-banner ad-note" role="note" data-profile-off>{off}</p>}
      <form className="ae-form" onSubmit={event => { event.preventDefault(); if (changed && !off && !busy) void send() }} data-profile-form>
        <label className="ae-field">
          <span>Primary model</span>
          <select value={indexOf(primary)} disabled={noList || busy} onChange={event => { const next = choices[Number(event.target.value)].ref; setPrimary(next); setChain(list => list.filter(item => !same(item, next))) }} data-profile-primary>
            {choices.map((choice, index) => <option key={choice.label} value={String(index)}>{billed(choice.ref, choice.label)}</option>)}
          </select>
        </label>
        <div className="ae-field" role="group" aria-label="Fallbacks, in the order they are tried">
          <span>Fallbacks, tried in this order</span>
          {chain.length === 0 && <p className="team-dim" data-profile-nochain>With no fallbacks, a Codex limit means no reply.</p>}
          <ol className="ae-chain-list" data-profile-fallbacks>
            {chain.map((item, index) => (
              <li key={refName(item)} className="ae-chain-row" data-profile-fallback={index}>
                <select aria-label={`Fallback ${index + 1}`} value={indexOf(item)} disabled={busy} onChange={event => { const next = choices[Number(event.target.value)].ref; setChain(list => list.map((entry, at) => (at === index ? next : entry)).filter((entry, at, all) => all.findIndex(other => same(other, entry)) === at && !(primary && same(entry, primary)))) }}>
                  {choices.filter(choice => same(choice.ref, item) || !(primary && same(choice.ref, primary)) && !chain.some(entry => same(entry, choice.ref))).map(choice => <option key={choice.label} value={String(choices.indexOf(choice))}>{billed(choice.ref, choice.label)}</option>)}
                </select>
                <button type="button" className="hub-btn" disabled={busy || index === 0} onClick={() => move(index, -1)} aria-label={`Move ${item.model} up`} data-fallback-up>Up</button>
                <button type="button" className="hub-btn" disabled={busy || index === chain.length - 1} onClick={() => move(index, 1)} aria-label={`Move ${item.model} down`} data-fallback-down>Down</button>
                <button type="button" className="hub-btn" disabled={busy} onClick={() => setChain(list => list.filter((_, at) => at !== index))} aria-label={`Remove ${item.model}`} data-fallback-remove>Remove</button>
              </li>
            ))}
          </ol>
          <div className="ae-actions">
            <button type="button" className="hub-btn" disabled={busy || noList || chain.length >= MAX_FALLBACKS || !addable} onClick={() => { if (addable) setChain(list => [...list, addable]) }} data-fallback-add>Add a fallback</button>
          </div>
          <small className="team-dim">Up to {MAX_FALLBACKS}. Each model once.</small>
          {opusNoteText && <p className="hub-banner ad-note" role="note" data-profile-opus-note>{opusNoteText}</p>}
        </div>
        <label className="ae-field">
          <span>Why (optional)</span>
          <input type="text" value={why} maxLength={400} placeholder="Shown on the request" onChange={event => setWhy(event.target.value)} data-profile-why />
        </label>
        <p className="hub-muted" data-profile-restart>Applying restarts Hermes {profile} within about 5 minutes. A chat or job running then stops.</p>
        {error && <p className="hub-error" role="alert" data-profile-error>{error}</p>}
        {sent && <p className="hub-muted" role="status" data-profile-sent>Sent for approval. <a href={hubHash('ask', sent)} data-profile-ask>Open the request</a> and approve it with your passkey.</p>}
        <div className="ae-actions">
          <button type="submit" className="hub-btn pri" disabled={!changed || !!off || busy || !primary} data-profile-send>Send for approval</button>
          {changed && <button type="button" className="hub-btn" disabled={busy} onClick={() => { setPrimary(current); setChain(nowChain.map(item => ({ provider: item.provider, model: item.model }))) }} data-profile-discard>Discard changes</button>}
        </div>
      </form>
      {(view.changes?.length ?? 0) > 0 && (
        <>
          <h3 id="ae-changes">Changes</h3>
          <ul className="ae-versions" data-profile-changes aria-labelledby="ae-changes">{view.changes?.map(change => <ChangeRow key={change.id} change={change} />)}</ul>
        </>
      )}
    </section>
  )
}

/** `#/~hub/agent-edit/<id>`: what the owner may change of an agent. Its chat persona (role line, prompt, chat model, with versions), and the model and fallback order of its Hermes profile. Toolsets, skills, SOUL.md and jobs stay on the details page, view-only. */
export default function AgentEdit({ id }: { id: string }) {
  const [team, setTeam] = useState<TeamAgent[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    hubGet<TeamView>('/team', controller.signal).then(next => setTeam(next.agents), problem => { if ((problem as { name?: string }).name !== 'AbortError') setError(problem instanceof HubError ? problem.message : 'Could not load this.') })
    return () => controller.abort()
  }, [])
  const agent = team?.find(item => item.id === id) ?? null
  const back = <a className="ad-back" href={hubHash('agent', id)} data-edit-back>← {agent?.name || 'Details'}</a>
  if (!host.write) {
    return <div className="ad team" data-agent-edit={id}>{back}<p className="hub-empty" role="status" data-edit-signin>Sign in to edit this agent.</p></div>
  }
  if (!team || !agent) {
    return <div className="ad team" data-agent-edit={id}>{back}<p className={error || team ? 'hub-error' : 'hub-empty'} role={error || team ? 'alert' : undefined}>{error ?? (team ? 'No such agent.' : 'Loading…')}</p></div>
  }
  if (!agent.editable) {
    return <div className="ad team" data-agent-edit={id}>{back}<p className="hub-empty" role="status" data-edit-none>{agent.name} has nothing to edit here: its settings live on the PC.</p></div>
  }
  return (
    <div className="ad team" data-agent-edit={id}>
      {back}
      <header className="ad-head">
        <div className="ad-title">
          <h2>Edit {agent.name}</h2>
          <p className="team-dim">{agent.editable.persona ? 'The text every chat with this agent starts from, and the model it runs on. ' : 'The model it runs on. '}Toolsets, skills, SOUL.md and scheduled jobs stay view-only: see Details.</p>
        </div>
      </header>
      {agent.editable.persona && <PersonaEdit id={id} />}
      {agent.editable.profile && agent.profile && <ProfileEdit agent={agent} team={team} />}
      {agent.custom && <RetireSection agent={agent} />}
    </div>
  )
}
