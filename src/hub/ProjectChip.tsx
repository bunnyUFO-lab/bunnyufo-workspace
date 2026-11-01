import type { HubProject } from '../lib/hub'
import { needsHref, projectName } from '../lib/needsView.mjs'
import { useHubData } from './useHub'

export type ProjectNames = Record<string, string>

/** The display name of each project the Hub lists, by id; null until the list arrives. */
export function useProjectNames(enabled = true): ProjectNames | null {
  const { data } = useHubData<{ projects: HubProject[] }>(enabled ? '/projects' : null)
  return data ? Object.fromEntries(data.projects.map(project => [project.id, project.name])) : null
}

/**
 * The project of an item, as a neutral chip that links to the Needs you list narrowed to it. No project, no chip.
 * `names` gives the display names; without a name the id shows.
 */
export default function ProjectChip({ id, names, filter = 'all', className = 'ni-chip', pill = false }: {
  id: string | undefined
  names?: ProjectNames | null
  /** The list the link keeps: a kind chip stays chosen. */
  filter?: string
  className?: string
  /** An item page's header uses the pill look. */
  pill?: boolean
}) {
  if (!id) return null
  return <a className={`${pill ? 'hub-pill ' : ''}${className} ni-project`} href={needsHref(filter, id)} data-project-chip={id} title={`Show only ${projectName(names, id)}`}>{projectName(names, id)}</a>
}

/** The same chip for a page that opens one item alone: it loads the names itself. */
export function PageProjectChip({ id, pill = true }: { id: string | undefined; pill?: boolean }) {
  const names = useProjectNames(!!id)
  return <ProjectChip id={id} names={names} className={pill ? '' : 'ni-chip'} pill={pill} />
}
