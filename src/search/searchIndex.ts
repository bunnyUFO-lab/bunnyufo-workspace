// What Search finds and how it lays it out: pure, so a node test can cover the whole of it with no browser.
// The rows come from sources the screen has read (cards, items, projects, jobs, agents, chats, Beads text, message hits);
// nothing here reads a network or `window`.
import { skillHash } from '../hub/team/skillsModel.ts'
import { entityHash, hubHash, projectHash, projectNodeHash, reviewHash } from '../lib/route.ts'
import { rowMatches, snippetOf, words as wordsOf } from '../hub/beadSearch.ts'
import type { SearchRow } from '../hub/beadSearch.ts'

/** The kinds of result, which are also the filter chips (Needs you and Today are jumps, not filters). */
export type Kind = 'screens' | 'needs' | 'chats' | 'library' | 'projects' | 'tasks' | 'jobs' | 'team'

/** The picture on a row: the app's own icons, and a few of Search's own. */
export type HitIcon = 'today' | 'chat' | 'work' | 'project' | 'library' | 'team' | 'sketch' | 'settings' | 'inbox' | 'card' | 'job' | 'task' | 'skill' | 'activity' | 'sparkle'

export interface Hit {
  kind: Kind
  key: string
  title: string
  sub: string
  icon: HitIcon
  hash: string
  /** More words a query may match, that the row does not show. */
  hay?: string
  /** Listed before the rest of its group, whatever the match: a card of the open section. */
  first?: boolean
  rank?: number
}

/** The order of the groups when no chip narrows the results. */
export const GROUP_ORDER: Kind[] = ['screens', 'needs', 'chats', 'library', 'projects', 'tasks', 'jobs', 'team']
/** The filter chips, in the order they are drawn (after All). */
export const FILTERS: Kind[] = ['library', 'chats', 'jobs', 'projects', 'tasks', 'team', 'screens']
export const KIND_TITLE: Record<Kind, string> = { screens: 'Screens', needs: 'Needs you', chats: 'Chats', library: 'Library', projects: 'Projects', tasks: 'Tasks', jobs: 'Jobs', team: 'Team' }
export const KIND_NOUN: Record<Kind, [string, string]> = {
  chats: ['chat', 'chats'], library: ['card', 'cards'], projects: ['project', 'projects'], tasks: ['task', 'tasks'], jobs: ['job', 'jobs'], team: ['agent or skill', 'agents and skills'], screens: ['screen', 'screens'], needs: ['item', 'items'],
}
/** Each kind's own screen, for the "Open ..." link over a filtered list. */
export const KIND_SCREEN: Partial<Record<Kind, [string, string]>> = {
  chats: [hubHash('chat'), 'Open Chat'], library: [hubHash('library'), 'Open Library'], projects: [hubHash('project'), 'Open Projects'],
  tasks: [hubHash('work'), 'Open Board'], jobs: [hubHash('jobs'), 'Open Work'], team: [hubHash('team'), 'Open Team'],
}

/** How many rows of a group show with All, and how many a filtered list draws before "Show more". */
export const GROUP_LIMIT: Partial<Record<Kind, number>> = { needs: 6, screens: 6 }
export const ALL_LIMIT = 3
export const PAGE = 50

export interface Caps { hub: boolean; write: boolean; chat: boolean }

export interface CardSource { id: string; title: string; description?: string; category?: string; /** Set aside by the Library's archive rule. Found only when something is typed. */ archived?: boolean; workspace: { id: string; name: string; active?: boolean } }
export interface ItemSource { kind: string; id: string; title: string; project?: string; summary?: string; question?: string }
export interface JobSource { id: string; title: string; project: string; state: string; agent?: string }
export interface AgentSource { id: string; name: string; role?: string }
export interface ChatSource { id: string; title: string; persona?: string | null; archived?: boolean }
export interface ChatHit { chat: string; title: string; persona?: string | null; line: number; snippet: string; archived?: boolean }

