import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, RefObject } from 'react'
import type { CardWorkspace, WorkspaceCard } from '../types'
import type { DragItem, DropTarget } from '../lib/drag'
import { cardKey } from '../lib/order'
import { entityHash, homeLink, hubHash, type HubScreen } from '../lib/route'
import { host } from '../lib/host'
import { hubGroups } from '../lib/hubNav'
import { categoryIcon, groupIcon } from '../lib/categories'
import { useCollapsedSections } from '../lib/collapse'
import { cardUrl } from '../local/client'
import BrandLogo from './BrandLogo'
import BuwText from './BuwText'
import ProjectFilter from './ProjectFilter'
import WorkspaceSwitcher from './WorkspaceSwitcher'
import { useContextMenu } from './ItemMenu'
import { useCardMenu } from './CardMenu'
import { useCategoryMenu } from './CategoryMenu'
import TrashList from './TrashList'
import { trashOf } from '../lib/trash'

interface SidebarProps {
  /** The Hub screen on show, when one is. */
  hubScreen?: HubScreen | null
  /** How many things wait for the visitor (the Hub's Today count), for the badge. */
  hubNeedsYou?: number
  pinned: WorkspaceCard[]
  grouped: Map<string, WorkspaceCard[]>
  /** What the section headings mean: projects, categories, or one date-sorted run. */
  groupBy: 'project' | 'category' | 'date'
  activeId: string | null
  query: string
  onQuery: (q: string) => void
  searchRef: RefObject<HTMLInputElement | null>
  /** Opens the Ctrl+K palette. */
  onPalette: () => void
  workspaces: CardWorkspace[]
  project: string
  counts: Map<string, number>
  total: number
  onProject: (id: string) => void
  /** Put-away cards in this project: the archive chip's count. */
  archivedCount: number
  /** The archive filter: on, the sections list archived cards instead of live ones. */
  showArchived: boolean
  onToggleArchived: () => void
  /** Recent: one newest-first run, no sections. */
  showRecent: boolean
  onToggleRecent: () => void
  cardCount: number
  offline: boolean
  lastSync: Date | null
  onCollapse: () => void
  /** Back to the cards: the logo and the name are links to it. */
  onHome: () => void
  /** Pin, unpin and archive write card state: only where something can (the local service, a site's write API). */
  canWrite?: boolean
  /** What is being dragged right now, or null: a card, a project or a section heading. */
  dragItem?: DragItem | null
  /** Where it would land, from lib/drag. */
  dragOver?: DropTarget | null
  /** Start dragging a row. */
  onDragStart?: (card: WorkspaceCard, event: ReactPointerEvent) => void
  /** Start dragging a section heading. */
  onDragItem?: (item: DragItem, event: ReactPointerEvent) => void
  /** True when the click that follows a drag should not open the card. */
  afterDrag?: () => boolean
  /** The section a card is listed under: only a card of the same section can be dropped among its rows. */
  sectionOf?: (card: WorkspaceCard) => string
  /** What a heading stands for when dragged or nudged, or null when it cannot be moved. */
  sectionItem?: (label: string) => DragItem | null
  /** Alt+↑/↓ on a row or heading: one place up or down. */
  onNudge?: (item: DragItem, delta: -1 | 1) => void
  /** The menu is hidden: a navigation key brings it back before it moves anything. */
  collapsed?: boolean
  onReveal?: () => void
  /** Pin or unpin a card from the list itself. Where card state can be written. */
  onPin?: (card: WorkspaceCard, pinned: boolean) => void
  /** Archive or restore a card from the list itself. Local app only, like the card's own button. */
  onArchive?: (card: WorkspaceCard, archived: boolean) => void
  /** Archived as the app counts it: an explicit status, or the date rule. */
  isArchived?: (card: WorkspaceCard) => boolean
}

/**
 * A section heading that folds its section away.
 *
 * The whole row is the button, not a caret you have to hit: the list is long, the sections are
 * how you get through it, and a 10px target is not how you do that one-handed on a phone.
 */
