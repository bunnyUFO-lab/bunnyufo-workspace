import type { HostCapabilities } from './host'
import { hubHash, type HubScreen, type NavId } from './route'

/** The Hub's screens the search lists under "Go to", in order: [screen, label, icon]. Sketch needs writes and Chat needs the assistant. */
export function hubRows(caps: Pick<HostCapabilities, 'write' | 'chat'>): [HubScreen, string, string][] {
  const rows: [HubScreen, string, string, boolean][] = [
    ['today', 'Today', '☀', true], ['needs', 'Needs you', '✉', true], ['work', 'Work', '▦', true], ['team', 'Team', '☺', true], ['project', 'Projects', '◧', true], ['map', 'Roadmap', '◈', true],
    ['sketch', 'Sketch', '✎', caps.write], ['chat', 'Chat', '☁', caps.chat],
  ]
  return rows.filter(row => row[3]).map(([screen, label, icon]) => [screen, label, icon])
}

/** Where Chat would be, for a visitor who may only read: one line saying it exists and what it needs. Null once Chat is offered, or where the assistant is simply not set up. */
export const chatNote = (caps: Pick<HostCapabilities, 'write' | 'chat'>): string | null => (!caps.write && !caps.chat ? 'Chat with the assistant needs you to be signed in.' : null)

/** One entry of the rail or the tab bar. `nav` is what a screen lights (route.ts `navScreen`). */
export interface NavEntry {
  nav: NavId
  label: string
  /** The address it opens. Search has a tab and a rail button of its own. */
  hash: string
}

type Caps = Pick<HostCapabilities, 'hub' | 'write' | 'chat'>

/**
 * The entries of the rail, in the mockup's order: Search, Today, Chat, Library, Projects, a gap, Work, Team, then Sketch and
 * Settings at the foot. `group` says where the gap and the foot fall. A host with no Hub shows the Library and Settings, and
 * Search: every other entry would lead nowhere. Chat is offered with the assistant, and to a visitor who may only read (its
 * screen then says what it needs); where writes are on and chat is not set up, it is left out, as before.
 */
export function navEntries(caps: Caps): (NavEntry & { group: 'top' | 'work' | 'foot' })[] {
  const chat = caps.chat || !caps.write
  const all: (NavEntry & { group: 'top' | 'work' | 'foot'; on: boolean })[] = [
    { nav: 'search', label: 'Search', hash: hubHash('search'), group: 'top', on: true },
    { nav: 'today', label: 'Today', hash: hubHash('today'), group: 'top', on: caps.hub },
    { nav: 'chat', label: 'Chat', hash: hubHash('chat'), group: 'top', on: caps.hub && chat },
    { nav: 'library', label: 'Library', hash: hubHash('library'), group: 'top', on: true },
    { nav: 'project', label: 'Projects', hash: hubHash('project'), group: 'top', on: caps.hub },
    { nav: 'work', label: 'Work', hash: hubHash('work'), group: 'work', on: caps.hub },
    { nav: 'team', label: 'Team', hash: hubHash('team'), group: 'work', on: caps.hub },
    { nav: 'sketch', label: 'Sketch', hash: hubHash('sketch'), group: 'foot', on: caps.hub && caps.write },
    { nav: 'settings', label: 'Settings', hash: hubHash('settings'), group: 'foot', on: true },
  ]
  return all.filter(entry => entry.on).map(entry => ({ nav: entry.nav, label: entry.label, hash: entry.hash, group: entry.group }))
}

/** The phone's tabs: Today, Chat, Library, Projects, Search, where the host has a Hub. None without one. */
export function tabEntries(caps: Caps): NavEntry[] {
  if (!caps.hub) return []
  const order: NavId[] = ['today', 'chat', 'library', 'project', 'search']
  const all = navEntries(caps)
  return order.flatMap(nav => all.filter(entry => entry.nav === nav).map(entry => ({ nav: entry.nav, label: entry.label, hash: entry.hash })))
}
