import type { PointerEvent as ReactPointerEvent } from 'react'
import type { CardWorkspace } from '../types'
import type { DragItem, DropTarget } from '../lib/drag'
import { ARCHIVE_DAYS } from '../lib/workspace'

interface ProjectFilterProps {
  workspaces: CardWorkspace[]
  /** Cards each project would show right now, under the current search and archive toggle. */
  counts: Map<string, number>
  total: number
  /** Selected project id, or '' for every project at once. */
  value: string
  onChange: (id: string) => void
  /** The archive filter's chip, last in the row: on, the lists show what was put away instead. */
  archive?: { count: number; on: boolean; onToggle: () => void }
  /** Recent, before the archive chip: on, one newest-first run with no sections. A way of looking, not a filter. */
  recent?: { on: boolean; onToggle: () => void }
  /** Dragging a chip puts the projects in a new order. Omitted, the chips stay where they are. */
  drag?: {
    item: DragItem | null
    over: DropTarget | null
    begin: (item: DragItem, event: ReactPointerEvent) => void
    /** True when the click that follows a drag should not pick the project. */
    afterDrag: () => boolean
  }
}

/**
 * The project filter: every workspace's cards are on screen at once, and these chips narrow the
 * list to one. It replaces switching the active workspace in and out just to read another
 * project's cards — that switch now only decides where agents and new cards write.
 *
 * The first nine projects answer to their number key (`0` or `` ` `` for all); App binds them.
 */
export default function ProjectFilter({ workspaces, counts, total, value, onChange, archive, recent, drag }: ProjectFilterProps) {
  const projects = workspaces.length >= 2
  // The archive chip stays while the filter is on, even with nothing in it, so the way out of
  // an empty archive is where the way in was.
  const showArchive = !!archive && (archive.count > 0 || archive.on)
  // Recent is there whenever there are cards, and while it is on.
  const showRecent = !!recent && (total > 0 || recent.on)
  if (!projects && !showArchive && !showRecent) return null
  return (
    <div className="project-filter" role="group" aria-label="Filter by project">
      {projects && (
        <button
          type="button"
          className={`project-chip${value ? '' : ' active'}`}
          aria-pressed={!value}
          title="Every project, live cards ( 0 or Alt+A )"
          onClick={() => onChange('')}
        >
          <span className="project-chip-key" aria-hidden="true">0</span>
          All<span className="project-chip-count">{total}</span>
        </button>
      )}
      {projects && workspaces.map((workspace, index) => {
        const moving = drag?.item?.kind === 'project' ? drag.item : null
        const edge = moving && moving.id !== workspace.id && drag?.over?.kind === 'project' && drag.over.key === workspace.id ? drag.over.edge : null
        return (
        <button
          key={workspace.id}
          type="button"
          className={`project-chip${value === workspace.id ? ' active' : ''}${workspace.active ? ' writing' : ''}${edge ? ` drop-${edge}` : ''}`}
          aria-pressed={value === workspace.id}
          title={`${workspace.name}${workspace.active ? ' — agents and new cards write here' : ''}${index < 9 ? ` ( ${index + 1} )` : ''} — drag to reorder`}
          data-drop={moving ? 'project' : undefined}
          data-drop-key={moving ? workspace.id : undefined}
          data-drop-axis={moving ? 'x' : undefined}
          onPointerDown={drag ? event => drag.begin({ kind: 'project', id: workspace.id }, event) : undefined}
          onClick={() => { if (!drag?.afterDrag()) onChange(value === workspace.id ? '' : workspace.id) }}
        >
          {index < 9 && <span className="project-chip-key" aria-hidden="true">{index + 1}</span>}
          {workspace.name}
          <span className="project-chip-count">{counts.get(workspace.id) ?? 0}</span>
        </button>
        )
      })}
      {(showArchive || showRecent) && projects && <span className="project-filter-sep" aria-hidden="true" />}
      {showRecent && (
        <button
          type="button"
          className={`project-chip recent-chip${recent.on ? ' active' : ''}`}
          aria-pressed={recent.on}
          title="Newest first, no sections ( Shift+R )"
          onClick={recent.onToggle}
        >
          {'\u{1F552}'} Recent
        </button>
      )}
      {showArchive && (
        <button
          type="button"
          className={`project-chip archive-chip${archive.on ? ' active' : ''}`}
          aria-pressed={archive.on}
          title={`${archive.on ? 'Back to live cards' : 'Show archived cards instead of live ones'} ( Shift+A ). Cards untouched for ${ARCHIVE_DAYS} days are archived automatically; pin a card to keep it live.`}
          onClick={archive.onToggle}
        >
          {'\u{1F4E6}'} Archive
          <span className="project-chip-count">{archive.count}</span>
        </button>
      )}
    </div>
  )
}
