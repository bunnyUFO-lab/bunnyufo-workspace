import { useEffect, useRef, useState } from 'react'
import { hubGet, hubPost } from '../../lib/hub'
import { hubHash } from '../../lib/route'
import type { RetiredPersona, TemplatesView } from '../../lib/hubTeam'
import './agentDetails.css'

const NAME_RE = /^(?=.*[A-Za-z0-9])[A-Za-z0-9 ]{1,40}$/
const ROLE_MAX = 200

/**
 * New persona: pick a template, give a name and a role line, and the page opens that persona's Edit page. A persona is a prompt on Hermes main:
 * nothing reaches the Hermes host. At the bottom, the personas that were retired, each with Bring back. A dialog on desktop and a bottom sheet on a phone,
 * like the Sprite sheet; Team puts the focus back on the button that opened it.
 */
export default function NewPersona({ onClose, onBrought }: { onClose: () => void; onBrought: (name: string) => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [view, setView] = useState<TemplatesView | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [template, setTemplate] = useState('research')
  const [name, setName] = useState('')
  const [role, setRole] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const node = dialog.current
    if (node && !node.open) node.showModal()
    const abort = new AbortController()
    hubGet<TemplatesView>('/team/templates', abort.signal).then(setView, problem => {
      if (!abort.signal.aborted) setLoadError(problem instanceof Error ? problem.message : 'The templates did not load.')
    })
    return () => abort.abort()
  }, [])

  const cleanName = name.replace(/\s+/g, ' ').trim()
  const ready = NAME_RE.test(cleanName) && role.trim().length > 0 && role.length <= ROLE_MAX && busy === null
  const create = async () => {
    setBusy('create')
    setError(null)
    try {
      const made = await hubPost<{ id: string }>('/team/new', { template, name: cleanName, role: role.trim() })
      dialog.current?.close()
      window.location.hash = hubHash('agent-edit', made.id)
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : 'That did not work.')
      setBusy(null)
    }
  }
  const bringBack = async (item: RetiredPersona) => {
    setBusy(item.id)
    setError(null)
    try {
      await hubPost(`/team/${encodeURIComponent(item.id)}/persona/revert`, { to: item.to, base: item.base })
      onBrought(item.name)
      dialog.current?.close()
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : 'That did not work.')
      setBusy(null)
    }
  }

  return (
    <dialog
      ref={dialog}
      className="sprite-sheet new-persona"
      aria-labelledby="new-persona-title"
      onClose={onClose}
      onClick={event => { if (event.target === dialog.current) dialog.current?.close() }}
      data-new-persona-sheet
    >
      <div className="sheet-head">
        <h2 id="new-persona-title">New persona</h2>
        <button type="button" className="hub-btn sheet-x" aria-label="Close" onClick={() => dialog.current?.close()}>×</button>
      </div>
      <form className="sheet-body" onSubmit={event => { event.preventDefault(); if (ready) void create() }}>
        <p className="team-dim np-lead">A persona is a prompt on Hermes main. It chats; nothing is set up on the Hermes host. You can change its text after.</p>
        {loadError && <p className="hub-error" role="alert" data-new-load-error>{loadError}</p>}
        {!view && !loadError && <p className="team-dim" aria-busy="true">Loading…</p>}
        {view && (
          <>
            <div className="np-templates" role="radiogroup" aria-label="Template">
              {view.templates.map(item => (
                <div key={item.id} className={`np-template${template === item.id ? ' on' : ''}`} data-template-row={item.id}>
                  <label className="np-pick">
                    <input type="radio" name="np-template" value={item.id} checked={template === item.id} onChange={() => setTemplate(item.id)} data-template={item.id} />
                    <span><b>{item.label}</b><small className="team-dim">{item.line}</small></span>
                  </label>
                  <details className="ad-prompt">
                    <summary><span className="ad-prompt-title">The text of this template</span></summary>
                    <pre className="ad-pre">{item.text}</pre>
                  </details>
                </div>
              ))}
            </div>
            <label className="ae-field">
              <span>Name</span>
              <input type="text" value={name} maxLength={40} autoComplete="off" onChange={event => setName(event.target.value)} data-new-name />
              <small className="team-dim">Letters, digits and spaces, up to 40. It cannot be renamed later.</small>
            </label>
            <label className="ae-field">
              <span>Role line</span>
              <input type="text" value={role} maxLength={ROLE_MAX} placeholder="What it does, in a few words" onChange={event => setRole(event.target.value)} data-new-role />
              <small className="team-dim">One line on the Team card, and in the first line of the prompt.</small>
            </label>
            {error && <p className="hub-error" role="alert" data-new-error>{error}</p>}
            <div className="np-actions">
              <button type="submit" className="hub-btn pri" disabled={!ready} data-new-create>{busy === 'create' ? 'Creating…' : 'Create'}</button>
            </div>
            {view.retired.length > 0 && (
              <section className="np-retired" aria-labelledby="np-retired-title" data-retired>
                <h3 id="np-retired-title">Retired</h3>
                <ul>
                  {view.retired.map(item => (
                    <li key={item.id} data-retired-row={item.id}>
                      <span className="np-retired-text"><b>{item.name}</b><small className="team-dim">{item.role}</small></span>
                      <button type="button" className="hub-btn" disabled={busy !== null} onClick={() => { void bringBack(item) }} data-bring-back={item.id}>Bring back</button>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )}
      </form>
    </dialog>
  )
}
