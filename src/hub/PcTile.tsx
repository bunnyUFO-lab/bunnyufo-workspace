import type { CSSProperties } from 'react'
import type { PcSummary, PcWake } from '../lib/hubPc'
import { pcHeadline, pcLines, seen } from './working'
import WakeButton from './WakeButton'
import './working.css'

/** `pc` is null when the PC has no status file (a long sleep): the tile then only offers the wake. */
export default function PcTile({ pc, wake }: { pc: PcSummary | null; wake?: PcWake }) {
  const asleep = !pc || pc.state === 'asleep-or-off'
  return (
    <section className="hub-panel rise pc-tile" style={{ '--i': 5 } as CSSProperties} aria-label="Gaming PC" data-pc={pc?.state ?? 'asleep-or-off'}>
      <h3><span className={`dot ${asleep ? 'st-idle' : 'st-working'}`} aria-hidden="true" />Gaming PC</h3>
      <p className="pc-head" data-pc-headline>{pc ? pcHeadline(pc) : 'Asleep or off · no report yet'}</p>
      {pc && pcLines(pc).map(line => (
        <div key={line.key} className="pc-line" data-pc-line={line.key}><span>{line.label}</span><b>{line.value}</b></div>
      ))}
      {pc && !asleep && pc.keepAwake && <span className="pc-chip" data-pc-awake>Kept awake</span>}
      {pc && !asleep && <small className="pc-updated">Updated {seen(pc.ageSeconds)}</small>}
      <WakeButton wake={wake} />
    </section>
  )
}
