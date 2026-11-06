import { useState } from 'react'
import type { Item } from '../lib/hub'
import { hubPost } from '../lib/hub'
import { host } from '../lib/host'
import { hold, useHeld } from './heldSend'
import { itemKey } from './needsFocus'

/**
 * Mark done for a review or a blocked row: a create-only write that hides it from Needs you. It is held for seven seconds with
 * Undo (`hold`), and the row is hidden by what is held, so Undo brings it back everywhere. A read-only copy gets the sign-in note instead.
 */
export function useMarkDone(item: Item, onDone: () => void, primary = true) {
  const held = useHeld()
  const [note, setNote] = useState(false)
  const busy = held.keys.has(itemKey(item))
  function done() {
    if (!host.write) { setNote(true); return }
    const id = encodeURIComponent(item.kind === 'blocked' ? item.file ?? item.id : item.id)
    if (hold({ key: itemKey(item), title: item.title.slice(0, 90), verb: 'Marked done', send: keepalive => hubPost(`/${item.kind === 'blocked' ? 'blocked' : 'reviews'}/${id}/done`, {}, undefined, false, keepalive) })) onDone()
  }
  return {
    button: <button type="button" className={`hub-btn${primary ? ' pri' : ''}`} title="Hide from Needs you. Does not approve or merge." disabled={busy} aria-disabled={host.write ? undefined : 'true'} onClick={done}>Mark done</button>,
    notes: (
      <>
        {note && <p className="hub-muted" data-readonly-note>Sign in to mark this done.</p>}
      </>
    ),
  }
}
