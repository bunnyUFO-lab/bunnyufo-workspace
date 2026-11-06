import type { ReactNode } from 'react'
import { back } from '../lib/entries'
import { IconButton } from './Controls'

/**
 * The top of a screen. A root screen (a tab's own list) has a large title. A detail screen has a Back button, which walks one
 * step of history, or goes to `parent` when nothing of ours is behind it, so it never leaves the app.
 */
export default function TopBar({ title, sub, parent, actions, phoneOnly }: { title: string; sub?: string; parent?: string; actions?: ReactNode; phoneOnly?: boolean }) {
  const detail = parent !== undefined
  return (
    <header className={`ui-top${detail ? ' detail' : ''}${phoneOnly ? ' phone-only' : ''}`} data-top={detail ? 'detail' : 'root'}>
      {detail && <IconButton icon="back" label="Back" data-back="" onClick={() => back(parent)} />}
      <div className="ui-top-title">{sub && <small>{sub}</small>}<h1>{title}</h1></div>
      {actions}
    </header>
  )
}
