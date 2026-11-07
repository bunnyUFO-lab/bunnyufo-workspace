import { useState } from 'react'
import { HubError, hubPost } from '../lib/hub'
import { host } from '../lib/host'

/**
 * Take a sent checklist back to edit it. Asks once (the agent may already have read it), then the Hub starts a new round: the ticks,
 * the note and the pictures stay, and the next Submit replaces the earlier one for the agent.
 */
export default function ReopenButton({ id, noun, pickedUp, reload }: { id: string; noun: string; pickedUp: boolean; reload: () => void }) {
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  async function reopen() {
    setBusy(true)
    setProblem(null)
    try {
      await hubPost(`/checklists/${encodeURIComponent(id)}/reopen`, {})
      setAsking(false)
      reload()
    } catch (failure) {
      if (failure instanceof HubError && failure.status === 409) reload()
      setProblem(failure instanceof HubError || failure instanceof Error ? failure.message : 'That did not work.')
    } finally {
      setBusy(false)
    }
  }

  if (!host.write) return null
  if (!asking) return <p><button type="button" className="hub-btn" data-reopen onClick={() => setAsking(true)}>Reopen to edit</button></p>
  return (
    <section className="hub-panel" aria-label="Reopen" data-reopen-ask>
      <p>Reopen this {noun}? {pickedUp ? 'The agent has already read it. It will see that you reopened it and get your new answer when you send it again.' : 'The agent will see that you reopened it, and get your new answer when you send it again.'} What you wrote and the pictures stay.</p>
      {problem && <p role="alert" className="hub-error">{problem}</p>}
      <p>
        <button type="button" className="hub-btn pri" data-reopen-confirm disabled={busy} onClick={() => void reopen()}>Reopen</button>{' '}
        <button type="button" className="hub-btn" disabled={busy} onClick={() => { setAsking(false); setProblem(null) }}>Keep as sent</button>
      </p>
    </section>
  )
}
