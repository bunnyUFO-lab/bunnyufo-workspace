import { useState } from 'react'
import type { HubProject, UnaskedItem } from '../lib/hub'
import MarkActions from './MarkActions'
import { useHubData } from './useHub'

const SHOWN = 5

function Row({ item, projectName }: { item: UnaskedItem; projectName: string }) {
  const [error, setError] = useState('')
  return (
    <div className={`unasked-row${item.mark ? ' marked' : ''}`} data-unasked-row={item.id}>
      <div className="unasked-text">
        <a href={item.href}>{item.title}</a>
        {item.reason && <span className="unasked-why" data-unasked-why>{item.reason}</span>}
        <small className="hub-muted">{projectName ? `${projectName} · ` : ''}{item.id}</small>
      </div>
      <MarkActions compact task={{ id: item.id, mark: item.mark ? { verdict: item.mark.verdict, at: item.mark.at, pending: true } : undefined }} title={item.title} project={item.project} projectName={projectName} eligible error={error} onError={setError} />
    </div>
  )
}

/**
 * Today's list of beads that say they need the owner (the needs-owner label) while nothing asks anything:
 * no Ask, no checklist, no other Needs you item. Each row has the three marks. Renders nothing when there are none.
 */
export default function UnaskedPanel() {
  const { data } = useHubData<{ items: UnaskedItem[] }>('/unasked')
  const projects = useHubData<{ projects: HubProject[] }>('/projects')
  // The display name once the projects are read; the id alone says nothing wrong in the meantime, a raw project id would.
  const nameOf = (id: string) => projects.data?.projects.find(project => project.id === id)?.name ?? ''
  const items = data?.items ?? []
  if (!items.length) return null
  // A row marked done or not needed is no longer asked of the owner, but stays (with Undo) until a session applies the mark.
  const n = items.filter(item => !item.mark).length
  return (
    <section className="hub-panel rise" aria-label="Says it needs you" data-today-unasked>
      {n > 0 && <h3>⚠ {n} {n === 1 ? 'item says it needs' : 'items say they need'} you but {n === 1 ? 'asks' : 'ask'} nothing</h3>}
      {items.slice(0, SHOWN).map(item => <Row key={`${item.project}/${item.id}`} item={item} projectName={nameOf(item.project)} />)}
      {items.length > SHOWN && <p className="hub-muted"><a href="#/~hub/work/all">+{items.length - SHOWN} more</a></p>}
    </section>
  )
}
