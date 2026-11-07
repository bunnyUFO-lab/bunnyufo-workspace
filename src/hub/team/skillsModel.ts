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
  /** Skills any part of the group loads on every reply. */
  autoLoad: string[]
  note?: string
  /** Each profile's agents and what it loads, in order. A group from `agentGroups` has one part; `listGroups` can merge several. */
  parts: { profile: AgentProfile; agents: { id: string; name: string }[]; autoLoad: string[] }[]
  /** The profiles behind the group, in order; empty for an agent with none. */
  profiles: string[]
}

/** Agents that share a profile share one list, so they are one group, in the order the agents come. An agent with no profile is alone. */
export function agentGroups(view: Pick<TeamSkillsView, 'agents'>): AgentGroup[] {
  const groups: AgentGroup[] = []
  for (const agent of view.agents) {
    const found = agent.profile ? groups.find(group => group.profile === agent.profile) : undefined
    if (found) { found.agents.push({ id: agent.id, name: agent.name }); found.parts[0].agents.push({ id: agent.id, name: agent.name }); continue }
    groups.push({
      key: agent.profile ? `profile:${agent.profile}` : `agent:${agent.id}`, profile: agent.profile, agents: [{ id: agent.id, name: agent.name }],
      skills: agent.skills, autoLoad: agent.autoLoad ?? [], ...(agent.note ? { note: agent.note } : {}),
      parts: [{ profile: agent.profile, agents: [{ id: agent.id, name: agent.name }], autoLoad: agent.autoLoad ?? [] }], profiles: agent.profile ? [agent.profile] : [],
    })
  }
  return groups
}

const sameSet = (a: string[], b: string[]) => {
  const left = [...new Set(a)].sort()
  const right = [...new Set(b)].sort()
  return left.length === right.length && left.every((id, at) => id === right[at])
}

/**
 * The groups of `agentGroups`, with the ones whose skill lists are the same set merged into the first of them (its key and place
 * stay). Only the list decides: auto-load and plugins can differ between two groups with one list, and the owner's duplicate
 * (two profiles, one list) is what this removes. A group with no known list never merges.
 */
export function listGroups(view: Pick<TeamSkillsView, 'agents'>): AgentGroup[] {
  const merged: AgentGroup[] = []
  for (const group of agentGroups(view)) {
    const skills = group.skills
    const into = skills ? merged.find(other => other.skills && sameSet(other.skills, skills)) : undefined
    if (!into) { merged.push(group); continue }
    into.agents.push(...group.agents)
    into.parts.push(...group.parts)
    into.profiles.push(...group.profiles.filter(profile => !into.profiles.includes(profile)))
    into.autoLoad = [...new Set([...into.autoLoad, ...group.autoLoad])]
  }
  return merged
}

/** Where a group loads a skill on every reply: null when none does, `all` when every profile does, else the names of the agents that do. */
export function autoOf(group: Pick<AgentGroup, 'parts'>, id: string): { all: boolean; only: string | null } | null {
  const loading = group.parts.filter(part => part.autoLoad.includes(id))
  if (!loading.length) return null
  if (loading.length === group.parts.length) return { all: true, only: null }
  return { all: false, only: `Only for ${loading.flatMap(part => part.agents.map(agent => agent.name)).join(', ')}` }
}

/** Who has a skill, in a line: "All 6 agents with a list", up to three names and a rest, or that none is known. */
export function agentsLine(skill: Pick<TeamSkill, 'agents'>, view: Pick<TeamSkillsView, 'agents'>): string {
  const known = view.agents.filter(agent => agent.skills).length
  const names = skill.agents.map(agent => agent.name)
  if (!names.length) return 'No agent known'
  if (known > 1 && names.length >= known) return `All ${known} agents with a list`
  return names.length <= 3 ? names.join(', ') : `${names.slice(0, 3).join(', ')} +${names.length - 3}`
}

/** The first three names and "+N" for the rest, for a closed section's head. */
export const previewOf = (names: string[], shown = 3): string => (names.length <= shown ? names.join(', ') : `${names.slice(0, shown).join(', ')} +${names.length - shown}`)

/** Up to this many rows in a group or view needs no folding: its sections start open. */
export const SHORT_LIST = 8
/** What the user opened or closed, kept in this browser as JSON `{ [foldKey]: boolean }`. Only the overrides are stored. */
export const OPEN_KEY = 'hub.team.skillsOpen'
export function readOpen(raw: string | null): Record<string, boolean> {
  try {
    const value: unknown = raw ? JSON.parse(raw) : null
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, boolean] => typeof entry[1] === 'boolean'))
  } catch {
    return {}
  }
}
/** Whether a fold is open: what the user chose, else the fallback. */
export const foldOpen = (key: string, stored: Record<string, boolean>, fallback: boolean): boolean => (typeof stored[key] === 'boolean' ? stored[key] : fallback)

/** The skill to show beside the list: the current one while it still matches the search, else the first match; null when nothing matches. */
export function openSkill(ids: string[], current: string | null, query: string): string | null {
  const matching = ids.filter(id => skillMatches(id, query))
  return current && matching.includes(current) ? current : matching[0] ?? null
}

/** "Hermes, Planner and Researcher share one list." (one profile) or "... have the same skills." (several), or null for one agent. */
export function sharedText(group: Pick<AgentGroup, 'agents'> & { profiles?: string[] }): string | null {
  const names = group.agents.map(agent => agent.name)
  if (names.length < 2) return null
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]} ${(group.profiles?.length ?? 0) > 1 ? 'have the same skills' : 'share one list'}.`
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

/** A plugin of a group: one status when every profile of the group agrees, else `differs` with a line saying who has it how. */
export interface GroupPluginRow extends Omit<PluginRow, 'status'> { status: PluginRow['status'] | 'differs'; line?: string }

const STATUS_FOR = { enabled: 'On for', disabled: 'Off for', 'not enabled': 'Not on for' } as const

/** The plugins a group's profiles list. A profile that does not list one counts as not on. Null when the Hub does not know (no export list, or no profile). */
export function groupPluginRows(view: Pick<TeamSkillsView, 'plugins'>, group: Pick<AgentGroup, 'parts'>): GroupPluginRow[] | null {
  const parts = group.parts.filter(part => part.profile)
  if (!view.plugins.known || !parts.length) return null
  const byPart = parts.map(part => ({ part, rows: pluginRows(view, part.profile) ?? [] }))
  const names = [...new Set(byPart.flatMap(entry => entry.rows.map(row => row.name)))]
  const rows: GroupPluginRow[] = names.map(name => {
    const found = byPart.map(entry => ({ part: entry.part, row: entry.rows.find(row => row.name === name) }))
    const first = found.find(entry => entry.row)?.row as PluginRow
    const statuses = found.map(entry => entry.row?.status ?? 'not enabled')
    if (statuses.every(status => status === statuses[0])) return { ...first, status: statuses[0] }
    const line = (['enabled', 'disabled', 'not enabled'] as const)
      .map(status => ({ status, who: found.filter((_, at) => statuses[at] === status).flatMap(entry => entry.part.agents.map(agent => agent.name)) }))
      .filter(entry => entry.who.length)
      .map(entry => `${STATUS_FOR[entry.status]} ${entry.who.join(', ')}.`)
      .join(' ')
    return { ...first, status: 'differs', line }
  })
  const rank = (row: GroupPluginRow) => (row.status === 'enabled' ? 0 : row.status === 'differs' ? 1 : 2)
  return rows.sort((a, b) => rank(a) - rank(b) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}
