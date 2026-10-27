import { useState } from 'react'
import type { CardWorkspace } from '../types'
import { createCard, openForEditing } from '../lib/cards'
import { entityHash } from '../lib/route'
import './cards.css'

/**
 * "New card" on the board: a title, an optional line about it, and the project it goes in. The
 * card starts with one Markdown section and opens on it, in the editor.
 */
export default function NewCard({ workspaces, project, open, onOpen }: {
  workspaces: CardWorkspace[]
  project: string
  /** The board shows the button in its header and the form under it, so it holds this. */
  open: boolean
  onOpen: (open: boolean) => void
}) {
  const writable = workspaces.filter(w => !w.builtin)
  const setOpen = onOpen
  const [where, setWhere] = useState('')
  const [title, setTitle] = useState('')
  const [about, setAbout] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  // What was picked, else the project in view, else the first one that can take cards.
  const chosen = writable.some(w => w.id === where) ? where : writable.find(w => w.id === project)?.id ?? writable[0]?.id ?? ''

  if (!writable.length) return null

  const close = () => { setOpen(false); setTitle(''); setAbout(''); setError('') }
  const submit = async () => {
    if (!title.trim() || !chosen || busy) return
    setBusy(true); setError('')
    try {
      const card = await createCard(chosen, title, about)
      openForEditing(chosen, card.id, card.steps[0]?.path ?? 'index.md')
      close()
      window.location.hash = entityHash(card.id)
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : String(problem))
    } finally {
      setBusy(false)
    }
  }

  if (!open) return <button type="button" className="card-new-button" onClick={() => setOpen(true)}>＋ New card</button>

  return <form className="card-form card-new-form" aria-label="New card" onSubmit={event => { event.preventDefault(); void submit() }}
    onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); close() } }}>
    <header className="card-new-head">
      <h2>New card</h2>
      <button type="button" className="card-new-close" onClick={close} disabled={busy} aria-label="Close">✕</button>
    </header>
    <input className="card-new-title" autoFocus value={title} onChange={event => setTitle(event.target.value)} maxLength={120} placeholder="What is this card about?" aria-label="Title" disabled={busy} />
    <input value={about} onChange={event => setAbout(event.target.value)} maxLength={400} placeholder="One line shown on the board (optional)" aria-label="Description" disabled={busy} />
    {/* Chips rather than a <select>: the native list ignores the dark theme on most browsers. */}
    {writable.length > 1 && <div className="card-new-projects" role="radiogroup" aria-label="Project">
      <span className="card-new-label">Project</span>
      {writable.map(w => <button key={w.id} type="button" role="radio" aria-checked={w.id === chosen} className="card-new-project"
        onClick={() => setWhere(w.id)} disabled={busy}>{w.name}</button>)}
    </div>}
    <span className="card-form-actions">
      {error && <p className="card-form-error" role="alert">{error}</p>}
      <button type="button" onClick={close} disabled={busy}>Cancel</button>
      <button type="submit" disabled={busy || !title.trim() || !chosen}>{busy ? 'Creating…' : 'Create card'}</button>
    </span>
  </form>
}
