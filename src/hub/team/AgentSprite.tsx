import { useMemo } from 'react'
import { resolveSprite, type SpriteChoice } from './sprites'

/** Draws a 16 x 16 sprite as SVG: one rect per run of equal pixels, no logic beyond drawing. */
export function AgentSprite({ sprite, size = 32, title }: { sprite: SpriteChoice; size?: number; title?: string }) {
  const data = useMemo(() => resolveSprite(sprite), [sprite])
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
    <svg className="px" width={size} height={size} viewBox="0 0 16 16" shapeRendering="crispEdges"
      role={title ? 'img' : undefined} aria-label={title} aria-hidden={title ? undefined : true}>
      {rects.map(r => <rect key={`${r.x},${r.y}`} x={r.x} y={r.y} width={r.w} height={1} fill={r.fill} />)}
    </svg>
  )
}
