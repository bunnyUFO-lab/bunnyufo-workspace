import Icon, { type IconName } from '../ui/Icon'
import type { HitIcon } from './searchIndex'

/** The pictures Search needs that the shared set does not have. Same stroke and size as `Icon`, so a row cannot tell them apart. */
const OWN: Partial<Record<HitIcon, string>> = {
  inbox: '<path d="M4 13 6.5 5.5h11L20 13v5.5a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5z"/><path d="M4 13h4.5l1 2.5h5l1-2.5H20"/>',
  card: '<rect x="4" y="3.5" width="16" height="17" rx="2.5"/><path d="M8 8.5h8M8 12.5h8M8 16.5h4"/>',
  job: '<rect x="3.5" y="7.5" width="17" height="12" rx="2.5"/><path d="M9 7.5V6a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v1.5M3.5 13h17"/>',
  task: '<circle cx="12" cy="12" r="8.5"/><path d="m8.5 12.3 2.5 2.5 4.5-5"/>',
  skill: '<path d="M12 3.5 14.4 9l5.9.5-4.5 3.9 1.4 5.8L12 16.2l-5.2 3 1.4-5.8-4.5-3.9L9.6 9z"/>',
  activity: '<path d="M3 12h4l2.5-6 4 12 2.5-6H21"/>',
  sparkle: '<path d="M12 3.5v4M12 16.5v4M3.5 12h4M16.5 12h4M6.3 6.3l2.4 2.4M15.3 15.3l2.4 2.4M6.3 17.7l2.4-2.4M15.3 8.7l2.4-2.4"/>',
}
const SHARED: Partial<Record<HitIcon, IconName>> = { today: 'today', chat: 'chat', work: 'work', project: 'project', library: 'library', team: 'team', sketch: 'sketch', settings: 'settings' }

export default function SearchIcon({ name, size = 22 }: { name: HitIcon; size?: number }) {
  const shared = SHARED[name]
  if (shared) return <Icon name={shared} size={size} />
  return (
    <svg className="ui-icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"
      dangerouslySetInnerHTML={{ __html: OWN[name] ?? '' }} />
  )
}
