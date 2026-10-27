import { useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { CardWorkspace, WorkspaceCard } from '../types'
import type { DragItem, DropTarget } from '../lib/drag'
import { cardKey } from '../lib/order'
import { groupIcon } from '../lib/categories'
import { useCollapsedSections } from '../lib/collapse'
import { ARCHIVE_DAYS } from '../lib/workspace'
import BuwCard from './BuwCard'
import BuwText from './BuwText'
import BrandLogo from './BrandLogo'
import ProjectFilter from './ProjectFilter'
import NewCard from './NewCard'
import { host } from '../lib/host'

interface HomeGridProps {
  /** The header's counts for the project in view, ignoring the search: live, put away, categories. */
  hero: { live: number; archived: number; categories: number }
  grouped: Map<string, WorkspaceCard[]>
  groupBy: 'project' | 'category' | 'date'
  workspaces: CardWorkspace[]
  project: string
  counts: Map<string, number>
  total: number
  onProject: (id: string) => void
  offline: boolean
  searching: boolean
  query: string
  onClearSearch: () => void
  /** Put-away cards in this project: the archive chip's count. */
  archivedCount: number
  /** The archive filter: on, `grouped` holds archived cards instead of live ones. */
  showArchived: boolean
  onToggleArchived: () => void
  /** Recent: one newest-first run, no sections. */
  showRecent: boolean
  onToggleRecent: () => void
  showProject: boolean
  /** Local app only; a site has no service to write workspace.json. */
  onArchive?: (card: WorkspaceCard, archived: boolean) => void
  /** Local app only; pins the card to the sidebar list. */
  onPin?: (card: WorkspaceCard, pinned: boolean) => void
  /** Local app or write API only; sets the card's icon ('' goes back to its own). */
  onIcon?: (card: WorkspaceCard, emoji: string) => void
  /** What is being dragged, and what it is over: cards, project chips and section headings all move. */
  dragItem?: DragItem | null
  dragOver?: DropTarget | null
  /** Start dragging a card (to the sidebar's pins or archive, or to a new place in its section). */
  onDragStart?: (card: WorkspaceCard, event: ReactPointerEvent) => void
  /** Start dragging a project chip or a section heading. */
  onDragItem?: (item: DragItem, event: ReactPointerEvent) => void
  afterDrag?: () => boolean
  /** The section a card is listed under. */
  sectionOf?: (card: WorkspaceCard) => string
  /** What a heading stands for when dragged, or null when it cannot be moved. */
  sectionItem?: (label: string) => DragItem | null
  /** Card whose status is being written right now. */
  busyId: string | null
}

export default function HomeGrid({
  hero,
  grouped,
  groupBy,
  workspaces,
  project,
  counts,
  total,
  onProject,
  offline,
  searching,
  query,
  onClearSearch,
  archivedCount,
  showArchived,
  onToggleArchived,
  showRecent,
  onToggleRecent,
  showProject,
  onArchive,
  onPin,
  onIcon,
  dragItem,
  dragOver,
  onDragStart,
  onDragItem,
  afterDrag,
  sectionOf,
  sectionItem,
  busyId,
}: HomeGridProps) {
  const shown = [...grouped.values()].reduce((n, list) => n + list.length, 0)
  const projectName = workspaces.find(w => w.id === project)?.name
  // The board folds its sections like the sidebar does, and shares its state (lib/collapse).
  const { isClosed, toggle } = useCollapsedSections()
  // The form takes the width under the header rather than squeezing in beside the logo.
  const [newCardOpen, setNewCardOpen] = useState(false)
  return (
    <div className="home">
      <header className="home-hero">
        <BrandLogo size={84} />
        <div>
          <h1 className="home-title home-wordmark" aria-label="bunnyUFO Workspace"><BuwText height={30} /></h1>
          <p className="home-sub">
            <b>{hero.live}</b> active · <b>{hero.archived}</b> archived ·{' '}
            <b>{hero.categories}</b> categories
            {projectName
              ? <> · <b>{projectName}</b></>
              : workspaces.length > 1 && <> · <b>{workspaces.length}</b> projects</>}
            {offline && <span className="home-offline"> · workspace.json unreachable</span>}
          </p>
        </div>
        {host.cards && !newCardOpen && <NewCard workspaces={workspaces} project={project} open={false} onOpen={setNewCardOpen} />}
      </header>
      {host.cards && newCardOpen && <NewCard workspaces={workspaces} project={project} open onOpen={setNewCardOpen} />}

      <ProjectFilter
        workspaces={workspaces}
        counts={counts}
        total={total}
        value={project}
        onChange={onProject}
        archive={{ count: archivedCount, on: showArchived, onToggle: onToggleArchived }}
        recent={{ on: showRecent, onToggle: onToggleRecent }}
        drag={onDragItem && afterDrag ? { item: dragItem ?? null, over: dragOver ?? null, begin: onDragItem, afterDrag } : undefined}
      />

      {showArchived && (
        <p className="home-filter home-archive-note">
          Cards untouched for {ARCHIVE_DAYS} days are archived automatically. Pin a card to keep it live.
        </p>
      )}

      {searching && (
        <p className="home-filter">
          {shown === 0
            ? 'No matches for'
            : `${shown} match${shown === 1 ? '' : 'es'} for`}{' '}
          “{query.trim()}”{showArchived && ' in the archive'}{' '}
          <button type="button" className="home-filter-clear" onClick={onClearSearch} title="Clear the search ( Esc )">Clear</button>
        </p>
      )}

      {[...grouped.entries()].map(([label, list]) => {
        const open = !isClosed(label)
        // A heading moves only beside its own kind: a project among projects, a category among categories.
        const item = sectionItem?.(label) ?? null
        const moving = dragItem && item && dragItem.kind === item.kind ? dragItem : null
        const same = !!moving && (moving.kind === 'project' ? moving.id === (item as typeof moving).id : moving.kind === 'section' && moving.label === label)
        const edge = moving && !same && dragOver?.kind === item?.kind && dragOver?.key === (item?.kind === 'project' ? item.id : label) ? dragOver?.edge : null
        const mover = dragItem?.kind === 'card' ? dragItem.card : null
        return (
          <section key={label} className="home-section">
            <button
              type="button"
              className={`section-head section-toggle${edge ? ` drop-${edge}` : ''}`}
              onClick={() => { if (!afterDrag?.()) toggle(label) }}
              aria-expanded={open}
              title={open ? `Fold ${label} away` : `Show ${label}`}
              data-drop={moving && item ? item.kind : undefined}
              data-drop-key={moving && item ? (item.kind === 'project' ? item.id : label) : undefined}
              onPointerDown={item && onDragItem ? event => onDragItem(item, event) : undefined}
            >
              <span className="section-title">
                <span className="section-caret" aria-hidden="true">{open ? '▾' : '▸'}</span>{' '}
                {groupIcon(groupBy, label)} {label.replace(/-/g, ' ')}
              </span>
              <span className="section-count">{list.length}</span>
            </button>
            {open && (
              <div className="card-grid">
                {list.map(e => {
                  // A card is a place to drop only for another card of the same section.
                  const target = !!mover && sectionOf?.(mover) === label && cardKey(mover) !== cardKey(e)
                  const over = target && dragOver?.kind === 'order' && dragOver.key === cardKey(e) && dragOver.section === label ? dragOver.edge ?? null : null
                  return (
                    <BuwCard key={cardKey(e)} entity={e} archived={showArchived} showProject={showProject} onProject={onProject} onArchive={onArchive} onPin={onPin} onIcon={onIcon} onDragStart={onDragStart} afterDrag={afterDrag} busy={busyId === e.id} order={target ? { section: label, edge: over } : undefined} />
                  )
                })}
              </div>
            )}
          </section>
        )
      })}

      {shown === 0 && !searching && (
        <div className="home-empty">
          {showArchived
            ? `Nothing archived${projectName ? ` in ${projectName}` : ''}.`
            : offline
            ? 'Could not load workspace.json — is the public/workspace link in place? Run npm run dev again.'
            : projectName
              ? `Nothing active in ${projectName} right now. Pick another project, or look in its archive.`
              : 'Nothing here yet. New work will appear as cards.'}
        </div>
      )}
    </div>
  )
}
