import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { ago, HubError, hubGet, hubPost } from '../lib/hub'
import { hubHash } from '../lib/route'
import { host } from '../lib/host'
import type { AgentDetailsView, ModelRef, PersonaVersion, PersonaView, ProfileChange, ProfileChangeAnswer, TeamAgent, TeamView } from '../lib/hubTeam'
import { isDear, opusNote } from './agentEditField'
import { ChangeBanner } from './AgentDetails'
import { AUTO_FOLLOWS_TEXT, BRIEFS_WAIT_TEXT, pressRestartText, restartText, REPLACED_WORD, STATE_WORDS } from './profileChangeWords'
import { useWaitingPoll } from './useWaitingPoll'
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
function PersonaEdit({ id, hasProfile }: { id: string; hasProfile: boolean }) {
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
          <small className="team-dim" data-edit-model-note>{hasProfile ? "Chat only, this agent only. Jobs and Auto use the profile's model below." : 'Chat only, this agent only.'}</small>
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
/** "claude-sonnet-5-5, then gpt-6-sol" */
const chainText = (set: { provider: string; model: string; fallbacks: ModelRef[] }) => [set.model, ...set.fallbacks.map(item => item.model)].join(', then ')

/** One row of the changes list: when, the order it asked for, and where it stands. `undo` is the way back, on the newest finished change only. */
function ChangeRow({ change, undo }: { change: ProfileChange; undo?: ReactNode }) {
  return (
    <li className="ae-version" data-profile-change={change.id} data-state={change.state} data-replaced={change.replaced ? '' : undefined}>
      <div className="ae-version-head">
        <span className="ae-version-who">{chainText(change.to)}</span>
        <span className={`ad-tag${!change.replaced && (change.state === 'live' || change.state === 'applied') ? ' on' : ''}`} data-change-state>{change.replaced ? REPLACED_WORD : STATE_WORDS[change.state]}</span>
      </div>
      <p className="ae-version-note team-dim">Asked {ago(change.at)} by {change.by}. Before: {chainText(change.from)}.{change.reason ? ` ${change.reason}.` : ''}</p>
      {undo}
    </li>
  )
}

const keyOf = (value: { primary: ModelRef | null; chain: ModelRef[] }) => JSON.stringify([value.primary, value.chain])

/**
 * The model of a Hermes profile and the order of its fallbacks. The signed-in owner's press on "Change and restart Hermes <profile>" signs the change at once
 * (no Ask, no second look): the page shows what will happen above the button, and the newest finished change has a way back. The Hermes host applies it.
 * An Opus or Fable pick is one press like any other; the billing note shows on the page before the press (the owner's decision). The page takes no draft from the URL, from storage or from an Ask, and Enter submits nothing.
 * An agent's proposal is still an Ask that the owner answers Apply.
 */
function ProfileEdit({ agent, team }: { agent: TeamAgent; team: TeamAgent[] }) {
  const hasPersona = !!agent.editable?.persona
  const profile = agent.profile
  const [view, setView] = useState<AgentDetailsView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState<{ primary: ModelRef | null; chain: ModelRef[] } | null>(null)
  const [busy, setBusy] = useState(false)
  const [asked, setAsked] = useState(() => Date.now())
  const primary = draft?.primary ?? null
  const chain = draft?.chain ?? []
  const setPrimary = (value: ModelRef | null) => setDraft(previous => ({ chain: previous?.chain ?? [], primary: value }))
  const setChain = (update: ModelRef[] | ((list: ModelRef[]) => ModelRef[])) => setDraft(previous => ({ primary: previous?.primary ?? null, chain: typeof update === 'function' ? update(previous?.chain ?? []) : update }))
  // What the form held when the host last gave it an order, or when it was sent: an owner who typed nothing since gets the new order when the change ends.
  const baseline = useRef('')
  const wasWaiting = useRef(false)

  /** Reads the details and shows them. Throws when the read fails, so a poll can try again without an error on the page. */
  const read = useCallback((signal?: AbortSignal) => hubGet<AgentDetailsView>(`/team/${encodeURIComponent(agent.id)}/details`, signal).then(next => {
    setView(next)
    setAsked(Date.now())
    const eff = next.settings?.effective ?? (next.settings?.model?.provider && next.settings.model.default ? { provider: next.settings.model.provider, model: next.settings.model.default, fallbacks: next.settings.fallbacks } : null)
    const stillWaiting = next.change?.state === 'waiting'
    const ended = wasWaiting.current && !stillWaiting
    wasWaiting.current = stillWaiting
    if (!eff) return
    const fresh = { primary: { provider: eff.provider, model: eff.model }, chain: eff.fallbacks.map(item => ({ provider: item.provider, model: item.model })) }
    setDraft(previous => {
      if (previous && !(ended && keyOf(previous) === baseline.current)) return previous
      baseline.current = keyOf(fresh)
      return fresh
    })
  }), [agent.id])
  const load = useCallback((signal?: AbortSignal) => read(signal).catch((problem: unknown) => { if ((problem as { name?: string }).name !== 'AbortError') setError(problem instanceof Error ? problem.message : 'Could not load this.') }), [read])
  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
    return () => controller.abort()
  }, [load])
  // A change that waits for the host is read again every few seconds: the block clears and the row says Running with no reload.
  useWaitingPoll(view?.change?.state === 'waiting', read)

  const shared = team.filter(item => item.profile === profile).map(item => item.name)
  const sharedText = shared.length > 1 ? `${shared.slice(0, -1).join(', ')} and ${shared[shared.length - 1]}` : shared.join('')
  const heading = <><h3 id="ae-profile">Model and fallbacks of profile {profile}</h3><p className="team-dim" data-profile-shared>Profile {profile}. Shared by {sharedText}</p>{profile === 'main' && <p className="team-dim" data-profile-auto>{AUTO_FOLLOWS_TEXT}</p>}</>
  if (!view) return <section className="ad-section" aria-labelledby="ae-profile" data-edit-profile={profile}>{heading}<p className={error ? 'hub-error' : 'hub-empty'} role={error ? 'alert' : undefined}>{error ?? 'Loading…'}</p></section>

  const settings = view.settings
  const options = settings?.modelOptions ?? []
  // What the profile runs now: the export's order, or the one the host confirmed after that export was made.
  const eff = settings?.effective
  const current = eff ? { provider: eff.provider, model: eff.model } : settings?.model?.provider && settings.model.default ? { provider: settings.model.provider, model: settings.model.default } : null
  const nowChain = eff?.fallbacks ?? settings?.fallbacks ?? []
  // The select shows what the host offers, and also what is set now when the host no longer offers it (marked), so a row never goes blank.
  const choices: { ref: ModelRef; label: string }[] = options.map(ref => ({ ref, label: refName(ref) }))
  const billed = (ref: ModelRef, label: string) => (isDear(ref.model) ? `${label} · billed through the API` : label)
  for (const ref of [current, ...chain, ...nowChain, primary]) if (ref && !choices.some(choice => same(choice.ref, ref))) choices.push({ ref, label: `${refName(ref)} (not offered now)` })
  const opusNoteText = opusNote(primary, chain)
  const indexOf = (ref: ModelRef | null) => String(choices.findIndex(choice => ref && same(choice.ref, ref)))
  const waiting = view.change?.state === 'waiting'
  const other = profile === 'main' ? 'briefs' : 'main'
  const waitingOff = view.change ? `Hermes ${profile} is changing to ${view.change.to.model}. That covers ${sharedText}, so this order can be changed again once it finishes. Profile ${other} is not affected.${hasPersona ? ' Chat models above still save.' : ''}` : 'A change is already waiting for the Hermes host.'
  const fresh = view.freshness.state === 'fresh'
  const noList = options.length === 0
  const changed = !!primary && !!current && (!same(primary, current) || chain.length !== nowChain.length || chain.some((item, index) => !same(item, nowChain[index])))
  const off = noList ? 'The Hermes host has not published its model list yet.' : !fresh ? 'The last export from the Hermes host is old, so its settings may have changed. Changing the model is off until a new one arrives.' : waiting ? waitingOff : null
  const unused = options.filter(ref => !(primary && same(ref, primary)) && !chain.some(item => same(item, ref)))
  // "Add a fallback" is a default pick in the owner's hand, so it never adds Opus or Fable; choosing one in a row's select is the deliberate step.
  const addable = unused.find(ref => !isDear(ref.model))
  const move = (index: number, by: -1 | 1) => setChain(list => { const next = [...list]; [next[index], next[index + by]] = [next[index + by], next[index]]; return next })

  // The order the page showed as current goes with every press: if the host's settings moved since, the server refuses (409) instead of signing over them.
  const base = current ? { provider: current.provider, model: current.model, fallbacks: nowChain.map(item => ({ provider: item.provider, model: item.model })) } : null
  const press = async (body: Record<string, unknown>, after: { primary: ModelRef | null; chain: ModelRef[] }) => {
    setBusy(true)
    setError(null)
    try {
      await hubPost<ProfileChangeAnswer>(`/team/${encodeURIComponent(agent.id)}/profile-change`, { ...body, base })
      baseline.current = keyOf(after)
      // The form holds what was signed (for a way back, the order gone back to), so when the wait ends nothing is left armed that the owner did not choose.
      setDraft({ primary: after.primary, chain: after.chain })
      await load()
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : 'That did not work.')
      void load()
    } finally { setBusy(false) }
  }
  const send = () => { if (primary && base) void press({ primary, fallbacks: chain }, { primary, chain }) }
  // The way back is on the newest change only, once the host confirmed it and while it still runs: a Replaced row (the host was edited since) has none.
  const newest = view.changes?.[0]
  const canUndo = !!newest && !newest.replaced && (newest.state === 'applied' || newest.state === 'live') && !waiting && fresh && !!base
  const goBack = (change: ProfileChange) => void press({ undo: change.id }, { primary: { provider: change.from.provider, model: change.from.model }, chain: change.from.fallbacks.map(item => ({ provider: item.provider, model: item.model })) })

  return (
    <section className="ad-section" aria-labelledby="ae-profile" data-edit-profile={profile}>
      {heading}
      {profile === 'briefs' && <p className="team-dim" data-profile-briefs>The three weekly jobs are pinned to Sonnet and do not follow this.</p>}
      {view.change && <ChangeBanner change={view.change} now={asked} />}
      {off && <p className="hub-banner ad-note" role="note" data-profile-off>{off}</p>}
      <form className="ae-form" onSubmit={event => event.preventDefault()} data-profile-form>
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
        {changed && !off ? (
          <div className="hub-banner ad-note" role="note" data-profile-summary>
            <p data-profile-summary-now>Now: {chainText({ provider: current?.provider ?? '', model: current?.model ?? '', fallbacks: nowChain })}.</p>
            <p data-profile-summary-new>New: {primary ? chainText({ ...primary, fallbacks: chain }) : ''}.</p>
            <p data-profile-summary-shared>This moves {sharedText}, who share profile {profile}.</p>
            <p data-profile-summary-restart>{pressRestartText(profile ?? '')}</p>
          </div>
        ) : (
          <p className="hub-muted" data-profile-restart>{restartText(profile ?? '')}</p>
        )}
        {profile === 'briefs' && <p className="hub-muted" data-profile-briefs-wait>{BRIEFS_WAIT_TEXT}</p>}
        {error && <p className="hub-error" role="alert" data-profile-error>{error}</p>}
        <div className="ae-actions">
          <button type="button" className="hub-btn pri" disabled={!changed || !!off || busy || !primary} onClick={send} data-profile-send>Change and restart Hermes {profile}</button>
          {changed && <button type="button" className="hub-btn" disabled={busy} onClick={() => { setPrimary(current); setChain(nowChain.map(item => ({ provider: item.provider, model: item.model }))) }} data-profile-discard>Discard changes</button>}
        </div>
      </form>
      {(view.changes?.length ?? 0) > 0 && (
        <>
          <h3 id="ae-changes">Changes</h3>
          <ul className="ae-versions" data-profile-changes aria-labelledby="ae-changes">{view.changes?.map((change, index) => (
            <ChangeRow key={change.id} change={change} undo={index === 0 && canUndo ? (
              <div className="ae-undo">
                {opusNote(change.from, change.from.fallbacks) && <p className="hub-banner ad-note" role="note" data-undo-opus-note>{opusNote(change.from, change.from.fallbacks)}</p>}
                <button type="button" className="hub-btn" disabled={busy} onClick={() => goBack(change)} data-change-undo>Go back to {chainText(change.from)}</button>
                <small className="team-dim" data-change-undo-restart>This restarts Hermes {profile} too.</small>
              </div>
            ) : undefined} />
          ))}</ul>
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
      {agent.editable.persona && <PersonaEdit id={id} hasProfile={!!agent.editable.profile && !!agent.profile} />}
      {agent.editable.profile && agent.profile && <ProfileEdit agent={agent} team={team} />}
      {agent.custom && <RetireSection agent={agent} />}
    </div>
  )
}
