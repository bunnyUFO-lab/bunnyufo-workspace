import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

export interface MenuItem {
  label: string
  onSelect: () => void
  disabled?: boolean
  danger?: boolean
}

/** Where the app's overlay menu turns into a bottom sheet (the same breakpoint as the sidebar). */
const SHEET = '(max-width: 960px)'
const sheet = () => window.matchMedia(SHEET).matches

interface MenuProps {
  items: MenuItem[]
  label: string
  /** The point or box the popover hangs from (desktop). */
  anchor: { x: number; y: number }
  onClose: () => void
}

/**
 * The open menu: a popover beside its anchor, or a bottom sheet on a phone. Keyboard reachable
 * (arrows move, Enter and Space pick, Esc closes) and `role="menu"`.
 */
export function Menu({ items, label, anchor, onClose }: MenuProps) {
  const box = useRef<HTMLDivElement>(null)
  const [at, setAt] = useState<{ left: number; top: number } | null>(null)
  const asSheet = sheet()
  useLayoutEffect(() => {
    if (asSheet) return
    const el = box.current
    if (!el) return
    const margin = 8
    const left = Math.max(margin, Math.min(anchor.x, window.innerWidth - el.offsetWidth - margin))
    const top = anchor.y + el.offsetHeight + margin > window.innerHeight ? Math.max(margin, anchor.y - el.offsetHeight - 30) : anchor.y
    setAt({ left, top })
  }, [anchor, asSheet])
  useEffect(() => {
    const outside = (event: PointerEvent) => { if (!box.current?.contains(event.target as Node)) onClose() }
    // Capture, so Esc closes the menu before App reads it as "back to the cards".
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.stopImmediatePropagation(); event.preventDefault(); onClose() }
    }
    document.addEventListener('pointerdown', outside)
    window.addEventListener('keydown', key, true)
    return () => { document.removeEventListener('pointerdown', outside); window.removeEventListener('keydown', key, true) }
  }, [onClose])
  // Focus the first item once the popover is placed: a hidden element cannot take the focus.
  useEffect(() => {
    if (asSheet || at) box.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
  }, [asSheet, at])
  const move = (event: React.KeyboardEvent) => {
    const buttons = [...(box.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])]
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement)
    if (event.key === 'ArrowDown') buttons[(at + 1) % buttons.length]?.focus()
    else if (event.key === 'ArrowUp') buttons[(at - 1 + buttons.length) % buttons.length]?.focus()
    else if (event.key === 'Home') buttons[0]?.focus()
    else if (event.key === 'End') buttons[buttons.length - 1]?.focus()
    else if (event.key === 'Tab') { event.preventDefault(); onClose(); return }
    else return
    event.preventDefault()
  }
  return createPortal(
    <>
      {asSheet && <div className="item-menu-scrim" aria-hidden="true" />}
      <div
        ref={box}
        className={`item-menu${asSheet ? ' sheet' : ''}`}
        role="menu"
        aria-label={label}
        style={asSheet ? undefined : { left: at?.left ?? anchor.x, top: at?.top ?? anchor.y, visibility: at ? 'visible' : 'hidden' }}
        // The card or heading underneath starts a drag on pointerdown; a pick is not a drag.
        onPointerDown={event => event.stopPropagation()}
        onKeyDown={move}
      >
        {items.map(item => (
          <button
            key={item.label}
            type="button"
            role="menuitem"
            className={item.danger ? 'danger' : undefined}
            disabled={item.disabled}
            onClick={() => { onClose(); item.onSelect() }}
          >
            {item.label}
          </button>
        ))}
      </div>
    </>,
    document.body,
  )
}

/** The right-click menu of anything: spread `props` on the element, render `menu` anywhere. */
export function useContextMenu(label: string, items: MenuItem[] | null) {
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null)
  const close = useCallback(() => setAnchor(null), [])
  const props = items ? { onContextMenu: (event: ReactMouseEvent) => { event.preventDefault(); event.stopPropagation(); setAnchor({ x: event.clientX, y: event.clientY }) } } : {}
  const menu = items && anchor ? <Menu items={items} label={label} anchor={anchor} onClose={close} /> : null
  return { props, menu }
}

/** A "⋯" button that opens a menu. Give it `items: null` where the person may not change anything. */
export default function ItemMenu({ label, items, className = '', children }: { label: string; items: MenuItem[] | null; className?: string; children?: ReactNode }) {
  const button = useRef<HTMLButtonElement>(null)
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null)
  const id = useId()
  const close = useCallback(() => { setAnchor(null); button.current?.focus() }, [])
  if (!items) return null
  return (
    <>
      <button
        ref={button}
        type="button"
        className={`item-menu-button ${className}`.trim()}
        aria-haspopup="menu"
        aria-expanded={!!anchor}
        aria-controls={anchor ? id : undefined}
        title={label}
        aria-label={label}
        // The card underneath starts a drag on pointerdown.
        onPointerDown={event => event.stopPropagation()}
        onClick={() => {
          const box = button.current?.getBoundingClientRect()
          setAnchor(anchor ? null : { x: box?.left ?? 0, y: (box?.bottom ?? 0) + 4 })
        }}
      >
        {children ?? '⋯'}
      </button>
      {anchor && <Menu items={items} label={label} anchor={anchor} onClose={close} />}
    </>
  )
}
