import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useOverlayEntry } from '../lib/entries'
import { IconButton } from './Controls'

/** A bottom sheet on a phone, a dialog at 900 px and up. Open adds one history entry; Back closes it and stays on the screen. */
export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useOverlayEntry(true, onClose)
  return createPortal(
    <div className="ui-scrim" onClick={event => { if (event.target === event.currentTarget) window.history.back() }}>
      <div className="ui-sheet" role="dialog" aria-modal="true" aria-label={title}>
        <div className="ui-sheet-h"><h2>{title}</h2><IconButton icon="x" label="Close" onClick={() => window.history.back()} /></div>
        <div className="ui-sheet-b">{children}</div>
      </div>
    </div>,
    document.body,
  )
}
