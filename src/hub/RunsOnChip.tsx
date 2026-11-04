import { useEffect, useRef, useState } from 'react'
import type { RunsOn } from '../lib/hub'

/** Where a project's work runs by default: full text and the rule in plain words, a short text on a phone. */
export const RUNS_ON: Record<RunsOn, { full: string; short: string; rule: string }> = {
  pc: { full: 'Runs on: Gaming PC', short: 'Runs on PC', rule: 'Work for this project runs on the PC by default.' },
  cloud: { full: 'Runs on: cloud', short: 'Runs in cloud', rule: 'This project lives in a GitHub repository, so its work runs in the cloud.' },
  'at-pc': { full: 'Started by you at the PC', short: 'You start it', rule: 'This project is never started remotely; you start its work at the PC.' },
}

export default function RunsOnChip({ runsOn }: { runsOn?: RunsOn }) {
  const text = runsOn && RUNS_ON[runsOn]
  const [shown, setShown] = useState(false)
  const root = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (!shown) return
    const away = (event: Event) => { if (!root.current?.contains(event.target as Node)) setShown(false) }
    const escape = (event: globalThis.KeyboardEvent) => { if (event.key === 'Escape') setShown(false) }
    document.addEventListener('pointerdown', away)
    document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('pointerdown', away); document.removeEventListener('keydown', escape) }
  }, [shown])
  if (!text) return null
  return (
    <span className="hub-runs-wrap" ref={root}>
      <button type="button" className="hub-runs" title={text.rule} aria-label={`${text.full}. ${text.rule}`} aria-expanded={shown} aria-controls="hub-runs-rule" onClick={() => setShown(value => !value)}>
        <span className="hub-runs-full">{text.full}</span>
        <span className="hub-runs-short" aria-hidden="true">{text.short}</span>
      </button>
      {shown && <span className="hub-runs-rule" id="hub-runs-rule" role="note">{text.rule}</span>}
    </span>
  )
}
