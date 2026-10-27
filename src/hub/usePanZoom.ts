/* eslint-disable react-hooks/immutability, react-hooks/refs, react-hooks/preserve-manual-memoization -- this hook writes the transform straight to the DOM on purpose: a gesture must never go through React state. */
import { useCallback, useEffect, useMemo, useRef } from 'react'
import type { RefObject } from 'react'
import { clamp, clampView, dataView, fitView, limitsFor, viewString, zoomAround } from './panZoom'
import type { Size, View } from './panZoom'

const THRESHOLD = 6
const WHEEL_SETTLE = 150
const GLIDE_MS = 300
const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches

export interface PanZoom {
  /** The view right now (a copy). */
  current: () => View
  /** Tell it how big the content is (once per layout); it does not move the view. */
  setContent: (size: Size) => void
  /** Show a view: clamped, then glided to, or set at once. */
  go: (view: View, animate?: boolean) => void
  fit: (animate?: boolean) => void
  zoomBy: (factor: number, animate?: boolean) => void
  box: () => Size
}

/**
 * Pan and zoom for a box holding a stage, by a CSS transform on the stage: drag, pinch, wheel and
 * keys write the transform inside one animation frame and never touch React state, so nothing is
 * laid out again while your finger moves. The view lives in a ref; the box's `data-view` shows it.
 * `onGesture` is called when a drag, pinch or zoom by the user starts.
 */
