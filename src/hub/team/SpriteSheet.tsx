import { useEffect, useRef, useState } from 'react'
import type { AvatarSprite, CustomSprite, SheetInfo, TeamAgent } from '../../lib/hubTeam'
import { ago, hubGet } from '../../lib/hub'
import { host } from '../../lib/host'
import { cachedPresets, loadPresets } from '../spawnData'
import { openSpawn } from '../spawnStore'
import { AgentSprite } from './AgentSprite'
import { nextSalt, quickTiles, randomOf, sameSprite, sheetNote, spriteKey, startSalt, tileId, tileLabel, type AnySprite } from './teamModel'

type Mode = 'quick' | 'custom'

/** The sheet's own sprite, for a preview or a Use this. */
const spriteOfSheet = (info: SheetInfo): CustomSprite => ({ kind: 'custom', sheet: info.sheet, url: info.url, frame: { w: 192, h: 208 }, cols: 8, rows: info.rows })

/**
 * The Custom segment: the agent's pet sheets, newest first, each a live preview of its idle row and
 * a Use this (same `onUse`, so the same toast and Undo as Quick). The server marks the current one.
 */
function CustomTab({ agent, onUse, onDone }: { agent: TeamAgent; onUse: (sprite: AnySprite) => Promise<boolean>; onDone: () => void }) {
  return (
    <>
      <MakeNew agent={agent} onDone={onDone} />
      <CustomSheets agent={agent} onUse={onUse} onDone={onDone} />
    </>
  )
}

/** Make a new one: Spawn, prefilled with the Agent avatar preset. Hidden when signed out or when the server has no such preset. */
function MakeNew({ agent, onDone }: { agent: TeamAgent; onDone: () => void }) {
  const [known, setKnown] = useState(() => cachedPresets()?.presets.some(item => item.id === 'agent-avatar') ?? false)
  useEffect(() => {
    if (!host.write) return undefined
    const abort = new AbortController()
    loadPresets(abort.signal).then(list => setKnown(list.presets.some(item => item.id === 'agent-avatar')), () => { /* no button */ })
    return () => abort.abort()
  }, [])
  if (!host.write || !known) return null
  const make = () => {
    onDone()
    openSpawn({ preset: 'agent-avatar', project: 'sprite-studio', agent: agent.id, text: `Pixel sprite for ${agent.name}: ${agent.role}` })
  }
  return (
    <div className="sheet-make">
      <button type="button" className="hub-btn pri" onClick={make} data-sheet-make={agent.id}>Make a new one</button>
      <small className="team-dim">Four pixel-art variants on the Gaming PC. You pick one, then check the finished sheet.</small>
    </div>
  )
}

function CustomSheets({ agent, onUse, onDone }: { agent: TeamAgent; onUse: (sprite: AnySprite) => Promise<boolean>; onDone: () => void }) {
  const [sheets, setSheets] = useState<SheetInfo[] | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  useEffect(() => {
    const abort = new AbortController()
    hubGet<{ sheets: SheetInfo[] }>(`/team/${encodeURIComponent(agent.id)}/sheets`, abort.signal)
      .then(answer => setSheets(Array.isArray(answer.sheets) ? answer.sheets : []))
      .catch(failure => { if (!abort.signal.aborted) setProblem(failure instanceof Error ? failure.message : 'The sheets did not load.') })
    return () => abort.abort()
  }, [agent.id, agent.sprite])
  if (problem) return <p className="hub-error" role="alert" data-sheet-custom>{problem}</p>
  if (!sheets) return <p className="sheet-custom" data-sheet-custom aria-busy="true">Loading…</p>
  if (!sheets.length) return <p className="sheet-custom" data-sheet-custom data-agent={agent.id}>No custom sheets yet.</p>
  const use = async (info: SheetInfo) => {
    setBusy(info.sheet)
    const done = await onUse(spriteOfSheet(info))
    setBusy(null)
    if (done) onDone()
  }
  return (
    <ul className="sheet-list" data-sheet-custom data-agent={agent.id} aria-label={`${agent.name} sprite sheets`}>
      {sheets.map(info => (
        <li key={info.sheet} className={`sheet-item${info.current ? ' on' : ''}`} data-sheet-item={info.sheet}>
          <span className="team-tile"><AgentSprite sprite={spriteOfSheet(info)} size={52} name={agent.name} state="idle" /></span>
          <span className="sheet-item-text"><b>{info.current ? 'Current sheet' : 'Sheet'}</b><small>{ago(info.at)}</small></span>
          <button type="button" className="hub-btn pri" disabled={info.current || busy !== null} onClick={() => { void use(info) }} data-sheet-use-custom={info.sheet}>{info.current ? 'In use' : 'Use this'}</button>
        </li>
      ))}
    </ul>
  )
}

/**
 * Pick a sprite for one agent. A dialog on desktop and a bottom sheet on a phone (the stylesheet
 * decides). The native dialog gives the focus trap and Escape; Team puts the focus back on the
 * button that opened it.
 */
export default function SpriteSheet({ agent, onClose, onUse }: { agent: TeamAgent; onClose: () => void; onUse: (sprite: AnySprite) => Promise<boolean> }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [mode, setMode] = useState<Mode>('quick')
  const [selected, setSelected] = useState<AnySprite>(agent.sprite)
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
                const label = tileLabel(sprite)
                return (
                  <button
                    key={spriteKey(sprite)}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    aria-label={index === 0 ? `${label}, current` : label}
                    className={`sheet-tile${on ? ' on' : ''}`}
                    data-sprite-tile={tileId(sprite)}
                    onClick={() => setSelected(sprite)}
                  >
                    <AgentSprite sprite={sprite} size={40} />
                  </button>
                )
              })}
            </div>
            <p className="team-dim sheet-hint">Instant, no job. Randomize draws one from the name {agent.name}: body, palette and accessory.</p>
          </>
        ) : <CustomTab agent={agent} onUse={onUse} onDone={() => dialog.current?.close()} />}
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
