import { useEffect, useRef, useState } from 'react'
import type { Item } from '../lib/hub'
import { hubGet } from '../lib/hub'
import type { SettledVerb } from '../lib/nextItem.mjs'
import { NOTE_VERB, itemKey, itemLink, pickNext } from '../lib/nextItem.mjs'
import { hubHash } from '../lib/route'
import { setHandoff } from './flash'
import { setFocus } from './needsFocus'
import { useHubData } from './useHub'

const AUTO_KEY = 'hub.autoNext'

/** "Next item after answering": off unless the owner turned it on in Settings. Stored in this browser only. */
export const autoNext = (): boolean => { try { return localStorage.getItem(AUTO_KEY) === '1' } catch { return false } }
export const setAutoNext = (on: boolean) => { try { if (on) localStorage.setItem(AUTO_KEY, '1'); else localStorage.removeItem(AUTO_KEY) } catch { /* no storage: it stays off */ } }

/**
 * Whether another item waits after this one, from the queue the owner is already reading. The page offers "Next item"
 * when it does and "Back to Today" when it does not.
 */
export function useHasNext(settled: string): boolean {
  const { data } = useHubData<{ items: Item[] }>('/inbox?filter=all')
  return !!data && Array.isArray(data.items) && data.items.some(item => item && itemKey(item) !== settled)
}

/** The setting as state, for Settings. */
export function useAutoNext(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(autoNext)
  return [on, value => { setAutoNext(value); setOn(value) }]
}

/**
 * The order of the queue as the owner saw it, kept while a deep-link view is open. Read it when an action succeeds:
 * the refetch that follows the write has not landed yet, so the settled item is still in it.
 */
export function useQueueOrder(): () => string[] {
  const { data } = useHubData<{ items: Item[] }>('/inbox?filter=all')
  const order = useRef<string[]>([])
  useEffect(() => { if (data && Array.isArray(data.items)) order.current = data.items.filter(Boolean).map(itemKey) }, [data])
  return () => order.current
}

/**
 * The owner asked for the next item (the Next item button, or the Settings choice that does it after every answer): find the
 * next open item, leave a note for the page that shows it, and go there. `assign`, not `replace`, so the browser's Back also
 * returns to the settled item. With nothing left, Today says "All clear". When the queue cannot be read, the action still
 * worked: go to Needs you with a note that says only what was done.
 */
export async function goNext(settled: { kind: Item['kind']; id: string; title?: string }, verb: SettledVerb, previous: string[], backHash: string, detail?: string) {
  const word = NOTE_VERB[verb]
  try {
    const answer = await hubGet<{ items: Item[] }>('/inbox?filter=all')
    // An answer that is not JSON reads as null: the queue could not be read, which is not "nothing left".
    if (!answer) throw new Error('The queue could not be read.')
    const next = pickNext(Array.isArray(answer.items) ? answer.items : [], itemKey(settled), previous)
    if (!next) {
      setHandoff({ verb: word, ...(detail ? { detail } : {}), title: settled.title, nothingLeft: true, backHash })
      window.location.assign(hubHash('today'))
      return
    }
    const link = itemLink(next)
    if (link.focus) setFocus(link.focus)
    setHandoff({ verb: word, ...(detail ? { detail } : {}), title: settled.title, next: next.title, backHash })
    window.location.assign(link.hash)
  } catch {
    setHandoff({ verb: word, ...(detail ? { detail } : {}), title: settled.title, backHash })
    window.location.assign(hubHash('needs'))
  }
}
