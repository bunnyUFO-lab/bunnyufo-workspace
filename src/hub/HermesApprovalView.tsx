import { useEffect, useState } from 'react'
import type { Item } from '../lib/hub'
import { hubPost } from '../lib/hub'
import { host } from '../lib/host'

/** Seconds left before Hermes denies the ask on its own, or 0. */
function secondsLeft(expiresAt: string | undefined, now: number) {
  const left = Math.ceil((new Date(expiresAt ?? 0).getTime() - now) / 1000)
  return Number.isFinite(left) && left > 0 ? left : 0
}

/**
 * A Hermes approval in Needs you: what Hermes wants to run and why, verbatim, and two answers. Hermes denies the ask
 * itself after five minutes, so the card says how long is left and the answers turn off when it is over.
 */
export default function HermesApprovalView({ item, onSettled }: { item: Item; onSettled: () => void }) {
  const [now, setNow] = useState(() => Date.now())
  const [busy, setBusy] = useState<'once' | 'deny' | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])
  const left = secondsLeft(item.expiresAt, now)
  const choices = item.choices ?? ['once', 'deny']

  async function answer(choice: 'once' | 'deny') {
    if (!host.write) { setError('Sign in to answer.'); return }
    setBusy(choice)
    setError('')
    try {
      await hubPost(`/hermes-approvals/${encodeURIComponent(item.id)}/answer`, { choice })
      onSettled()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not send the answer.')
      setBusy(null)
    }
  }

  return (
    <>
      <div className="ni-b" data-hermes-approval>
        {item.command && <pre className="ni-mono" data-hermes-command>{item.command}</pre>}
        {item.description && <pre className="ni-mono" data-hermes-description>{item.description}</pre>}
        <p className="hub-muted" data-hermes-countdown>
          {left > 0 ? `Hermes denies it in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}.` : 'Hermes denied it after 5 minutes.'}
        </p>
      </div>
      <div className="ni-a">
        {choices.includes('once') && <button type="button" className="hub-btn pri" disabled={busy !== null || left === 0} onClick={() => answer('once')} data-answer="once">Approve once</button>}
        {choices.includes('deny') && <button type="button" className="hub-btn" disabled={busy !== null || left === 0} onClick={() => answer('deny')} data-answer="deny">Deny</button>}
        {error && <span className="hub-error" role="alert">{error}</span>}
      </div>
    </>
  )
}
