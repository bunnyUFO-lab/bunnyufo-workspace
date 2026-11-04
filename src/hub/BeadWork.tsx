import { useState } from 'react'
import type { MapTask } from '../lib/hub'
import { hubGet } from '../lib/hub'
import { hubHash } from '../lib/route'
import { BEAD_ROWS, runWord, seedPath, type BeadKind, type BeadSeed } from './beadActions'
import { openSpawn } from './spawnStore'
import './questions.css'

/**
 * The "Do it" block of an open task's sheet: Build it, Mock it up and Research it. A tap reads the bead's seed from the Hub and opens
 * Spawn filled from it; the Approve there is the owner's one tap, so nothing is filed or signed here. While a run is on the bead the
 * block says so and links to it instead of offering a second one. The caller decides whether the block shows at all (`visible`).
 */
export default function BeadWork({ task, project }: { task: MapTask; project: string }) {
  const [busy, setBusy] = useState<BeadKind | null>(null)
  const [problem, setProblem] = useState('')

  async function start(kind: BeadKind) {
    setBusy(kind)
    setProblem('')
    try {
      const seed = await hubGet<BeadSeed>(seedPath(project, task.id, kind))
      openSpawn({ preset: seed.preset, project, title: seed.title, text: seed.text, ...(seed.doneWhen ? { doneWhen: seed.doneWhen } : {}), bead: task.id })
    } catch (failure) {
      setProblem(failure instanceof Error ? failure.message : 'Could not read this task.')
    } finally {
      setBusy(null)
    }
  }

  if (task.run) {
    return (
      <div className="hub-map-panel-dostuff" data-bead-work>
        <h4>Do it</h4>
        <p className="hub-bead-run" data-bead-run={task.run.state}>{runWord(task.run.state)} · <a href={hubHash('request', task.run.id)} data-bead-run-link>Open the run</a></p>
      </div>
    )
  }
  return (
    <div className="hub-map-panel-dostuff" data-bead-work>
      <h4>Do it</h4>
      <div className="hub-bead-btns">
        {BEAD_ROWS.map(row => (
          <button key={row.kind} type="button" className="hub-btn hub-bead-btn" data-bead-do={row.kind} disabled={busy !== null} aria-busy={busy === row.kind} onClick={() => void start(row.kind)}>
            <span>{row.label}</span>
            <small>{row.note}</small>
          </button>
        ))}
      </div>
      {problem && <p className="hub-error" role="alert" data-bead-error>{problem}</p>}
    </div>
  )
}
