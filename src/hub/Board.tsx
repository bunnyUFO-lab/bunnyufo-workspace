import { useState } from 'react'
import type { MapTask, ProgressMap } from '../lib/hub'
import { copyAge, hubPost } from '../lib/hub'
import { host } from '../lib/host'
import { hubHash } from '../lib/route'
import { SIGN_GLYPH, SIGN_LABEL } from './signs'
import { useHubData } from './useHub'
import { useProject } from './useProject'

const WHEN: [string, string][] = [['next-sprint', 'Next sprint'], ['nightly', 'Nightly'], ['record', 'Just record it']]

function RequestForm({ project }: { project: string }) {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [when, setWhen] = useState('next-sprint')
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const send = async () => {
    setBusy(true)
    setError(null)
    try {
      const answer = await hubPost<{ id: string }>('/requests', { project, text: text.trim(), when })
      setSent(answer.id)
      setText('')
      setOpen(false)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The request was not sent.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="hub-request">
      {!open && <button type="button" className="hub-btn pri" onClick={() => { setOpen(true); setSent(null) }}>Ask an agent to do something</button>}
      {sent && <p className="hub-ok" role="status">Request sent <code>{sent}</code></p>}
      {open && (
        <section className="hub-panel" aria-label="New request">
          <label className="hub-field">What should happen?
            <textarea value={text} onChange={event => setText(event.target.value)} rows={3} maxLength={4000} />
          </label>
          <div className="hub-seg" role="radiogroup" aria-label="When">
            {WHEN.map(([key, label]) => (
              <button key={key} type="button" role="radio" aria-checked={when === key} className={when === key ? 'on' : ''} onClick={() => setWhen(key)}>{label}</button>
            ))}
          </div>
          {error && <p className="hub-error" role="alert">{error}</p>}
          <div className="hub-actions">
            <button type="button" className="hub-btn" onClick={() => setOpen(false)}>Cancel</button>
            <button type="button" className="hub-btn pri" disabled={busy || !text.trim()} onClick={() => void send()}>Send</button>
          </div>
        </section>
      )}
    </div>
  )
}

function Card({ task, tag }: { task: MapTask; tag?: string }) {
  return (
    <div className="hub-ticket" data-task={task.id}>
      <div className="hub-ticket-title">{task.title}</div>
      <div className="hub-ticket-meta">
        <span className="hub-id">{task.id}</span>
        {tag && <span className="hub-pill amber">{tag}</span>}
        {task.signs.map(sign => <span key={sign} className="hub-sign" title={SIGN_LABEL[sign]} aria-label={SIGN_LABEL[sign]}>{SIGN_GLYPH[sign]}</span>)}
      </div>
    </div>
  )
}

export default function Board({ project: wanted }: { project?: string }) {
  const { list, project, loading: listing, error: listError } = useProject(wanted)
  const map = useHubData<ProgressMap>(project ? `/map/${encodeURIComponent(project)}` : null)

  const tasks = (map.data?.milestones ?? []).flatMap(milestone => milestone.features.flatMap(feature => feature.tasks))
  const has = (task: MapTask, sign: string) => task.signs.some(item => item === sign)
  const ready = tasks.filter(task => task.state === 'next' || task.state === 'you')
  const progress = tasks.filter(task => task.state === 'doing' && !has(task, 'review') && !has(task, 'pr'))
  const review = tasks.filter(task => task.state !== 'done' && (has(task, 'review') || has(task, 'pr')))
  const done = tasks.filter(task => task.state === 'done').sort((a, b) => (b.closedAt ?? '').localeCompare(a.closedAt ?? '')).slice(0, 20)
  const later = tasks.filter(task => task.state === 'later').length
  const columns: [string, MapTask[]][] = [['Ready', ready], ['In progress', progress], ['Review', review], ['Done', done]]

  return (
    <>
      <div className="hub-top">
        <h2>Board{project ? ` · ${list.find(item => item.id === project)?.name ?? project}` : ''}</h2>
        {map.data?.ageMinutes != null && <span className="hub-muted">Beads copy from {copyAge(map.data.ageMinutes)}</span>}
      </div>
      <div className="hub-chips" aria-label="Project">
        {list.map(item => <a key={item.id} className={`hub-chip${item.id === project ? ' on' : ''}`} href={hubHash('board', item.id)}>{item.name}</a>)}
      </div>
      {project && host.write && <RequestForm project={project} />}
      {project && !host.write && <p className="hub-muted">Sign in to ask an agent to do something.</p>}
      {!map.data && !map.error && (listing || map.loading || !project) && !listError && <p className="hub-empty">Loading…</p>}
      {map.error && <p className="hub-error" role="alert">{map.error}</p>}
      {map.data && !map.data.meta && <p className="hub-empty">No Beads copy yet. It appears after the next agent session in this repo.</p>}
      {map.data?.meta && (
        <>
          <div className="hub-board">
            {columns.map(([label, items]) => (
              <section key={label} className="hub-column" aria-label={label}>
                <h3>{label} <span>{items.length}</span></h3>
                {items.map(task => <Card key={task.id} task={task} tag={task.state === 'you' ? 'needs you' : undefined} />)}
                {!items.length && <p className="hub-empty">Nothing here.</p>}
              </section>
            ))}
          </div>
          <p className="hub-muted">{later} later</p>
        </>
      )}
    </>
  )
}
