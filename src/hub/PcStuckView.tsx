import { useState } from 'react'
import type { Item } from '../lib/hub'
import { hubPost } from '../lib/hub'
import { host } from '../lib/host'
import { hubHash } from '../lib/route'
import type { PcWait } from '../lib/hubPc'
import type { SettleExtra, SettleVerb } from './NeedsItem'
import { CodeBlock } from './Md'

/** The step and the command to copy, for a cause that has one. Shared by the Needs you item and the job page. */
export function PcFix({ wait }: { wait: Pick<PcWait, 'step' | 'command'> }) {
  if (!wait.command) return null
  return (
    <div data-pc-fix>
      {wait.step && <p className="hub-muted">{wait.step}</p>}
      <CodeBlock exact>{wait.command}</CodeBlock>
    </div>
  )
}

/**
 * An approved PC job that has not started after 10 minutes, for a cause the Hub knows (ws-3o5): a plain title above, then two or three
 * sentences, the step to copy, and the buttons that make sense. Retry wakes the PC (only when it looks asleep or off). "Run it in the
 * cloud" is there only when the job could run there. Cancel stops the job. The item goes away by itself when the job is taken.
 */
export default function PcStuckView({ item, onSettled }: { item: Item; onSettled: (verb: SettleVerb, extra?: SettleExtra) => void }) {
  const [busy, setBusy] = useState<'wake' | 'cloud' | 'cancel' | null>(null)
  const [error, setError] = useState('')
  const [woke, setWoke] = useState(false)
  const id = encodeURIComponent(item.id)

  async function run(kind: 'wake' | 'cloud' | 'cancel') {
    if (!host.write) { setError('Sign in to do that.'); return }
    setBusy(kind)
    setError('')
    try {
      if (kind === 'wake') { await hubPost('/pc/wake', {}); setWoke(true); setBusy(null); return }
      if (kind === 'cancel') {
        await hubPost(`/requests/${id}/stop`, { reason: 'Cancelled: the PC could not start it' })
        onSettled('cancelled')
        return
      }
      const made = await hubPost<{ id: string }>(`/requests/${id}/move-to-cloud`, {})
      onSettled('approved', { detail: 'it runs in the cloud now', link: { label: 'Watch the cloud run', hash: hubHash('request', made.id) } })
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'That did not work.')
      setBusy(null)
    }
  }

  return (
    <>
      <div className="ni-b" data-pc-stuck={item.cause}>
        {item.job && <p className="hub-muted" data-pc-stuck-job>Job: {item.job}</p>}
        <p data-pc-stuck-text>{item.summary}</p>
        <PcFix wait={{ step: item.step, command: item.command }} />
        {woke && <p className="hub-muted" role="status" data-pc-stuck-woke>Asked the PC to wake. This item goes away when the job starts.</p>}
        {error && <p className="hub-error" role="alert" data-pc-stuck-error>{error}</p>}
      </div>
      <div className="ni-a">
        {item.canWake && host.write && <button type="button" className="hub-btn pri" disabled={busy !== null} onClick={() => void run('wake')} data-pc-stuck-retry>Retry (wake the PC)</button>}
        {item.cloudOk && host.write && <button type="button" className={`hub-btn${item.canWake ? '' : ' pri'}`} disabled={busy !== null} onClick={() => void run('cloud')} data-pc-stuck-cloud>Run it in the cloud</button>}
        <a className="hub-btn" href={hubHash('request', item.id)} data-pc-stuck-open>Open the job</a>
        <span className="sp" />
        {host.write && <button type="button" className="hub-btn" disabled={busy !== null} onClick={() => void run('cancel')} data-pc-stuck-cancel>Cancel the job</button>}
      </div>
    </>
  )
}
