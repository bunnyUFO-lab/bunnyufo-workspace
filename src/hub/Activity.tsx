import { useState } from 'react'
import type { HubEvent, HubProject } from '../lib/hub'
import { hubHash } from '../lib/route'
import ItemRow from './ItemRow'
import { useHubData } from './useHub'

const FILTERS: [string, string, (kind: string) => boolean][] = [
  ['all', 'All', () => true],
  ['agents', 'Agents', kind => kind.startsWith('session-') || ['blocked', 'ready-for-review', 'ask-created'].includes(kind)],
  ['deploys', 'Deploys', kind => kind === 'deployed'],
  ['ci', 'CI', kind => kind.startsWith('pr-') || kind.startsWith('ci-')],
  ['alerts', 'Alerts', kind => kind === 'alert'],
]

const dayLabel = (iso: string) => new Date(iso).toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })

export default function Activity({ filter }: { filter?: string }) {
  const active = FILTERS.find(([key]) => key === filter) ?? FILTERS[0]
  const [project, setProject] = useState('')
  const [days, setDays] = useState(1)
  // The window starts at a whole hour of when the screen opened, so polling does not move it.
  const [opened] = useState(() => Math.floor(Date.now() / 3_600_000) * 3_600_000)
  const since = new Date(opened - days * 86_400_000).toISOString()
  const { data, error, loading } = useHubData<{ events: HubEvent[]; truncated: boolean }>(`/events?since=${encodeURIComponent(since)}${project ? `&project=${encodeURIComponent(project)}` : ''}`)
  const projects = useHubData<{ projects: HubProject[] }>('/projects')
  const events = (data?.events ?? []).filter(event => active[2](event.kind))
  const groups = new Map<string, HubEvent[]>()
  for (const event of events) {
    const label = dayLabel(event.ts)
    groups.set(label, [...(groups.get(label) ?? []), event])
  }
  return (
    <>
      <div className="hub-top">
        <h2>Activity</h2>
        <label className="hub-muted">Project <select value={project} onChange={event => setProject(event.target.value)} aria-label="Project">
          <option value="">All</option>
          {(projects.data?.projects ?? []).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select></label>
      </div>
      <div className="hub-chips">
        {FILTERS.map(([key, label]) => (
          <a key={key} className={`hub-chip${key === active[0] ? ' on' : ''}`} href={hubHash('activity', key)} aria-current={key === active[0] ? 'true' : undefined}>{label}</a>
        ))}
      </div>
      {error && <p className="hub-error" role="alert">{error}</p>}
      {!data && !error && loading && <p className="hub-empty">Loading…</p>}
      {data && !events.length && <p className="hub-empty">Nothing to show in the last {days === 1 ? '24 hours' : `${days} days`}.</p>}
      {[...groups.entries()].map(([label, list]) => (
        <section className="hub-panel" key={label} aria-label={label}>
          <h3>{label} <span>{list.length}</span></h3>
          {list.map(event => <ItemRow key={event.file} event={event} />)}
        </section>
      ))}
      {days < 7 && <button type="button" className="hub-btn" onClick={() => setDays(value => Math.min(7, value + 1))}>Load older</button>}
      {data?.truncated && <p className="hub-muted">The window holds more events than are shown.</p>}
    </>
  )
}
