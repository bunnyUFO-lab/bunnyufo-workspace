import { useSyncExternalStore } from 'react'
import { getStore, subscribe } from './inProgress.ts'
import type { Store } from './inProgress.ts'

/** The device's list of chats and jobs in progress (inProgress.ts), re-read when it changes, here or in another tab. */
export const useInProgress = (): Store => useSyncExternalStore(subscribe, getStore)
