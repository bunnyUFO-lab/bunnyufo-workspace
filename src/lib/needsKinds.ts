// The kinds of thing that wait on the owner, shared by Today and the Needs you list.
// site/api/hub-model.mjs (`needsKindOf`, `NEEDS_KINDS`, `INBOX_FILTER_ALIASES`) holds the server's copy of
// these rules: change both together.
import type { Item } from './hub'
import { sessionLabel } from './needsView.mjs'

export type NeedsKind = 'question' | 'design' | 'steps' | 'playtest' | 'unstick' | 'pr' | 'approval'

export function needsKind(item: Item): NeedsKind {
  switch (item.kind) {
    case 'checklist': return item.playtest === true ? 'playtest' : 'steps'
    case 'review': return 'pr'
    case 'blocked': return 'unstick'
    case 'request': return 'approval'
    case 'approval': return 'approval'
    case 'hermes-approval': return 'approval'
    case 'run-question': return 'question'
    case 'ask': return item.design === true ? 'design' : 'question'
    default: return 'question' // a session never reaches Needs you
  }
}

export const KIND_LABEL: Record<NeedsKind, string> = {
  question: 'Question', design: 'Design review', steps: 'Steps', playtest: 'Playtest', unstick: 'Sessions', pr: 'Review', approval: 'Approval',
}

/** The kind in the plural, lower case, for a sentence: "No more design reviews." */
export const KIND_PLURAL: Record<NeedsKind, string> = {
  question: 'questions', design: 'design reviews', steps: 'steps', playtest: 'playtests', unstick: 'sessions', pr: 'reviews', approval: 'approvals',
}

/** Inner markup of a 24 px stroke icon, one per kind. */
export const KIND_ICON: Record<NeedsKind, string> = {
  question: '<circle cx="12" cy="12" r="8.5"/><path d="M9.6 9.6a2.5 2.5 0 1 1 3.3 2.4c-.6.2-.9.8-.9 1.4v.6"/><path d="M12 16.8h.01"/>',
  design: '<rect x="3.5" y="5" width="17" height="14" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="m4 17 5-4.5 3.5 3 3-2.5L20 17"/>',
  steps: '<path d="M10 6.5h10M10 12h10M10 17.5h10"/><path d="m3.8 6.4 1.2 1.2 2-2.2M3.8 11.9l1.2 1.2 2-2.2M3.8 17.4l1.2 1.2 2-2.2"/>',
  playtest: '<path d="M7 8.5h10a4 4 0 0 1 4 4.4l-.5 3.1a2.3 2.3 0 0 1-4 1.1L15 15.5H9l-1.5 1.6a2.3 2.3 0 0 1-4-1.1L3 12.9a4 4 0 0 1 4-4.4z"/><path d="M8 11v3M6.5 12.5h3M15.5 12h.01M17.5 13.5h.01"/>',
  unstick: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="m7.5 9.5 3 2.5-3 2.5M12.5 15h4"/>',
  pr: '<circle cx="6.5" cy="6" r="2"/><circle cx="6.5" cy="18" r="2"/><circle cx="17.5" cy="18" r="2"/><path d="M6.5 8v8M17.5 16V9.5A2.5 2.5 0 0 0 15 7h-4M13 4.8 10.8 7 13 9.2"/>',
  approval: '<path d="M12 3.5 5 6.2v5.4c0 4.3 3 7.6 7 8.9 4-1.3 7-4.6 7-8.9V6.2z"/><path d="m9 12 2.2 2.2L15.5 10"/>',
}

/** The chips of the Needs you list, in order. `answered` is history; `requests` shows only when it is the open filter. */
export const NEEDS_FILTERS = ['all', 'approvals', 'question', 'design', 'steps', 'playtest', 'unstick', 'pr', 'answered', 'requests'] as const

/** Old filter names, kept so links in Discord history and bookmarks land on the right chip. */
const FILTER_ALIAS: Record<string, string> = { 'needs-you': 'all', asks: 'question', todo: 'steps', reviews: 'pr', blocked: 'unstick', sessions: 'unstick' }

