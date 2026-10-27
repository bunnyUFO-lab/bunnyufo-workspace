import type { Sign } from '../lib/hub'
import { SIGN_GLYPH, SIGN_LABEL } from './signs'

const ORDER: Sign[] = ['working', 'idle', 'new', 'pr', 'ci-failed', 'review', 'deployed']
const COLOR: Record<Sign, string> = {
  working: 'var(--pink)', idle: 'var(--text-dim)', new: 'var(--blue)', pr: 'var(--purple)', 'ci-failed': 'var(--red)', review: 'var(--amber)', deployed: 'var(--green)',
}

/** Small round badges in a row from (x, y): ⟳ (an animated ring), ⏸, ✦, ⇄, ✕, 👁, ▲, in that order. */
export default function MapSigns({ signs, x, y }: { signs: Sign[]; x: number; y: number }) {
  const shown = ORDER.filter(sign => signs.includes(sign))
  return (
    <>
      {shown.map((sign, index) => (
        <g key={sign} transform={`translate(${x + index * 16} ${y})`} data-sign={sign}>
          <title>{SIGN_LABEL[sign]}</title>
          {sign === 'working' ? (
            <circle r="7" fill="none" strokeWidth="2" strokeDasharray="22 8" style={{ stroke: COLOR[sign] }}>
              <animateTransform attributeName="transform" type="rotate" from="0" to="360" dur="1.4s" repeatCount="indefinite" />
            </circle>
          ) : (
            <>
              <circle r="7" strokeWidth="1.2" style={{ fill: 'var(--surface-solid)', stroke: COLOR[sign] }} />
              <text y="3.5" fontSize="9" textAnchor="middle" style={{ fill: COLOR[sign] }}>{SIGN_GLYPH[sign]}</text>
            </>
          )}
        </g>
      ))}
    </>
  )
}
