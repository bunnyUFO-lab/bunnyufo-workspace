import { useEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

/** A small modal: closes on Esc and on a click outside, and is a bottom sheet on a phone (cards.css). */
export default function Dialog({ title, onClose, children, wide = false }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    // Capture, so Esc closes the dialog before App reads it as "back to the cards".
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopImmediatePropagation(); event.preventDefault(); onClose() } }
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  }, [onClose])
  useEffect(() => { box.current?.querySelector<HTMLElement>('input, select, button')?.focus() }, [])
  return createPortal(
    <div className="lib-scrim" onPointerDown={event => { if (event.target === event.currentTarget) onClose() }}>
      <div ref={box} className={`lib-dialog${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} onPointerDown={event => event.stopPropagation()}>
        <h2 className="lib-dialog-title">{title}</h2>
        {children}
      </div>
    </div>,
    document.body,
  )
}
