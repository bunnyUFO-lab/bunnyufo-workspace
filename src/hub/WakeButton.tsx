import { useState } from 'react'
import { hubPost } from '../lib/hub'
import { host } from '../lib/host'
import type { PcWake } from '../lib/hubPc'
import './working.css'

/** "Wake the PC" when it reads as asleep or off, "Waking…" while a wake is under way. Nothing when no wake is set up or the PC is up. */
export default function WakeButton({ wake }: { wake: PcWake | null | undefined }) {
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  if (!wake || !wake.wakeAvailable) return null
  if (wake.state === 'awake' || wake.state === 'woke') return null
  const send = async () => {
    setBusy(true)
    setProblem(null)
    try { await hubPost('/pc/wake', {}) } catch (failure) { setProblem(failure instanceof Error ? failure.message : 'It did not work.') } finally { setBusy(false) }
  }
  if (wake.state === 'waking') return <div className="pc-wake waking" data-wake="waking" role="status"><p>Waking…</p></div>
  return (
    <div className="pc-wake" data-wake={wake.state}>
      {wake.state === 'off' && <p data-wake-off>It didn't wake. It's off or signed out (Wake-on-LAN works only from sleep). Start it at the PC.</p>}
      {host.write && <button type="button" className="hub-btn" disabled={busy} aria-busy={busy} onClick={() => void send()} data-wake-button>Wake the PC</button>}
      {problem && <p className="hub-error" role="alert" data-wake-error>{problem}</p>}
    </div>
  )
}
