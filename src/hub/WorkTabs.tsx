import type { ReactNode } from 'react'
import { hubHash } from '../lib/route'

/** Work's three tabs. Lanes is `#/~hub/work`, Activity is `#/~hub/activity`, Jobs is `#/~hub/jobs`; each screen draws its own body inside. */
export default function WorkTabs({ tab, children }: { tab: 'lanes' | 'activity' | 'jobs'; children: ReactNode }) {
  return (
    <>
      <div className="hub-top"><h2>Work</h2></div>
      <div className="wk-tabs" role="tablist" aria-label="Work">
        <a role="tab" href={hubHash('work')} className={`wk-tab${tab === 'lanes' ? ' on' : ''}`} aria-selected={tab === 'lanes'} data-work-tab="lanes">Lanes</a>
        <a role="tab" href={hubHash('activity')} className={`wk-tab${tab === 'activity' ? ' on' : ''}`} aria-selected={tab === 'activity'} data-work-tab="activity">Activity</a>
        <a role="tab" href={hubHash('jobs')} className={`wk-tab${tab === 'jobs' ? ' on' : ''}`} aria-selected={tab === 'jobs'} data-work-tab="jobs">Jobs</a>
      </div>
      {children}
    </>
  )
}
