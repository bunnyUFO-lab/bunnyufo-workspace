import { useId, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import type { Item } from '../lib/hub'
import { hubPost } from '../lib/hub'
import { host } from '../lib/host'

/** The reasons offered with one tap. The ids are the Hub's (site/api/hub-feedback.mjs PRESETS). */
const PRESETS: [string, string][] = [
  ['nothing-to-decide', 'Nothing to decide'],
  ['too-long', 'Too long'],
  ['unclear', 'Unclear what to do'],
  ['already-done', 'Already done'],
]

/** The kinds of Needs you item that carry the button. Approvals and run questions keep Decline or an answer. */
const KINDS = ['ask', 'checklist', 'review', 'blocked']

/**
 * "Not useful" for a Needs you card: a quiet button for the header and a small panel under it. One tap on a reason
 * files it; Send files the typed line (or none). The Hub hides the item and records it for the sprint. `button` and
 * `panel` are null where the item has none (an approval, or a blocked row with no event file).
 */
export function useNotUseful(item: Item, onFiled: () => void) {
  const [open, setOpen] = useState(false)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [signIn, setSignIn] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const panelId = useId()
  const id = item.kind === 'blocked' ? item.file : item.id
  if (!KINDS.includes(item.kind) || !id) return { button: null, panel: null }

  function close() {
    setOpen(false)
    setNote('')
    setError('')
    trigger.current?.focus()
  }
  function toggle() {
    if (!host.write) { setSignIn(true); return }
    if (open) close()
    else setOpen(true)
  }
  async function send(preset?: string) {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await hubPost(`/needs/${item.kind}/${encodeURIComponent(id as string)}/not-useful`, { ...(preset ? { preset } : {}), ...(note.trim() ? { note: note.trim() } : {}) })
      onFiled()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not file this.')
      setBusy(false)
    }
  }
  function keys(event: KeyboardEvent) {
    if (event.key === 'Escape') { event.stopPropagation(); close() }
  }

  const button = (
    <button ref={trigger} type="button" className="hub-btn ni-nu" data-not-useful aria-expanded={open} aria-controls={open ? panelId : undefined} aria-disabled={host.write ? undefined : 'true'} title="Tell the sprint this was not worth your time" onClick={toggle}>Not useful</button>
  )
  const panel = (open || signIn) && (
    <div className="ni-nu-panel" onKeyDown={keys}>
      {open && (
        <div id={panelId} role="group" aria-label="Why is this not useful?" data-not-useful-panel>
          <div className="ni-nu-chips">
            {PRESETS.map(([preset, label]) => <button key={preset} type="button" className="hub-btn ni-nu-chip" data-preset={preset} disabled={busy} onClick={() => send(preset)}>{label}</button>)}
          </div>
          <form className="ni-nu-line" onSubmit={event => { event.preventDefault(); send() }}>
            <input type="text" className="ni-nu-input" maxLength={200} value={note} placeholder="Or say why (optional)" aria-label="Or say why (optional)" data-not-useful-note disabled={busy} onChange={event => setNote(event.target.value)} />
            <button type="submit" className="hub-btn pri" data-not-useful-send disabled={busy}>Send</button>
            <button type="button" className="hub-btn" data-not-useful-cancel disabled={busy} onClick={close}>Cancel</button>
          </form>
          {error && <p className="hub-error" role="alert">{error}</p>}
        </div>
      )}
      {signIn && !open && <p className="hub-muted" data-readonly-note>Sign in to mark this.</p>}
    </div>
  )
  return { button, panel: panel || null }
}
