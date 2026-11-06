import { useEffect, useState } from 'react'
import { host } from '../lib/host'
import { canManage, useLibrary } from '../lib/library'
import { purgeDue, purgeOn, restore, type TrashEntry } from '../lib/trash'
import Dialog from './Dialog'

/**
 * The Trash's rows: what was deleted from the workspaces in view, each with its way back. Drawn inline by the Library's Trash view
 * and in the dialog below. Opening them asks the site to empty what is due, once.
 */
export function TrashRows({ entries, className = 'lib-trash' }: { entries: TrashEntry[]; className?: string }) {
  const [busy, setBusy] = useState<string | null>(null)
  // On the site the Trash empties itself after 30 days, when someone opens it. Not in the local app: nothing is deleted there.
  const purges = host.purge
  const { workspaces, cards } = useLibrary()
  useEffect(() => {
    if (purges) purgeDue(workspaces, cards)
  // Once, when the Trash opens.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [purges])
  return (
    <ul className={className} aria-label="Deleted cards" data-trash-rows>
      {entries.map(entry => (
        <li key={`${entry.workspace.id}/${entry.id}`} data-trash={entry.id}>
          <span className="lib-trash-title">{entry.entity.title}</span>
          <span className="lib-trash-meta">{entry.workspace.name} · deleted {entry.at}{purges && purgeOn(entry.at) && <> · Deleted forever on {purgeOn(entry.at)}</>}</span>
          {canManage(entry.workspace) && (
            <button type="button" disabled={busy !== null} onClick={async () => { setBusy(entry.id); await restore(entry); setBusy(null) }}>Restore</button>
          )}
        </li>
      ))}
    </ul>
  )
}

/** The Trash in a dialog. */
export default function TrashList({ entries, onClose }: { entries: TrashEntry[]; onClose: () => void }) {
  return (
    <Dialog title="Trash" onClose={onClose} wide>
      {entries.length === 0 && <p>The Trash is empty.</p>}
      <TrashRows entries={entries} />
    </Dialog>
  )
}
