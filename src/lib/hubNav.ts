import type { HostCapabilities } from './host'
import type { HubScreen } from './route'

/** Shorter labels where a row is narrow: the phone's tab bar and the sidebar's two-column Hub. */
export const HUB_SHORT: Partial<Record<HubScreen, string>> = {}

/**
 * The Hub's rows, in order: [screen, label, icon]. The sidebar's Hub group and the phone's tab bar
 * both read this, so the two cannot drift. Sketch needs writes and Chat needs the assistant.
 */
export function hubRows(caps: Pick<HostCapabilities, 'write' | 'chat'>): [HubScreen, string, string][] {
  const rows: [HubScreen, string, string, boolean][] = [
    ['today', 'Today', '☀', true], ['needs', 'Needs you', '✉', true], ['work', 'Work', '▦', true], ['team', 'Team', '☺', true], ['map', 'Roadmap', '◈', true],
    ['sketch', 'Sketch', '✎', caps.write], ['chat', 'Chat', '☁', caps.chat],
  ]
  return rows.filter(row => row[3]).map(([screen, label, icon]) => [screen, label, icon])
}

export type HubGroup = 'operate' | 'plan' | 'know' | 'run'

/**
 * The rail's groups, from the mission control mockup. A new screen must be placed in a group. Rows
 * name screens; a row is drawn only if `hubRows` offers it (or it is the Library, which is always
 * there), so a screen that has not shipped, or that needs a capability the host lacks, leaves no link
 * that leads nowhere. Run is empty until its first screen (System) ships, and an empty group is not
 * drawn. `team` is listed ahead of its screen for the same reason: it appears with `hubRows`.
 */
export const HUB_GROUPS: { id: HubGroup; label: string; rows: (HubScreen | 'library' | 'team')[] }[] = [
  { id: 'operate', label: 'Operate', rows: ['today', 'needs', 'work', 'team'] },
  { id: 'plan', label: 'Plan', rows: ['map', 'chat'] },
  { id: 'know', label: 'Know', rows: ['library', 'sketch'] },
  { id: 'run', label: 'Run', rows: [] },
]

/** The groups to draw: each group's rows that `hubRows` offers, with their label and icon, and no empty group. */
export function hubGroups(caps: Pick<HostCapabilities, 'write' | 'chat'>): { id: HubGroup; label: string; rows: [HubScreen | 'library', string, string][] }[] {
  const offered = new Map(hubRows(caps).map(([screen, label, icon]) => [screen as string, [screen, label, icon] as [HubScreen, string, string]]))
  return HUB_GROUPS
    .map(group => ({
      id: group.id,
      label: group.label,
      rows: group.rows.flatMap((row): [HubScreen | 'library', string, string][] => (row === 'library' ? [['library', 'Library', '▤']] : offered.has(row) ? [offered.get(row)!] : [])),
    }))
    .filter(group => group.rows.length > 0)
}
