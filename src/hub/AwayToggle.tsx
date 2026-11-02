import { useState } from 'react'
import { clock, hubPost } from '../lib/hub'
import { host } from '../lib/host'
import { useHubData } from './useHub'

/** What `/hub/presence` says: away only while its `until` is ahead (the Hub works that out). */
interface Presence { away: boolean; until: string | null }

/**
 * "At the PC / Away" in the Needs you header. While it says Away, a Claude session's question reaches the Hub (and Discord)
 * instead of a dialog on the PC; the switch turns itself off after 12 hours. Only the signed-in owner can flip it.
 */
export default function AwayToggle() {
  const { data, at } = useHubData<Presence>('/presence')
  // What a flip answered holds until the next read of the route replaces it.
  const [local, setLocal] = useState<{ presence: Presence; base: Date | null } | null>(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const state = local && local.base === at ? local.presence : data
  if (!state) return null
  const away = state.away
  const writable = host.write
  const flip = async () => {
    setBusy(true)
    setProblem(null)
    try { setLocal({ presence: await hubPost<Presence>('/presence', { away: !away }), base: at }) } catch (failure) { setProblem(failure instanceof Error ? failure.message : 'It did not work.') } finally { setBusy(false) }
  }
  const until = away && state.until ? clock(state.until) : ''
  return (
    <div className="away" data-away={away ? 'on' : 'off'}>
      <button
        type="button" role="switch" aria-checked={away} className={`hub-btn away-btn${away ? ' on' : ''}`} data-away-toggle
        disabled={busy || !writable} aria-busy={busy} title={writable ? undefined : 'Sign in to change this'} onClick={() => void flip()}
      >
        <span className="away-dot" aria-hidden="true" />
        <span data-away-label>{away ? `Away${until ? ` until ${until}` : ''}` : 'At the PC'}</span>
      </button>
      {away && <p className="away-sub" data-away-sub>Questions from Claude sessions come here and to Discord.</p>}
      {problem && <p className="hub-error" role="alert" data-away-error>{problem}</p>}
    </div>
  )
}
