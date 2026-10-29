import { useMemo, useState } from 'react'
import type { Ask, AskAnswer } from '../lib/hub'
import { HubError, fileUrl, hubPost } from '../lib/hub'
import { authHeaders } from '../local/client'
import type { DrawingIo } from '../components/DrawingEditor'
import { annotationScene, blankScene, takeHandoff } from './drawing'

export interface Attached { scene: string; png: string; optionId: string | null }
export interface Editing { optionId: string | null; image?: string; w: number; h: number; scene?: string }
/** What the owner did to take an Ask off the queue. */
export type AskVerb = 'answered' | 'snoozed' | 'cancelled'

// An Ask file is written by agents and tools, so every field here may be missing or the wrong type.
export const when = (iso: unknown) => {
  const date = typeof iso === 'string' ? new Date(iso) : null
  return date && !Number.isNaN(date.getTime()) ? date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'an unknown time'
}
export const text = (value: unknown) => (typeof value === 'string' || typeof value === 'number' ? String(value) : '')
export const optionList = (ask: Ask): NonNullable<Ask['options']> => (Array.isArray(ask.options) ? ask.options.filter(item => item && typeof item === 'object' && typeof item.id === 'string') : [])

/**
 * Everything the owner does to one Ask: pick an option, write a note, draw, and then send, snooze or cancel.
 * The list card and the Ask's own view share it; only the own view (`handoff`) takes a drawing handed over from Sketch. `onSettled` runs after a write that took the Ask off the queue.
 */
export function useAskAnswer(ask: Ask, { reload, onSettled, onTaken, handoff = false }: { reload: () => void; onSettled?: (verb: AskVerb) => void; onTaken?: (answer: AskAnswer | null) => void; handoff?: boolean }) {
  const [choice, setChoice] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [drawing, setDrawing] = useState<Attached | null>(() => { const handed = handoff ? takeHandoff() : null; return handed ? { ...handed, optionId: null } : null })
  const [editing, setEditing] = useState<Editing | null>(null)
  const [sizes, setSizes] = useState<Record<string, { w: number; h: number }>>({})

  const askId = ask.id
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
    try {
      await run()
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
  return {
    choice, setChoice, note, setNote, busy, problem, confirming, setConfirming, drawing, setDrawing, editing, setEditing, sizes, setSizes, io,
    ready: !!choice || note.trim().length > 0 || !!drawing,
    send: () => act(() => hubPost(`${base}/answer`, { ...(choice ? { choice } : {}), ...(note.trim() ? { note: note.trim() } : {}), ...(drawing ? { drawing: { scene: drawing.scene, png: drawing.png } } : {}) }), 'answered'),
    snooze: () => act(() => hubPost(`${base}/snooze`, { hours: 24 }), 'snoozed'),
    cancel: () => act(() => hubPost(`${base}/cancel`), 'cancelled'),
  }
}
