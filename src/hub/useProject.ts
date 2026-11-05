import { useEffect } from 'react'
import type { HubProject } from '../lib/hub'
import { remember } from '../lib/hub'
import { useHubData } from './useHub'

const KEY = 'buw.hub.project'
const SCOPE_KEY = 'hub-today-project' // The old name stays: existing values keep working and no migration is needed.

/** What Today and Needs you show: a project id, or '' for All. Only a pick writes it (`chooseProject`); an address or a visit never does. */
export const savedScope = () => { try { return localStorage.getItem(SCOPE_KEY) ?? '' } catch { return '' } }
export const saveScope = (project: string) => { try { if (project) localStorage.setItem(SCOPE_KEY, project); else localStorage.removeItem(SCOPE_KEY) } catch { /* private mode: All next time */ } }
/** A pick in a project picker: null is All. Addresses and visits never call this. All leaves the last real project (`buw.hub.project`) alone. */
export function chooseProject(id: string | null) { saveScope(id ?? ''); if (id) remember(KEY, id) }

/**
 * The project Work, the Roadmap and the Project page show (a pick on any picker also sets what Today and Needs you show, see `chooseProject`): the one in the address (any project, so a link to one
 * without a Beads copy says so), else the last one chosen, else the first in the server's order (the project table's order, then alphabetical; nothing here re-sorts). Both draw from a Beads
 * copy, so the chips list only projects that have one (all of them while none has).
 *
 * `early` is the id to start fetching with while the list is out (the address's, else the remembered one). Its answer is not to
 * be shown until `project` equals it: the server answers 200 for any valid id, so only the list can say the project exists.
 */
export function useProject(wanted?: string) {
  const projects = useHubData<{ projects: HubProject[] }>('/projects')
  const all = projects.data?.projects ?? []
  const withBeads = all.filter(item => item.beads)
  const list = withBeads.length ? withBeads : all
  const project = all.find(item => item.id === wanted)?.id ?? list.find(item => item.id === remember(KEY))?.id ?? list.find(item => item.beads)?.id ?? list[0]?.id
  useEffect(() => { if (project) remember(KEY, project) }, [project])
  const early = !projects.data && !projects.error ? wanted || remember(KEY) || undefined : undefined
  return { list, project, early, error: projects.error, loading: projects.loading }
}
