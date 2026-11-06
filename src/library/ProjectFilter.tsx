import { useEffect, useRef, useState } from 'react'
import type { CardWorkspace } from '../types'
import Icon from '../ui/Icon'
import { Sheet } from '../ui/Sheet'
import { filterLabel, projectOrder, togglePick } from './libraryModel'

/**
 * The Library's project filter: one button on one line ("All projects", the project's name, or "3 projects") that opens a list of
 * checkboxes. A tap toggles a project and the list stays open, with the rows behind it updating. "All projects" clears the picks, and
 * so does unticking the last one. The list is the app's Sheet: a bottom sheet on a phone, a dialog from 900 px (ui.css), so there is one
 * piece for both. Opening it adds a sheet's history entry and Back closes it; picking adds none.
 */
export default function ProjectFilter({ workspaces, picks, counts, total, onChange }: {
  workspaces: CardWorkspace[]
  picks: string[]
  /** What each project would show under the current search and view (the Trash's count in the Trash). */
  counts: ReadonlyMap<string, number>
  total: number
  onChange: (picks: string[]) => void
}) {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!open) return undefined
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); setOpen(false) } }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])
  // A keyboard starts in the list (the first box), and comes back to the button when it closes.
  const button = useRef<HTMLButtonElement>(null)
  const list = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return undefined
    const trigger = button.current
    list.current?.querySelector('input')?.focus()
    return () => trigger?.focus()
  }, [open])
  const label = filterLabel(picks, workspaces)
  const byId = new Map(workspaces.map(w => [w.id, w]))
  return (
    <>
      <button ref={button} type="button" className={`lib-filter${picks.length ? ' on' : ''}`} aria-haspopup="dialog" aria-expanded={open} data-project-filter="" title={label} onClick={() => setOpen(true)}>
        <span className="lib-filter-label">{label}</span>
        <Icon name="down" size={18} />
      </button>
      {open && (
        <Sheet title="Projects" onClose={() => setOpen(false)}>
          <div ref={list} className="lib-picks" role="group" aria-label="Projects" data-project-list="">
            <label className="lib-pick" data-pick="">
              <input type="checkbox" checked={picks.length === 0} onChange={() => { if (picks.length) onChange([]) }} />
              <span className="lib-pick-name">All projects</span>
              <small>{total}</small>
            </label>
            {projectOrder(workspaces, counts).map(id => {
              const w = byId.get(id)!
              const count = counts.get(id) ?? 0
              return (
                <label key={id} className={`lib-pick${count ? '' : ' dim'}`} data-pick={id}>
                  <input type="checkbox" checked={picks.includes(id)} onChange={() => onChange(togglePick(picks, id))} />
                  <span className="lib-pick-name">{w.name}</span>
                  <small>{count}</small>
                </label>
              )
            })}
          </div>
        </Sheet>
      )}
    </>
  )
}
