import { AgentSprite } from './team/AgentSprite'
import type { TeamAgent } from '../lib/hubTeam'

/** persona: the agent's own sprite from the Team, else a name-seeded one while the Team loads or when it is off. */
export default function Who({ id, name, agents, size, bare }: { id: string; name: string; agents: TeamAgent[]; size: number; bare?: boolean }) {
  const sprite = agents.find(agent => agent.id === id)?.sprite ?? { kind: 'random' as const, salt: 0, name }
  return <span className="hub-who" data-who={id}><AgentSprite sprite={sprite} size={size} title={name} />{!bare && <span className="hub-who-name">{name}</span>}</span>
}