export interface Sources {
  caps: Caps
  cards: CardSource[]
  items: ItemSource[]
  projects: { id: string; name?: string }[]
  jobs: JobSource[]
  agents: AgentSource[]
  /** Skill ids from `/hub/team/skills` (signed in only); empty for a guest. */
  skills?: string[]
  chats: ChatSource[]
  /** The Beads text rows (`/search-text`), read only while two letters are typed. */
  beads: SearchRow[]
  /** Message hits (`/chat/search`) for the text typed. */
  hits: ChatHit[]
}

/** The Hub's route for an open item. */
export function itemHash(item: Pick<ItemSource, 'kind' | 'id'>): string {
  if (item.kind === 'ask') return hubHash('ask', item.id)
  if (item.kind === 'checklist') return hubHash('checklist', item.id)
  if (item.kind === 'review') return reviewHash(item.id)
  if (item.kind === 'approval' || item.kind === 'request') return hubHash('request', item.id)
  return hubHash('needs', 'sessions')
}

const ITEM_KIND: Record<string, string> = { ask: 'Question', checklist: 'Steps', review: 'Review', approval: 'Job to approve', request: 'Job to approve', 'hermes-approval': 'Approval', 'run-question': 'Question', blocked: 'Blocked', session: 'Session' }
const JOB_STATE = (state: string) => (state === 'running' || state === 'taken' || state === 'approved' || state === 'stopping' ? 'Running' : state === 'failed' || state === 'lost' ? 'Failed' : state === 'proposed' || state === 'asking' ? 'Waiting for you' : 'Delivered')

/** The words of a query, lower case. */
export const queryWords = (q: string): string[] => wordsOf(q)

/** A chat message's own address: the thread, landed on that line. */
export const chatLineHash = (chat: string, line: number): string => `${hubHash('chat', chat)}/m/${line}`

/** The screens a visitor can open from Search, as rows. Every screen the host has, and only those. */
export function screenRows(caps: Caps): Hit[] {
  const chat = caps.hub && (caps.chat || !caps.write)
  const all: [string, string, HitIcon, string, boolean][] = [
    ['today', 'Today', 'today', hubHash('today'), caps.hub],
    ['needs', 'Needs you', 'inbox', hubHash('needs'), caps.hub],
    ['chat', 'Chat', 'chat', hubHash('chat'), chat],
    ['work', 'Work', 'work', hubHash('work'), caps.hub],
    ['activity', 'Activity', 'activity', hubHash('activity'), caps.hub],
    ['project', 'Projects', 'project', hubHash('project'), caps.hub],
    ['library', 'Library', 'library', hubHash('library'), true],
    ['team', 'Team', 'team', hubHash('team'), caps.hub],
    ['skills', 'Skills and plugins', 'skill', `${hubHash('team')}/skills`, caps.hub],
    ['sketch', 'Sketch', 'sketch', hubHash('sketch'), caps.hub && caps.write],
    ['settings', 'Settings', 'settings', hubHash('settings'), true],
  ]
  return all.filter(row => row[4]).map(([key, title, icon, hash]) => ({ kind: 'screens', key, title, sub: 'Screen', icon, hash }))
}

/** The tiles shown before anything is typed: Work first, then Team, Skills, Activity, Sketch, Settings. */
export function tileRows(caps: Caps): Hit[] {
  const by = new Map(screenRows(caps).map(row => [row.key, row]))
  return ['work', 'team', 'skills', 'activity', 'sketch', 'settings'].flatMap(key => { const row = by.get(key); return row ? [{ ...row, title: key === 'skills' ? 'Skills' : row.title }] : [] })
}

