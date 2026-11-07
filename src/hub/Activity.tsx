import { useState, type MouseEvent } from 'react'
import type { HubEvent, HubProject } from '../lib/hub'
import { hubHash, withScope } from '../lib/route'
import { useScope } from '../lib/useScope'
import { swap } from '../lib/entries'
import ItemRow from './ItemRow'
import ProjectPicker from './ProjectPicker'
import RefreshNote from './RefreshNote'
import { useHubData } from './useHub'

const FILTERS: [string, string, (kind: string) => boolean][] = [
  ['all', 'All', () => true],
  ['agents', 'Agents', kind => kind.startsWith('session-') || kind.startsWith('run-') || ['blocked', 'ready-for-review', 'review-done', 'ask-created', 'resumed', 'checklist-created', 'checklist-submitted', 'checklist-reopened'].includes(kind)],
  ['deploys', 'Deploys', kind => kind === 'deployed'],
  ['ci', 'CI', kind => kind.startsWith('pr-') || kind.startsWith('ci-')],
  ['alerts', 'Alerts', kind => kind === 'alert'],
]

/** A plain left click. A filter is a chip, not a place: it rewrites the address and adds no step. A modified click is left to the browser. */
const plain = (event: MouseEvent) => event.button === 0 && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey

const dayLabel = (iso: string) => new Date(iso).toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })

export default function Activity({ filter }: { filter?: string }) {
  const active = FILTERS.find(([key]) => key === filter) ?? FILTERS[0]
  // The project selector starts on `?project=` (a tab keeps it); the sprint is kept in the address but not applied here.
  const scope = useScope()
  const [project, setProject] = useState(scope.project && scope.project !== 'all' ? scope.project : '')
  const [days, setDays] = useState(1)
  // The window starts at a whole hour of when the screen opened, so polling does not move it.
  const [opened] = useState(() => Math.floor(Date.now() / 3_600_000) * 3_600_000)
  const since = new Date(opened - days * 86_400_000).toISOString()
  const { data, error, loading, at } = useHubData<{ events: HubEvent[]; truncated: boolean }>(`/events?since=${encodeURIComponent(since)}${project ? `&project=${encodeURIComponent(project)}` : ''}`)
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
        <label className="hub-muted" htmlFor="hub-activity-project">Project</label>
        <ProjectPicker id="hub-activity-project" projects={projects.data?.projects ?? []} value={project || 'all'} allValue="all" onChange={id => setProject(id === 'all' ? '' : id)} alwaysList inRow local />
      </div>
      <div className="hub-chips">
        {FILTERS.map(([key, label]) => (
          <a key={key} className={`hub-chip${key === active[0] ? ' on' : ''}`} href={withScope(hubHash('activity', key), scope)} aria-current={key === active[0] ? 'true' : undefined} data-activity-filter={key} onClick={event => plain(event) && (event.preventDefault(), swap(withScope(hubHash('activity', key), scope)))}>{label}</a>
        ))}
      </div>
      <RefreshNote error={error} hasData={!!data} at={at} />
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