export function usePanZoom(box: RefObject<HTMLDivElement | null>, stage: RefObject<HTMLDivElement | null>, onGesture?: () => void): PanZoom {
  const view = useRef<View>({ x: 0, y: 0, k: 1 })
  const content = useRef<Size>({ w: 0, h: 0 })
  const frame = useRef(0)
  const timer = useRef(0)
  const gesture = useRef(onGesture)
  gesture.current = onGesture

  const size = useCallback((): Size => ({ w: box.current?.clientWidth ?? 0, h: box.current?.clientHeight ?? 0 }), [box])
  const limits = useCallback(() => limitsFor(content.current, size()), [size])
  const settle = useCallback((next: View) => clampView(next, content.current, size(), limits()), [size, limits])

  const paint = useCallback(() => {
    frame.current = 0
    const el = box.current
    const st = stage.current
    if (!el || !st) return
    st.style.transform = viewString(view.current)
    el.dataset.view = dataView(view.current)
  }, [box, stage])
  const paintNow = useCallback(() => { cancelAnimationFrame(frame.current); paint() }, [paint])
  const schedule = useCallback(() => { if (!frame.current) frame.current = requestAnimationFrame(paint) }, [paint])
  const endGlide = useCallback(() => { window.clearTimeout(timer.current); stage.current?.classList.remove('glide') }, [stage])

  const go = useCallback((target: View, animate = true) => {
    const st = stage.current
    view.current = settle(target)
    if (!st) return
    if (!animate || reduced()) { endGlide(); paintNow(); return }
    st.classList.add('glide')
    paintNow()
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(endGlide, GLIDE_MS)
  }, [stage, settle, endGlide, paintNow])

  const api = useMemo<PanZoom>(() => ({
    current: () => ({ ...view.current }),
    setContent: next => { content.current = next },
    go,
    fit: (animate = true) => go(fitView(content.current, size()), animate),
    zoomBy: (factor, animate = true) => {
      const { w, h } = size()
      go(zoomAround(view.current, { x: w / 2, y: h / 2 }, factor, limits()), animate)
      gesture.current?.()
    },
    box: size,
  }), [go, size, limits])

  useEffect(() => {
    const el = box.current
    const st = stage.current
    if (!el || !st) return undefined
    const pointers = new Map<number, { x: number; y: number }>()
    let start = { x: 0, y: 0 }
    let last = { x: 0, y: 0 }
    let panning = false
    let pinch: { d0: number; mid0: { x: number; y: number }; view0: View } | null = null
    let pinched = false
    let suppress = false
    let samples: { t: number; x: number; y: number }[] = []
    let inertia = 0
    let wheelTimer = 0

    const moving = (on: boolean) => st.classList.toggle('moving', on)
    const local = (x: number, y: number) => { const rect = el.getBoundingClientRect(); return { x: x - rect.left, y: y - rect.top } }
    const announce = () => gesture.current?.()
    const stopInertia = () => { if (inertia) { cancelAnimationFrame(inertia); inertia = 0; moving(false) } }
    const cancelGlide = () => {
      if (!st.classList.contains('glide')) return
      // Carry on from where the glide has got to.
      const m = new DOMMatrix(getComputedStyle(st).transform)
      view.current = { x: m.e, y: m.f, k: m.a || view.current.k }
      endGlide()
      paintNow()
    }

    const pair = () => {
      const [a, b] = [...pointers.values()]
      return { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, mid: local((a.x + b.x) / 2, (a.y + b.y) / 2) }
    }
    const startPinch = () => {
      const { d, mid } = pair()
      pinch = { d0: d, mid0: mid, view0: { ...view.current } }
      pinched = true
      suppress = true
      panning = false
      moving(true)
      announce()
    }
    const updatePinch = () => {
      if (!pinch) return
      const { d, mid } = pair()
      const { view0, mid0, d0 } = pinch
      const { kMin, kMax } = limits()
      const k = clamp(view0.k * (d / d0), kMin, kMax)
      // The content point that was under the fingers stays under them, wherever they have moved.
      view.current = settle({ k, x: mid.x - ((mid0.x - view0.x) / view0.k) * k, y: mid.y - ((mid0.y - view0.y) / view0.k) * k })
      schedule()
    }

    const onDown = (event: PointerEvent) => {
      if (event.pointerType === 'mouse' && event.button !== 0) return
      cancelGlide()
      stopInertia()
      if (pointers.size === 0) { suppress = false; pinched = false }
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
      if (pointers.size === 1) { start = { x: event.clientX, y: event.clientY }; last = start; panning = false; samples = [] }
      else if (pointers.size === 2) startPinch()
    }
    const onMove = (event: PointerEvent) => {
      const point = pointers.get(event.pointerId)
      if (!point) return
      point.x = event.clientX
      point.y = event.clientY
      if (pinch) { updatePinch(); return }
      if (pointers.size !== 1) return
      if (!panning) {
        // Not a drag until it has travelled a few pixels, so a tap still reaches the node. The pointer
        // is captured only now: capturing at pointerdown would send the click to the box.
        if (Math.hypot(point.x - start.x, point.y - start.y) < THRESHOLD) return
        panning = true
        suppress = true
        moving(true)
        announce()
        try { el.setPointerCapture(event.pointerId) } catch { /* the pointer is gone */ }
      }
      view.current = settle({ ...view.current, x: view.current.x + point.x - last.x, y: view.current.y + point.y - last.y })
      last = { x: point.x, y: point.y }
      samples.push({ t: event.timeStamp, x: point.x, y: point.y })
      if (samples.length > 12) samples.shift()
      schedule()
    }
    const glideOut = (event: PointerEvent) => {
      const recent = samples.filter(sample => event.timeStamp - sample.t <= 80)
      moving(false)
      if (pinched || reduced() || recent.length < 2) return
      const dt = recent[recent.length - 1].t - recent[0].t
      if (dt <= 0) return
      let vx = (recent[recent.length - 1].x - recent[0].x) / dt
      let vy = (recent[recent.length - 1].y - recent[0].y) / dt
      if (Math.hypot(vx, vy) < 0.02) return
      moving(true)
      let before = performance.now()
      const step = (now: number) => {
        const elapsed = Math.min(32, now - before)
        before = now
        const was = view.current
        view.current = settle({ ...was, x: was.x + vx * elapsed, y: was.y + vy * elapsed })
        if (view.current.x === was.x) vx = 0
        if (view.current.y === was.y) vy = 0
        vx *= 0.92
        vy *= 0.92
        paint()
        if (Math.hypot(vx, vy) < 0.02) { inertia = 0; moving(false); return }
        inertia = requestAnimationFrame(step)
      }
      inertia = requestAnimationFrame(step)
    }
    const onUp = (event: PointerEvent) => {
      if (!pointers.delete(event.pointerId)) return
      if (pinch) {
        if (pointers.size >= 2) { startPinch(); return }
        pinch = null
        if (pointers.size === 1) {
          // One finger lifted: carry on as a pan from the other, with no jump.
          const [rest] = [...pointers.values()]
          panning = true
          last = { x: rest.x, y: rest.y }
          samples = []
          return
        }
      }
      if (pointers.size === 0) {
        if (panning) glideOut(event)
        else moving(false)
        panning = false
        window.setTimeout(() => { if (!pointers.size) suppress = false }, 60)
      }
    }
    // The click that follows a drag must not reach a node.
    const onClick = (event: MouseEvent) => { if (suppress) { event.stopPropagation(); event.preventDefault() } }

    const onWheel = (event: WheelEvent) => {
      const lines = event.deltaMode === 1 ? 16 : 1
      if (event.ctrlKey || event.metaKey || event.altKey) {
        event.preventDefault()
        cancelGlide()
        stopInertia()
        view.current = settle(zoomAround(view.current, local(event.clientX, event.clientY), Math.exp(-event.deltaY * lines * 0.0015), limits()))
      } else if (event.deltaX && Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
        // Sideways swipes pan; a vertical wheel is left to the page.
        event.preventDefault()
        cancelGlide()
        view.current = settle({ ...view.current, x: view.current.x - event.deltaX * lines })
      } else return
      moving(true)
      announce()
      schedule()
      window.clearTimeout(wheelTimer)
      wheelTimer = window.setTimeout(() => moving(false), WHEEL_SETTLE)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.target !== el || event.ctrlKey || event.metaKey || event.altKey) return
      const pan: Record<string, [number, number]> = { ArrowLeft: [60, 0], ArrowRight: [-60, 0], ArrowUp: [0, 60], ArrowDown: [0, -60] }
      if (event.key in pan) {
        event.preventDefault()
        const [dx, dy] = pan[event.key]
        go({ ...view.current, x: view.current.x + dx, y: view.current.y + dy }, false)
        announce()
      } else if (event.key === '+' || event.key === '=') { event.preventDefault(); api.zoomBy(1.25, false) }
      else if (event.key === '-' || event.key === '_') { event.preventDefault(); api.zoomBy(1 / 1.25, false) }
    }
    // Focusing a node that is out of sight makes the browser scroll the box; scroll the view by that much instead.
    const onScroll = () => {
      if (!el.scrollLeft && !el.scrollTop) return
      view.current = settle({ ...view.current, x: view.current.x - el.scrollLeft, y: view.current.y - el.scrollTop })
      el.scrollLeft = 0
      el.scrollTop = 0
      paintNow()
    }
    // iOS Safari zooms the page on a pinch unless told not to.
    const noPageZoom = (event: Event) => event.preventDefault()

    el.addEventListener('pointerdown', onDown)
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerup', onUp)
    el.addEventListener('pointercancel', onUp)
    el.addEventListener('click', onClick, true)
    el.addEventListener('wheel', onWheel, { passive: false })
    el.addEventListener('keydown', onKey)
    el.addEventListener('scroll', onScroll)
    el.addEventListener('gesturestart', noPageZoom)
    st.addEventListener('transitionend', endGlide)
    return () => {
      el.removeEventListener('pointerdown', onDown)
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerup', onUp)
      el.removeEventListener('pointercancel', onUp)
      el.removeEventListener('click', onClick, true)
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('keydown', onKey)
      el.removeEventListener('scroll', onScroll)
      el.removeEventListener('gesturestart', noPageZoom)
      st.removeEventListener('transitionend', endGlide)
      cancelAnimationFrame(inertia)
      window.clearTimeout(wheelTimer)
    }
  }, [box, stage, api, go, limits, settle, paint, paintNow, schedule, endGlide])

  return api
}
