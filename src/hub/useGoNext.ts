import { useEffect, useRef } from 'react'
import type { Item } from '../lib/hub'
import { hubGet } from '../lib/hub'
import type { SettledVerb } from '../lib/nextItem.mjs'
import { NOTE_VERB, itemKey, itemLink, pickNext } from '../lib/nextItem.mjs'
import { hubHash } from '../lib/route'
import { setHandoff } from './flash'
import { setFocus } from './needsFocus'
import { useHubData } from './useHub'

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
 * After an item is settled from its own page: find the next open item, leave a note for the page that shows it, and go
 * there. `assign`, not `replace`, so the browser's Back also returns to the settled item. When the queue cannot be
 * read, the action still worked: go to Needs you with a note that says only what was done.
 */
export async function goNext(settled: { kind: Item['kind']; id: string; title?: string }, verb: SettledVerb, previous: string[], backHash: string) {
  const word = NOTE_VERB[verb]
  try {
    const answer = await hubGet<{ items: Item[] }>('/inbox?filter=all')
    const next = pickNext(Array.isArray(answer.items) ? answer.items : [], itemKey(settled), previous)
    if (!next) {
      setHandoff({ verb: word, title: settled.title, nothingLeft: true, backHash })
      window.location.assign(hubHash('needs'))
      return
    }
    const link = itemLink(next)
    if (link.focus) setFocus(link.focus)
    setHandoff({ verb: word, title: settled.title, next: next.title, backHash })
    window.location.assign(link.hash)
  } catch {
    setHandoff({ verb: word, title: settled.title, backHash })
    window.location.assign(hubHash('needs'))
  }
}
