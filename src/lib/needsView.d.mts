export interface NeedsRoute { filter: string | undefined; project: string; linked: string }
export function parseNeedsRoute(raw: string | undefined, isFilter: (word: string) => boolean): NeedsRoute
export function needsHref(filter: string | undefined, project?: string): string
export function projectName(names: Record<string, string> | null | undefined, id: string | undefined): string
export type MetaPart = { kind: 'project'; id: string; text: string } | { kind: 'text'; text: string }
export function metaParts(input: { project?: string; who?: string; asked?: string; bead?: string; names?: Record<string, string> | null }): MetaPart[]
export interface ProjectOption { id: string; name: string; count: number }
export function projectOptions(counts: Record<string, number> | null | undefined, names: Record<string, string> | null | undefined, chosen?: string): ProjectOption[]
export function filterSlug(filter: string | undefined): string
export interface SessionFields { tool?: string; source?: string; reason?: string }
export function sessionWait(item: SessionFields): 'permission' | 'question' | 'waiting'
export function sessionLabel(item: SessionFields): string
