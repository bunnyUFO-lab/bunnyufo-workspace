import { useEffect, useRef, useState } from 'react'
import type { AvatarSprite, TeamAgent } from '../../lib/hubTeam'
import { AgentSprite } from './AgentSprite'
import { builtinLabel, nextSalt, quickTiles, randomOf, sameSprite, sheetNote, spriteKey, startSalt } from './teamModel'

type Mode = 'quick' | 'custom'

/**
 * The Custom segment. M2 shows one line; the Agent avatar preset replaces this body with the agent's
 * sprite sheets and a "Use this" for each (same `onUse`, so the same toast and Undo).
 */
function CustomTab({ agent }: { agent: TeamAgent; onUse: (sprite: AvatarSprite) => Promise<boolean> }) {
  return <p className="sheet-custom" data-sheet-custom data-agent={agent.id}>Custom sprites arrive with the Agent avatar preset.</p>
}

/**
 * Pick a sprite for one agent. A dialog on desktop and a bottom sheet on a phone (the stylesheet
 * decides). The native dialog gives the focus trap and Escape; Team puts the focus back on the
 * button that opened it.
 */
export default function SpriteSheet({ agent, onClose, onUse }: { agent: TeamAgent; onClose: () => void; onUse: (sprite: AvatarSprite) => Promise<boolean> }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [mode, setMode] = useState<Mode>('quick')
  const [selected, setSelected] = useState<AvatarSprite>(agent.sprite)
  const [randomized, setRandomized] = useState<AvatarSprite | null>(null)
  const [salt, setSalt] = useState(() => startSalt(agent.sprite))
  const [busy, setBusy] = useState(false)
  const current = agent.sprite

  useEffect(() => {
    const node = dialog.current
    if (!node) return
    if (!node.open) node.showModal()
    node.querySelector<HTMLElement>('[aria-checked="true"]')?.focus()
  }, [])

  const randomize = () => {
    const next = nextSalt(salt)
    const sprite = randomOf(agent.name, next)
    setSalt(next)
    setRandomized(sprite)
    setSelected(sprite)
  }
  const use = async () => {
    setBusy(true)
    const done = await onUse(selected)
    setBusy(false)
    if (done) dialog.current?.close()
  }
  const tiles = quickTiles(current, randomized)
  return (
    <dialog
      ref={dialog}
      className="sprite-sheet"
      aria-labelledby="sprite-sheet-title"
      onClose={onClose}
      onClick={event => { if (event.target === dialog.current) dialog.current?.close() }}
      data-sprite-sheet={agent.id}
    >
      <div className="sheet-head">
        <h2 id="sprite-sheet-title">Sprite for {agent.name}</h2>
        <button type="button" className="hub-btn sheet-x" aria-label="Close" onClick={() => dialog.current?.close()}>×</button>
      </div>
      <div className="sheet-body">
        <div className="sheet-preview">
          <span className="team-tile big" data-sheet-preview><AgentSprite sprite={mode === 'quick' ? selected : current} size={56} title={`${agent.name} preview`} /></span>
          <div>
            <b>{agent.name}</b>
            <div className="team-dim" data-sheet-note aria-live="polite">{mode === 'quick' ? sheetNote(agent.name, current, selected) : 'Current sprite'}</div>
          </div>
        </div>
        <div className="hub-seg sheet-seg" role="group" aria-label="Where the sprite comes from">
          <button type="button" className={mode === 'quick' ? 'on' : ''} aria-pressed={mode === 'quick'} onClick={() => setMode('quick')} data-sheet-mode="quick">Quick default</button>
          <button type="button" className={mode === 'custom' ? 'on' : ''} aria-pressed={mode === 'custom'} onClick={() => setMode('custom')} data-sheet-mode="custom">Custom in Sprite Studio</button>
        </div>
        {mode === 'quick' ? (
          <>
            <div className="sheet-grid" role="radiogroup" aria-label="Built-in sprites">
              {tiles.map((sprite, index) => {
                const on = sameSprite(sprite, selected)
                const label = sprite.kind === 'builtin' ? builtinLabel(sprite.key) : 'Randomized sprite'
                return (
                  <button
                    key={spriteKey(sprite)}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    aria-label={index === 0 ? `${label}, current` : label}
                    className={`sheet-tile${on ? ' on' : ''}`}
                    data-sprite-tile={sprite.kind === 'builtin' ? sprite.key : `random-${sprite.salt}`}
                    onClick={() => setSelected(sprite)}
                  >
                    <AgentSprite sprite={sprite} size={40} />
                  </button>
                )
              })}
            </div>
            <p className="team-dim sheet-hint">Instant, no job. Randomize draws one from the name {agent.name}: body, palette and accessory.</p>
          </>
        ) : <CustomTab agent={agent} onUse={onUse} />}
      </div>
      {mode === 'quick' && (
        <div className="sheet-foot">
          <button type="button" className="hub-btn" onClick={randomize} data-sheet-randomize>Randomize</button>
          <span className="sheet-spacer" />
          <button type="button" className="hub-btn pri" onClick={use} disabled={busy || sameSprite(selected, current)} data-sheet-use>Use this</button>
        </div>
      )}
    </dialog>
  )
}
