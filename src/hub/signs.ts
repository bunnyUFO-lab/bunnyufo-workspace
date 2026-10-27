import type { Sign } from '../lib/hub'
import type { Marks } from './mapLayout'

/** The glyphs for the signs on a task, in the order the map draws them. */
export const SIGN_GLYPH: Record<Sign, string> = {
  working: '⟳', idle: '⏸', new: '✦', pr: '⇄', 'ci-failed': '✕', review: '👁', deployed: '▲',
}

export const SIGN_LABEL: Record<Sign, string> = {
  working: 'An agent is working on it', idle: 'The last session ended', new: 'Not started', pr: 'A pull request is open',
  'ci-failed': 'CI is failing', review: 'Waiting for review', deployed: 'Deployed',
}

/** The signs a group of tasks shows: any task working, idle, with a PR open and so on. A group does not show ✦. */
export function groupSigns(marks: Marks): Sign[] {
  const signs: Sign[] = []
  if (marks.working) signs.push('working')
  if (marks.idle) signs.push('idle')
  if (marks.prs) signs.push('pr')
  if (marks.failing) signs.push('ci-failed')
  if (marks.review) signs.push('review')
  if (marks.deployed) signs.push('deployed')
  return signs
}
