import { useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { MapWayfinder } from '../lib/hub'
import { host } from '../lib/host'
import QuestionActions from './QuestionActions'
import { COST, preparable, questionSeed } from './questionSeed'
import { openSpawn } from './spawnStore'

/** The Wayfinder destination above the Roadmap (the Map or the list): one row, with the open questions as links to their nodes. Starts open on a wide box and closed on a narrow one; the state is not remembered. */
export default function WayfinderHeader({ project, repoName, wayfinder, plan, nodeHref }: { project: string; repoName: string; wayfinder: MapWayfinder; plan?: ReactNode; /** Where a question's row goes: the Map's address on the Map, the project's on the list. */ nodeHref: (id: string) => string }) {
  const root = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  useLayoutEffect(() => { setOpen((root.current?.clientWidth ?? 0) > 600) }, [])
  const { destination, decisions, open: questions } = wayfinder
  const ready = preparable(wayfinder)
  if (!destination && !decisions && !questions.length) return null
  return (
    <div className="hub-wayfinder" data-open={open} ref={root}>
      <div className="hub-wayfinder-row">
        <span className="hub-wayfinder-eyebrow">Destination</span>
        {destination && (
          <button type="button" className="hub-wayfinder-text" aria-expanded={open} aria-controls="hub-wayfinder-list" onClick={() => setOpen(value => !value)}>
            <span className="hub-wayfinder-dest">{destination}</span>
            <span className="hub-wayfinder-cue" aria-hidden="true">{open ? 'Less' : 'More ›'}</span>
          </button>
        )}
        {decisions > 0 && <span className="hub-wayfinder-count">{decisions} {decisions === 1 ? 'decision' : 'decisions'}</span>}
        {questions.length > 0 && (
          <button type="button" className="hub-wayfinder-toggle" aria-expanded={open} aria-controls="hub-wayfinder-list" onClick={() => setOpen(value => !value)}>
            Open questions · {questions.length}
          </button>
        )}
        {plan}
        {open && host.write && ready.length > 0 && (
          <span className="hub-wayfinder-all">
            <button type="button" className="hub-btn pri" data-q-all onClick={() => openSpawn({ preset: 'question', project, text: questionSeed(project, wayfinder, ready.map(item => item.id), 'grilling') })}>Prepare all · {ready.length}</button>
            <span className="hub-q-cost" data-q-all-cost>{COST.prepareAll}</span>
          </span>
        )}
      </div>
      {open && questions.length > 0 && (
        <ul className="hub-wayfinder-list" id="hub-wayfinder-list">
          {questions.map(item => (
            <li key={item.id} className="hub-q-row" data-q-row={item.id}>
              <span className="hub-q-title"><a href={nodeHref(item.id)}><span className="hub-wayfinder-type">{item.type}</span> {item.title}</a></span>
              <QuestionActions project={project} repoName={repoName} wayfinder={wayfinder} item={item} layout="row" />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
