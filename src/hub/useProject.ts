import { useEffect } from 'react'
import type { HubProject } from '../lib/hub'
import { remember } from '../lib/hub'
import { useHubData } from './useHub'

const KEY = 'buw.hub.project'

/** The project the Board and the map show: the one in the address, else the last one chosen, else the first with a Beads copy. */
export function useProject(wanted?: string) {
  const projects = useHubData<{ projects: HubProject[] }>('/projects')
  const list = projects.data?.projects ?? []
  const project = list.find(item => item.id === wanted)?.id ?? list.find(item => item.id === remember(KEY))?.id ?? list.find(item => item.beads)?.id ?? list[0]?.id
  useEffect(() => { if (project) remember(KEY, project) }, [project])
  return { list, project, error: projects.error, loading: projects.loading }
}
