import { useState } from 'react'
import type { WorkspaceCard } from '../types'
import { ICON_PRESETS, categoryIcon } from '../lib/categories'
import { cardUrl } from '../local/client'
import Dialog from '../components/Dialog'

/** The card's own icon, as a row draws it: its emoji, its picture, or its category's. */
export function CardIcon({ card, size = 24 }: { card: WorkspaceCard; size?: number }) {
  if (card.emoji) return <>{card.emoji}</>
  if (card.icon) return <img src={cardUrl(card, card.icon)} width={size} height={size} alt="" loading="lazy" decoding="async" />
  return <>{categoryIcon(card.category)}</>
}

/** Change a card's icon: the presets, a box for any other emoji, and a way back to the card's own. */
export default function IconDialog({ card, onPick, onClose }: { card: WorkspaceCard; onPick: (emoji: string) => void; onClose: () => void }) {
  const [typed, setTyped] = useState('')
  return (
    <Dialog title={`Icon of “${card.title}”`} onClose={onClose}>
      <div className="lib-icons" role="group" aria-label="Choose an icon">
        {ICON_PRESETS.map(emoji => (
          <button key={emoji} type="button" className={emoji === card.emoji ? 'on' : undefined} aria-pressed={emoji === card.emoji} onClick={() => onPick(emoji)}>{emoji}</button>
        ))}
      </div>
      <form className="lib-form lib-inline" onSubmit={event => { event.preventDefault(); if (typed.trim()) onPick(typed.trim()) }}>
        <input value={typed} onChange={event => setTyped(event.target.value)} placeholder="Any emoji (Win + .)" aria-label="Any emoji" maxLength={12} />
        <button type="submit" disabled={!typed.trim()}>Use</button>
      </form>
      {card.emoji && <button type="button" className="lib-icon-reset" onClick={() => onPick('')}>Back to the card’s own icon</button>}
    </Dialog>
  )
}
