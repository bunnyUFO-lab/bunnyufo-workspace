export const HUB_CACHE_MAX: number
export const HUB_CACHE_MAX_AGE_MS: number
export function hubCacheStamp(): number
export function peekHub<T>(path: string, now?: number): { data: T; at: Date } | null
export function putHub<T>(path: string, data: T, stamp: number, at: Date): void
export function clearHub(prefix?: string): void
