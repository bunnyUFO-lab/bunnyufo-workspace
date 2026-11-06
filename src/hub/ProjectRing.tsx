import { isLaterOnly, tallyFraction } from './mapCount.ts'
import type { Tally } from './mapCount.ts'

/** The ring of a project or a milestone: the done part of everything it holds, and `done/total` inside. */
export default function ProjectRing({ tally }: { tally: Tally }) {
  const r = 21
  const length = 2 * Math.PI * r
  const colour = isLaterOnly(tally) ? 'var(--text-muted)' : 'var(--green)'
  return (
    <svg className="pp-ring" viewBox="0 0 52 52" aria-hidden="true">
      <circle cx="26" cy="26" r={r} fill="none" stroke="var(--line)" strokeWidth="5" />
      {tallyFraction(tally) > 0 && <circle cx="26" cy="26" r={r} fill="none" stroke={colour} strokeWidth="5" strokeLinecap="round" strokeDasharray={`${length * tallyFraction(tally)} ${length}`} transform="rotate(-90 26 26)" />}
      <text x="26" y="26" textAnchor="middle" dominantBaseline="central">{tally.done}/{tally.total}</text>
    </svg>
  )
}
