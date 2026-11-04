// Today for one project. Pure: the screen computes it once, before the phone and wide layouts are built.
import type { Today } from '../lib/hub.ts'

/** Today narrowed to a project, with the counts redone from the rows that stay. */
export type TodayView = { data: Today; elsewhere: number }

const active = (item: { state?: string }) => item.state !== 'idle' && item.state !== 'stale'

/**
 * No project returns `data` itself. Otherwise the rows of that project stay (the same rule as `inProject` on the server: a row
 * with no project is only at All) and `counts` are recounted. `elsewhere` is how many Needs you rows the filter hid.
 */
export function todayFor(data: Today, project: string): TodayView {
  if (!project) return { data, elsewhere: 0 }
  const mine = <T extends { project?: string }>(rows: T[]) => rows.filter(row => row.project === project)
  const needsYou = mine(data.needsYou)
  const recent = mine(data.recent)
  const alerts = mine(data.alerts)
  const running = mine(data.running)
  const working = data.working && mine(data.working)
  const offers = data.offers && mine(data.offers)
  const counts = { needsYou: needsYou.length, recent: recent.length, alerts: alerts.length, running: working ? working.filter(active).length : running.length }
  return { data: { ...data, needsYou, recent, alerts, running, working, offers, counts }, elsewhere: data.needsYou.length - needsYou.length }
}
