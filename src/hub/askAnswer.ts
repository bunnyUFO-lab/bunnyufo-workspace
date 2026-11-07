import { useMemo, useState } from 'react'
import type { Ask, AskAnswer, AskDecision, DecisionVerdict } from '../lib/hub'
import { HubError, fileUrl, hubPost } from '../lib/hub'
import { authHeaders } from '../local/client'
import type { DrawingIo } from '../components/DrawingEditor'
import { annotationScene, blankScene, takeHandoff } from './drawing'
import { KEEPALIVE_LIMIT, bodyBytes, heldDraft, hold } from './heldSend'
import { toBase64 } from './chatImages'
import { usePictures } from './pictures'

/** Pictures with an answer: at most this many. */
export const ANSWER_PICTURES = 4
/** Whether an Ask takes pictures with its answer: a note or a drawing to put them beside, and nothing the Hub acts on by itself (rerun, edit of an agent, avatar, change list). */
export const takesPictures = (ask: Ask) => (ask.allowNote || ask.allowDrawing === true) && !ask.rerun && !ask.agentEdit && !ask.avatar && !(Array.isArray(ask.changes) && ask.changes.length > 0)

export interface Attached { scene: string; png: string; optionId: string | null }
export interface Editing { optionId: string | null; image?: string; w: number; h: number; scene?: string }
/** What the owner did to take an Ask off the queue. */
export type AskVerb = 'answered' | 'snoozed' | 'cancelled' | 'reviewed'

/** What the server says an answer set going: the avatar flow's line, the rerun's or an applied edit's, or null for any other answer. */
export function avatarNotice(result: unknown): string | null {
  const rerun = (result as { rerun?: { started?: boolean; request?: string; kind?: string; project?: string; allowed?: string[]; already?: boolean; message?: string; why?: string } } | null)?.rerun
  if (rerun && typeof rerun === 'object') {
    if (rerun.started !== true) return `Not run again: ${text(rerun.why)}`
    if (Array.isArray(rerun.allowed) && rerun.allowed.length > 0) {
      const count = rerun.allowed.length
      return `Allowed ${count} rule${count === 1 ? '' : 's'} for ${text(rerun.project)} and approved again as ${text(rerun.request)}. The Gaming PC adds the rule${count === 1 ? '' : 's'} and starts it within a few minutes; it sends an alert when it does.`
    }
    if (rerun.already === true) return text(rerun.message)
    return rerun.kind === 'continue'
      ? 'A new run starts on the Gaming PC within a few minutes, with your answer.'
      : `Approved again as ${text(rerun.request)}. It starts on the Gaming PC within a few minutes of the allow lines being in.`
  }
  const edit = (result as { agentEdit?: { applied?: boolean; why?: string; profile?: string } } | null)?.agentEdit
  if (edit && typeof edit === 'object' && edit.applied === true && typeof edit.profile === 'string') return 'Sent to the Hermes host. Not running yet. Usually about a minute, at most 5. Details of the agent says when it is running.'
  if (edit && typeof edit === 'object') return edit.applied === true ? 'Applied. The persona has a new version; chats use it from their next message. You can revert it on the Edit page.' : `Not applied: ${text(edit.why)}`
  const avatar = (result as { avatar?: { started?: boolean; message?: string; chosen?: boolean; why?: string } } | null)?.avatar
  if (!avatar || typeof avatar !== 'object') return null
  if (avatar.started === true) return text(avatar.message)
  if (avatar.chosen === true) return 'This sheet is now the sprite.'
  return avatar.started === false ? `The sprite sheet did not start: ${text(avatar.why)}` : `The sheet was not chosen: ${text(avatar.why)}`
}

