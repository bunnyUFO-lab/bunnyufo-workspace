import { useState } from 'react'
import type { CardWorkspace } from '../types'
import { createCard, openForEditing } from '../lib/cards'
import { go } from '../lib/entries'
import { entityHash, hubHash } from '../lib/route'
import './cards.css'

/**
 * "New card" on the board: a title, an optional line about it, and the project it goes in. The
 * card starts with one Markdown section and opens on it, in the editor.
 */
export default function NewCard({ workspaces, project, open, onOpen, onCreated }: {
  workspaces: CardWorkspace[]
  project: string
  /** The board shows the button in its header and the form under it, so it holds this. */
  open: boolean
  onOpen: (open: boolean) => void
  /** Called with the project the card went into, before the card opens. */
  onCreated?: (project: string) => void
}) {
  const writable = workspaces.filter(w => !w.builtin)
  const setOpen = onOpen
  const [where, setWhere] = useState('')
  const [title, setTitle] = useState('')
  const [about, setAbout] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  // What was tapped; else the only project that can take cards; else the one project in view. Never a silent guess: with
  // All or several in view nothing is chosen, and the form asks.
  const chosen = writable.some(w => w.id === where) ? where
    : writable.length === 1 ? writable[0].id
    : writable.find(w => w.id === project)?.id ?? ''
  const chosenName = writable.find(w => w.id === chosen)?.name ?? ''

  const close = () => { setOpen(false); setTitle(''); setAbout(''); setError('') }
  const submit = async () => {
    if (!title.trim() || !chosen || busy) return
    setBusy(true); setError('')
    try {
      const card = await createCard(chosen, title, about)
      openForEditing(chosen, card.id, card.steps[0]?.path ?? 'index.md')
      close()
      onCreated?.(chosen)
      window.location.hash = entityHash(card.id)
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : String(problem))
    } finally {
      setBusy(false)
    }
  }

  if (!open) return writable.length ? <button type="button" className="card-new-button" onClick={() => setOpen(true)}>＋ New card</button> : null

  // Only the starter examples here: nothing can take a card until a workspace exists.
  if (!writable.length) return <div className="card-form card-new-form" role="group" aria-label="New card" data-new-card-none
    onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); close() } }}>
    <header className="card-new-head">
      <h2>New card</h2>
      <button type="button" className="card-new-close" onClick={close} aria-label="Close">✕</button>
    </header>
    <p className="card-new-note">No project here can take cards yet. Make a workspace in <button type="button" className="card-new-link" onClick={() => { close(); go(hubHash('settings')) }}>Settings</button>, then come back.</p>
    <span className="card-form-actions"><button type="button" onClick={close}>Close</button></span>
  </div>

  return <form className="card-form card-new-form" aria-label="New card" onSubmit={event => { event.preventDefault(); void submit() }}
    onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); close() } }}>
    <header className="card-new-head">
      <h2>New card</h2>
      <button type="button" className="card-new-close" onClick={close} disabled={busy} aria-label="Close">✕</button>
    </header>
    <input className="card-new-title" autoFocus value={title} onChange={event => setTitle(event.target.value)} maxLength={120} placeholder="What is this card about?" aria-label="Title" disabled={busy} />
    <input value={about} onChange={event => setAbout(event.target.value)} maxLength={400} placeholder="One line shown on the board (optional)" aria-label="Description" disabled={busy} />
    {/* Chips rather than a <select>: the native list ignores the dark theme on most browsers. */}
    {writable.length === 1
      ? <p className="card-new-target" data-new-card-target>Goes in <strong>{writable[0].name}</strong></p>
      : <div className="card-new-projects" role="radiogroup" aria-label="Project">
      <span className="card-new-label">{chosen ? 'Project' : 'Project: pick one'}</span>
      {writable.map(w => <button key={w.id} type="button" role="radio" aria-checked={w.id === chosen} className="card-new-project"
        onClick={() => setWhere(w.id)} disabled={busy}>{w.name}</button>)}
    </div>}
    <span className="card-form-actions">
      {error && <p className="card-form-error" role="alert">{error}</p>}
      <button type="button" onClick={close} disabled={busy}>Cancel</button>
      <button type="submit" disabled={busy || !title.trim() || !chosen}>{busy ? 'Creating…' : chosen ? `Create in ${chosenName}` : 'Pick a project'}</button>
    </span>
  </form>
}