/** Every row the sources can give. `typed` is whether anything is typed: archived cards and chats are found only then. */
export function indexRows(sources: Sources, typed: boolean): Hit[] {
  const { caps } = sources
  const out: Hit[] = [...screenRows(caps)]
  if (caps.hub) {
    for (const item of sources.items) out.push({ kind: 'needs', key: `${item.kind}:${item.id}`, title: item.title, sub: [ITEM_KIND[item.kind] ?? 'Item', item.project].filter(Boolean).join(' · '), icon: 'inbox', hash: itemHash(item), hay: `${item.summary ?? ''} ${item.question ?? ''}` })
  }
  for (const chat of caps.hub ? sources.chats : []) {
    if (chat.archived && !typed) continue
    out.push({ kind: 'chats', key: chat.id, title: chat.title, sub: [chat.archived ? 'Archived' : '', chat.persona ?? ''].filter(Boolean).join(' · ') || 'Chat', icon: 'chat', hash: hubHash('chat', chat.id) })
  }
  // With more than one section, the hint names the card's section; with one, its category.
  const sections = new Set(sources.cards.map(card => card.workspace.id)).size > 1
  for (const card of sources.cards) {
    const archived = !!card.archived
    if (archived && !typed) continue
    out.push({
      kind: 'library', key: `${card.workspace.id}/${card.id}`, title: card.title, sub: `${archived ? 'Archived · ' : ''}${sections ? card.workspace.name : card.category ?? 'Card'}`,
      icon: 'card', hash: entityHash(card.id), hay: `${card.description ?? ''} ${card.category ?? ''} ${card.workspace.name}`, first: !!card.workspace.active,
    })
  }
  if (caps.hub) {
    for (const project of sources.projects) out.push({ kind: 'projects', key: project.id, title: project.name || project.id, sub: 'Project', icon: 'project', hash: projectHash(project.id), hay: project.id })
    for (const job of sources.jobs) out.push({ kind: 'jobs', key: job.id, title: job.title, sub: [JOB_STATE(job.state), projectName(sources, job.project)].filter(Boolean).join(' · '), icon: 'job', hash: hubHash('request', job.id), hay: job.agent })
    for (const agent of sources.agents) out.push({ kind: 'team', key: agent.id, title: agent.name, sub: `Agent${agent.role ? ` · ${agent.role}` : ''}`, icon: 'team', hash: hubHash('agent', agent.id), hay: agent.role })
    for (const skill of sources.skills ?? []) out.push({ kind: 'team', key: `skill:${skill}`, title: skill, sub: 'Skill', icon: 'skill', hash: skillHash(skill), hay: '' })
  }
  return out
}

function projectName(sources: Sources, id: string): string {
  return sources.projects.find(project => project.id === id)?.name || id
}

/** The text a row shows under its title, cut around the first word that matches. About 80 characters. */
export function snippet(text: string, q: string, side = 36): string {
  return snippetOf(text, q, side) ?? text.slice(0, 80)
}

const rankOf = (title: string, ws: string[]): number => {
  const low = title.toLowerCase()
  return low.startsWith(ws[0]) ? 0 : low.includes(ws[0]) ? 1 : 2
}

/** The rows for what is typed: every word must be in the title, the line under it or the hidden words. Prefix matches rank first, the open section's cards before the rest. Nothing typed gives every row, unranked. */
export function searchRows(sources: Sources, q: string): Hit[] {
  const ws = queryWords(q)
  const rows = indexRows(sources, ws.length > 0)
  if (!ws.length) return rows
  const found: Hit[] = []
  for (const row of rows) {
    const hay = `${row.title} ${row.sub} ${row.hay ?? ''}`.toLowerCase()
    if (ws.every(word => hay.includes(word))) found.push({ ...row, rank: rankOf(row.title, ws) })
  }
  // A bead is found by its id, title or text. Its row names the id and the project; a hit in the text shows where.
  for (const bead of sources.caps.hub ? sources.beads : []) {
    if (!rowMatches(bead, q)) continue
    const inTitle = `${bead.id} ${bead.title}`.toLowerCase()
    const shown = ws.every(word => inTitle.includes(word)) ? `${bead.id} · ${projectName(sources, bead.project)}` : `${bead.id} · ${snippet(bead.text, q)}`
    found.push({ kind: 'tasks', key: `${bead.project}/${bead.id}`, title: bead.title, sub: shown, icon: 'task', hash: projectNodeHash(bead.project, bead.id), rank: rankOf(bead.title, ws) })
  }
  // A message is found by its words after the chats whose titles matched.
  for (const hit of sources.caps.hub ? sources.hits : []) {
    found.push({ kind: 'chats', key: `${hit.chat}#${hit.line}`, title: hit.title, sub: `${hit.archived ? 'Archived · ' : ''}${hit.snippet}`, icon: 'chat', hash: chatLineHash(hit.chat, hit.line), rank: 3 })
  }
  return found
    .map((row, index) => ({ row, index }))
    .sort((a, b) => Number(!a.row.first) - Number(!b.row.first) || a.row.rank! - b.row.rank! || a.index - b.index)
    .map(entry => entry.row)
}

