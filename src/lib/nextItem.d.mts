export type SettledVerb = 'answered' | 'snoozed' | 'submitted' | 'done' | 'cancelled' | 'reviewed' | 'reported'
export interface QueueItem { kind: string; id: string; title?: string }
export const NOTE_VERB: Record<SettledVerb, string>
export function itemKey(item: QueueItem): string
export function pickNext<T extends QueueItem>(items: (T | null | undefined)[], settledKey: string, previousKeys?: string[]): T | null
export function itemLink(item: QueueItem): { hash: string; focus?: string }
