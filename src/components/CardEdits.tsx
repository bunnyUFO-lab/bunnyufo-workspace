import { useEffect, useState } from 'react'
import type { WorkspaceCard } from '../types'
import { addSection, openForEditing, restoreSection, updateCard } from '../lib/cards'
import type { SectionKind } from '../lib/cards'
import './cards.css'

const message = (problem: unknown) => problem instanceof Error ? problem.message : String(problem)

/** The "+" after a card's tabs: name a new Markdown section or drawing, and it opens in the editor. */
export function AddSection({ card, onStep, onNaming }: { card: WorkspaceCard; onStep: (id: string, index: number) => void; onNaming?: () => void }) {
  const [naming, setNaming] = useState(false)
  // The tab bar re-measures its overflow when the button turns into the form and back.
  useEffect(() => { onNaming?.() }, [naming]) // eslint-disable-line react-hooks/exhaustive-deps
  const [name, setName] = useState('')
  const [kind, setKind] = useState<SectionKind>('markdown')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const removed = card.removedTabs ?? []
  const close = () => { setNaming(false); setName(''); setKind('markdown'); setError('') }
  // The name offered for a drawing is replaced by the user's own, but a name they typed is kept.
  const pick = (next: SectionKind) => {
    setKind(next)
    setName(current => next === 'drawing' ? (current.trim() ? current : 'Drawing') : (current === 'Drawing' ? '' : current))
  }
  const submit = async () => {
    if (!name.trim() || busy) return
    setBusy(true); setError('')
    try {
      const { step, path } = await addSection(card.workspace.id, card.id, name, kind)
      openForEditing(card.workspace.id, card.id, path)
      close()
      onStep(card.id, step)
    } catch (problem) { setError(message(problem)) } finally { setBusy(false) }
  }
  if (!naming) return <button type="button" className="step-tab step-tab-add" onClick={() => setNaming(true)} title="Add a section" aria-label="Add a section">＋</button>
  return <form className="card-form card-inline-form" aria-label="New section" onSubmit={event => { event.preventDefault(); void submit() }}
    onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); close() } }}>
    <span className="kind-picker" role="radiogroup" aria-label="Kind of section">
      {(['markdown', 'drawing'] as const).map(option => <button key={option} type="button" role="radio" aria-checked={kind === option} className={kind === option ? 'on' : ''} onClick={() => pick(option)} disabled={busy}>{option === 'markdown' ? 'Markdown' : 'Drawing'}</button>)}
    </span>
    <input autoFocus value={name} onChange={event => setName(event.target.value)} maxLength={60} placeholder="Section name" aria-label="Section name" disabled={busy} />
    <button type="submit" disabled={busy || !name.trim()}>{busy ? 'Adding…' : 'Add'}</button>
    <button type="button" onClick={close} disabled={busy} aria-label="Cancel">✕</button>
    {removed.length > 0 && (
      <details className="removed-tabs">
        <summary>Removed tabs ({removed.length})</summary>
        <ul>
          {removed.map(tab => (
            <li key={tab.path}>
              <span>{tab.name}</span>
              <button type="button" disabled={busy} onClick={async () => {
                setBusy(true); setError('')
                try { const back = await restoreSection(card.workspace.id, card.id, tab.path); close(); onStep(card.id, back.step) } catch (problem) { setError(message(problem)) } finally { setBusy(false) }
              }}>Restore</button>
            </li>
          ))}
        </ul>
      </details>
    )}
    {error && <p className="card-form-error" role="alert">{error}</p>}
  </form>
}

/** The pencil beside a card's title: change its title and the line shown on the board. */
export function EditCard({ card }: { card: WorkspaceCard }) {
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState(card.title)
  const [about, setAbout] = useState(card.description ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const start = () => { setTitle(card.title); setAbout(card.description ?? ''); setError(''); setOpen(true) }
  const submit = async () => {
    if (!title.trim() || busy) return
    setBusy(true); setError('')
    try {
      await updateCard(card.workspace.id, card.id, { title, description: about })
      setOpen(false)
    } catch (problem) { setError(message(problem)) } finally { setBusy(false) }
  }
  if (!open) return <button type="button" className="crumb-edit" onClick={start} title="Edit the title and description" aria-label="Edit the card's title and description">✎</button>
  return <form className="card-form card-edit-form" aria-label="Edit card" onSubmit={event => { event.preventDefault(); void submit() }}
    onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); setOpen(false) } }}>
    <label>Title<input autoFocus value={title} onChange={event => setTitle(event.target.value)} maxLength={120} disabled={busy} /></label>
    <label>Description<input value={about} onChange={event => setAbout(event.target.value)} maxLength={400} disabled={busy} /></label>
    <span className="card-form-actions">
      <button type="submit" disabled={busy || !title.trim()}>{busy ? 'Saving…' : 'Save'}</button>
      <button type="button" onClick={() => setOpen(false)} disabled={busy}>Cancel</button>
    </span>
    {error && <p className="card-form-error" role="alert">{error}</p>}
  </form>
}
