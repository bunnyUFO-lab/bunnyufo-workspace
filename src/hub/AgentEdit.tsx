import { useCallback, useEffect, useState } from 'react'
import { ago, HubError, hubGet, hubPost } from '../lib/hub'
import { hubHash } from '../lib/route'
import { host } from '../lib/host'
import type { PersonaVersion, PersonaView } from '../lib/hubTeam'
import './team/agentDetails.css'

const LIMITS = { role: 200, prompt: 8000, note: 200 }

interface Draft { role: string; prompt: string; model: string; note: string }
const draftOf = (view: PersonaView): Draft => ({ role: view.current.role, prompt: view.current.prompt, model: view.current.model, note: '' })

/** One version in the list: when, who, why, the whole text closed under a summary, and the button that takes it back. */
function VersionRow({ version, current, models, busy, onRevert }: { version: PersonaVersion; current: boolean; models: PersonaView['models']; busy: boolean; onRevert: (version: PersonaVersion) => void }) {
  const isApp = version.id === 'default'
  const who = isApp ? "The app's own text" : [version.default ? "Back to the app's text" : version.revertOf ? 'Reverted' : version.fromAsk ? 'Agent edit' : 'Edited', version.at ? ago(version.at) : '', version.by && `by ${version.by}`].filter(Boolean).join(' · ')
  const model = models.find(item => item.id === version.model)?.label ?? version.model
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

/** `#/~hub/agent-edit/<id>`: the role line, prompt and chat model of an agent's persona, with its versions. Toolsets, skills, SOUL.md and jobs stay on the details page, view-only. */
export default function AgentEdit({ id }: { id: string }) {
  const [view, setView] = useState<PersonaView | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<number | null>(null)
  const [stale, setStale] = useState(false)
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState<string | null>(null)
  const [name, setName] = useState('')

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
    hubGet<{ agents: { id: string; name: string }[] }>('/team', controller.signal).then(team => setName(team.agents.find(agent => agent.id === id)?.name ?? ''), () => {})
    return () => controller.abort()
  }, [id, show, refuse])
  const reload = () => { hubGet<PersonaView>(`/team/${encodeURIComponent(id)}/persona`).then(next => show(next, true), refuse) }

  const back = <a className="ad-back" href={hubHash('agent', id)} data-edit-back>← {name || 'Details'}</a>
  if (!host.write) {
    return <div className="ad team" data-agent-edit={id}>{back}<p className="hub-empty" role="status" data-edit-signin>Sign in to edit this persona.</p></div>
  }
  if (!view || !draft) {
    return (
      <div className="ad team" data-agent-edit={id}>
        {back}
        {status === 401
          ? <p className="hub-empty" role="status" data-edit-signin>Sign in to edit this persona.</p>
          : status === 404
            ? <p className="hub-empty" role="status" data-edit-none>This agent has no chat persona to edit.</p>
            : <p className={error ? 'hub-error' : 'hub-empty'} role={error ? 'alert' : undefined}>{error ?? 'Loading…'}</p>}
      </div>
    )
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
    <div className="ad team" data-agent-edit={id}>
      {back}
      <header className="ad-head">
        <div className="ad-title">
          <h2>Edit {name || 'persona'}</h2>
          <p className="team-dim">The text every chat with this agent starts from. Toolsets, skills, SOUL.md and scheduled jobs stay view-only: see Details.</p>
        </div>
      </header>
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
    </div>
  )
}
