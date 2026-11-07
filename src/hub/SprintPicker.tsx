import { useMemo } from 'react'
import Combobox from './Combobox'

export interface SprintChoice { name: string; title?: string; done: number; total: number }

/** "28 of 34 tasks done": every sprint number counts tasks, never milestones or groups. */
export const sprintCount = (sprint: Pick<SprintChoice, 'done' | 'total'>) => `${sprint.done} of ${sprint.total} tasks done`

/**
 * The sprint picker: "All sprints" first, then each sprint as its title (else its name) and how far it is. A sprint in the address that
 * the list lacks still shows, so a link to one never reads as "All sprints". `onChange` gets the sprint name, or '' for all.
 */
export default function SprintPicker({ id, sprints, value, onChange, className = 'cb-bar wk-sprint' }: { id: string; sprints: SprintChoice[]; value: string; onChange: (name: string) => void; className?: string }) {
  const options = useMemo(() => [
    { value: '', label: 'All sprints' },
    ...sprints.map(sprint => ({ value: sprint.name, label: `${sprint.title ?? sprint.name} · ${sprintCount(sprint)}`, keywords: [sprint.name] })),
    ...(value && !sprints.some(sprint => sprint.name === value) ? [{ value, label: value }] : []),
  ], [sprints, value])
  return <Combobox className={className} id={id} value={value} options={options} onChange={onChange} openLabel="Show sprints" inputAttrs={{ 'aria-label': 'Sprint', 'data-filter-sprint': '' }} />
}
