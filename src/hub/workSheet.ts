import { useEffect } from 'react'
import type { ProgressMap as MapModel } from '../lib/hub'
import { useHubData } from './useHub'

/** The maps read this session, by project: a sheet opened again shows at once while the map is fetched anew. */
const cache = new Map<string, MapModel>()

/** The project's map model, fetched only while `project` is set (a sheet is open). */
export function useSheetMap(project: string | undefined): { model: MapModel | null; error: string | null } {
  const { data, error } = useHubData<MapModel>(project ? `/map/${encodeURIComponent(project)}` : null)
  useEffect(() => { if (project && data) cache.set(project, data) }, [project, data])
  return { model: data ?? (project ? cache.get(project) ?? null : null), error }
}
