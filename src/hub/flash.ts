// A one-line note handed to the next screen: "Marked done" after a review is cleared from its own view.
let note = ''
export const setFlash = (text: string) => { note = text }
export const takeFlash = () => { const text = note; note = ''; return text }

/**
 * What the owner just did and what is next, handed to the screen that opens after it: that screen shows it as a note at
 * its top. `next` is the next item's title; `nothingLeft` says the queue is empty. `backHash` opens the settled item.
 */
export interface Handoff { verb: string; /** Plain words after the verb, and a link to what the action made. */ detail?: string; link?: { label: string; hash: string }; title?: string; next?: string | null; nothingLeft?: boolean; elsewhere?: number; kindPlural?: string; backHash: string }
let handoff: Handoff | null = null
export const setHandoff = (value: Handoff) => { handoff = value }
export const takeHandoff = (): Handoff | null => { const value = handoff; handoff = null; return value }

/** The text Get help leaves for the composer of the help chat it opens: owner-side, editable, never sent by itself. */
let helpDraft = ''
export const setHelpDraft = (text: string) => { helpDraft = text }
export const takeHelpDraft = () => { const text = helpDraft; helpDraft = ''; return text }
