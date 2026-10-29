import type { HelpKind } from '../lib/route'

export interface HelpTarget { kind: HelpKind; id: string; /** What the draft calls the item: "question", "checklist"… */ label: string; title: string }

/** The draft for the composer when the owner opens help on a whole item. */
export const itemDraft = (target: HelpTarget) => `Help me with this ${target.label}: ${target.title.replace(/\s+/g, ' ').trim().slice(0, 160)}.`

/** The draft for one failed step, with the note the owner had already typed. */
export const stepDraft = (step: string, text: string, note: string) => `Step ${step} failed: ${text.replace(/\s+/g, ' ').trim().slice(0, 200)}. ${note.trim() ? `My note so far: ${note.trim().slice(0, 400)}` : ''}`

