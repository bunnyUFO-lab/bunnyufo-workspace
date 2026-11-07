import type { PcWait } from '../lib/hubPc'
import { useHubData } from './useHub'

/**
 * Whether the PC can start a job of this project, as the Hub knows it from the PC's report (`GET /hub/pc/start`). Null until it answers,
 * and when the Hub has nothing to say. Only asked for a job that runs on the PC, so no other target sees a PC line.
 */
export function usePcStart(project: string | undefined, enabled: boolean): PcWait | null {
  const path = enabled && project ? `/pc/start?project=${encodeURIComponent(project)}` : null
  return useHubData<{ pcWait: PcWait | null }>(path).data?.pcWait ?? null
}
