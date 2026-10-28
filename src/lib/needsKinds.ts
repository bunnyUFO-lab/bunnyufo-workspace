// The kinds of thing that wait on the owner, shared by Today and (later) the Needs you list.
// In M0 the kind comes from the item's own kind; M1 adds design and playtest.
import type { Item } from './hub'

export type NeedsKind = 'question' | 'design' | 'steps' | 'playtest' | 'unstick' | 'pr' | 'approval'

export function needsKind(item: Item): NeedsKind {
  switch (item.kind) {
    case 'checklist': return 'steps'
    case 'review': return 'pr'
    case 'blocked': return 'unstick'
    case 'request': return 'approval'
    default: return 'question' // ask, and a session (which never reaches Needs you)
  }
}

export const KIND_LABEL: Record<NeedsKind, string> = {
  question: 'Question', design: 'Design review', steps: 'Steps', playtest: 'Playtest', unstick: 'Unstick', pr: 'PR review', approval: 'Approval',
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
