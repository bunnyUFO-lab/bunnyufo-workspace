import { useState, type ReactNode } from 'react'
import type { WorkspaceCard } from '../types'
import { deleteCard, restoreCard, updateCard } from '../lib/cards'
import { reportError } from '../local/client'
import { canManage, categoriesOf, useLibrary } from '../lib/library'
import type { MenuItem } from './ItemMenu'
import Dialog from './Dialog'
import MoveCard from './MoveCard'
import { showUndo } from '../lib/undo'

const message = (problem: unknown) => problem instanceof Error ? problem.message : String(problem)

/** Title and description of a card, in a dialog (the same fields as the pencil in the breadcrumb). */
export function RenameCardDialog({ card, onClose }: { card: WorkspaceCard; onClose: () => void }) {
  const [title, setTitle] = useState(card.title)
  const [about, setAbout] = useState(card.description ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const save = async () => {
    if (!title.trim() || busy) return
    setBusy(true); setError('')
    try {
      const before = { title: card.title, description: card.description ?? '' }
      await updateCard(card.workspace.id, card.id, { title, description: about })
      onClose()
      showUndo(`Renamed to “${title.trim()}”`, () => updateCard(card.workspace.id, card.id, before))
    } catch (problem) { setError(message(problem)); setBusy(false) }
  }
  return (
    <Dialog title="Rename card" onClose={onClose}>
      <form className="lib-form" onSubmit={event => { event.preventDefault(); void save() }}>
        <label>Title<input value={title} onChange={event => setTitle(event.target.value)} maxLength={120} disabled={busy} /></label>
        <label>Description<input value={about} onChange={event => setAbout(event.target.value)} maxLength={400} disabled={busy} /></label>
        <span className="lib-actions">
          <button type="submit" disabled={busy || !title.trim()}>{busy ? 'Saving…' : 'Save'}</button>
          <button type="button" onClick={onClose} disabled={busy}>Cancel</button>
        </span>
        {error && <p className="card-form-error" role="alert">{error}</p>}
      </form>
    </Dialog>
  )
}

/** Pick one of the workspace's categories for a card, or start a new one. */
function CategoryDialog({ card, onClose }: { card: WorkspaceCard; onClose: () => void }) {
  const { cards } = useLibrary()
  const current = card.category || 'other'
  const [fresh, setFresh] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const set = async (category: string) => {
    if (busy || !category.trim()) return
    setBusy(true); setError('')
    try {
      const updated = await updateCard(card.workspace.id, card.id, { category })
      onClose()
      showUndo(`“${card.title}” is now in ${updated.category || 'other'}`, () => updateCard(card.workspace.id, card.id, { category: current }))
    } catch (problem) { setError(message(problem)); setBusy(false) }
  }
  return (
    <Dialog title={`Category of “${card.title}”`} onClose={onClose}>
      <ul className="lib-choices" aria-label="Categories">
        {categoriesOf(cards, card.workspace.id).map(c => (
          <li key={c.label}>
            <button type="button" className={c.label === current ? 'on' : ''} aria-current={c.label === current} disabled={busy || c.label === current} onClick={() => void set(c.label)}>
              {c.label.replace(/-/g, ' ')} <span className="lib-count">{c.count}</span>
            </button>
          </li>
        ))}
      </ul>
      <form className="lib-form lib-inline" onSubmit={event => { event.preventDefault(); void set(fresh) }}>
        <input value={fresh} onChange={event => setFresh(event.target.value)} placeholder="New category" aria-label="New category" maxLength={48} disabled={busy} />
        <button type="submit" disabled={busy || !fresh.trim()}>Use</button>
      </form>
      {error && <p className="card-form-error" role="alert">{error}</p>}
    </Dialog>
  )
}

/**
 * The card's menu: Rename, Category, Move to workspace, Delete (into the Trash, with Undo). Items are
 * null where the person may not change the card; `dialogs` is the node to render beside the trigger.
 */
export function useCardMenu(card: WorkspaceCard): { items: MenuItem[] | null; dialogs: ReactNode } {
  const [dialog, setDialog] = useState<'rename' | 'category' | 'move' | null>(null)
  const { workspaces } = useLibrary()
  if (!canManage(card.workspace)) return { items: null, dialogs: null }
  const close = () => setDialog(null)
  const others = workspaces.filter(w => w.id !== card.workspace.id && canManage(w))
  const remove = async () => {
    try {
      await deleteCard(card.workspace.id, card.id)
      showUndo(`Deleted “${card.title}” (in the Trash)`, () => restoreCard(card.workspace.id, card.id))
    } catch (problem) { reportError(problem) }
  }
  return {
    items: [
      { label: 'Rename…', onSelect: () => setDialog('rename') },
      { label: 'Category…', onSelect: () => setDialog('category') },
      { label: 'Move to workspace…', onSelect: () => setDialog('move'), disabled: others.length === 0 },
      { label: 'Delete', onSelect: () => void remove(), danger: true },
    ],
    dialogs: dialog === 'rename' ? <RenameCardDialog card={card} onClose={close} />
      : dialog === 'category' ? <CategoryDialog card={card} onClose={close} />
      : dialog === 'move' ? <MoveCard card={card} onClose={close} />
      : null,
  }
}
