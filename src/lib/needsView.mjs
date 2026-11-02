// The pure parts of the Needs you list's project filter: the address, the project chip on a row and the picker's options.
// Kept in a .mjs so node --test reads it without a build (server/test/needs-view.test.mjs).

/**
 * What the address after `#/~hub/needs/` names. `<filter>/<project>` is the list; `all` in the project slot means no
 * project. A first segment that is not a filter is an item to focus (`linked`), and then the rest is ignored.
 * `isFilter` says whether a word is a filter name (or an old alias of one).
 */
export function parseNeedsRoute(raw, isFilter) {
  if (!raw) return { filter: undefined, project: '', linked: '' }
  const slash = raw.indexOf('/')
  const first = (slash < 0 ? raw : raw.slice(0, slash)).replace(/%3A/gi, ':')
  if (!isFilter(first)) return { filter: undefined, project: '', linked: raw }
  const rest = slash < 0 ? '' : raw.slice(slash + 1)
  return { filter: first, project: rest === 'all' ? '' : rest, linked: '' }
}

// The words in the address that differ from a filter's key: the key `unstick` keeps its name inside, the owner sees `sessions`.
const SLUG = { unstick: 'sessions' }

/** The word a filter has in the address. */
export const filterSlug = filter => SLUG[filter] ?? (filter || 'all')

/** The address of the list: `#/~hub/needs/<filter>` with `/<project>` when one is chosen. */
export function needsHref(filter, project) {
  const word = encodeURIComponent(filterSlug(filter)).replace(/%3A/gi, ':') // `question:verify` keeps its colon
  return project ? `#/~hub/needs/${word}/${encodeURIComponent(project)}` : `#/~hub/needs/${word}`
}

/** A project's display name: the Hub's name for it, else its id. */
export const projectName = (names, id) => (id && names && names[id]) || id || ''

/**
 * The parts of a row's meta line, in order: the project (a chip, first), who asked, when, and the bead. An item without a
 * project has no project part, and one without a bead keeps nothing in its place.
 */
export function metaParts({ project, who, asked, bead, names }) {
  const parts = []
  if (project) parts.push({ kind: 'project', id: project, text: projectName(names, project) })
  for (const text of [who, asked, bead]) if (text) parts.push({ kind: 'text', text })
  return parts
}

/**
 * The picker's projects from the API's `{ project: count }`: those with items, by display name, each with its count.
 * The chosen project stays listed with 0 when nothing is left in it, so the picker still shows where the owner is.
 */
export function projectOptions(counts, names, chosen = '') {
  const ids = Object.keys(counts ?? {}).filter(id => counts[id] > 0)
  if (chosen && !ids.includes(chosen)) ids.push(chosen)
  return ids
    .map(id => ({ id, name: projectName(names, id), count: counts?.[id] ?? 0 }))
    .sort((a, b) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1))
}

const TOOL_NAME = { 'claude-code': 'Claude', claude: 'Claude', codex: 'Codex', hermes: 'Hermes' }

/** The tool a session runs: the event's own `tool` (or `from.tool`); the hub-hooks mod is the Claude Code plugin; else nothing is known. */
function sessionTool(item) {
  const tool = String(item.tool ?? '').trim().toLowerCase() || (item.source === 'hub-hooks' ? 'claude-code' : '')
  if (!tool) return 'Session'
  return TOOL_NAME[tool] ?? tool.charAt(0).toUpperCase() + tool.slice(1)
}

/** What a session waits on: `permission`, `question` or `waiting`. The hub-hooks mod posts `blocked` for permission prompts and for questions without saying which, so with no reason it is `waiting`. */
export function sessionWait(item) {
  const reason = String(item.reason ?? '').toLowerCase()
  if (/permission/.test(reason)) return 'permission'
  if (/question|elicitation|\bask/.test(reason)) return 'question'
  if (reason) return 'waiting'
  return 'waiting'
}

/** The label of a blocked session: "Claude permission", "Codex question", "Session waiting". */
export const sessionLabel = item => `${sessionTool(item)} ${sessionWait(item)}`
