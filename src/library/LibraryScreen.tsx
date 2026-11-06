import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import type { CardWorkspace, WorkspaceCard } from '../types'
import { go, useEntryMemo } from '../lib/entries'
import { entityHash, hubHash } from '../lib/route'
import { cardKey, useOrder } from '../lib/order'
import { host } from '../lib/host'
import { canManage } from '../lib/library'
import { trashOf } from '../lib/trash'
import { ARCHIVE_DAYS } from '../lib/workspace'
import { useCanWrite } from '../lib/writes'
import TopBar from '../ui/TopBar'
import Icon from '../ui/Icon'
import { Button, IconButton, Segment } from '../ui/Controls'
import { Section } from '../ui/Layout'
import NewCard from '../components/NewCard'
import WorkspaceSwitcher from '../components/WorkspaceSwitcher'
import { TrashRows } from '../components/TrashList'
import LibraryRow, { CategoryHead, type PinMove } from './LibraryRow'
import { movePin } from './cardActions'
import ProjectFilter from './ProjectFilter'
import { PAGE, arrangeApplies, libraryList, pageOf, projectOrder, sortPins, type Arrange, type LibraryView } from './libraryModel'
import './library.css'

export interface LibraryProps {
  /** In the order the project filter lists them. */
  workspaces: CardWorkspace[]
  cards: WorkspaceCard[]
  /** The projects picked, or none for all. Kept by the app: one pick is the first path segment on a site; several are kept on this device. */
  projects: string[]
  onProjects: (ids: string[]) => void
  /** Recent (one newest-first run) or By project (a heading per project), kept on this device by the app. */
  arrange: Arrange
  onArrange: (next: Arrange) => void
  /** The open card, so its row is lit. */
  active: WorkspaceCard | null
  offline: boolean
  lastSync: Date | null
  /** Said above the list: the link that brought you here was a card that is now in the Trash. */
  notice?: ReactNode
  /** The search field, so Ctrl+Shift+F can reach it. */
  searchRef: RefObject<HTMLInputElement | null>
  /** Folds the list away beside an open card. Left out where the list is the screen. */
  onCollapse?: () => void
}

/**
 * The Library: every card, as rows. A top bar, a search field, one line with the project filter and the Recent | By project toggle,
 * the views All, Pinned, Archive and Trash, then the rows. The view, the search text, how many rows are shown and the scroll are kept against the history entry, so Back
 * from a card finds the list as it was; none of them adds an entry. Cards live here and nowhere else.
 */
