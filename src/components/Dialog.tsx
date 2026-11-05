import { useEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

/** A small modal: closes on Esc and on a click outside, and is a bottom sheet on a phone (cards.css). */
export default function Dialog({ title, onClose, children, wide = false }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const box = useRef<HTMLDivElement>(null)
  // The scrim closes on the click, not the press: closing on the press leaves the tap's click to land on whatever lies under it.
  // It closes only when the press began on the scrim too, so a drag that starts in the dialog and ends outside keeps it open.
  const pressed = useRef(false)
  useEffect(() => {
    // Capture, so Esc closes the dialog before App reads it as "back to the cards".
    const key = (event: KeyboardEvent) => {
      // An open list inside the dialog (a Combobox) takes the first Escape itself.
      if (event.key === 'Escape' && (event.target as Element | null)?.closest?.('.cb')?.querySelector('[role="combobox"][aria-expanded="true"]')) return
      if (event.key === 'Escape') { event.stopImmediatePropagation(); event.preventDefault(); onClose() } }
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  }, [onClose])
  useEffect(() => {
    // A Combobox first would open its list (and the phone keyboard) on focus: land on the dialog itself then.
    const first = box.current?.querySelector<HTMLElement>('input, select, button')
    if (first?.getAttribute('role') === 'combobox') box.current?.focus()
    else first?.focus()
  }, [])
  return createPortal(
    <div className="lib-scrim" onPointerDown={event => { pressed.current = event.target === event.currentTarget }} onClick={event => { const close = pressed.current && event.target === event.currentTarget; pressed.current = false; if (close) onClose() }}>
      <div ref={box} tabIndex={-1} className={`lib-dialog${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} onPointerDown={event => event.stopPropagation()}>
        <h2 className="lib-dialog-title">{title}</h2>
        {children}
      </div>
    </div>,
    document.body,
  )
}
