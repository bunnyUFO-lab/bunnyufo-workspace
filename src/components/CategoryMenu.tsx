import { useState, type ReactNode } from 'react'
import { renameCategory } from '../lib/cards'
import { renameCategoryOrder } from '../lib/order'
import { renameCollapsed } from '../lib/collapse'
import { canManage, categoriesOf, useLibrary } from '../lib/library'
import type { MenuItem } from './ItemMenu'
import Dialog from './Dialog'
import { showUndo } from '../lib/undo'

const message = (problem: unknown) => problem instanceof Error ? problem.message : String(problem)
const slugOf = (value: string) => value.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48)

/**
 * Rename a category, or merge it into another. A rename onto a name that exists is a merge and is
 * confirmed first ("Merge 4 cards into Brief?"). The saved order and fold state follow the new name.
 */
function CategoryDialog({ workspace, label, mode, onClose }: { workspace: string; label: string; mode: 'rename' | 'merge'; onClose: () => void }) {
  const { cards, workspaces } = useLibrary()
  const categories = categoriesOf(cards, workspace)
  const count = categories.find(c => c.label === label)?.count ?? 0
  const others = categories.filter(c => c.label !== label)
  const [value, setValue] = useState(mode === 'rename' ? label.replace(/-/g, ' ') : (others[0]?.label ?? ''))
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const target = mode === 'merge' ? value : slugOf(value)
  const merging = mode === 'merge' || others.some(c => c.label === target)
  const run = async () => {
    setBusy(true); setError('')
    try {
      const done = await renameCategory(workspace, label, value)
      renameCategoryOrder(label, done.to)
      renameCollapsed(label, done.to)
      onClose()
      const where = workspaces.find(w => w.id === workspace)?.name ?? workspace
      showUndo(
        done.merged ? `Merged ${done.count} card${done.count === 1 ? '' : 's'} into ${done.to} in ${where}` : `Renamed ${label} to ${done.to}`,
        done.merged ? undefined : async () => { await renameCategory(workspace, done.to, label); renameCategoryOrder(done.to, label); renameCollapsed(done.to, label) },
      )
    } catch (problem) { setError(message(problem)); setBusy(false); setConfirm(false) }
  }
  const submit = () => {
    if (busy || !target || target === label) return
    if (merging && !confirm) { setConfirm(true); return }
    void run()
  }
  return (
    <Dialog title={mode === 'rename' ? `Rename ${label.replace(/-/g, ' ')}` : `Merge ${label.replace(/-/g, ' ')} into…`} onClose={onClose}>
      <form className="lib-form" onSubmit={event => { event.preventDefault(); submit() }}>
        {mode === 'rename' ? (
          <label>New name<input value={value} onChange={event => { setValue(event.target.value); setConfirm(false) }} maxLength={48} disabled={busy} /></label>
        ) : (
          <label>Merge into
            <select value={value} onChange={event => { setValue(event.target.value); setConfirm(false) }} disabled={busy}>
              {others.map(c => <option key={c.label} value={c.label}>{c.label.replace(/-/g, ' ')}</option>)}
              {!others.some(c => c.label === 'other') && <option value="other">other</option>}
            </select>
          </label>
        )}
        {confirm && <p className="lib-note" role="alert">Merge {count} card{count === 1 ? '' : 's'} into {target.replace(/-/g, ' ')}? This cannot be undone in one step.</p>}
        <span className="lib-actions">
          <button type="submit" disabled={busy || !target || target === label}>{busy ? 'Saving…' : confirm ? 'Merge' : mode === 'merge' ? 'Merge…' : merging ? 'Merge…' : 'Rename'}</button>
          <button type="button" onClick={onClose} disabled={busy}>Cancel</button>
        </span>
        {error && <p className="card-form-error" role="alert">{error}</p>}
      </form>
    </Dialog>
  )
}

/** The ⋯ menu of a category heading: Rename…, Merge into…. Null where nothing may be changed. */
export function useCategoryMenu(workspaceId: string | null, label: string): { items: MenuItem[] | null; dialogs: ReactNode } {
  const [dialog, setDialog] = useState<'rename' | 'merge' | null>(null)
  const { workspaces } = useLibrary()
  const workspace = workspaces.find(w => w.id === workspaceId)
  if (!workspaceId || !workspace || !canManage(workspace)) return { items: null, dialogs: null }
  return {
    items: [
      { label: 'Rename…', onSelect: () => setDialog('rename') },
      { label: 'Merge into…', onSelect: () => setDialog('merge') },
    ],
    dialogs: dialog ? <CategoryDialog workspace={workspaceId} label={label} mode={dialog} onClose={() => setDialog(null)} /> : null,
  }
}
