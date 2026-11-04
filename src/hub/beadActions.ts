// What the Roadmap sheet's "Do it" block says and when it shows, as plain functions (BeadWork.tsx draws it).
import type { MapTask, MapWayfinder } from '../lib/hub'

export type BeadKind = 'build' | 'mockup' | 'research'

export interface BeadRow { kind: BeadKind; label: string; note: string }

/** The three buttons, in order: the label and the line under it that says who does it and what comes back. */
export const BEAD_ROWS: readonly BeadRow[] = [
  { kind: 'build', label: 'Build it', note: 'Claude · opens a PR' },
  { kind: 'mockup', label: 'Mock it up', note: 'Codex · a page and pictures' },
  { kind: 'research', label: 'Research it', note: 'Codex · a card with sources' },
]

/** What Spawn starts from, as `GET /hub/map/:project/beads/:bead/seed` answers it. */
export interface BeadSeed { preset: string; title: string; text: string; doneWhen?: string }

/**
 * Whether a task's sheet offers the block. Not for a done task (a mark that waits for Beads shows it done too), not without write access,
 * and not for a Wayfinder question: its Resolve block already gives it one main button, and two sets would compete.
 */
export function visible(task: Pick<MapTask, 'state'>, resolving: MapWayfinder['open'][number] | undefined | null | false, canWrite: boolean): boolean {
  return canWrite && !resolving && task.state !== 'done'
}

const RUN_WORDS: Record<string, string> = {
  proposed: 'Waiting for your approval', approved: 'Approved, waiting to start', taken: 'Starting', running: 'Running', stopping: 'Stopping', asking: 'Waiting for your answer', lost: 'Lost contact',
}

/** The line that replaces the buttons while a run is on the bead. */
export const runWord = (state: string): string => RUN_WORDS[state] ?? state

/** The path of the seed for one bead and kind. */
export const seedPath = (project: string, bead: string, kind: BeadKind): string => `/map/${encodeURIComponent(project)}/beads/${encodeURIComponent(bead)}/seed?kind=${kind}`
