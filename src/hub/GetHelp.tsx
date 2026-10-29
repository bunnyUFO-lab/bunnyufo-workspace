import { host } from '../lib/host'
import { helpHash, hubHash } from '../lib/route'
import { Icon } from '../local/Icons'
import { setHelpDraft } from './flash'
import type { HelpTarget } from './helpDraft'
import { itemDraft, stepDraft } from './helpDraft'

const open = (target: HelpTarget, draft: string, step?: string) => {
  setHelpDraft(draft)
  window.location.assign(helpHash(target, step))
}

/** The Get help button of a Needs-you card or an item's page. It shows only where Chat is set up. At 480 px and under it is an icon. */
export default function GetHelp({ target, className = '' }: { target: HelpTarget; className?: string }) {
  if (!host.chat) return null
  return (
    <button type="button" className={`hub-btn ni-help ${className}`.trim()} data-get-help={target.kind} aria-label="Get help" title="Get help" onClick={() => open(target, itemDraft(target))}>
      <Icon name="chats" size={18} /><span className="ni-help-text">Get help</span>
    </button>
  )
}

/** The link under a step's guide: help focused on that step. */
export function StepHelp({ target, step, text, note }: { target: HelpTarget; step: string; text: string; note: string }) {
  if (!host.chat) return null
  return <p><button type="button" className="hub-link ni-step-help" data-step-help={step} onClick={() => open(target, stepDraft(step, text, note), step)}>Get help with this step</button></p>
}

/** "Help chat attached" with a link, where an answer or a submission shows what was sent. */
export function HelpAttachedNote({ chat }: { chat?: string }) {
  if (!chat) return null
  return <p className="hub-muted" data-help-attached>Help chat attached. <a href={hubHash('chat', chat)}>Open it</a></p>
}
