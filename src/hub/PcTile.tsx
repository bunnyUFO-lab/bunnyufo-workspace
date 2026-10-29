import type { CSSProperties } from 'react'
import type { PcSummary } from '../lib/hubPc'
import { pcHeadline, pcLines, seen } from './working'
import './working.css'

export default function PcTile({ pc }: { pc: PcSummary }) {
  const asleep = pc.state === 'asleep-or-off'
  return (
    <section className="hub-panel rise pc-tile" style={{ '--i': 5 } as CSSProperties} aria-label="Gaming PC" data-pc={pc.state}>
      <h3><span className={`dot ${asleep ? 'st-idle' : 'st-working'}`} aria-hidden="true" />Gaming PC</h3>
      <p className="pc-head" data-pc-headline>{pcHeadline(pc)}</p>
      {pcLines(pc).map(line => (
        <div key={line.key} className="pc-line" data-pc-line={line.key}><span>{line.label}</span><b>{line.value}</b></div>
      ))}
      {!asleep && pc.keepAwake && <span className="pc-chip" data-pc-awake>Kept awake</span>}
      {!asleep && <small className="pc-updated">Updated {seen(pc.ageSeconds)}</small>}
    </section>
  )
}
