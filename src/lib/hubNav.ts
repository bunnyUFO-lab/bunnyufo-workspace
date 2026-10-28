import type { HostCapabilities } from './host'
import type { HubScreen } from './route'

/** Shorter labels where a row is narrow: the phone's tab bar and the sidebar's two-column Hub. */
export const HUB_SHORT: Partial<Record<HubScreen, string>> = { map: 'Map' }

/**
 * The Hub's rows, in order: [screen, label, icon]. The sidebar's Hub group and the phone's tab bar
 * both read this, so the two cannot drift. Sketch needs writes and Chat needs the assistant.
 */
export function hubRows(caps: Pick<HostCapabilities, 'write' | 'chat'>): [HubScreen, string, string][] {
  const rows: [HubScreen, string, string, boolean][] = [
    ['today', 'Today', '☀', true], ['inbox', 'Inbox', '✉', true], ['map', 'Progress map', '◈', true], ['board', 'Board', '▦', true],
    ['activity', 'Activity', '≋', true], ['sketch', 'Sketch', '✎', caps.write], ['chat', 'Chat', '☁', caps.chat],
  ]
  return rows.filter(row => row[3]).map(([screen, label, icon]) => [screen, label, icon])
}
