import type { CSSProperties, KeyboardEvent } from 'react'
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ComboOption } from './comboboxLogic'
import { filterOptions, moveActive } from './comboboxLogic'
import './combobox.css'

type Props = {
  /** The id of the text input, so a <label htmlFor> points at it. */
  id: string
  value: string
  options: ComboOption[]
  onChange: (value: string) => void
  disabled?: boolean
  /** The chevron's accessible name, e.g. "Show projects". */
  openLabel: string
  /** Extra attributes for the input (data-* hooks). */
  inputAttrs?: Record<string, string>
}

/**
 * A typeable, filterable picker for lists that grow (projects, repositories). Two hit areas: the chevron opens the list without
 * focusing the input (no phone keyboard), the text focuses the input and filters. Free text is never committed: blur or a
 * second Escape puts the current value's label back.
 */
export default function Combobox({ id, value, options, onChange, disabled, openLabel, inputAttrs }: Props) {
  const uid = useId()
  const listId = `${uid}-list`
  const root = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLUListElement>(null)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState<string | null>(null)
  const [active, setActive] = useState(-1)
  const [place, setPlace] = useState<CSSProperties>({})

  const selected = options.find(option => option.value === value)
  const label = selected?.label ?? ''
  const shown = useMemo(() => (query === null ? options : filterOptions(options, query)), [options, query])

  const close = useCallback(() => { setOpen(false); setActive(-1) }, [])
  const restore = useCallback(() => { setQuery(null); close() }, [close])
  const pick = (option: ComboOption) => { onChange(option.value); restore() }
  const show = () => {
    if (disabled) return
    setOpen(true)
    setActive(Math.max(0, options.findIndex(option => option.value === value)))
  }

  // Fixed to the viewport so the sheet's own scrolling does not clip it; under the field, or above it when there is no room below.
  const position = useCallback(() => {
    const box = root.current?.getBoundingClientRect()
    if (!box) return
    const gap = 4
    const below = innerHeight - box.bottom - gap - 8
    const above = box.top - gap - 8
    const up = below < 200 && above > below
    const room = Math.max(120, Math.min(280, up ? above : below))
    setPlace({ left: box.left, width: box.width, maxHeight: room, ...(up ? { bottom: innerHeight - box.top + gap } : { top: box.bottom + gap }) })
  }, [])
  useLayoutEffect(() => {
    if (!open) return
    position()
    addEventListener('resize', position)
    addEventListener('scroll', position, true)
    return () => { removeEventListener('resize', position); removeEventListener('scroll', position, true) }
  }, [open, position])

  useEffect(() => {
    if (!open || active < 0) return
    list.current?.children[active]?.scrollIntoView?.({ block: 'nearest' })
  }, [open, active])

  const key = (event: KeyboardEvent) => {
    const k = event.key
    if (k === 'ArrowDown' || k === 'ArrowUp' || k === 'Home' || k === 'End') {
      if ((k === 'Home' || k === 'End') && !open) return
      event.preventDefault()
      if (!open) { show(); return }
      setActive(moveActive(active, shown.length, k))
    } else if (k === 'Enter') {
      if (open && active >= 0 && shown[active]) { event.preventDefault(); pick(shown[active]) }
      else if (event.target === input.current) { event.preventDefault(); if (!open) show() }
    } else if (k === 'Escape') {
      if (open) { event.preventDefault(); event.stopPropagation(); close() }
      else if (query !== null) { event.preventDefault(); event.stopPropagation(); setQuery(null) }
    }
  }

  return (
    <div className="cb" ref={root} onKeyDown={key} onBlur={event => { if (!root.current?.contains(event.relatedTarget as Node | null)) restore() }}>
      <input
        ref={input} id={id} className="cb-input" type="text" role="combobox" autoComplete="off" spellCheck={false}
        aria-expanded={open} aria-controls={listId} aria-autocomplete="list" aria-haspopup="listbox"
        aria-activedescendant={open && active >= 0 ? `${uid}-o${active}` : undefined}
        value={query ?? label} data-value={value} disabled={disabled}
        onFocus={event => { event.currentTarget.select(); show() }}
        onClick={() => { if (!open) show() }}
        onChange={event => { setQuery(event.target.value); setOpen(true); setActive(0) }}
        {...inputAttrs}
      />
      <button type="button" className="cb-chev" tabIndex={-1} aria-label={openLabel} aria-expanded={open} aria-controls={listId} disabled={disabled}
        onMouseDown={event => { if (document.activeElement === input.current) event.preventDefault() }}
        onClick={() => { if (open) restore(); else show() }}>
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 6l4.5 4.5L12.5 6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>
      {open && (
        <ul id={listId} ref={list} className="cb-list" role="listbox" aria-label={openLabel} style={place} onMouseDown={event => event.preventDefault()}>
          {shown.length === 0 && <li className="cb-none" role="presentation">No match</li>}
          {shown.map((option, index) => (
            <li key={option.value} id={`${uid}-o${index}`} role="option" aria-selected={option.value === value} data-value={option.value}
              className={`cb-opt${index === active ? ' on' : ''}${option.value === value ? ' sel' : ''}`}
              onMouseMove={() => { if (index !== active) setActive(index) }} onClick={() => pick(option)}>
              {option.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
