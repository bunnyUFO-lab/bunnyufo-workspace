import { useState } from 'react'
import type { Item } from '../lib/hub'
import { hubPost } from '../lib/hub'
import { host } from '../lib/host'

/** Mark done for a review or a blocked row: a create-only write that hides it from Needs you. A read-only copy gets the sign-in note instead. */
export function useMarkDone(item: Item, onDone: () => void) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [note, setNote] = useState(false)
  async function done() {
    if (!host.write) { setNote(true); return }
    setBusy(true)
    setError('')
    try {
      const id = encodeURIComponent(item.kind === 'blocked' ? item.file ?? item.id : item.id)
      await hubPost(`/${item.kind === 'blocked' ? 'blocked' : 'reviews'}/${id}/done`)
      onDone()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not mark this done.')
      setBusy(false)
    }
  }
  return {
    button: <button type="button" className="hub-btn pri" title="Hide from Needs you. Does not approve or merge." disabled={busy} aria-disabled={host.write ? undefined : 'true'} onClick={done}>Mark done</button>,
    notes: (
      <>
        {error && <p className="hub-error" role="alert">{error}</p>}
        {note && <p className="hub-muted" data-readonly-note>Sign in to mark this done.</p>}
      </>
    ),
  }
}
