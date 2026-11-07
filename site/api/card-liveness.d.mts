export const ARCHIVE_DAYS: number
export const PURPOSES: readonly ['report', 'reference']
export type Purpose = 'report' | 'reference'

/** `YYYY-MM-DD` a week before `now`. */
export function archiveCutoff(now?: Date): string

/** The state a card carries beside its entry (pins, status, tags, icon, purpose, restore date). */
export interface CardStateLike {
  pinned?: boolean
  pinOrder?: number
  status?: 'active' | 'done' | 'archived'
  tags?: string[]
  emoji?: string
  purpose?: Purpose
  restoredAt?: string
}

/** The card as the page shows it: the entry with the state laid over it. */
export function applyCardState<T extends object>(entity: T, state?: CardStateLike | null): T

export function isArchivedCard(
  card: { status?: string, pinned?: boolean, sample?: boolean, purpose?: string, updated?: string, created?: string },
  now?: Date,
): boolean

export function isLiveCard(entity: object, state?: CardStateLike | null, now?: Date): boolean
