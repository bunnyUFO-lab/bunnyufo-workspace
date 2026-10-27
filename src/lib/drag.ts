import { useCallback, useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import type { WorkspaceCard } from '../types'

/**
 * Dragging a card, a project or a section heading, on pointer events rather than HTML5 drag-and-drop.
 *
 * The native API looks like the obvious choice and is the wrong one here: a `dragstart` only
 * happens for an OS-level drag, so a synthetic mouse press — a touch screen, a pen, an
 * accessibility tool, or the browser automation we check this app with — never starts one. The
 * drop targets were unreachable for all of them, and untestable for us. Pointer events are the
 * same gesture with none of that: press, move past a few pixels, release over a target.
 *
 * A target is any element carrying `data-drop`; the hook finds it under the pointer, so zones
 * are plain markup and only this file knows how a drag works.
 */

/** `order`, `project` and `section` rearrange a list; the others change a card's state. */
export type DropKind = 'pin' | 'unpin' | 'archive' | 'order' | 'project' | 'section'

/** What is in the air: a card, a project (a chip or a project's heading) or a category heading. */
export type DragItem =
  | { kind: 'card'; card: WorkspaceCard }
  | { kind: 'project'; id: string }
  | { kind: 'section'; label: string }

export interface DropTarget {
  kind: DropKind
  /** Pinned rows: which one the pointer is over, and which side of it the card would land. */
  index?: number
  edge?: 'before' | 'after'
  /** Rearranging: the element under the pointer (a card key, a project id or a section label)… */
  key?: string
  /** …and, for a card, the section it sits in. */
  section?: string
}

/** Pixels the pointer must travel before a press counts as a drag and not a click. */
const THRESHOLD = 5

const targetAt = (x: number, y: number): DropTarget | null => {
  const element = document.elementFromPoint(x, y)?.closest('[data-drop]') as HTMLElement | null
  if (!element) return null
  const kind = element.dataset.drop as DropKind
  if (!kind) return null
  const raw = element.dataset.dropIndex
  const key = element.dataset.dropKey
  if (raw === undefined && key === undefined) return { kind }
  const box = element.getBoundingClientRect()
  // Rows are above and below each other; chips and grid cards are beside each other.
  const before = element.dataset.dropAxis === 'x' ? x < box.left + box.width / 2 : y < box.top + box.height / 2
  return {
    kind,
    index: raw === undefined ? undefined : Number(raw),
    edge: before ? 'before' : 'after',
    key,
    section: element.dataset.dropSection,
  }
}

export function useCardDrag(onDrop: (item: DragItem, target: DropTarget) => void) {
  const [item, setItem] = useState<DragItem | null>(null)
  const [over, setOver] = useState<DropTarget | null>(null)
  // A press that has not moved far enough to be a drag yet.
  const pending = useRef<{ item: DragItem; x: number; y: number } | null>(null)
  // Set between the end of a drag and the click the browser fires after it, so letting go over
  // a card does not also open it.
  const dragged = useRef(false)
  // The window listeners are bound once; this keeps them looking at the current values.
  const latest = useRef({ item, onDrop })
  useEffect(() => { latest.current = { item, onDrop } }, [item, onDrop])

  useEffect(() => {
    const move = (event: PointerEvent) => {
      const start = pending.current
      if (start && !latest.current.item) {
        if (Math.hypot(event.clientX - start.x, event.clientY - start.y) < THRESHOLD) return
        setItem(start.item)
      }
      if (!pending.current) return
      event.preventDefault()
      setOver(targetAt(event.clientX, event.clientY))
    }
    const up = (event: PointerEvent) => {
      const dragging = latest.current.item
      pending.current = null
      if (!dragging) return
      dragged.current = true
      // The click that follows a release over the pressed element comes before the next task; one
      // that never comes (released elsewhere) must not swallow a later keyboard Enter or Space.
      window.setTimeout(() => { dragged.current = false }, 0)
      const target = targetAt(event.clientX, event.clientY)
      setItem(null)
      setOver(null)
      if (target) latest.current.onDrop(dragging, target)
    }
    const cancel = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      pending.current = null
      setItem(null)
      setOver(null)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
    window.addEventListener('keydown', cancel)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      window.removeEventListener('keydown', cancel)
    }
  }, [])

  const begin = useCallback((entity: WorkspaceCard, event: ReactPointerEvent) => {
    // Left button only, and never from a button inside the row: those have their own job.
    if (event.button !== 0 || (event.target as HTMLElement).closest('button')) return
    pending.current = { item: { kind: 'card', card: entity }, x: event.clientX, y: event.clientY }
    dragged.current = false
  }, [])

  /** A project chip or a section heading. Those are buttons themselves, so unlike a card they
   *  start a drag from the button; the few pixels of travel are what tell it from a click. */
  const beginItem = useCallback((dragItem: DragItem, event: ReactPointerEvent) => {
    if (event.button !== 0) return
    pending.current = { item: dragItem, x: event.clientX, y: event.clientY }
    dragged.current = false
  }, [])

  /** On a link or card: swallow the click that follows a drag. */
  const afterDrag = useCallback(() => {
    if (!dragged.current) return false
    dragged.current = false
    return true
  }, [])

  return { card: item?.kind === 'card' ? item.card : null, item, over, begin, beginItem, afterDrag }
}
