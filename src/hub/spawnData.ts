import { hubGet } from '../lib/hub'
import type { ChatModel } from '../lib/hub'
import type { SpawnPreset, SpawnRule } from '../lib/hubSpawn'

export interface PresetList { presets: SpawnPreset[]; rules: SpawnRule[]; models?: ChatModel[] }

let cache: PresetList | null = null

/** The presets and the rule list: read once per page load, shared by Spawn and the approval view. */
export async function loadPresets(signal?: AbortSignal): Promise<PresetList> {
  if (cache) return cache
  cache = await hubGet<PresetList>('/presets', signal)
  return cache
}

export const cachedPresets = (): PresetList | null => cache
