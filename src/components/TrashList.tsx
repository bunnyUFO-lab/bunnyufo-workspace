import { useState } from 'react'
import { canManage } from '../lib/library'
import { restore, type TrashEntry } from '../lib/trash'
import Dialog from './Dialog'

/** The Trash: what was deleted from the workspaces in view, with a way back. */
export default function TrashList({ entries, onClose }: { entries: TrashEntry[]; onClose: () => void }) {
  const [busy, setBusy] = useState<string | null>(null)
  return (
    <Dialog title="Trash" onClose={onClose} wide>
      {entries.length === 0 ? <p>The Trash is empty.</p> : (
        <ul className="lib-trash" aria-label="Deleted cards">
          {entries.map(entry => (
            <li key={`${entry.workspace.id}/${entry.id}`} data-trash={entry.id}>
              <span className="lib-trash-title">{entry.entity.title}</span>
              <span className="lib-trash-meta">{entry.workspace.name} · deleted {entry.at}</span>
              {canManage(entry.workspace) && (
                <button type="button" disabled={busy !== null} onClick={async () => { setBusy(entry.id); await restore(entry); setBusy(null) }}>Restore</button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  )
}
