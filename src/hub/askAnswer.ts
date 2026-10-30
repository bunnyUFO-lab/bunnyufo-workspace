import { useMemo, useState } from 'react'
import type { Ask, AskAnswer, AskDecision, DecisionVerdict } from '../lib/hub'
import { HubError, fileUrl, hubPost } from '../lib/hub'
import { authHeaders } from '../local/client'
import type { DrawingIo } from '../components/DrawingEditor'
import { annotationScene, blankScene, takeHandoff } from './drawing'

export interface Attached { scene: string; png: string; optionId: string | null }
export interface Editing { optionId: string | null; image?: string; w: number; h: number; scene?: string }
/** What the owner did to take an Ask off the queue. */
export type AskVerb = 'answered' | 'snoozed' | 'cancelled' | 'reviewed'

/** What the server says an answer set going: the avatar flow's line, or null for any other answer. */
export function avatarNotice(result: unknown): string | null {
  const avatar = (result as { avatar?: { started?: boolean; message?: string; chosen?: boolean; why?: string } } | null)?.avatar
  if (!avatar || typeof avatar !== 'object') return null
  if (avatar.started === true) return text(avatar.message)
  if (avatar.chosen === true) return 'This sheet is now the sprite.'
  return avatar.started === false ? `The sprite sheet did not start: ${text(avatar.why)}` : `The sheet was not chosen: ${text(avatar.why)}`
}

export const VERDICTS: [DecisionVerdict, string][] = [['approve', 'Approve'], ['change', 'Change'], ['skip', 'Skip']]
export interface Verdicts { [decision: string]: { verdict: DecisionVerdict; note: string } }

// An Ask file is written by agents and tools, so every field here may be missing or the wrong type.
export const when = (iso: unknown) => {
  const date = typeof iso === 'string' ? new Date(iso) : null
  return date && !Number.isNaN(date.getTime()) ? date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'an unknown time'
}
export const text = (value: unknown) => (typeof value === 'string' || typeof value === 'number' ? String(value) : '')
export const optionList = (ask: Ask): NonNullable<Ask['options']> => (Array.isArray(ask.options) ? ask.options.filter(item => item && typeof item === 'object' && typeof item.id === 'string') : [])

/** The decisions of a Design review, as the server cleaned them; an Ask read by an older server may carry none. */
export const decisionList = (ask: Ask): AskDecision[] => (Array.isArray(ask.decisions) ? ask.decisions.filter(item => item && typeof item.id === 'string' && typeof item.text === 'string') : [])
export const imageName = (ask: Ask): string => (typeof ask.image === 'string' ? ask.image : '')
/** `review`: a picture or decisions to go through; `pick`: options with pictures and nothing to decide; null: a plain Question. */
export function designKind(ask: Ask): 'review' | 'pick' | null {
  if (decisionList(ask).length || imageName(ask)) return 'review'
  return optionList(ask).some(option => typeof option.image === 'string' && option.image) ? 'pick' : null
}

/**
 * Everything the owner does to one Ask: pick an option, write a note, draw, and then send, snooze or cancel.
 * The list card and the Ask's own view share it; only the own view (`handoff`) takes a drawing handed over from Sketch. `onSettled` runs after a write that took the Ask off the queue.
 */
export function useAskAnswer(ask: Ask, { reload, onSettled, onTaken, handoff = false, help }: { reload: () => void; onSettled?: (verb: AskVerb) => void; onTaken?: (answer: AskAnswer | null) => void; handoff?: boolean; help?: { chat: string } }) {
  const [choice, setChoice] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const [verdicts, setVerdicts] = useState<Verdicts>({})
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [drawing, setDrawing] = useState<Attached | null>(() => { const handed = handoff ? takeHandoff() : null; return handed ? { ...handed, optionId: null } : null })
  const [editing, setEditing] = useState<Editing | null>(null)
  const [sizes, setSizes] = useState<Record<string, { w: number; h: number }>>({})

  const askId = ask.id
  const decisions = decisionList(ask)
  const kind = designKind(ask)
  const io = useMemo<DrawingIo | null>(() => (editing ? {
    load: async () => ({ text: editing.scene ?? (editing.image ? annotationScene(editing.image, editing.w, editing.h) : blankScene()), etag: null }),
    save: async (scene, png) => {
      setDrawing({ scene, png, optionId: editing.optionId })
      if (editing.optionId) setChoice(editing.optionId)
      return { etag: null }
    },
    background: async name => {
      const response = await fetch(fileUrl(`asks/${askId}/${name}`), { headers: authHeaders() })
      if (!response.ok) throw new Error(`${response.status}`)
      return response.blob()
    },
  } : null), [editing, askId])

  const act = async (run: () => Promise<unknown>, verb: AskVerb) => {
    setBusy(true)
    setProblem(null)
    setNotice(null)
    try {
      setNotice(avatarNotice(await run()))
      onSettled?.(verb)
      reload()
    } catch (failure) {
      if (failure instanceof HubError && failure.status === 409) {
        const existing = (failure.body?.answer ?? null) as AskAnswer | null
        onTaken?.(existing)
        setProblem(existing ? `Already answered by ${existing.by} at ${when(existing.at)}.` : failure.message)
        reload()
      } else {
        setProblem(failure instanceof Error ? failure.message : 'That did not work.')
      }
    } finally {
      setBusy(false)
    }
  }

  const base = `/asks/${encodeURIComponent(askId)}`
  const sentDecisions = () => Object.fromEntries(decisions.map(item => {
    const given = verdicts[item.id]
    return [item.id, { verdict: given.verdict, ...(given.verdict === 'change' && given.note.trim() ? { note: given.note.trim() } : {}) }]
  }))
  return {
    verdicts, kind, decisions,
    setVerdict: (decision: string, verdict: DecisionVerdict) => setVerdicts(previous => ({ ...previous, [decision]: { verdict, note: previous[decision]?.note ?? '' } })),
    setVerdictNote: (decision: string, text: string) => setVerdicts(previous => (previous[decision] ? { ...previous, [decision]: { ...previous[decision], note: text } } : previous)),
    choice, setChoice, note, setNote, busy, problem, notice, confirming, setConfirming, drawing, setDrawing, editing, setEditing, sizes, setSizes, io,
    // A review is ready when every decision has a verdict, a pick when one option is chosen, anything else when it says something.
    ready: decisions.length ? decisions.every(item => !!verdicts[item.id]) : kind === 'pick' ? !!choice : !!choice || note.trim().length > 0 || !!drawing,
    send: () => act(() => hubPost(`${base}/answer`, { ...(decisions.length ? { decisions: sentDecisions() } : {}), ...(choice ? { choice } : {}), ...(note.trim() ? { note: note.trim() } : {}), ...(drawing ? { drawing: { scene: drawing.scene, png: drawing.png } } : {}), ...(help ? { help } : {}) }), kind ? 'reviewed' : 'answered'),
    snooze: () => act(() => hubPost(`${base}/snooze`, { hours: 24 }), 'snoozed'),
    cancel: () => act(() => hubPost(`${base}/cancel`), 'cancelled'),
  }
}
