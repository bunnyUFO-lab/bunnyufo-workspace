import type { HubProject } from '../lib/hub'
import { needsHref, projectName } from '../lib/needsView.mjs'
import { projectHash } from '../lib/route'
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

/** The project's name on a page that opens one item alone, as a chip that opens the project's page. It loads the names itself. */
export function PageProjectChip({ id, pill = true }: { id: string | undefined; pill?: boolean }) {
  const names = useProjectNames(!!id)
  if (!id) return null
  const name = projectName(names, id)
  return <a className={`${pill ? 'hub-pill' : 'ni-chip'} ni-project`} href={projectHash(id)} data-project-chip={id} title={`Open ${name}`}>{name}</a>
}

/** A link to a project's page: `Open <name> ›` by default, or the `label` you give it (`Project`). */
export function ProjectLink({ id, name, label, className = 'pp-link' }: { id: string; name?: string; label?: string; className?: string }) {
  return <a className={className} href={projectHash(id)} data-project-link={id}>{label ?? `Open ${name || id}`} ›</a>
}
