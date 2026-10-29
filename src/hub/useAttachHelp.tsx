import { useState } from 'react'
import type { ChatSummary } from '../lib/hub'
import { host } from '../lib/host'
import { hubHash } from '../lib/route'
import type { HelpKind } from '../lib/route'
import { useHubData } from './useHub'

/**
 * The newest help chat about this item, if the owner has one. The checkbox is on by default: the chat is the owner's own
 * troubleshooting for this very item. `help` is what the request carries (`{ chat }`) or undefined.
 */
export function useAttachHelp(kind: HelpKind, id: string, live: boolean) {
  const enabled = host.chat && host.write && live
  const list = useHubData<{ conversations: ChatSummary[] }>(enabled ? '/chat' : null)
  const [off, setOff] = useState(false)
  const found = enabled ? list.data?.conversations.find(item => item.about?.kind === kind && item.about.id === id) : undefined
  const attach = !!found && !off
  return {
    chat: found ?? null,
    help: attach && found ? { chat: found.id } : undefined,
    element: found ? (
      <div className="hub-attach-help" data-attach-help>
        <label>
          <input type="checkbox" checked={attach} onChange={event => setOff(!event.target.checked)} />
          <span>Attach my help chat ({Math.max(0, found.count - 1)} messages) so the agent sees what we tried</span>
        </label>
        <a href={hubHash('chat', found.id)} data-attach-help-open>Open</a>
      </div>
    ) : null,
  }
}

