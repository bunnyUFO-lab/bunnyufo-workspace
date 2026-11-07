import { useSyncExternalStore } from 'react'
import { remember } from '../lib/hub'

/** "Hide completed" on the Roadmap rows, kept in this browser. Off by default; a blocked store reads as off. */
export const HIDE_DONE_KEY = 'buw.roadmap.hideDone'
const EVENT = 'buw-hide-done'

export const readHideDone = (): boolean => remember(HIDE_DONE_KEY) === '1'

export function writeHideDone(on: boolean): void {
  remember(HIDE_DONE_KEY, on ? '1' : '0')
  window.dispatchEvent(new Event(EVENT))
}

const subscribe = (notify: () => void) => {
  window.addEventListener(EVENT, notify)
  window.addEventListener('storage', notify)
  return () => { window.removeEventListener(EVENT, notify); window.removeEventListener('storage', notify) }
}

/** The setting, for every place that reads it: the rows, the project page's "Done" fold and its sprint picker. */
export const useHideDone = (): boolean => useSyncExternalStore(subscribe, readHideDone)