/** What the owner had filled in when an answer was held. */
interface AskDraft { choice: string | null; note: string; verdicts: Verdicts; drawing: Attached | null }

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
export function useAskAnswer(ask: Ask, { reload, onSettled, onTaken, handoff = false, help }: { reload: () => void; onSettled?: (verb: AskVerb, detail?: string) => void; onTaken?: (answer: AskAnswer | null) => void; handoff?: boolean; help?: { chat: string } }) {
  // What a held answer left behind (Undo, or a send that failed) comes back with the item, even to a form that mounted after it was answered elsewhere.
  const [saved] = useState(() => heldDraft<AskDraft>(`ask-${ask.id}`))
  const [choice, setChoice] = useState<string | null>(saved?.choice ?? null)
  const [note, setNote] = useState(saved?.note ?? '')
  const [verdicts, setVerdicts] = useState<Verdicts>(saved?.verdicts ?? {})
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  // A big picture cannot be held for Undo (a request that outlives the page carries 64 KB at most): the owner is asked first.
  const [bigConfirm, setBigConfirm] = useState(false)
  const [drawing, setDrawing] = useState<Attached | null>(() => { const handed = handoff ? takeHandoff() : null; return handed ? { ...handed, optionId: null } : saved?.drawing ?? null })
  const [editing, setEditing] = useState<Editing | null>(null)
  const [sizes, setSizes] = useState<Record<string, { w: number; h: number }>>({})

  const askId = ask.id
  const base = `/asks/${encodeURIComponent(askId)}`
  const pictureable = takesPictures(ask)
  // Saved when picked, so the answer names a few files, Undo keeps working and a reload keeps the tray.
  const pictures = usePictures({
    max: ANSWER_PICTURES, noun: 'An answer', stored: pictureable ? ask.pendingPictures : undefined, pathOf: name => `asks/${askId}/${name}`,
    store: async picture => {
      try {
        return (await hubPost<{ file: string }>(`${base}/files`, { image: { type: picture.type, data: await toBase64(picture.blob) } }, undefined, true)).file
      } catch (failure) {
        if (failure instanceof HubError && failure.status === 409) reload()
        throw failure
      }
    },
    discard: async name => { await hubPost(`${base}/files/${encodeURIComponent(name)}/delete`, {}, undefined, true) },
  })
  const decisions = decisionList(ask)
  const kind = designKind(ask)
  const needsOption = optionList(ask).length > 0
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
      const said = avatarNotice(await run())
      setNotice(said)
      onSettled?.(verb, said ?? undefined)
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

  const sentDecisions = () => Object.fromEntries(decisions.map(item => {
    const given = verdicts[item.id]
    return [item.id, { verdict: given.verdict, ...(given.verdict === 'change' && given.note.trim() ? { note: given.note.trim() } : {}) }]
  }))
  const answerBody = () => ({ ...(decisions.length ? { decisions: sentDecisions() } : {}), ...(choice ? { choice } : {}), ...(note.trim() ? { note: note.trim() } : {}), ...(drawing ? { drawing: { scene: drawing.scene, png: drawing.png } } : {}), ...(pictureable && pictures.files().length ? { pictures: pictures.files() } : {}), ...(help ? { help } : {}), ...(ask.rev ? { rev: ask.rev } : {}) })
  // An answer that starts work or changes something says so when it lands (the notice), and a passkey-only Ask is the owner's check in the moment:
  // those go at once. Everything else waits seven seconds with Undo.
  const holdable = ask.requirePasskey !== true && !ask.rerun && !ask.agentEdit && !ask.avatar
  const answerVerb: AskVerb = kind ? 'reviewed' : 'answered'
  const sendNow = () => { setBigConfirm(false); return act(() => hubPost(`${base}/answer`, answerBody()), answerVerb) }
  // A held answer that loses the race says who answered first, in the words the open form used to show.
  const sendHeld = async (keepalive: boolean, body: unknown) => {
    try { return await hubPost(`${base}/answer`, body, undefined, false, keepalive) } catch (failure) {
      const existing = failure instanceof HubError && failure.status === 409 ? (failure.body?.answer ?? null) as AskAnswer | null : null
      if (existing) { const taken = new Error(`Already answered by ${existing.by} at ${when(existing.at)}.`); (taken as Error & { cause?: unknown }).cause = failure; throw taken }
      throw failure
    }
  }
  const send = () => {
    const body = answerBody()
    if (!holdable) return sendNow()
    if (bodyBytes(body) > KEEPALIVE_LIMIT) { setBigConfirm(true); return Promise.resolve() }
    setProblem(null)
    setNotice(null)
    if (hold({ key: `ask-${askId}`, title: text(ask.question).slice(0, 90), verb: kind ? 'Review sent' : 'Answered', draft: { choice, note, verdicts, drawing } satisfies AskDraft, send: keepalive => sendHeld(keepalive, body) })) onSettled?.(answerVerb)
    return Promise.resolve()
  }
  return {
    verdicts, kind, decisions,
    setVerdict: (decision: string, verdict: DecisionVerdict) => setVerdicts(previous => ({ ...previous, [decision]: { verdict, note: previous[decision]?.note ?? '' } })),
    setVerdictNote: (decision: string, text: string) => setVerdicts(previous => (previous[decision] ? { ...previous, [decision]: { ...previous[decision], note: text } } : previous)),
    pictures, pictureable, choice, setChoice, note, setNote, busy, problem, notice, confirming, setConfirming, bigConfirm, setBigConfirm, drawing, setDrawing, editing, setEditing, sizes, setSizes, io,
    // A review is ready when every decision has a verdict, a pick when one option is chosen, anything else when it says something.
    // An Ask with options needs one of them picked, whatever else it asks for.
    needsOption,
    ready: pictures.ready && (!needsOption || !!choice) && (decisions.length ? decisions.every(item => !!verdicts[item.id]) : kind === 'pick' ? !!choice : !!choice || note.trim().length > 0 || !!drawing || (pictureable && pictures.files().length > 0)),
    send, sendNow,
    snooze: () => act(() => hubPost(`${base}/snooze`, { hours: 24 }), 'snoozed'),
    cancel: () => act(() => hubPost(`${base}/cancel`), 'cancelled'),
  }
}
