import type { ReactNode } from 'react'
import { host } from '../lib/host'
import { hubHash } from '../lib/route'
import { openSpawn } from './spawnStore'

export type WorkTab = 'running' | 'delivered' | 'board' | 'activity'

const TABS: [WorkTab, string, string][] = [
  ['running', 'Running', hubHash('jobs', 'running')],
  ['delivered', 'Delivered', hubHash('jobs', 'finished')],
  ['board', 'Board', hubHash('work')],
  ['activity', 'Activity', hubHash('activity')],
]

/**
 * Work's four tabs, drawn as links so each tap is one step of history: Running and Delivered are `#/~hub/jobs/running` and `jobs/finished`, Board is
 * `#/~hub/work`, Activity is `#/~hub/activity`. Each screen draws its own body inside. `running` is the count the tab shows, when the screen has it.
 * New job is here on every tab but the Board, which has its own button because it knows the project.
 */
export default function WorkTabs({ tab, running, children }: { tab: WorkTab; running?: number; children: ReactNode }) {
  return (
    <>
      <div className="hub-top wk-top">
        <h2>Work</h2>
        {host.write && tab !== 'board' && <button type="button" className="hub-btn pri" data-spawn-open onClick={() => openSpawn()}>New job</button>}
      </div>
      <nav className="ui-seg ui-seg-tabs" role="tablist" aria-label="Work" data-work-tabs>
        {TABS.map(([id, label, href]) => (
          <a key={id} role="tab" href={href} className={id === tab ? 'on' : undefined} aria-selected={id === tab} data-work-tab={id}>
            {label}{id === 'running' && running ? <small>{running}</small> : null}
          </a>
        ))}
      </nav>
      {children}
    </>
  )
}
