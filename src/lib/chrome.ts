import { useEffect, useRef, useState } from 'react'

/** Where the screen is a phone's: the header hides on scroll and the tool rail folds into a menu (global.css). */
export const PHONE = '(max-width: 640px)'
export const isPhone = () => window.matchMedia(PHONE).matches

// Small enough to follow a deliberate flick, large enough to ignore a finger resting on the glass.
const STEP = 6

/**
 * On a phone the header takes a third of the screen, so it gets out of the way while you read:
 * scrolling down hides it, scrolling up (or reaching the top) brings it back. `page` is what is
 * on screen; opening another card or tab shows the header again.
 *
 * Only scrolling inside `.content` counts — the menu and panels scroll too, and they are not the
 * page. A card's HTML tab scrolls inside its frame, which is followed as well when it is
 * same-origin (the published site serves cards from its own origin; the local app isolates
 * them on a second one, where the header simply stays).
 *
 * The state is written to `<html data-chrome-hidden>` so the shell outside the app (the tool
 * menu button) can hide with it.
 */
export function useAutoHideHeader(page: string) {
  // The page the header was hidden on: moving to another page shows it again without an effect.
  const [hiddenOn, setHiddenOn] = useState<string | null>(null)
  const hidden = hiddenOn === page
  // Read by the listeners, which are bound once: a frame keeps the one it was given.
  const current = useRef(page)
  useEffect(() => { current.current = page })

  useEffect(() => {
    const followed = new WeakSet<Document>()
    const last = new WeakMap<Element, { top: number; max: number }>()
    const scrolled = (el: Element | null) => {
      if (!el || !isPhone()) return
      const top = el.scrollTop
      const max = el.scrollHeight - el.clientHeight
      const prev = last.get(el)
      // Rubber-banding past either end is not a direction.
      if (top < 0 || top > max) return
      last.set(el, { top, max })
      // A table scrolled sideways fires here too, with no vertical change.
      if (!prev || top === prev.top) return
      // Hiding the header gives the page its height, so at the bottom the browser pulls the scroll
      // position up by the header's height: that is the page changing, not a scroll up. Reading it
      // as one would show the header again, and flip it forever.
      if (top >= max - 1 && max < prev.max) return
      const before = prev.top
      if (top <= STEP) setHiddenOn(null)
      else if (top - before > STEP) setHiddenOn(current.current)
      else if (before - top > STEP) setHiddenOn(null)
    }
    const onScroll = (event: Event) => {
      const target = event.target
      if (target instanceof Element && target.closest('.content')) scrolled(target)
    }
    const follow = (frame: HTMLIFrameElement) => {
      try {
        const doc = frame.contentDocument
        if (!doc || followed.has(doc) || !frame.closest('.content')) return
        followed.add(doc)
        // The frame's elements are not this window's Element, so no instanceof here.
        doc.addEventListener('scroll', event => {
          const target = event.target as Element | Document
          scrolled(target === doc ? doc.scrollingElement : 'scrollTop' in target ? target : null)
        }, { capture: true, passive: true })
      } catch { /* A cross-origin frame: the header stays. */ }
    }
    const onLoad = (event: Event) => { if (event.target instanceof HTMLIFrameElement) follow(event.target) }
    document.addEventListener('scroll', onScroll, { capture: true, passive: true })
    // Load does not bubble, but it is seen on the way down; a frame loaded before this ran is picked up here.
    document.addEventListener('load', onLoad, true)
    document.querySelectorAll<HTMLIFrameElement>('.content iframe').forEach(follow)
    return () => {
      document.removeEventListener('scroll', onScroll, { capture: true })
      document.removeEventListener('load', onLoad, true)
    }
  }, [])

  useEffect(() => {
    if (hidden) document.documentElement.dataset.chromeHidden = ''
    else delete document.documentElement.dataset.chromeHidden
  }, [hidden])
  return hidden
}
