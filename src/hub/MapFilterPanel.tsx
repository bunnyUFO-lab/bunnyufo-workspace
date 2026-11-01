import { useEffect, useRef } from 'react'
import type { TaskState } from '../lib/hub'
import { OPEN_FILTER, FILTER_STATES, FILTER_STATE_LABEL, PRESETS, presetOf, type MapFilter } from './mapFilter'
import { STATE_COLOR } from './mapState'

/** The Roadmap's filter panel: a popover above the Key bar on a desktop, a sheet along the bottom on a phone. Every change applies at once. */
export default function MapFilterPanel({ filter, shown, total, onChange, onClose }: { filter: MapFilter; shown: number; total: number; onChange: (next: MapFilter) => void; onClose: () => void }) {
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => { root.current?.querySelector<HTMLElement>('button, input')?.focus({ preventScroll: true }) }, [])
  const preset = presetOf(filter)
  const toggleState = (state: TaskState) => {
    const has = filter.states.includes(state)
    // The last state stays on: a filter that shows nothing is never what anyone wants.
    if (has && filter.states.length === 1) return
    onChange({ ...filter, states: FILTER_STATES.filter(item => (item === state ? !has : filter.states.includes(item))) })
  }
  const within = (days: 7 | 30 | 90 | null) => onChange({ ...filter, within: days, from: '', to: '' })
  const range = (key: 'from' | 'to', value: string) => onChange({ ...filter, within: null, [key]: value })
  const custom = Boolean(filter.from || filter.to)
  return (
    <div className="hub-filter" id="hub-map-filter" role="group" aria-label="Roadmap filter" ref={root}>
      <div className="hub-filter-head">
        <strong>Filter</strong>
        <span className="hub-muted" data-filter-count>{shown === total ? `All ${total} tasks shown` : `${shown} of ${total} tasks shown`}</span>
        <button type="button" className="hub-filter-x" aria-label="Close the filter" onClick={onClose}>×</button>
      </div>
      <div className="hub-filter-row" aria-label="Show">
        {PRESETS.map(item => (
          <button key={item.id} type="button" className={`hub-chip${preset === item.id ? ' on' : ''}`} aria-pressed={preset === item.id} data-preset={item.id}
            onClick={() => onChange({ ...filter, states: [...item.states] })}>{item.label}</button>
        ))}
      </div>
      <p className="hub-filter-label">Status</p>
      <div className="hub-filter-row">
        {FILTER_STATES.map(state => {
          const on = filter.states.includes(state)
          return (
            <button key={state} type="button" className={`hub-chip hub-filter-state${on ? ' on' : ''}`} aria-pressed={on} data-state-chip={state} onClick={() => toggleState(state)}>
              <i style={{ background: STATE_COLOR[state] }} aria-hidden="true" />{FILTER_STATE_LABEL[state]}
            </button>
          )
        })}
      </div>
      <p className="hub-filter-label">Updated</p>
      <div className="hub-filter-row">
        {([[null, 'Any time'], [7, '7 days'], [30, '30 days'], [90, '90 days']] as const).map(([days, text]) => {
          const on = !custom && filter.within === days
          return <button key={text} type="button" className={`hub-chip${on ? ' on' : ''}`} aria-pressed={on} data-within={days ?? 'any'} onClick={() => within(days as 7 | 30 | 90 | null)}>{text}</button>
        })}
      </div>
      <div className="hub-filter-dates">
        <label>From <input type="date" value={filter.from} max={filter.to || undefined} onChange={event => range('from', event.target.value)} /></label>
        <label>To <input type="date" value={filter.to} min={filter.from || undefined} onChange={event => range('to', event.target.value)} /></label>
      </div>
      <div className="hub-filter-foot">
        <button type="button" className="hub-btn" onClick={() => onChange(OPEN_FILTER)}>Reset to Open</button>
        <button type="button" className="hub-btn pri" onClick={onClose}>Done</button>
      </div>
    </div>
  )
}
