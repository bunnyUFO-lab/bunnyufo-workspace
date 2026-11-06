import { useSyncExternalStore } from 'react'

/** Where the screen is a phone's: the header hides on scroll and the tool rail folds into a menu (global.css). */
export const PHONE = '(max-width: 640px)'
export const isPhone = () => window.matchMedia(PHONE).matches

const subscribePhone = (changed: () => void) => {
  const query = window.matchMedia(PHONE)
  query.addEventListener('change', changed)
  return () => query.removeEventListener('change', changed)
}
const subscribeQuery = (query: string) => (changed: () => void) => {
  const list = window.matchMedia(query)
  list.addEventListener('change', changed)
  return () => list.removeEventListener('change', changed)
}
/** Whether a media query matches now, followed through resize and rotation. */
export function useMedia(query: string) { return useSyncExternalStore(subscribeQuery(query), () => window.matchMedia(query).matches) }

/** Where the rail, the card list and sheets as dialogs appear: the one breakpoint of the shell. */
export const DESKTOP = '(min-width: 900px)'
export const useIsDesktop = () => useMedia(DESKTOP)

/** Whether the screen is a phone's now. Read before the first paint and followed through resize and rotation. */
export function useIsPhone() { return useSyncExternalStore(subscribePhone, isPhone) }

const subscribeKeyboard = (changed: () => void) => {
  const view = window.visualViewport
  view?.addEventListener('resize', changed)
  return () => view?.removeEventListener('resize', changed)
}
/** The on-screen keyboard is up: the visible area is well under the window (a phone's keyboard covers a third of it or more). */
// A pinch-zoomed page shrinks the visual viewport too, so only an unzoomed one counts.
const keyboardUp = () => { const view = window.visualViewport; return !!view && Math.abs(view.scale - 1) < 0.05 && window.innerHeight - view.height > 150 }

/** Whether the on-screen keyboard is showing now, for what should step aside for it (the tab bar). */
export function useKeyboardUp() { return useSyncExternalStore(subscribeKeyboard, keyboardUp) }
