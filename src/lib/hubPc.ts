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

/** A process the reporter found busy or orphaned (`reported`) or ended itself (`stopped`). `cmd` is already masked and shortened on the PC. */
export interface PcHog { name: string; cmd: string; cores: number; minutes: number; orphan: boolean; ramMB?: number; action: 'reported' | 'stopped' }

/**
 * Whether the PC can start an approved job (site/api/hub-pc-wait.mjs `pcWaitOf`). `blocked`: the Hub knows it cannot start now;
 * `stuck`: it has waited 10 minutes for that reason (a Needs you item); `wait`: the runner will take it, just not yet (a line on the job page).
 */
export interface PcWait {
  state: 'blocked' | 'stuck' | 'wait'
  cause?: 'not-on-runner' | 'launch-off' | 'pc-silent' | 'cap'
  kind?: 'away' | 'busy'
  title?: string
  /** One sentence for a toast or a line. */
  short?: string
  /** Two or three sentences. */
  text: string
  step?: string
  command?: string
  canWake?: boolean
  until?: string
  cloudOk?: boolean
}

export interface PcStatus {
  v: 1
  host: string
  at: string
  reason: 'change' | 'heartbeat'
  inUse: boolean
  keepAwake: boolean
  gpu: { util: number; memMB: number; memTotalMB: number; band: 'idle' | 'busy' | 'heavy' } | null
  /** Absent or null: an old reporter that does not send memory. */
  memory?: { totalGB: number; availableGB: number } | null
  /** Absent or empty: nothing is busy, or an old reporter. */
  hogs?: PcHog[]
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
  memory?: PcStatus['memory']
  hogs?: PcStatus['hogs']
  comfy: PcStatus['comfy']
  unity: PcStatus['unity']
  sessions: { busy: number; idle: number }
}

/** The PC's wake state (site/api/pc-wake.mjs): `wakeAvailable` is false when no wake is set up on the server. */
export interface PcWake {
  state: 'awake' | 'woke' | 'asleep-or-off' | 'waking' | 'off'
  wakeAvailable: boolean
}

/** What a Working now row is about: Beads items (opened on the Work board) and Library cards, from site/api/hub-links.mjs. */
export interface WorkingLinks {
  beads?: { project: string; id: string; title?: string }[]
  moreBeads?: number
  cards?: { section?: string; card: string; title: string; href: string }[]
  moreCards?: number
}

export interface WorkingItem {
  id: string
  source: 'pc' | 'events' | 'run'
  host: string
  agent: 'claude' | 'hermes'
  /** A request that was taken and has not finished (`source: 'run'`), or the request a PC session belongs to. Opens the run drawer. */
  request?: string
  runner?: 'hermes' | 'cloud' | 'pc'
  preset?: string
  title: string
  project?: string
  branch?: string
  bead?: string
  /** Absent on rows from sessions that never reported what they touched. */
  links?: WorkingLinks
  /** `stale`: a run past its time limit with no word since; `since` is then when it last gave word. */
  state: 'working' | 'needs-you' | 'stopping' | 'idle' | 'stale'
  since: string
  updatedAt?: string
  url?: string
  appUrl?: string
}
