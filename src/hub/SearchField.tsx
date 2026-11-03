import type { KeyboardEvent } from 'react'
import './combobox.css'

/** A search box in the Hub's field look: a magnifier, and a 44 px button that clears it. `label` is its accessible name. */
export default function SearchField({ value, onChange, onKeyDown, label, data, placeholder }: {
  value: string
  onChange: (value: string) => void
  onKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void
  label: string
  /** A `data-*` hook for the input, e.g. `{ 'data-work-search': '' }`. */
  data?: Record<string, string>
  placeholder?: string
}) {
  return (
    <div className="cb sf">
      <svg className="sf-icon" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5 14 14" /></svg>
      <input className="cb-input sf-input" type="search" value={value} aria-label={label} placeholder={placeholder} autoComplete="off" spellCheck={false} onChange={event => onChange(event.target.value)} onKeyDown={onKeyDown} {...data} />
      {value && <button type="button" className="sf-clear" aria-label="Clear search" onClick={() => onChange('')}>×</button>}
    </div>
  )
}
