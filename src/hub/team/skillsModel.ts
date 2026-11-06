// Pure words and addresses for the Skills and plugins half of Team. No React, so Node can test it.
import type { TeamSkill, TeamSkillsView } from '../../lib/hubTeam'

export const SHARED_LINE = 'Agents on one profile share a list.'
export const PLUGINS_LINE = 'Claude Code\'s plugins and skills live on the PC. The Hub has no list of them.'
export const GUEST_LINE = 'Skills need sign-in. Agents and the floor are open to everyone.'

/** The address of a skill's page. An id can hold `/` (a skill in a category), so it is encoded. */
export const skillHash = (id: string) => `#/~hub/team/skills/${encodeURIComponent(id)}`

/** The part of a Team route id after `skills/`: the skill's id; null on the list, or when the route is not the skills half. */
export function skillOf(routeId: string | undefined): string | null {
  if (!routeId?.startsWith('skills/')) return null
  const id = routeId.slice('skills/'.length)
  return id || null
}

export const isSkillsRoute = (routeId: string | undefined) => routeId === 'skills' || !!routeId?.startsWith('skills/')

/** Which lists name a skill, in plain words. */
export function sourceText(skill: TeamSkill): string {
  const parts: string[] = []
  if (skill.autoLoad) parts.push('loaded on every reply')
  if (skill.sources.includes('installed') && !skill.autoLoad) parts.push('installed')
  if (skill.owner) parts.push('one of yours')
  return parts.join(' · ')
}

export const agentCount = (skill: TeamSkill) => (skill.agents.length === 1 ? '1 agent' : `${skill.agents.length} agents`)

/** The line under the list about the export: when it is from, or that there is none. */
export function exportLine(view: Pick<TeamSkillsView, 'exportedAt' | 'fresh'>, when: string): { text: string; warn: boolean } {
  if (!view.exportedAt) return { text: 'The Hermes host has not published its settings yet, so no agent\'s skills are known.', warn: true }
  if (!view.fresh) return { text: `Last read from the Hermes host ${when}. Its export may have stopped, so this may be out of date.`, warn: true }
  return { text: `Read from the Hermes host ${when}.`, warn: false }
}

/** The names of the profiles a skill is on, for the skill page. */
export function profileText(skill: TeamSkill): string {
  if (!skill.profiles.length) return 'No profile has it installed.'
  return `On the ${skill.profiles.length === 1 ? 'profile' : 'profiles'} ${skill.profiles.join(', ')}.`
}
