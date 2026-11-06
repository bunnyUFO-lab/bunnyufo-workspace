import { useState } from 'react'
import type { WorkspaceCard } from '../types'
import { entityHash } from '../lib/route'
import { cardKey } from '../lib/order'
import { useCanWrite } from '../lib/writes'
import type { MenuItem } from '../components/ItemMenu'
import { useCardMenu } from '../components/CardMenu'
import { useCategoryMenu } from '../components/CategoryMenu'
import RowMenu from '../ui/RowMenu'
import IconDialog, { CardIcon } from './IconDialog'
import { setArchived, setIcon, setPinned } from './cardActions'
import { isArchived } from './libraryModel'

/** Where a pinned row can go: one place up or down the pinned list, or nowhere (the end of it, or nothing to write with). */
export interface PinMove { up: (() => void) | null; down: (() => void) | null }

/**
 * One card: its icon, title, section and date, a dot for its status, and the menu. The row is a link; the menu is a button beside it,
 * so neither sits inside the other. The menu holds Pin, Archive or Restore, Change icon and, for a pinned card, Move up and Move down,
 * then what `useCardMenu` gives (Rename, Category, Move to workspace, Delete). A visitor who may write nothing gets no menu at all.
 */
export default function LibraryRow({ card, active, pinMove }: { card: WorkspaceCard; active: boolean; pinMove?: PinMove }) {
  const { items, dialogs } = useCardMenu(card)
  const canWrite = useCanWrite()
  const [picking, setPicking] = useState(false)
  const archived = isArchived(card)
  const mine: MenuItem[] = canWrite ? [
    { label: card.pinned ? 'Unpin' : 'Pin', onSelect: () => void setPinned(card, !card.pinned) },
    { label: archived ? 'Restore' : 'Archive', onSelect: () => void setArchived(card, !archived) },
    { label: 'Change icon…', onSelect: () => setPicking(true) },
    ...(card.pinned && pinMove ? [
      { label: 'Move up', onSelect: () => pinMove.up?.(), disabled: !pinMove.up },
      { label: 'Move down', onSelect: () => pinMove.down?.(), disabled: !pinMove.down },
    ] : []),
  ] : []
  const all = [...mine, ...(items ?? [])]
  return (
    <div className={`lib-row${active ? ' on' : ''}${card.pinned ? ' pinned' : ''}`} role="listitem" data-entity={card.id} data-project={card.workspace.id} data-key={cardKey(card)}>
      <a className="lib-row-main" href={entityHash(card.id)} aria-current={active ? 'page' : undefined} title={`${card.title} — ${card.workspace.name}`}>
        <span className="lib-row-icon" aria-hidden="true"><CardIcon card={card} /></span>
        <span className="lib-row-body">
          <b>{card.title}</b>
          <small>{card.workspace.name} · {card.updated ?? card.created}{card.pinned ? ' · pinned' : ''}</small>
        </span>
        <span className={`status-dot ${card.status}`} title={card.status} />
      </a>
      <RowMenu label={`More for ${card.title}`} title={card.title} items={all.length ? all : null} />
      {dialogs}
      {picking && <IconDialog card={card} onClose={() => setPicking(false)} onPick={emoji => { setPicking(false); if (emoji !== (card.emoji ?? '')) void setIcon(card, emoji) }} />}
    </div>
  )
}

/** A category's heading in the one-section view, with its menu: Rename and Merge. */
export function CategoryHead({ label, workspace }: { label: string; workspace: string | null }) {
  const { items, dialogs } = useCategoryMenu(workspace, label)
  return (
    <div className="lib-head" data-section={label}>
      <h2>{label.replace(/-/g, ' ')}</h2>
      <RowMenu label={`More for the ${label.replace(/-/g, ' ')} category`} title={label.replace(/-/g, ' ')} items={items} />
      {dialogs}
    </div>
  )
}