export default function LibraryScreen({ workspaces, cards, projects, onProjects, arrange, onArrange, active, offline, lastSync, notice, searchRef, onCollapse }: LibraryProps) {
  const { order } = useOrder()
  const canWrite = useCanWrite()
  const [view, setView] = useEntryMemo<LibraryView>('lib.view', 'all')
  const [query, setQuery] = useEntryMemo('lib.query', '')
  const [limit, setLimit] = useEntryMemo('lib.limit', PAGE)
  const [scroll, setScroll] = useEntryMemo('lib.scroll', 0)
  const [newCard, setNewCard] = useState(false)
  const box = useRef<HTMLDivElement>(null)

  // A project that is gone from the registry is dropped by the app, so a pick can never filter every card away with nothing to undo it.
  // With one project there is nothing to pick: it is the one in view, and By project shows its categories.
  const only = workspaces.length === 1 ? [workspaces[0].id] : projects
  const shownProjects = only
  // The filter's list and By project's headings: projects with cards under this search and view first.
  const first = libraryList(cards, order, { query, projects: [], view })
  const rank = projectOrder(workspaces, first.counts)
  const list = libraryList(cards, order, { query, projects: shownProjects, view, arrange, projectOrder: rank })
  const inScope = shownProjects.length ? workspaces.filter(w => shownProjects.includes(w.id)) : workspaces
  const trashCounts = new Map(workspaces.map(w => [w.id, trashOf([w]).length]))
  const trash = trashOf(inScope).filter(t => !query.trim() || [t.entity.title, t.entity.description, t.entity.category, t.id, t.workspace.name].some(s => s && s.toLowerCase().includes(query.trim().toLowerCase())))
  const trashCount = trashOf(inScope).length
  // A purge that stopped partway leaves a pending tombstone and maybe no card in the Trash: opening the Trash retries it.
  const purgePending = host.purge && inScope.some(w => canManage(w) && Object.values(w.retired ?? {}).some(r => r.kind === 'purged' && r.pending))

  // Scroll: remembered once it settles (not on every frame), put back before the first paint.
  useLayoutEffect(() => { if (box.current) box.current.scrollTop = scroll }, [])  // eslint-disable-line react-hooks/exhaustive-deps
  const settle = useRef<number | undefined>(undefined)
  const onScroll = useCallback(() => {
    window.clearTimeout(settle.current)
    settle.current = window.setTimeout(() => setScroll(box.current?.scrollTop ?? 0), 120)
  }, [setScroll])
  useEffect(() => () => window.clearTimeout(settle.current), [])
  // The last position is written when the list goes away, so a quick tap on a card does not lose it.
  useLayoutEffect(() => { const el = box.current; return () => { if (el) setScroll(el.scrollTop) } }, [setScroll])

  const pins = sortPins(cards)
  const pinMove = (card: WorkspaceCard, shown: WorkspaceCard[]): PinMove | undefined => {
    if (!canWrite) return undefined
    const at = shown.findIndex(e => cardKey(e) === cardKey(card))
    const step = (delta: -1 | 1) => {
      const target = shown[at + delta]
      if (!target) return null
      return () => void movePin(card, pins, pins.findIndex(e => cardKey(e) === cardKey(target)))
    }
    return { up: step(-1), down: step(1) }
  }

  const shownGroups = pageOf(list.groups, limit)
  const rest = list.shown - shownGroups.reduce((n, g) => n + g.cards.length, 0)
  // Move up and Move down step through the pins on screen: the Pinned group, or the Pinned view; a search shows them all.
  const shownPins = view === 'pinned' ? list.groups[0]?.cards ?? [] : list.groups.find(g => g.label === 'Pinned')?.cards ?? pins
  const row = (card: WorkspaceCard) => (
    <LibraryRow key={cardKey(card)} card={card} active={!!active && cardKey(card) === cardKey(active)} pinMove={card.pinned ? pinMove(card, shownPins) : undefined} />
  )
  const searching = query.trim().length > 0

  return (
    <div className="lib" data-library>
      <TopBar title="Library" actions={<>
        {host.cards && !newCard && <IconButton icon="plus" label="New card" data-new-card="" onClick={() => setNewCard(true)} />}
        <WorkspaceSwitcher variant="sheet" />
        {!host.hub && <IconButton icon="search" label="Search" data-nav="search" onClick={() => go(hubHash('search'))} />}
        {!host.hub && <IconButton icon="settings" label="Settings" data-nav="settings" onClick={() => go(hubHash('settings'))} />}
        {onCollapse && <IconButton icon="back" label="Hide menu" title="Hide the list ( [ )" data-hide-list="" onClick={onCollapse} />}
      </>} />
      {host.cards && newCard && <div className="lib-new"><NewCard workspaces={workspaces} project={projects.length === 1 ? projects[0] : ''} open onOpen={setNewCard} /></div>}
      {notice}

      <label className="lib-search">
        <Icon name="search" size={18} />
        <input
          ref={searchRef}
          type="search"
          value={query}
          onChange={event => { setQuery(event.target.value); setLimit(PAGE) }}
          onKeyDown={event => {
            if (event.key === 'Enter') {
              const first = list.groups[0]?.cards[0]
              if (first && view !== 'trash') { event.preventDefault(); go(entityHash(first.id)) }
            } else if (event.key === 'Escape') { setQuery(''); event.currentTarget.blur() }
          }}
          placeholder="Search cards"
          aria-label="Search cards"
          autoComplete="off"
        />
      </label>

      {(workspaces.length >= 2 || arrangeApplies(view, query)) && (
        <div className="lib-bar">
          {workspaces.length >= 2 && (
            <ProjectFilter
              workspaces={workspaces}
              picks={projects}
              counts={view === 'trash' ? trashCounts : list.counts}
              total={view === 'trash' ? trashOf(workspaces).length : list.total}
              onChange={ids => { onProjects(ids); setLimit(PAGE) }}
            />
          )}
          {arrangeApplies(view, query) && (
            <Segment<Arrange>
              label="Arrange" className="lib-arrange" value={arrange} onChange={next => { onArrange(next); setLimit(PAGE) }}
              options={[{ id: 'recent', label: 'Recent' }, { id: 'project', label: 'By project' }]}
            />
          )}
        </div>
      )}
      <Segment<LibraryView>
        label="View"
        value={view}
        onChange={next => { setView(next); setLimit(PAGE) }}
        options={[{ id: 'all', label: 'All' }, { id: 'pinned', label: 'Pinned' }, { id: 'archive', label: 'Archive', count: list.archivedCount }, { id: 'trash', label: 'Trash', count: trashCount }]}
      />

      <div className="lib-scroll" ref={box} onScroll={onScroll} data-scroll="lib">
        {view === 'archive' && <p className="lib-note" data-archive-note>Cards untouched for {ARCHIVE_DAYS} days are archived automatically. Pin a card to keep it live.</p>}
        {searching && view !== 'trash' && (
          <p className="lib-note" data-matches>
            {list.shown === 0 ? 'No matches for' : `${list.shown} match${list.shown === 1 ? '' : 'es'} for`} “{query.trim()}”{view === 'archive' && ' in the archive'}{' '}
            <button type="button" className="lib-clear" onClick={() => setQuery('')}>Clear</button>
          </p>
        )}

        {view === 'trash' ? (
          <>
            {trash.length === 0 && <p className="lib-empty">{purgePending ? 'Some cards are still being deleted for good. Opening the Trash tries again.' : 'No cards here'}</p>}
            <TrashRows entries={trash} className="lib-trash lib-trash-rows" />
          </>
        ) : list.shown === 0 ? (
          <p className="lib-empty">{offline ? 'Could not load workspace.json. Is the public/workspace link in place?' : 'No cards here'}{searching ? ` for “${query.trim()}”` : ''}</p>
        ) : (
          shownGroups.map((group, index) => (
            <Section key={group.label ?? `run${index}`}>
              {group.label && (group.category
                ? <CategoryHead label={group.label} workspace={group.cards[0]?.workspace.id ?? null} />
                : <div className={`lib-head${group.project ? ' project' : ''}`} data-section={group.label} {...(group.project ? { 'data-project-head': group.project } : {})}><h2>{group.label}</h2></div>)}
              <div className="lib-rows" role="list" aria-label={group.label ?? 'Cards'}>{group.cards.map(row)}</div>
            </Section>
          ))
        )}
        {view !== 'trash' && rest > 0 && <Button wide tone="ghost" data-show-more="" onClick={() => setLimit(limit + PAGE)}>Show more ({rest})</Button>}

        <p className="lib-foot" data-lib-foot>
          <span className={`sync-dot${offline ? ' offline' : ''}`} />
          {cards.length} cards · {offline ? 'offline' : lastSync ? `synced ${lastSync.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'syncing…'}
        </p>
      </div>
    </div>
  )
}
