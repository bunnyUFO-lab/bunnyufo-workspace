import { useState } from 'react'
import type { WorkspaceCard } from '../types'
import { moveCard, type MoveProgress } from '../lib/cards'
import { entityHash } from '../lib/route'
import { categoriesOf, takesCards, useLibrary } from '../lib/library'
import Combobox from '../hub/Combobox'
import Dialog from './Dialog'
import { showUndo } from '../lib/undo'

const size = (bytes: number) => bytes >= 1024 * 1024 * 1024 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : bytes >= 1024 * 1024 ? `${Math.round(bytes / 1024 / 1024)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`
const message = (problem: unknown) => problem instanceof Error ? problem.message : String(problem)

/** "Move to workspace…": pick where the card goes, and optionally its category there. */
export default function MoveCard({ card, onClose }: { card: WorkspaceCard; onClose: () => void }) {
  const { workspaces, cards } = useLibrary()
  const targets = workspaces.filter(w => w.id !== card.workspace.id && takesCards(w))
  const [to, setTo] = useState(targets[0]?.id ?? '')
  const [category, setCategory] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [progress, setProgress] = useState<MoveProgress | null>(null)
  const target = targets.find(w => w.id === to)
  const known = categoriesOf(cards, to)
  const go = async () => {
    if (!target || busy) return
    setBusy(true); setError(''); setProgress(null)
    try {
      const answer = await moveCard(card.workspace.id, card.id, target.id, category, setProgress)
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
            <Combobox id="lib-move-to" value={to} onChange={setTo} disabled={busy} openLabel="Show workspaces"
              options={targets.map(w => ({ value: w.id, label: w.name, keywords: [w.id] }))} />
          </label>
          <label>Category
            <input list="lib-move-categories" value={category} onChange={event => setCategory(event.target.value)} placeholder={`Keep (${card.category || 'other'})`} maxLength={48} disabled={busy} />
            <datalist id="lib-move-categories">{known.map(c => <option key={c.label} value={c.label} />)}</datalist>
          </label>
          <p className="lib-note">Links keep working. The files stay in {card.workspace.name} too. A card can have up to 5,000 files or 2 GB.</p>
          <span className="lib-actions">
            <button type="submit" disabled={busy || !target}>{busy ? 'Moving…' : 'Move'}</button>
            <button type="button" onClick={onClose} disabled={busy}>Cancel</button>
          </span>
          {busy && progress && progress.total > 20 && (
            <div className="lib-progress" role="status">
              <progress max={progress.total} value={progress.done} aria-label="Files copied" />
              <span>Copying {progress.done} of {progress.total} files ({size(progress.doneBytes)} of {size(progress.bytes)}). Leave this page open. If it stops, press Move again to carry on.</span>
            </div>
          )}
          {error && <p className="card-form-error" role="alert">{error}</p>}
        </form>
      )}
    </Dialog>
  )
}
