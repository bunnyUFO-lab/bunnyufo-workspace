import { useState } from 'react'
import type { SettledVerb } from '../lib/nextItem.mjs'
import { NOTE_VERB } from '../lib/nextItem.mjs'
import { hubHash } from '../lib/route'
import { undoHeld, useHeld } from './heldSend'
import { goNext, useHasNext } from './useGoNext'

/**
 * What an item's own page knows about the answer it just gave: stay on the page, say what was done, offer Next item. Nothing
 * moves by itself unless the owner turned that on in Settings. `settle` is what the body's `onSettled` calls; Undo, or a send
 * that failed, takes the page back to the open item.
 */
export function useSettledHere(key: string) {
  const held = useHeld()
  // The verb counts only while the item has not been brought back since: Undo and a failed send both bump the count.
  const [settled, setSettled] = useState<{ verb: SettledVerb; restores: number; order: string[] } | null>(null)
  const restores = held.restoreCount(key)
  const verb = settled && settled.restores === restores ? settled.verb : null
  const phase = held.phase(key)
  // `order` is the queue as the page saw it when the answer was given: the refetch after the write drops the item, and Next item follows what was seen.
  return { phase, verb, order: settled?.order ?? [], settle: (value: SettledVerb, order: string[] = []) => setSettled({ verb: value, restores, order }), covered: !!phase }
}

/** The bar under (or in place of) a settled item's form: "Sending in a few seconds" with Undo, then "Answered", and always Next item. */
export default function SettledBar({ itemKey, kind, id, title, verb, phase, backHash, order }: {
  itemKey: string
  kind: 'ask' | 'checklist' | 'review' | 'approval' | 'request'
  id: string
  title: string
  verb: SettledVerb | null
  phase?: 'held' | 'sending' | 'sent'
  backHash: string
  /** The order of the queue as the page saw it when the answer was given (`useSettledHere`): Next item follows it. */
  order: string[]
}) {
  const hasNext = useHasNext(itemKey)
  const [moving, setMoving] = useState(false)
  if (!verb && !phase) return null
  const waiting = phase === 'held'
  const word = verb ? NOTE_VERB[verb] : 'Done'
  return (
    <section className="hub-panel settled-bar" role="status" aria-label="Settled" data-settled-bar data-settled-phase={phase ?? 'done'}>
      <h3 data-settled-title>{waiting ? 'Sending in a few seconds' : `${word}.`}</h3>
      {waiting && <p className="hub-muted">{word}: {title}. Nothing reaches the agent until the seconds are up.</p>}
      <div className="hub-actions start">
        {waiting && <button type="button" className="hub-btn" data-held-undo onClick={() => undoHeld(itemKey)}>Undo</button>}
        {hasNext
          ? <button type="button" className="hub-btn pri" disabled={moving} data-next-item onClick={() => { setMoving(true); void goNext({ kind, id, title }, verb ?? 'done', order, backHash) }}>Next item</button>
          : <a className="hub-btn pri" href={hubHash('today')} data-back-today>Back to Today</a>}
      </div>
    </section>
  )
}
