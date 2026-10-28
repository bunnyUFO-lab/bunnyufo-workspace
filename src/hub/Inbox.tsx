import type { Item } from '../lib/hub'
import { hubHash } from '../lib/route'
import { useState } from 'react'
import { takeFlash } from './flash'
import ItemRow from './ItemRow'
import { useHubData } from './useHub'

const FILTERS: [string, string, string][] = [
  ['needs-you', 'Needs you', 'Nothing needs you right now.'],
  ['todo', 'To do', 'No checklists. When an agent needs you to do a set of steps, it posts one here.'],
  ['asks', 'Asks', 'No Asks yet. An agent that needs a decision posts one here.'],
  ['reviews', 'Reviews', 'No pull request is waiting for review.'],
  ['requests', 'Requests', 'No requests. Ask an agent to do something from the Board.'],
  ['blocked', 'Blocked', 'No session is blocked on you.'],
  ['answered', 'Answered', 'No Ask has been answered yet.'],
]

export default function Inbox({ filter }: { filter?: string }) {
  const [flash] = useState(takeFlash)
  const active = FILTERS.find(([key]) => key === filter) ?? FILTERS[0]
  const { data, error, loading } = useHubData<{ items: Item[] }>(`/inbox?filter=${active[0]}`)
  return (
    <>
      <div className="hub-top"><h2>Inbox</h2><span className="hub-muted">The one place to act.</span></div>
      <div className="hub-chips" role="tablist" aria-label="Inbox filter">
        {FILTERS.map(([key, label]) => (
          <a key={key} role="tab" aria-selected={key === active[0]} className={`hub-chip${key === active[0] ? ' on' : ''}`} href={hubHash('inbox', key)}>{label}</a>
        ))}
      </div>
      <section className="hub-panel">
        {flash && <p className="hub-muted" role="status" data-marked-done>{flash}</p>}
        {error && <p className="hub-error" role="alert">{error}</p>}
        {data ? (data.items.length ? data.items.map(item => <ItemRow key={`${item.kind}-${item.id}`} item={item} />) : <p className="hub-empty">{active[2]}</p>) : !error && loading && <p className="hub-empty">Loading…</p>}
      </section>
    </>
  )
}