function Heading({
  label,
  count,
  open,
  onToggle,
  cursor = false,
  id,
  move,
  category,
}: {
  /** Category headings: right-click offers Rename and Merge (the workspace is the one the rows belong to). */
  category?: { workspace: string | null; label: string }
  label: string
  /** Left out where a number would only count the rows below (the Hub group). */
  count?: number
  open: boolean
  onToggle: () => void
  /** The search box's arrow keys are on this heading: Space folds or opens it. */
  cursor?: boolean
  /** The section's own name, for the keyboard to find the heading again after it moves. */
  id?: string
  /** Dragging the heading rearranges the sections: where it starts, what it can land on, and the line shown. */
  move?: { onPointerDown?: (event: ReactPointerEvent) => void; drop?: { kind: string; key: string }; edge: 'before' | 'after' | null; afterDrag?: () => boolean }
}) {
  const { items, dialogs } = useCategoryMenu(category?.workspace ?? null, category?.label ?? '')
  const context = useContextMenu(`Category ${category?.label ?? ''}`, category ? items : null)
  return (
    <>
    <button
      type="button"
      {...context.props}
      className={`sidebar-section sidebar-section-toggle${cursor ? ' cursor' : ''}${move?.edge ? ` drop-${move.edge}` : ''}`}
      onClick={() => { if (!move?.afterDrag?.()) onToggle() }}
      aria-expanded={open}
      title={open ? `Fold ${label} away` : `Show ${label}`}
      data-section={id}
      data-drop={move?.drop?.kind}
      data-drop-key={move?.drop?.key}
      onPointerDown={move?.onPointerDown}
    >
      <span className="sidebar-label">
        <span className="sidebar-caret" aria-hidden="true">{open ? '▾' : '▸'}</span> {label}
      </span>
      {count !== undefined && <span className="sidebar-count">{count}</span>}
    </button>
    {context.menu}
    {category && dialogs}
    </>
  )
}

/**
 * The Hub: where the things that need you are. Its own block above the search box, as buttons two
 * to a row, so it does not read as more cards; the Needs you count is the phone's pink badge. Only where
 * the host has a Hub.
 */
function HubNav({ screen, needsYou, library, onHome }: { screen: HubScreen | null; needsYou: number; library: boolean; onHome: () => void }) {
  const groups = hubGroups(host)
  return (
    <nav className="sidebar-hub" data-hub-nav aria-label="Hub">
      {groups.map(group => (
        <div key={group.id} className="sidebar-hub-group" role="group" aria-labelledby={`hub-group-${group.id}`} data-hub-group={group.id}>
          <div className="sidebar-hub-heading" id={`hub-group-${group.id}`}>{group.label}</div>
          {group.rows.map(([key, label, icon]) => key === 'library' ? (
            <a key={key} {...homeLink(onHome)} className={`hub-link${library ? ' active' : ''}`} aria-current={library ? 'page' : undefined} title="Library" data-hub-link="library">
              <span className="hub-link-icon" aria-hidden="true">{icon}</span>
              <span className="hub-link-text">Library</span>
            </a>
          ) : (
            <a key={key} href={hubHash(key)} className={`hub-link${screen === key ? ' active' : ''}`} aria-current={screen === key ? 'page' : undefined} title={label} data-hub-link={key}>
              <span className="hub-link-icon" aria-hidden="true">{icon}</span>
              <span className="hub-link-text">{label}</span>
              {key === 'today' && needsYou > 0 && <span className="sidebar-count hub-badge" data-hub-badge>{needsYou}</span>}
              {key === 'needs' && needsYou > 0 && <span className="hub-inbox-badge" data-hub-inbox-badge role="img" title={`${needsYou} waiting for you`} aria-label={`Needs you, ${needsYou} waiting for you`}>{needsYou}</span>}
            </a>
          ))}
        </div>
      ))}
    </nav>
  )
}

