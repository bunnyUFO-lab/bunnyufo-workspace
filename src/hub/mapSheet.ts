// What the Roadmap item sheet (MapPanel.tsx) says about an item, as plain functions.
import type { MapCard, MapPr, MapTask } from '../lib/hub'

/** The close reasons the Beads backfill wrote; they say nothing the sheet's "Closed" line does not. */
const STOCK_REASONS = new Set(['done (backfilled)', 'every task done (backfilled)'])

/** `18 Oct`, or null when the date does not parse. */
export function shortDate(iso: string | undefined): string | null {
  if (!iso) return null
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? null : date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}

/** `Finished 18 Oct.` for a done feature or milestone; `Finished.` when the date is missing. */
export function finishedLine(closedAt: string | undefined): string {
  const date = shortDate(closedAt)
  return date ? `Finished ${date}.` : 'Finished.'
}

/** `Closed 18 Oct`, plus the reason unless it is a backfill stock phrase; null for a task that is not closed. */
export function closedLine(task: MapTask): string | null {
  if (task.state !== 'done' || task.mark) return null
  const date = shortDate(task.closedAt)
  const reason = task.closeReason?.trim()
  const why = reason && !STOCK_REASONS.has(reason.toLowerCase()) ? reason : null
  if (!date && !why) return null
  return [date ? `Closed ${date}` : 'Closed', why].filter(Boolean).join(' · ')
}

export interface SheetPr { task: MapTask; pr: MapPr }

/** Every PR of these tasks: open first, then the rest, newest first within each. */
export function sheetPrs(tasks: MapTask[]): SheetPr[] {
  const rows = tasks.flatMap(task => (task.prs ?? []).map(pr => ({ task, pr })))
  const rank = (row: SheetPr) => (row.pr.state === 'open' ? 0 : 1)
  return rows.sort((a, b) => rank(a) - rank(b) || (a.pr.at < b.pr.at ? 1 : a.pr.at > b.pr.at ? -1 : 0))
}

/** `#138 · merged` beside an Open PR link; `PR #138 · merged` when there is no link to open. */
export function prLabel(pr: MapPr, linked: boolean): string {
  const parts = [pr.number ? `${linked ? '' : 'PR '}#${pr.number}` : null, pr.state ?? null].filter(Boolean)
  return parts.length ? parts.join(' · ') : 'pull request'
}

/** What the PR list says when it is empty. */
export const noPrs = (done: boolean) => (done ? 'No pull request on record.' : 'No pull requests yet.')

/** A Library card's path, only when it is a site path of this origin (`/<section>#/<id>`). */
export const cardHref = (card: MapCard): string | undefined => (/^\/(?!\/)[^\s]*$/.test(card.href) ? card.href : undefined)

/** Whether "Open in Needs you" leads somewhere: the task has an open Ask, or Needs you has an item naming it. */
export const hasNeedsItem = (task: MapTask, inboxBeads: ReadonlySet<string>): boolean => Boolean(task.ask) || inboxBeads.has(task.id)
