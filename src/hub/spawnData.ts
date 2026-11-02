import { hubGet } from '../lib/hub'
import type { ChatModel } from '../lib/hub'
import type { SpawnPreset, SpawnRule } from '../lib/hubSpawn'

export interface PresetList { presets: SpawnPreset[]; rules: SpawnRule[]; models?: ChatModel[] }

let cache: PresetList | null = null

/** The presets and the rule list: read once per page load, shared by Spawn and the approval view. */
export async function loadPresets(signal?: AbortSignal): Promise<PresetList> {
  if (cache) return cache
  const list = await hubGet<PresetList>('/presets', signal)
  // An answer that is not JSON reads as null: fail like any other miss, and ask again next time.
  if (!list) throw new Error('The presets could not be read.')
  cache = list
  return cache
}

export const cachedPresets = (): PresetList | null => cache