function Item({
  entity,
  active,
  onDragStart,
  afterDrag,
  dropIndex,
  dropEdge,
  order,
  onPin,
  onArchive,
  archived = false,
  cursor = false,
}: {
  entity: WorkspaceCard
  active: boolean
  onDragStart?: (card: WorkspaceCard, event: ReactPointerEvent) => void
  afterDrag?: () => boolean
  /** Another card of this section is in the air: this row is a place to drop it. */
  order?: { section: string }
  onPin?: (card: WorkspaceCard, pinned: boolean) => void
  onArchive?: (card: WorkspaceCard, archived: boolean) => void
  archived?: boolean
  /** Pinned rows only: this row's place in the list, which makes it a drop target. */
  dropIndex?: number
  /** Which edge of this row the line is drawn on while a card hovers it. */
  dropEdge?: 'before' | 'after' | null
  /** The row the search box's arrow keys are on: Enter opens it. */
  cursor?: boolean
}) {
  const { items, dialogs } = useCardMenu(entity)
  const context = useContextMenu(`Menu for ${entity.title}`, items)
  return (
    // A row, not a bare link: the archive button cannot live inside an <a>, and putting work
    // away should not mean going back to the grid to find the card again.
    <div
      className={`sidebar-row${dropEdge ? ` drop-${dropEdge}` : ''}`}
      data-drop={dropIndex !== undefined ? 'pin' : order ? 'order' : undefined}
      data-drop-index={dropIndex}
      data-drop-key={order ? cardKey(entity) : undefined}
      data-drop-section={order?.section}
      {...context.props}
    >
    <a
      href={entityHash(entity.id)}
      data-key={cardKey(entity)}
      className={`sidebar-item${active ? ' active' : ''}${entity.pinned ? ' pinned' : ''}${cursor ? ' cursor' : ''}`}
      aria-current={active ? 'page' : undefined}
      title={`${entity.title} — ${entity.workspace.name}`}
      onPointerDown={event => onDragStart?.(entity, event)}
      onClick={event => { if (afterDrag?.()) event.preventDefault() }}
      // The browser's own link drag would fight the pointer gesture for the same press.
      draggable={false}
    >
      <span className="item-icon" aria-hidden="true">
        {entity.emoji
          ? entity.emoji
          : entity.icon ? <img src={cardUrl(entity, entity.icon)} width="24" height="24" alt="" decoding="async" /> : categoryIcon(entity.category)}
      </span>
      <span className="item-text">{entity.title}</span>
      <span className={`status-dot ${entity.status}`} title={entity.status} />
    </a>
    {onPin && (
      <button
        type="button"
        className={`sidebar-item-archive sidebar-item-pin${entity.pinned ? ' on' : ''}`}
        title={entity.pinned ? `Unpin ${entity.title}` : `Pin ${entity.title} to the top of the menu`}
        aria-label={entity.pinned ? `Unpin ${entity.title}` : `Pin ${entity.title}`}
        aria-pressed={!!entity.pinned}
        onClick={() => onPin(entity, !entity.pinned)}
      >
        {/* A drawn pin, not 📌: an emoji is a coloured blob at this size, and this one follows the text colour. */}
        <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true" fill={entity.pinned ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" strokeLinecap="round">
          <path d="M9.8 1.8 14.2 6.2 12.4 7 10.9 8.5 11.3 11.3 10.5 12.1 7.5 9.1 3.4 13.2 2.8 13.2 2.8 12.6 6.9 8.5 3.9 5.5 4.7 4.7 7.5 5.1 9 3.6Z" />
        </svg>
      </button>
    )}
    {onArchive && (
      <button
        type="button"
        className="sidebar-item-archive"
        title={archived ? `Bring ${entity.title} back to the active list` : `Put ${entity.title} in the archive`}
        aria-label={archived ? `Restore ${entity.title}` : `Archive ${entity.title}`}
        onClick={() => onArchive(entity, !archived)}
      >
        {/* Monochrome glyphs: an emoji renders as a coloured blob at this size. */}
        {archived ? '↩' : '⤓'}
      </button>
    )}
    {context.menu}
    {dialogs}
    </div>
  )
}

