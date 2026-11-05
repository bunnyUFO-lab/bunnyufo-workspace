import { useEffect, useMemo, useRef } from 'react'
import type { HubProject } from '../lib/hub'
import { useIsPhone } from '../lib/chrome'
import { useOverflowEdges } from '../lib/useOverflowEdges'
import Combobox from './Combobox'
import { chooseProject } from './useProject'

/** Up to this many projects the picker is a row of chips (one tap) on a desktop; past it, a typeable list. A phone always gets one native select. "All" does not count. */
export const CHIP_LIMIT = 10

type Props = {
  projects: Pick<HubProject, 'id' | 'name'>[]
  /** The chosen project id (or `allValue`). */
  value: string
  onChange: (id: string) => void
  id: string
  /** Adds a first "All" row whose value is this. */
  allValue?: string
  allLabel?: string
  /** Chips are links when this gives their address, buttons otherwise. */
  href?: (id: string) => string
  /** Chips scroll in one row instead of wrapping. */
  oneRow?: boolean
  /** The picker sits in a toolbar row that supplies its own spacing. */
  inRow?: boolean
  /** A dropdown at any count (Activity's filter was one already). */
  alwaysList?: boolean
  /** How many items each project has (and `allCount` the "All" row): shown beside the name. */
  counts?: Record<string, number>
  allCount?: number
  /** The pick is this view's own filter or a form field, not the app's project: it does not re-scope the other screens. */
  local?: boolean
}

/**
 * The Hub's project picker: at phone width always one native select (no keyboard, nothing scrolls sideways, whatever the number of projects);
 * on a desktop chips while the owner has ten or fewer projects, a typeable list once there are more. Matches the name or the id.
 */
export default function ProjectPicker({ projects, value, onChange, id, allValue, allLabel = 'All', href, oneRow, inRow, alwaysList, counts, allCount, local }: Props) {
  const record = (next: string) => { if (!local && next) chooseProject(next === allValue ? null : next) }
  const pick = (next: string) => { record(next); onChange(next) }
  const options = useMemo(() => [
    ...(allValue === undefined ? [] : [{ value: allValue, label: allLabel }]),
    ...projects.map(item => ({ value: item.id, label: item.name, keywords: [item.id] })),
  ], [projects, allValue, allLabel])
  const countOf = (option: string) => (option === allValue ? allCount : counts?.[option])
  // A count is its own number on a chip, and part of the label in the typeable list.
  const listOptions = useMemo(() => options.map(option => { const n = option.value === allValue ? allCount : counts?.[option.value]; return n === undefined ? option : { ...option, label: `${option.label} (${n})` } }), [options, allValue, allCount, counts])
  const phone = useIsPhone()
  const short = projects.length <= CHIP_LIMIT
  const native = phone
  const chips = !phone && !alwaysList && short
  const row = useRef<HTMLDivElement>(null)
  const edges = useOverflowEdges(row, [options.length, value, chips])
  useEffect(() => { if (oneRow) row.current?.querySelector('.hub-chip.on')?.scrollIntoView({ inline: 'nearest', block: 'nearest' }) }, [oneRow, options.length, value, chips])

  if (native) {
    const known = options.some(option => option.value === value)
    const field = (
      <select id={id} className="hub-project-select" aria-label="Project" data-project-picker="" data-value={value}
        value={known ? value : ''} disabled={!options.length} onChange={event => pick(event.target.value)}>
        {!known && <option value="" disabled hidden>Choose a project</option>}
        {listOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    )
    return inRow ? field : <div className="hub-project-pick">{field}</div>
  }
  if (chips) {
    const list = (
      <div className={`hub-chips${oneRow ? ' one-row' : ''}`} aria-label="Project" data-value={value} ref={row}>
        {options.map(option => {
          const cls = `hub-chip${option.value === value ? ' on' : ''}`
          return href
            ? <a key={option.value} className={cls} href={href(option.value)} onClick={() => record(option.value)}>{option.label}{countOf(option.value) !== undefined && <span className="n">{countOf(option.value)}</span>}</a>
            : <button key={option.value} type="button" className={cls} onClick={() => pick(option.value)}>{option.label}{countOf(option.value) !== undefined && <span className="n">{countOf(option.value)}</span>}</button>
        })}
      </div>
    )
    return oneRow ? <div className="hub-chips-wrap" data-overflow={edges}>{list}</div> : list
  }
  const field = <Combobox className="cb-bar" id={id} value={value} options={listOptions} onChange={pick} openLabel="Show projects" inputAttrs={{ 'aria-label': 'Project', 'data-project-picker': '' }} />
  return inRow ? field : <div className="hub-project-pick">{field}</div>
}
