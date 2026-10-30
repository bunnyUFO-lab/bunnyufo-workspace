// Wording for Working now and the Gaming PC tile. Plain functions, so node can test them.
import type { PcSummary, WorkingItem } from '../lib/hubPc'

export const STATE_LABEL: Record<WorkingItem['state'], string> = { working: 'Working', 'needs-you': 'Needs you', stopping: 'Stopping', idle: 'Idle' }
export const STATE_DOT: Record<WorkingItem['state'], string> = { working: 'working', 'needs-you': 'needs', stopping: 'working', idle: 'idle' }
/** A run that asked a question waits on the owner; the PC calls the same thing "Needs you". */
export const runStateLabel = (item: WorkingItem) => (item.source === 'run' && item.state === 'needs-you' ? 'Waiting on you' : STATE_LABEL[item.state])
export const RUNNER_LABEL = { hermes: 'Hermes', cloud: 'Cloud', pc: 'PC' } as const
/** "research" is "Research"; "code-task" is "Code task". */
export const presetLabel = (preset: string) => { const words = preset.replace(/[-_]+/g, ' ').trim(); return words ? words[0].toUpperCase() + words.slice(1) : '' }

/** "for 12 min", "for 3 h 5 min", "for 2 days". Empty when the time is unknown. */
export function duration(since: string, now = Date.now()): string {
  const start = new Date(since).getTime()
  if (Number.isNaN(start)) return ''
  const minutes = Math.max(0, Math.floor((now - start) / 60000))
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `for ${minutes} min`
  if (minutes < 48 * 60) {
    const rest = minutes % 60
    return `for ${Math.floor(minutes / 60)} h${rest ? ` ${rest} min` : ''}`
  }
  return `for ${Math.floor(minutes / 1440)} days`
}

/** "40 s ago", "5 min ago", "2 h ago". */
export function seen(seconds: number): string {
  if (seconds < 60) return `${Math.max(0, Math.round(seconds))} s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  if (minutes < 48 * 60) return `${Math.floor(minutes / 60)} h ago`
  return `${Math.floor(minutes / 1440)} days ago`
}

const gb = (mb: number) => (mb / 1024).toFixed(1)

export interface PcLine { key: string; label: string; value: string }

/** The tile's headline: "On · in use", "On · idle" or "Asleep or off · last seen 2 h ago". */
export function pcHeadline(pc: PcSummary): string {
  if (pc.state === 'asleep-or-off') return `Asleep or off · last seen ${seen(pc.ageSeconds)}`
  return `On · ${pc.inUse ? 'in use' : 'idle'}`
}

/** The tile's rows. A stale PC shows none: its numbers are old. */
export function pcLines(pc: PcSummary): PcLine[] {
  if (pc.state === 'asleep-or-off') return []
  const lines: PcLine[] = []
  if (pc.gpu) lines.push({ key: 'gpu', label: 'GPU', value: `${Math.round(pc.gpu.util)} % · ${gb(pc.gpu.memMB)} / ${Math.round(pc.gpu.memTotalMB / 1024)} GB` })
  if (pc.comfy) {
    const { up, running, pending } = pc.comfy
    lines.push({ key: 'comfy', label: 'ComfyUI', value: !up ? 'down' : running || pending ? `${running} running, ${pending} queued` : 'idle' })
  }
  if (pc.unity) lines.push({ key: 'unity', label: 'Unity', value: pc.unity.open ? `${pc.unity.projects.join(', ') || 'a project'} open` : 'closed' })
  lines.push({ key: 'sessions', label: 'Sessions', value: `${pc.sessions.busy} busy, ${pc.sessions.idle} idle` })
  return lines
}
