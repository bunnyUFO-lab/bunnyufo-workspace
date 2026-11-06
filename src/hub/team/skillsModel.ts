// Pure words and addresses for the Skills and plugins half of Team. No React, so Node can test it.
import type { AgentProfile, TeamSkill, TeamSkillsView } from '../../lib/hubTeam'

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

export const NO_PLUGINS_LINE = "The Hermes host's export does not list plugins yet."

/** Two ways to read the same list. Kept in this browser. */
export type SkillsBy = 'agent' | 'skill'
export const BY_KEY = 'hub.team.skillsBy'
export const byOf = (stored: string | null): SkillsBy => (stored === 'skill' ? 'skill' : 'agent')

export interface FolderGroup<T> { folder: string; label: string; items: T[] }

/** The first folder of a skill id (`creative/art/x` is in `creative`); empty for a skill with none. */
export const folderOf = (id: string): string => (id.includes('/') ? id.slice(0, id.indexOf('/')) : '')

/** Skills grouped by their first folder: folders in name order, the ones with no folder last as "Other". Items keep their order. */
export function groupByFolder<T extends { id: string }>(items: T[]): FolderGroup<T>[] {
  const map = new Map<string, T[]>()
  for (const item of items) {
    const folder = folderOf(item.id)
    map.set(folder, [...(map.get(folder) ?? []), item])
  }
  const folders = [...map.keys()].filter(folder => folder).sort()
  return [...folders, ...(map.has('') ? [''] : [])].map(folder => ({ folder, label: folder || 'Other', items: map.get(folder) ?? [] }))
}

/** The search box: any part of the text, ignoring case and spaces at the ends. */
export const skillMatches = (text: string, query: string): boolean => text.toLowerCase().includes(query.trim().toLowerCase())

export interface AgentGroup {
  key: string
  profile: AgentProfile
  agents: { id: string; name: string }[]
  /** Everything the group can use, or null when the Hub does not know. */
  skills: string[] | null
  autoLoad: string[]
  note?: string
}

/** Agents that share a profile share one list, so they are one group, in the order the agents come. An agent with no profile is alone. */
export function agentGroups(view: Pick<TeamSkillsView, 'agents'>): AgentGroup[] {
  const groups: AgentGroup[] = []
  for (const agent of view.agents) {
    const found = agent.profile ? groups.find(group => group.profile === agent.profile) : undefined
    if (found) { found.agents.push({ id: agent.id, name: agent.name }); continue }
    groups.push({
      key: agent.profile ? `profile:${agent.profile}` : `agent:${agent.id}`, profile: agent.profile, agents: [{ id: agent.id, name: agent.name }],
      skills: agent.skills, autoLoad: agent.autoLoad ?? [], ...(agent.note ? { note: agent.note } : {}),
    })
  }
  return groups
}

/** The skill to show beside the list: the current one while it still matches the search, else the first match; null when nothing matches. */
export function openSkill(ids: string[], current: string | null, query: string): string | null {
  const matching = ids.filter(id => skillMatches(id, query))
  return current && matching.includes(current) ? current : matching[0] ?? null
}

/** "Hermes, Planner and Researcher share one list.", or null for one agent. */
export function sharedText(group: Pick<AgentGroup, 'agents'>): string | null {
  const names = group.agents.map(agent => agent.name)
  if (names.length < 2) return null
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]} share one list.`
}

export interface PluginRow { name: string; version: string; source: string; description: string; status: 'enabled' | 'disabled' | 'not enabled' }

/** The plugins one profile lists, enabled ones first, then by name. Null when the export does not list plugins, or the agent has no profile. */
export function pluginRows(view: Pick<TeamSkillsView, 'plugins'>, profile: AgentProfile): PluginRow[] | null {
  if (!view.plugins.known || !profile) return null
  const rows: PluginRow[] = []
  for (const item of view.plugins.items) {
    const mine = item.profiles.find(entry => entry.profile === profile)
    if (mine) rows.push({ name: item.name, version: item.version, source: item.source, description: item.description, status: mine.status })
  }
  const rank = (row: PluginRow) => (row.status === 'enabled' ? 0 : 1)
  return rows.sort((a, b) => rank(a) - rank(b) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}
