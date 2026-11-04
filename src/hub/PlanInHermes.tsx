import { host } from '../lib/host'
import { hubHash } from '../lib/route'
import { startChat } from './chatStart'
import { planDraft } from './questionSeed'

/**
 * "Plan in Hermes": opens Chat with the Planner and a draft that names this project and the node the owner is looking at. It files nothing
 * and sends nothing; the owner reads the draft and presses send. The Planner files one change-list Ask when the plan is ready.
 */
export default function PlanInHermes({ project, projectName, selected, action }: { project: string; projectName: string; selected: { id: string; title: string } | null; /** The project page marks its button `data-project-action`. */ action?: string }) {
  if (!host.write || !host.chat) return null
  return (
    <button
      type="button" className="hub-btn hub-plan-btn" data-plan-in-hermes data-project-action={action} title="Talk the plan through with Hermes. It files a change list for you to approve; nothing changes until you answer."
      onClick={() => { startChat({ persona: 'planner', draft: planDraft(project, projectName, selected) }); window.location.hash = hubHash('chat') }}
    >Plan in Hermes</button>
  )
}