/** The sub-types a chip can narrow to, in order: a Question by its Ask's kind, Steps by the list's. Keep equal to FILTER_SUBTYPES in site/api/hub-model.mjs. */
export const ASK_SUBTYPES = ['approval', 'verify', 'design', 'decision'] as const
export const STEPS_SUBTYPES = ['verify', 'setup', 'investigate', 'develop'] as const
export const FILTER_SUBTYPES: Record<string, readonly string[]> = { question: ASK_SUBTYPES, steps: STEPS_SUBTYPES }

/** The words on a sub-type badge and chip. */
export const SUBTYPE_LABEL: Record<string, Record<string, string>> = {
  question: { approval: 'Approval', verify: 'Verify', design: 'Design choice', decision: 'Decision' },
  steps: { verify: 'Verify', setup: 'Set up', investigate: 'Investigate', develop: 'Develop' },
}

/** `question:verify` as `['question', 'verify']`; a filter without a sub-type has an empty second part. */
export const splitFilter = (filter: string): [string, string] => { const at = filter.indexOf(':'); return at < 0 ? [filter, ''] : [filter.slice(0, at), filter.slice(at + 1)] }

const isSubFilter = (raw: string): boolean => { const [base, sub] = splitFilter(raw); return !!sub && !!FILTER_SUBTYPES[base]?.includes(sub) }

/** Whether `raw` is a filter key or an old alias of one (anything else in the address is an item id). */
export const isKnownFilter = (raw: string): boolean => Object.prototype.hasOwnProperty.call(FILTER_ALIAS, raw) || (NEEDS_FILTERS as readonly string[]).includes(raw) || isSubFilter(raw)

/** The filter a URL names, old names mapped to the new ones; an unknown or missing name is `all`. `question:verify` keeps its sub-type. */
export function canonicalFilter(raw: string | undefined): string {
  if (raw && isSubFilter(raw)) return raw
  const mapped = raw && Object.prototype.hasOwnProperty.call(FILTER_ALIAS, raw) ? FILTER_ALIAS[raw] : raw
  return mapped && (NEEDS_FILTERS as readonly string[]).includes(mapped) ? mapped : 'all'
}

// --- Badges: the type of an item, and its sub-type, each with a word, an icon and a colour ---

/** One colour per type. Request approvals, Hermes approvals and Hermes questions are their own types, apart from a Question (an Ask). */
export type BadgeType = 'approval-request' | 'hermes-approval' | 'hermes-asks' | 'question' | 'design' | 'steps' | 'playtest' | 'pr' | 'unstick'

export interface Badge { type: BadgeType; label: string; icon: string }

/** The type badge of an item. A session keeps its tool label ("Claude permission"). */
export function typeBadge(item: Item): Badge {
  const kind = needsKind(item)
  let type: BadgeType
  let label: string
  switch (item.kind) {
    case 'hermes-approval': type = 'hermes-approval'; label = 'Hermes approval'; break
    case 'run-question': type = 'hermes-asks'; label = 'Hermes asks'; break
    case 'approval': case 'request': type = 'approval-request'; label = 'Approval request'; break
    default: type = kind as BadgeType; label = itemLabel(item)
  }
  const icon = item.kind === 'hermes-approval' || item.kind === 'approval' || item.kind === 'request' ? KIND_ICON.approval : KIND_ICON[kind]
  return { type, label, icon }
}

/** The sub-type badge of a Question or a list of Steps, from the `subtype` the Hub sends; none for anything else. A design review says "Design review" already. */
export function subBadge(item: Item): { group: 'question' | 'steps'; sub: string; label: string; inferred: boolean } | null {
  const sub = item.subtype
  if (!sub) return null
  const kind = needsKind(item)
  const group = kind === 'question' && item.kind === 'ask' ? 'question' : kind === 'steps' ? 'steps' : kind === 'design' && sub !== 'design' ? 'question' : null
  const label = group ? SUBTYPE_LABEL[group][sub] : undefined
  return group && label ? { group, sub, label, inferred: item.kindInferred === true } : null
}

/** The label on an item's type chip: a blocked session names its tool and what it waits on ("Claude permission"). */
export const itemLabel = (item: Item): string => (item.kind === 'blocked' ? sessionLabel(item) : KIND_LABEL[needsKind(item)])