/** How many rows each kind has: the live counts on the chips. */
export function countsOf(rows: Hit[]): Record<Kind, number> {
  const counts: Record<Kind, number> = { screens: 0, needs: 0, chats: 0, library: 0, projects: 0, tasks: 0, jobs: 0, team: 0 }
  for (const row of rows) counts[row.kind] += 1
  return counts
}

/** One drawn group: its title, the rows it shows, how many it has, and whether All can open it. */
export interface Group { kind: Kind; title: string; rows: Hit[]; total: number; all: boolean }

/** The groups for a chip. All with text gives the mockup's order, three each (six for Needs you and Screens). A kind's chip gives that kind alone, `limit` rows of it. */
export function groupsFor(rows: Hit[], chip: 'all' | Kind, limit = PAGE): Group[] {
  if (chip !== 'all') {
    const list = rows.filter(row => row.kind === chip)
    return [{ kind: chip, title: KIND_TITLE[chip], rows: list.slice(0, limit), total: list.length, all: false }]
  }
  const groups: Group[] = []
  for (const kind of GROUP_ORDER) {
    const list = rows.filter(row => row.kind === kind)
    if (!list.length) continue
    const cap = GROUP_LIMIT[kind] ?? ALL_LIMIT
    groups.push({ kind, title: KIND_TITLE[kind], rows: list.slice(0, cap), total: list.length, all: list.length > cap && kind !== 'needs' && kind !== 'screens' })
  }
  return groups
}

/** The text cut into parts, the parts that hit a word of the query marked. Never HTML: the screen draws the marks itself. */
export function segments(text: string, q: string): { text: string; mark: boolean }[] {
  const ws = queryWords(q)
  if (!ws.length || !text) return [{ text, mark: false }]
  const pattern = new RegExp(`(${ws.map(word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'ig')
  return text.split(pattern).map((part, index) => ({ text: part, mark: index % 2 === 1 })).filter(part => part.text !== '')
}

// ---- Recent: the last items picked, in this browser only. ----

export interface Recent { title: string; sub: string; icon: HitIcon; hash: string }
export const RECENT_KEY = 'buw.searchRecent'
export const RECENT_KEEP = 6
export const RECENT_ICONS: HitIcon[] = ['today', 'chat', 'work', 'project', 'library', 'team', 'sketch', 'settings', 'inbox', 'card', 'job', 'task', 'skill', 'activity', 'sparkle']

type Store = Pick<Storage, 'getItem' | 'setItem'>

/** The recent list. Anything stored that does not look like a row is left out, so a hand-edited or old value cannot break the screen. */
export function readRecent(store: Store | null): Recent[] {
  try {
    const parsed: unknown = JSON.parse(store?.getItem(RECENT_KEY) ?? '[]')
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((entry): entry is Recent => !!entry && typeof entry.title === 'string' && typeof entry.sub === 'string' && typeof entry.hash === 'string' && entry.hash.startsWith('#') && RECENT_ICONS.includes(entry.icon))
      .slice(0, RECENT_KEEP)
  } catch { return [] }
}

/** The row just picked goes first; an earlier pick of the same address leaves. A browser that blocks storage keeps nothing. */
export function pushRecent(store: Store | null, row: Pick<Hit, 'title' | 'sub' | 'icon' | 'hash'>): Recent[] {
  const next = [{ title: row.title, sub: row.sub, icon: row.icon, hash: row.hash }, ...readRecent(store).filter(entry => entry.hash !== row.hash)].slice(0, RECENT_KEEP)
  try { store?.setItem(RECENT_KEY, JSON.stringify(next)) } catch { /* storage blocked */ }
  return next
}
