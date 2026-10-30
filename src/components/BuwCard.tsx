import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import type { WorkspaceCard } from '../types'
import { entityHash } from '../lib/route'
import { ICON_PRESETS, categoryIcon } from '../lib/categories'
import { cardUrl } from '../local/client'
import ItemMenu from './ItemMenu'
import { useCardMenu } from './CardMenu'

/**
 * The icon picker: the presets, a box for any other emoji, and a way back to the card's own
 * icon. It closes on a pick, on Esc and on a click anywhere else.
 */
function IconPicker({ current, own, onPick, onClose }: { current?: string; own: ReactNode; onPick: (emoji: string) => void; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null)
  const [typed, setTyped] = useState('')
  useEffect(() => {
    const outside = (event: PointerEvent) => { if (!box.current?.contains(event.target as Node)) onClose() }
    // Capture, so Esc closes the picker before App reads it as "back to the cards".
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopImmediatePropagation(); onClose() } }
    document.addEventListener('pointerdown', outside)
    window.addEventListener('keydown', key, true)
    return () => { document.removeEventListener('pointerdown', outside); window.removeEventListener('keydown', key, true) }
  }, [onClose])
  useEffect(() => { box.current?.querySelector<HTMLButtonElement>('button')?.focus() }, [])
  return (
    <div
      ref={box}
      className="icon-picker"
      role="dialog"
      aria-label="Choose an icon"
      // The card underneath starts a drag on pointerdown; a pick is not a drag.
      onPointerDown={event => event.stopPropagation()}
    >
      <div className="icon-picker-grid">
        {ICON_PRESETS.map(emoji => (
          <button
            key={emoji}
            type="button"
            className={emoji === current ? 'on' : undefined}
            aria-pressed={emoji === current}
            onClick={() => onPick(emoji)}
          >
            {emoji}
          </button>
        ))}
      </div>
      <form
        className="icon-picker-own"
        onSubmit={event => { event.preventDefault(); if (typed.trim()) onPick(typed.trim()) }}
      >
        <input
          value={typed}
          onChange={event => setTyped(event.target.value)}
          placeholder="Any emoji (Win + .)"
          aria-label="Any emoji"
          maxLength={12}
        />
        <button type="submit" disabled={!typed.trim()}>Use</button>
      </form>
      {current && <button type="button" className="icon-picker-reset" onClick={() => onPick('')}><span className="icon-picker-reset-icon" aria-hidden="true">{own}</span>Back to the card’s own icon</button>}
    </div>
  )
}

interface BuwCardProps {
  entity: WorkspaceCard
  /** Archived as the home grid counts it: an explicit status, or the date rule. */
  archived?: boolean
  /** Show which project this card belongs to — only worth it when the grid mixes projects. */
  showProject?: boolean
  /** Filter the grid to this card's project. */
  onProject?: (id: string) => void
  /** Local app only — writes the new status into that card's workspace.json. Omitted on a site, which is read-only. */
  onArchive?: (card: WorkspaceCard, archived: boolean) => void
  /** Local app only — pins or unpins the card. The button is the keyboard's way in; the sidebar also takes a drop. */
  onPin?: (card: WorkspaceCard, pinned: boolean) => void
  /** Where something can write card state — sets the card's icon ('' goes back to its own). */
  onIcon?: (card: WorkspaceCard, emoji: string) => void
  /** Local app only — start dragging this card (to the sidebar's pinned list or archive). */
  onDragStart?: (card: WorkspaceCard, event: ReactPointerEvent) => void
  /** True when the click that follows a drag should not open the card. */
  afterDrag?: () => boolean
  /** Another card of this section is in the air: this one is a place to drop it, with the line on `edge`. */
  order?: { section: string; edge: 'before' | 'after' | null }
  busy?: boolean
}

/**
 * The design-system card: glass surface over the aura, gradient edge
 * (pink→purple; amber when pinned), glow + lift on hover. Building
 * block of the home grid; mirrored as `.buw-card` in
 * scripts/shared/report_style.py for generated reports.
 *
 * The title carries the link and `.card-link::after` stretches it over the whole
 * surface, so the archive button can sit above it: a button inside an `<a>` would
 * be invalid markup and would swallow the click.
 */
/** "Magic Loops" and "magic-loops" are the same word twice. */
const sameWord = (a: string, b: string) =>
  a.toLowerCase().replace(/[^a-z0-9]/g, '') === b.toLowerCase().replace(/[^a-z0-9]/g, '')

