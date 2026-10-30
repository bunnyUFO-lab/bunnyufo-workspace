import { useState } from 'react'
import type { WorkspaceCard } from '../types'
import { moveCard } from '../lib/cards'
import { entityHash } from '../lib/route'
import { categoriesOf, takesCards, useLibrary } from '../lib/library'
import Dialog from './Dialog'
import { showUndo } from '../lib/undo'

const message = (problem: unknown) => problem instanceof Error ? problem.message : String(problem)

/** "Move to workspace…": pick where the card goes, and optionally its category there. */
export default function MoveCard({ card, onClose }: { card: WorkspaceCard; onClose: () => void }) {
  const { workspaces, cards } = useLibrary()
  const targets = workspaces.filter(w => w.id !== card.workspace.id && takesCards(w))
  const [to, setTo] = useState(targets[0]?.id ?? '')
  const [category, setCategory] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const target = targets.find(w => w.id === to)
  const known = categoriesOf(cards, to)
  const go = async () => {
    if (!target || busy) return
    setBusy(true); setError('')
    try {
      const answer = await moveCard(card.workspace.id, card.id, target.id, category)
      onClose()
      window.location.assign(entityHash(card.id))
      showUndo(`Moved “${card.title}” to ${target.name}${answer.warning ? ' (pins and tags need redoing)' : ''}`, () => moveCard(target.id, card.id, card.workspace.id, card.category))
    } catch (problem) { setError(message(problem)); setBusy(false) }
  }
  return (
    <Dialog title={`Move “${card.title}”`} onClose={busy ? () => {} : onClose}>
      {targets.length === 0 ? <p>There is no other workspace to move it to.</p> : (
        <form className="lib-form" onSubmit={event => { event.preventDefault(); void go() }}>
          <label>Move to
            <select value={to} onChange={event => setTo(event.target.value)} disabled={busy}>
              {targets.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
          </label>
          <label>Category
            <input list="lib-move-categories" value={category} onChange={event => setCategory(event.target.value)} placeholder={`Keep (${card.category || 'other'})`} maxLength={48} disabled={busy} />
            <datalist id="lib-move-categories">{known.map(c => <option key={c.label} value={c.label} />)}</datalist>
          </label>
          <p className="lib-note">Links keep working. The files stay in {card.workspace.name} too.</p>
          <span className="lib-actions">
            <button type="submit" disabled={busy || !target}>{busy ? 'Moving…' : 'Move'}</button>
            <button type="button" onClick={onClose} disabled={busy}>Cancel</button>
          </span>
          {error && <p className="card-form-error" role="alert">{error}</p>}
        </form>
      )}
    </Dialog>
  )
}
