import type { ChatJob } from '../lib/hub'

/** What a chat's job row says about a job's state, in the words of the request page. */
export const JOB_STATE: Record<string, string> = {
  proposed: 'Waiting for you', approved: 'Approved, waiting to start', taken: 'Taken', running: 'Running', stopping: 'Stopping', stopped: 'Stopped',
  asking: 'Asking you', failed: 'Failed', lost: 'Lost', done: 'Done', declined: 'Declined', expired: 'Expired', open: 'Open',
}
/** A job in one of these is still going: the chat looks again every 20 s. */
export const LIVE_JOB = new Set(['approved', 'taken', 'running', 'stopping'])
export const jobTone = (state: string) => (LIVE_JOB.has(state) ? 'working' : state === 'proposed' || state === 'asking' ? 'needs' : state === 'done' ? 'done' : 'idle')

/** One tap takes at most this many (the server refuses more). Above it each row has its own Approve. */
export const MAX_ONE_TAP = 3

const millions = (value: number) => String(Math.round(value * 10) / 10)

/** What the rows ready for the tap cost together, from the presets' own estimates: the tokens added up, anything else listed. */
export function estimateOf(rows: ChatJob[]): string {
  const withTokens = rows.filter(job => job.tokens)
  // A cost that repeats is counted (3 × about $2), never dropped: the total is what the owner reads before the tap.
  const counted = new Map<string, number>()
  for (const job of rows) if (!job.tokens && job.estimate) counted.set(job.estimate.cost, (counted.get(job.estimate.cost) ?? 0) + 1)
  const others = [...counted].map(([cost, count]) => (count > 1 ? `${count} × ${cost}` : cost))
  const parts: string[] = []
  if (withTokens.length) {
    const low = withTokens.reduce((sum, job) => sum + job.tokens!.low, 0)
    const high = withTokens.reduce((sum, job) => sum + job.tokens!.high, 0)
    parts.push(low === high ? `about ${millions(low)} M tokens` : `${millions(low)}–${millions(high)} M tokens`)
  }
  parts.push(...others)
  // A paused Codex plan makes Hermes fall back to paid models: the token figure is an estimate, not a promise.
  if (rows.some(job => /Codex plan/.test(job.estimate?.cost ?? ''))) parts.push('if Codex is paused it may use paid models')
  return parts.join(' · ')
}