export default function BuwCard({ entity, archived = false, showProject = false, onProject, onArchive, onPin, onIcon, onDragStart, afterDrag, order, busy = false }: BuwCardProps) {
  const steps = entity.steps.length
  const { items: menu, dialogs } = useCardMenu(entity)
  const [picking, setPicking] = useState(false)
  const iconButton = useRef<HTMLButtonElement>(null)
  const closePicker = () => { setPicking(false); iconButton.current?.focus() }
  // A card whose category just repeats its project needs one chip, not two. The project is
  // the one to keep: it is the clickable filter, and the category adds nothing here.
  const category = entity.category || 'other'
  const showCategory = !(showProject && sameWord(category, entity.workspace.name))
  return (
    <div
      className={`buw-card entity-card${entity.pinned ? ' pinned' : ''}${picking ? ' picking' : ''}${order?.edge ? ` drop-${order.edge}` : ''}`}
      data-entity={entity.id}
      data-project={entity.workspace.id}
      data-drop={order ? 'order' : undefined}
      data-drop-key={order ? `${entity.workspace.id}/${entity.id}` : undefined}
      data-drop-section={order?.section}
      data-drop-axis={order ? 'x' : undefined}
      onPointerDown={event => onDragStart?.(entity, event)}
    >
      <div className="card-top">
        {showProject && (
          <button
            type="button"
            className="chip chip-project"
            onClick={() => onProject?.(entity.workspace.id)}
            title={`Show only ${entity.workspace.name}`}
          >
            <span aria-hidden="true">{'\u{1F3AE}'}</span>
            {entity.workspace.name}
          </button>
        )}
        {showCategory && (
          <span className="chip">
            <span aria-hidden="true">{categoryIcon(entity.category)}</span>
            {category}
          </span>
        )}
        {entity.pinned && !onPin && <span className="chip chip-pin">pinned</span>}
        {/* With the archive open the grid mixes put-away cards in with the rest; say which is which. */}
        {archived && <span className="chip chip-archived">archived</span>}
        <span className={`status-dot ${entity.status}`} title={entity.status} />
        {onPin && (
          <button
            type="button"
            className={`card-action card-pin${entity.pinned ? ' on' : ''}`}
            disabled={busy}
            aria-pressed={!!entity.pinned}
            title={
              entity.pinned
                ? `Take ${entity.title} off the pinned list`
                : `Pin ${entity.title} to the sidebar — or drag it there`
            }
            onClick={() => onPin(entity, !entity.pinned)}
          >
            <span aria-hidden="true">{'\u{1F4CC}'}</span>
            {entity.pinned ? 'pinned' : 'pin'}
          </button>
        )}
        {onArchive && (
          <button
            type="button"
            className="card-action card-archive"
            disabled={busy}
            title={
              archived
                ? `Bring ${entity.title} back to the active list`
                : `Put ${entity.title} in the archive`
            }
            onClick={() => onArchive(entity, !archived)}
          >
            {archived ? 'restore' : 'archive'}
          </button>
        )}
        <ItemMenu label={`More for ${entity.title}`} items={menu} className="card-more" />
        {dialogs}
      </div>

      <div className="card-project-title">
        {/* The icon is the picker's button where card state can be written; elsewhere it is
            just shown. A card with no icon of its own offers a faint slot to give it one. */}
        {onIcon ? (
          <button
            ref={iconButton}
            type="button"
            className={`card-icon-button${entity.emoji || entity.icon ? '' : ' empty'}`}
            disabled={busy}
            aria-expanded={picking}
            title={`Change the icon of ${entity.title}`}
            aria-label={`Change the icon of ${entity.title}`}
            onPointerDown={event => event.stopPropagation()}
            onClick={() => setPicking(v => !v)}
          >
            {entity.emoji
              ? <span className="card-emoji" aria-hidden="true">{entity.emoji}</span>
              : entity.icon
                ? <img className="card-project-icon" src={cardUrl(entity, entity.icon)} width="48" height="48" alt="" loading="lazy" decoding="async" />
                : <span className="card-emoji" aria-hidden="true">{categoryIcon(entity.category)}</span>}
          </button>
        ) : entity.emoji
          ? <span className="card-emoji" aria-hidden="true">{entity.emoji}</span>
          : entity.icon && <img className="card-project-icon" src={cardUrl(entity, entity.icon)} width="48" height="48" alt="" loading="lazy" decoding="async" />}
        {picking && onIcon && (
          <IconPicker
            current={entity.emoji}
            own={entity.icon
              ? <img className="card-project-icon" src={cardUrl(entity, entity.icon)} width="18" height="18" alt="" />
              : <span className="card-emoji">{categoryIcon(entity.category)}</span>}
            onClose={closePicker}
            onPick={emoji => { closePicker(); if (emoji !== (entity.emoji ?? '')) onIcon(entity, emoji) }}
          />
        )}
        <h3 className="card-title">
          {/* The browser's own link drag would fight the pointer gesture for the same press,
              and a drag that ends on a drop zone must not also open the card. */}
          <a
            className="card-link"
            href={entityHash(entity.id)}
            draggable={false}
            onClick={event => { if (afterDrag?.()) event.preventDefault() }}
          >
            {entity.title}
          </a>
        </h3>
      </div>

      {entity.description && <p className="card-desc">{entity.description}</p>}

      <div className="card-foot">
        <span>
          {steps} step{steps === 1 ? '' : 's'}
        </span>
        <span>·</span>
        <span>{entity.updated ?? entity.created}</span>
        <span className="card-open" aria-hidden="true">
          open →
        </span>
      </div>
    </div>
  )
}
