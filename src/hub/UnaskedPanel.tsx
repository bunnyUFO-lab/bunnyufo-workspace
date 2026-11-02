import { useState } from 'react'
import type { UnaskedItem } from '../lib/hub'
import { workHash } from '../lib/route'
import MarkActions from './MarkActions'
import { useHubData } from './useHub'

const SHOWN = 5

function Row({ item }: { item: UnaskedItem }) {
  const [error, setError] = useState('')
  return (
    <div className="unasked-row" data-unasked-row={item.id}>
      <div className="unasked-text">
        <a href={workHash(item.project, item.id)}>{item.title}</a>
        <small className="hub-muted">{item.project} · {item.id}</small>
      </div>
      <MarkActions compact task={{ id: item.id }} project={item.project} projectName={item.project} eligible error={error} onError={setError} />
    </div>
  )
}

/**
 * Today's list of beads that say they need the owner (the needs-owner label) while nothing asks anything:
 * no Ask, no checklist, no other Needs you item. Each row has the three marks. Renders nothing when there are none.
 */
export default function UnaskedPanel() {
  const { data } = useHubData<{ items: UnaskedItem[] }>('/unasked')
  const items = data?.items ?? []
  if (!items.length) return null
  const n = items.length
  return (
    <section className="hub-panel rise" aria-label="Says it needs you" data-today-unasked>
      <h3>⚠ {n} {n === 1 ? 'item says it needs' : 'items say they need'} you but {n === 1 ? 'asks' : 'ask'} nothing</h3>
      {items.slice(0, SHOWN).map(item => <Row key={`${item.project}/${item.id}`} item={item} />)}
      {n > SHOWN && <p className="hub-muted"><a href="#/~hub/work/all">+{n - SHOWN} more</a></p>}
    </section>
  )
}
