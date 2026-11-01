import { useMemo } from 'react'
import type { HubProject } from '../lib/hub'
import Combobox from './Combobox'

type Props = {
  projects: Pick<HubProject, 'id' | 'name'>[]
  /** The chosen project id (or `allValue`). */
  value: string
  onChange: (id: string) => void
  id: string
  /** Adds a first "All" row whose value is this. */
  allValue?: string
  allLabel?: string
  disabled?: boolean
}

/** The Hub's project picker: a typeable list, because projects are added by the owner and pass ten. Matches the name or the id. */
export default function ProjectPicker({ projects, value, onChange, id, allValue, allLabel = 'All', disabled }: Props) {
  const options = useMemo(() => [
    ...(allValue === undefined ? [] : [{ value: allValue, label: allLabel }]),
    ...projects.map(item => ({ value: item.id, label: item.name, keywords: [item.id] })),
  ], [projects, allValue, allLabel])
  return <Combobox className="cb-bar" id={id} value={value} options={options} onChange={onChange} disabled={disabled} openLabel="Show projects" inputAttrs={{ 'aria-label': 'Project', 'data-project-picker': '' }} />
}
