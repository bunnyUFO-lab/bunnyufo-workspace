import { useEffect, useState } from 'react'
import type { RefObject } from 'react'

/** Which edges of the tab bar have tabs scrolled out of sight: '', 'start', 'end' or 'start end'. */
export function useOverflowEdges(list: RefObject<HTMLDivElement | null>, deps: unknown[]) {
  const [overflow, setOverflow] = useState('')
  useEffect(() => {
    const el = list.current
    if (!el) return
    // A string, so React skips the render when nothing changed: scrolling is not a render per frame.
    const measure = () => {
      const edges = []
      if (el.scrollLeft > 1) edges.push('start')
      if (el.scrollLeft + el.clientWidth < el.scrollWidth - 1) edges.push('end')
      setOverflow(edges.join(' '))
    }
    el.addEventListener('scroll', measure, { passive: true })
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    for (const child of el.children) observer.observe(child)
    // Also after a render that changed the tabs (a card, a step count, the active tab, the add form).
    const frame = requestAnimationFrame(measure)
    return () => { el.removeEventListener('scroll', measure); observer.disconnect(); cancelAnimationFrame(frame) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  return overflow
}
