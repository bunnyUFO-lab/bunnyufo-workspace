// The Gaming PC's status and Working now, as the site API sends them (site/api/hub-pc.mjs).

export interface PcSession {
  id: string
  name: string
  status: 'busy' | 'idle' | 'unknown'
  kind: string
  folder: string
  repo: string
  project?: string
  branch: string
  startedAt?: string
  updatedAt?: string
  url?: string
  appUrl?: string
}

export interface PcStatus {
  v: 1
  host: string
  at: string
  reason: 'change' | 'heartbeat'
  inUse: boolean
  keepAwake: boolean
  gpu: { util: number; memMB: number; memTotalMB: number; band: 'idle' | 'busy' | 'heavy' } | null
  comfy: { up: boolean; running: number; pending: number } | null
  unity: { open: boolean; projects: string[] } | null
  /** null: the PC could not list its sessions. */
  sessions: PcSession[] | null
  runs: unknown[]
}

export interface PcSummary {
  host: string
  at: string
  ageSeconds: number
  state: 'on' | 'asleep-or-off'
  inUse: boolean
  keepAwake: boolean
  gpu: PcStatus['gpu']
  comfy: PcStatus['comfy']
  unity: PcStatus['unity']
  sessions: { busy: number; idle: number }
}

export interface WorkingItem {
  id: string
  source: 'pc' | 'events'
  host: string
  agent: 'claude'
  title: string
  project?: string
  branch?: string
  bead?: string
  state: 'working' | 'needs-you' | 'idle'
  since: string
  updatedAt?: string
  url?: string
  appUrl?: string
}
