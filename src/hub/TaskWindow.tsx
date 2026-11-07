import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * The shell of a task's details: a dimmed scrim and `dialog#hub-map-panel`, a window centred on the screen from 900 px and a bottom sheet below
 * (hub.css). The Roadmap, the Map and the Work board all open a task in it. It is drawn in `document.body`, so no ancestor of the page can clip
 * or move it; the wrapper has `display: contents`, and its `hub` class keeps the `.hub` rules that reach the content.
 *
 * Built from `show()`, the scrim and a Tab loop, not `showModal()`: the top layer would put Spawn, dialogs and the question menu under it.
 * Escape and the scrim close it; a Dialog above it captures Escape first and stops it, so that closes first.
 */
export default function TaskWindow({ title, status, switchKey, onClose, children }: {
  title: ReactNode
  /** The line under the title: id, state, sprint. */
  status?: ReactNode
  /** Changes when the window shows another task: the title takes the focus again. */
  switchKey?: string
  onClose: () => void
  children?: ReactNode
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)

  useEffect(() => {
    const element = dialog.current
    if (element && !element.open) element.show()
  }, [])
  // The title takes the focus on open and on every switch, so a screen reader reads the new task.
  useEffect(() => { heading.current?.focus({ preventScroll: true }) }, [switchKey])
  useEffect(() => {
    // Spawn (a dialog of its own) and a Dialog lie above the window: Escape is theirs first, and closes only them.
    const onKey = (event: globalThis.KeyboardEvent) => { if (event.key === 'Escape' && !event.defaultPrevented && !document.querySelector('[data-spawn-sheet], .lib-scrim')) onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // Tab and Shift+Tab loop inside. A keydown on the dialog itself, not on `window`, so a Dialog above it is not fought.
  const loop = (event: KeyboardEvent<HTMLDialogElement>) => {
    if (event.key !== 'Tab' || event.defaultPrevented) return
    const root = dialog.current
    if (!root) return
    const items = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(item => item.offsetParent !== null || item === document.activeElement)
    if (!items.length) { event.preventDefault(); heading.current?.focus({ preventScroll: true }); return }
    const first = items[0]
    const last = items[items.length - 1]
    const active = document.activeElement
    if (event.shiftKey && (active === first || active === heading.current || !root.contains(active))) { event.preventDefault(); last.focus() }
    else if (!event.shiftKey && (active === last || !root.contains(active))) { event.preventDefault(); first.focus() }
  }

  return createPortal(
    <div className="hub hub-portal">
      <div className="hub-map-scrim" onClick={onClose} aria-hidden="true" />
      <dialog ref={dialog} id="hub-map-panel" className="hub-map-panel" aria-labelledby="hub-map-panel-title" aria-modal="true" onKeyDown={loop}>
        <div className="hub-map-grab" aria-hidden="true" />
        <div className="hub-map-panel-head">
          <div className="hub-map-panel-heading">
            <h3 id="hub-map-panel-title" ref={heading} tabIndex={-1}>{title}</h3>
            {status}
          </div>
          <button type="button" className="hub-map-panel-close" aria-label="Close details" onClick={onClose}>×</button>
        </div>
        {children}
      </dialog>
    </div>,
    document.body,
  )
}
