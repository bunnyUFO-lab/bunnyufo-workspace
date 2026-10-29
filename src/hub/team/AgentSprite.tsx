import { useEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from 'react'
import { resolveSprite, type SpriteChoice } from './sprites'
import { rowOf, rowSpec, sheetSrc, STATE_LABEL, type CustomSprite, type SpriteState } from './spriteState'
import './sprite-states.css'

/** The art is drawn at 48 x 52 and the sheet holds it at x4. */
const ART = { w: 48, h: 52 }
const SHEET_ROW_COUNT = 9

/**
 * Plays the greeting once when the pointer (mouse or pen, not touch) enters, or the focus arrives
 * in, the nearest agent card or Working now row around the sprite. Never under reduced motion.
 */
function useGreeting(node: RefObject<Element | null>) {
  const [greeting, setGreeting] = useState(false)
  useEffect(() => {
    const host = node.current?.closest('[data-agent], .wn-row') ?? null
    if (!host) return
    const start = () => { if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) setGreeting(true) }
    const enter = (event: Event) => { if ((event as PointerEvent).pointerType !== 'touch') start() }
    host.addEventListener('pointerenter', enter)
    host.addEventListener('focusin', start)
    return () => { host.removeEventListener('pointerenter', enter); host.removeEventListener('focusin', start) }
  }, [node])
  return [greeting, () => setGreeting(false)] as const
}

/**
 * An agent's sprite. A built-in or random one is a 16 x 16 SVG; a custom one is a div over its pet
 * sheet. `state` picks what it does: a row of the sheet, or a CSS motion on the SVG.
 */
export function AgentSprite({ sprite, size = 32, title, name, state }: {
  sprite: SpriteChoice | CustomSprite
  size?: number
  title?: string
  /** With `state`, the accessible name becomes "<name>, <state label>". */
  name?: string
  state?: SpriteState
}) {
  const label = name && state ? `${name}, ${STATE_LABEL[state]}` : title
  return sprite.kind === 'custom'
    ? <SheetSprite sprite={sprite} size={size} label={label} state={state} />
    : <SvgSprite sprite={sprite} size={size} label={label} state={state} />
}

/** Draws a 16 x 16 sprite as SVG: one rect per run of equal pixels. */
function SvgSprite({ sprite, size, label, state }: { sprite: SpriteChoice; size: number; label?: string; state?: SpriteState }) {
  const data = useMemo(() => resolveSprite(sprite), [sprite])
  const node = useRef<SVGSVGElement>(null)
  const [greeting, done] = useGreeting(node)
  const rects = useMemo(() => {
    const out: { x: number; y: number; w: number; fill: string }[] = []
    data.rows.forEach((row, y) => {
      let x = 0
      while (x < row.length) {
        const c = row[x]
        if (c === '.') { x++; continue }
        let w = 1
        while (x + w < row.length && row[x + w] === c) w++
        out.push({ x, y, w, fill: data.palette[c] })
        x += w
      }
    })
    return out
  }, [data])
  return (
    <svg ref={node} className="px" width={size} height={size} viewBox="0 0 16 16" shapeRendering="crispEdges"
      data-state={state} data-row={state ? rowOf(state) : undefined} data-greeting={greeting || undefined}
      onAnimationEnd={event => { if (event.animationName === 'spr-wave') done() }}
      role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      {rects.map(r => <rect key={`${r.x},${r.y}`} x={r.x} y={r.y} width={r.w} height={1} fill={r.fill} />)}
    </svg>
  )
}

/** A pet sheet row, played with steps(). `size` is the display height; the width keeps the 48 : 52 art. */
function SheetSprite({ sprite, size, label, state }: { sprite: CustomSprite; size: number; label?: string; state?: SpriteState }) {
  const node = useRef<HTMLDivElement>(null)
  const [greeting, done] = useGreeting(node)
  const src = sheetSrc(sprite.url)
  const h = size
  const w = Math.round((size * ART.w) / ART.h)
  const row = greeting ? 'waving' : rowOf(state ?? 'idle')
  const spec = rowSpec(sprite, row)
  // Whole multiples of the 48 x 52 art keep nearest neighbour exact; below that it would drop every other pixel.
  const crisp = size % ART.h === 0
  const style = {
    width: w, height: h,
    backgroundImage: src ? `url("${src}")` : undefined,
    backgroundSize: `${sprite.cols * w}px ${SHEET_ROW_COUNT * h}px`,
    '--spr-w': `${w}px`, '--spr-y': `${-spec.index * h}px`, '--spr-n': spec.frames, '--spr-dur': `${spec.frames / spec.fps}s`,
  } as CSSProperties
  return (
    <div ref={node} className={`px-sheet${crisp ? ' crisp' : ''}${spec.frames > 1 ? ' play' : ''}`} style={style}
      data-state={state} data-row={row} data-frames={spec.frames} data-greeting={greeting || undefined}
      onAnimationEnd={event => { if (event.animationName === 'spr-greet') done() }}
      role="img" aria-label={label ?? sprite.sheet} />
  )
}