export default function Sidebar({
  pinned,
  grouped,
  groupBy,
  activeId,
  query,
  onQuery,
  searchRef,
  onPalette,
  workspaces,
  project,
  counts,
  total,
  onProject,
  archivedCount,
  showArchived,
  onToggleArchived,
  showRecent,
  onToggleRecent,
  cardCount,
  offline,
  lastSync,
  onCollapse,
  onHome,
  canWrite = false,
  dragItem,
  dragOver,
  onDragStart,
  onDragItem,
  afterDrag,
  sectionOf,
  sectionItem,
  onNudge,
  collapsed = false,
  onReveal,
  onPin,
  onArchive,
  isArchived,
  hubScreen = null,
  hubNeedsYou = 0,
}: SidebarProps) {
  // Which sections are folded shut. A view preference, kept in this browser (lib/collapse).
  const { isClosed, toggle } = useCollapsedSections()
  const empty = pinned.length === 0 && grouped.size === 0
  // Deleted cards of the workspace in view (all of them under "All").
  const trashed = trashOf(project ? workspaces.filter(w => w.id === project) : workspaces)
  const [trashOpen, setTrashOpen] = useState(false)
  // Dragging is the mouse's way to pin; the card's own pin button is the keyboard's. Each
  // target below says what it is with `data-drop`, and lib/drag works out which one the
  // pointer is over — so a zone only has to say whether it would take the card in the air.
  const dragCard = dragItem?.kind === 'card' ? dragItem.card : null
  const takes = (kind: DropTarget['kind']) => {
    // Pinning and archiving write card state; rearranging a list does not.
    if (!dragCard || !canWrite) return false
    // `pinned` is absent on an unpinned card, not false, so compare the booleans.
    if (kind === 'pin') return !dragCard.pinned
    if (kind === 'unpin') return !!dragCard.pinned
    return !!onArchive && !isArchived?.(dragCard)
  }
  const zone = (kind: DropTarget['kind'], base: string) => ({
    'data-drop': kind,
    className: `${base}${takes(kind) ? ' drop-zone' : ''}${dragOver?.kind === kind && takes(kind) ? ' over' : ''}`,
  })

  // Rearranging is view state, so it is offered where pinning is not. A row is a place to drop a
  // card only for another card of its own section; a pinned card dragged over the sections is
  // on its way off the list instead, and the sections around it are the unpin zone.
  const orderRow = (label: string, card: WorkspaceCard) => {
    if (!dragCard || dragCard.pinned || !sectionOf || sectionOf(dragCard) !== label || cardKey(dragCard) === cardKey(card)) return undefined
    return { section: label }
  }
  const orderEdge = (label: string, card: WorkspaceCard) =>
    dragOver?.kind === 'order' && dragOver.section === label && dragOver.key === cardKey(card) ? dragOver.edge ?? null : null
  // A heading moves beside its own kind only (a project among projects, a category among categories).
  const headMove = (label: string) => {
    const item = sectionItem?.(label) ?? null
    if (!item) return undefined
    const mover = dragItem && dragItem.kind === item.kind ? dragItem : null
    const key = item.kind === 'project' ? item.id : item.kind === 'section' ? item.label : ''
    const same = !!mover && (mover.kind === 'project' ? mover.id === key : mover.kind === 'section' && mover.label === key)
    return {
      onPointerDown: onDragItem ? (event: ReactPointerEvent) => onDragItem(item, event) : undefined,
      drop: mover && !same ? { kind: item.kind, key } : undefined,
      edge: mover && !same && dragOver?.kind === item.kind && dragOver.key === key ? dragOver.edge ?? null : null,
      afterDrag,
    }
  }

  // An empty pinned list has nothing to drop onto, so it appears as a target as soon as a
  // card leaves the ground.
  const showPinned = pinned.length > 0 || takes('pin')

  // The search box drives the list from the keyboard: ↑/↓ walk the section headings and rows on
  // screen, Space or Enter on a heading folds or opens it, Enter on a card opens the card (or the
  // first card, if the arrows were never touched), Tab and Shift+Tab step through the project
  // chips. The cursor belongs to one query; typing starts it over.
  type Row = { head: string } | { card: WorkspaceCard }
  const rows: Row[] = []
  const section = (key: string, list: WorkspaceCard[]) => {
    rows.push({ head: key })
    if (!isClosed(key)) for (const card of list) rows.push({ card })
  }
  if (showPinned) section('pinned', pinned)
  for (const [label, list] of grouped) section(label, list)
  const [cursorAt, setCursorAt] = useState({ query, index: -1 })
  const cursor = cursorAt.query === query ? Math.min(cursorAt.index, rows.length - 1) : -1
  const cursorRow = cursor >= 0 ? rows[cursor] : null
  const onCard = (e: WorkspaceCard) => !!cursorRow && 'card' in cursorRow && cursorRow.card === e
  const onHead = (key: string) => !!cursorRow && 'head' in cursorRow && cursorRow.head === key
  const listRef = useRef<HTMLElement>(null)
  useEffect(() => {
    listRef.current?.querySelector('.cursor')?.scrollIntoView({ block: 'nearest' })
  }, [cursor, query])
  const onSearchKey = (ev: ReactKeyboardEvent<HTMLInputElement>) => {
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      if (rows.length === 0) return
      ev.preventDefault()
      const step = ev.key === 'ArrowDown' ? 1 : -1
      setCursorAt({ query, index: cursor < 0 ? (step > 0 ? 0 : rows.length - 1) : (cursor + step + rows.length) % rows.length })
    } else if ((ev.key === ' ' || ev.key === 'Enter') && cursorRow && 'head' in cursorRow) {
      // Only on a heading: anywhere else Space is a space in the search.
      ev.preventDefault()
      toggle(cursorRow.head)
    } else if (ev.key === 'Enter') {
      const row = cursorRow && 'card' in cursorRow ? cursorRow : rows.find(r => 'card' in r)
      if (!row || !('card' in row)) return
      ev.preventDefault()
      window.location.hash = entityHash(row.card.id)
    } else if (ev.key === 'Tab' && !ev.altKey && !ev.ctrlKey && !ev.metaKey && workspaces.length > 1) {
      ev.preventDefault()
      const order = ['', ...workspaces.map(w => w.id)]
      const at = Math.max(0, order.indexOf(project))
      onProject(order[(at + (ev.shiftKey ? order.length - 1 : 1)) % order.length])
    } else if (ev.key === 'Escape') {
      onQuery('')
      ev.currentTarget.blur()
    }
  }

  // The menu from the keyboard without the search box: J/K step real focus through the headings and
  // rows (↑/↓ too once focus is in the list), so Enter opens a card and Enter or Space folds a
  // heading the way the browser already does for a focused link or button. Alt+↑/↓ moves the
  // focused row or heading one place. The key handler is bound once and reads the latest props here.
  const latest = useRef({ collapsed, onReveal, onNudge, sectionItem, cards: new Map<string, WorkspaceCard>() })
  const refocus = useRef<string | null>(null)
  useEffect(() => {
    const cards = new Map<string, WorkspaceCard>()
    for (const card of pinned) cards.set(cardKey(card), card)
    for (const list of grouped.values()) for (const card of list) cards.set(cardKey(card), card)
    latest.current = { collapsed, onReveal, onNudge, sectionItem, cards }
  })
  // A moved row is a different place in the DOM, and that drops its focus: put it back.
  useEffect(() => {
    const key = refocus.current
    if (!key) return
    const el = listRef.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"], [data-section="${CSS.escape(key)}"]`)
    if (el && document.activeElement !== el) el.focus()
  })
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.ctrlKey || ev.metaKey || ev.defaultPrevented) return
      const target = ev.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)) return
      if (document.querySelector('[data-buw-editing], dialog[open]')) return
      const list = listRef.current
      const inList = !!target && !!list?.contains(target)
      const { collapsed: hidden, onReveal: reveal, onNudge: nudge, sectionItem: itemOf, cards } = latest.current
      if (ev.altKey) {
        if (!inList || ev.shiftKey || (ev.key !== 'ArrowUp' && ev.key !== 'ArrowDown')) return
        const row = target!.closest<HTMLElement>('[data-key], [data-section]')
        if (!row || !nudge) return
        const card = row.dataset.key ? cards.get(row.dataset.key) : undefined
        const item = card ? { kind: 'card' as const, card } : itemOf?.(row.dataset.section ?? '')
        if (!item) return
        ev.preventDefault()
        refocus.current = row.dataset.key ?? row.dataset.section ?? null
        nudge(item, ev.key === 'ArrowDown' ? 1 : -1)
        return
      }
      refocus.current = null
      const letter = ev.key.toLowerCase()
      const down = (letter === 'j' && !ev.shiftKey) || (inList && ev.key === 'ArrowDown')
      const up = (letter === 'k' && !ev.shiftKey) || (inList && ev.key === 'ArrowUp')
      if (!down && !up) return
      ev.preventDefault()
      const step = () => {
        const items = [...(listRef.current?.querySelectorAll<HTMLElement>('.sidebar-section-toggle, .sidebar-item') ?? [])]
        if (!items.length) return
        const focused = document.activeElement
        // A pin or archive button inside a row counts as being on that row.
        const at = items.findIndex(el => el === focused || (el.classList.contains('sidebar-item') && el.parentElement?.contains(focused)))
        const first = Math.max(0, items.findIndex(el => el.classList.contains('active')))
        const next = at < 0 ? (down ? first : items.length - 1) : (at + (down ? 1 : -1) + items.length) % items.length
        items[next].focus()
      }
      if (hidden) { reveal?.(); window.setTimeout(step, 0) } else step()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <a className="brand-home" {...homeLink(onHome)} title="Home" aria-label="Home" data-home-link="logo">
          <BrandLogo size={54} animated={activeId !== 'my-dream-game'} />
        </a>
        <div className="brand-text">
          <a className="brand-home" {...homeLink(onHome)} title="Home" tabIndex={-1} aria-hidden="true" data-home-link="name">
            <BuwText height={26} animated={activeId !== 'my-dream-game'} />
          </a>
          <WorkspaceSwitcher />
        </div>
        <button
          className="sidebar-collapse"
          onClick={onCollapse}
          title="Hide menu ( [ )"
          aria-label="Hide menu"
        >
          ‹
        </button>
      </div>

      {host.hub && <HubNav screen={hubScreen} needsYou={hubNeedsYou} library={!hubScreen && activeId === null} onHome={onHome} />}

      <button type="button" className="sidebar-palette" onClick={onPalette} data-palette-open>
        <span aria-hidden="true">{'⌕'}</span>
        <span className="sidebar-palette-text">Search</span>
        <kbd>{/Mac|iPhone|iPad/.test(navigator.platform) ? '⌘K' : 'Ctrl K'}</kbd>
      </button>

      <div className="sidebar-search">
        <span className="search-icon" aria-hidden="true">
          {'⌕'}
        </span>
        <input
          ref={searchRef}
          value={query}
          onChange={ev => onQuery(ev.target.value)}
          onKeyDown={onSearchKey}
          placeholder="Filter cards…  ( / )"
          aria-label="Search entities"
        />
        {query && (
          <button className="search-clear" onClick={() => onQuery('')} aria-label="Clear search">
            ×
          </button>
        )}
      </div>

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

      <nav className="sidebar-list" ref={listRef}>
        {showPinned && (
          <div {...zone('pin', 'sidebar-pins')}>
            <Heading
              label={`${'\u{1F4CC}'} pinned`}
              count={pinned.length}
              open={!isClosed('pinned')}
              onToggle={() => toggle('pinned')}
              cursor={onHead('pinned')}
              id="pinned"
            />
            {!isClosed('pinned') && pinned.map((e, index) => (
              <Item
                key={`${e.workspace.id}/${e.id}`}
                entity={e}
                active={e.id === activeId}
                onDragStart={onDragStart}
                afterDrag={afterDrag}
                dropIndex={index}
                dropEdge={dragOver?.kind === 'pin' && dragOver.index === index && takes('pin') ? dragOver.edge : null}
                onPin={onPin}
                onArchive={onArchive}
                archived={!!isArchived?.(e)}
                cursor={onCard(e)}
              />
            ))}
            {pinned.length === 0 && <div className="sidebar-drop-hint">Drop a card here to pin it</div>}
          </div>
        )}

        <div {...zone('unpin', 'sidebar-groups')}>
          {[...grouped.entries()].map(([label, list]) => (
            <div key={label}>
              <Heading
                label={`${groupIcon(groupBy, label)} ${label.replace(/-/g, ' ')}`}
                count={list.length}
                open={!isClosed(label)}
                onToggle={() => toggle(label)}
                cursor={onHead(label)}
                id={label}
                move={headMove(label)}
                category={groupBy === 'category' ? { workspace: list[0]?.workspace.id ?? null, label } : undefined}
              />
              {!isClosed(label) && list.map(e => (
                <Item
                  key={`${e.workspace.id}/${e.id}`}
                  entity={e}
                  active={e.id === activeId}
                  onDragStart={onDragStart}
                  afterDrag={afterDrag}
                  order={orderRow(label, e)}
                  dropEdge={orderEdge(label, e)}
                  onPin={onPin}
                  onArchive={onArchive}
                  archived={!!isArchived?.(e)}
                  cursor={onCard(e)}
                />
              ))}
            </div>
          ))}
          {takes('unpin') && (
            <div className="sidebar-drop-hint">Drop here to unpin</div>
          )}
        </div>

        {empty && <div className="sidebar-empty">{showArchived && !query ? 'Nothing archived here.' : 'Nothing matches.'}</div>}
      </nav>

      {/* The band a card is dropped on to put it away. Out of the scrolling list and always on
          screen, because a drop target you have to scroll to is a drop target you cannot reach
          mid-drag. It only says what the archive holds; opening it is the section above. */}
      {!query && (
        <div {...zone('archive', 'sidebar-archive-drop')}>
          <span className="sidebar-archive-hint">
            {archivedCount === 0
              ? 'Drop a card here to archive it'
              : `${archivedCount} archived · drop a card here`}
          </span>
        </div>
      )}

      {trashed.length > 0 && !query && (
        <button type="button" className="sidebar-trash" data-trash-link onClick={() => setTrashOpen(true)}>
          Trash ({trashed.length})
        </button>
      )}
      {trashOpen && <TrashList entries={trashed} onClose={() => setTrashOpen(false)} />}

      <footer className="sidebar-foot">
        <span className={`sync-dot${offline ? ' offline' : ''}`} />
        <span>
          {cardCount} entities ·{' '}
          {offline
            ? 'offline'
            : lastSync
              ? `synced ${lastSync.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
              : 'syncing…'}
        </span>
      </footer>
    </aside>
  )
}
