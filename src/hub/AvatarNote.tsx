import { useEffect, useState } from 'react'
import type { Ask } from '../lib/hub'
import { hubGet } from '../lib/hub'
import type { CustomSprite, SheetInfo } from '../lib/hubTeam'
import { AgentSprite } from './team/AgentSprite'
import { STATE_LABEL, type SpriteState } from './team/spriteState'
import { avatarOf } from './avatarAsk'
import './avatar.css'

/** The states the preview plays, in the order it cycles. */
const PLAY: SpriteState[] = ['idle', 'working', 'needs-you', 'done', 'failed', 'review']
const CYCLE_MS = 2800

function SheetPreview({ agent, sheet }: { agent: string; sheet: string }) {
  const [info, setInfo] = useState<SheetInfo | null | undefined>(undefined)
  const [index, setIndex] = useState(0)
  const [pinned, setPinned] = useState(false)
  useEffect(() => {
    const abort = new AbortController()
    hubGet<{ sheets: SheetInfo[] }>(`/team/${encodeURIComponent(agent)}/sheets`, abort.signal)
      .then(answer => setInfo((Array.isArray(answer.sheets) ? answer.sheets : []).find(item => item.sheet === sheet) ?? null))
      .catch(() => { if (!abort.signal.aborted) setInfo(null) })
    return () => abort.abort()
  }, [agent, sheet])
  const calm = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  useEffect(() => {
    if (!info || pinned || calm) return undefined
    const timer = window.setInterval(() => setIndex(at => (at + 1) % PLAY.length), CYCLE_MS)
    return () => window.clearInterval(timer)
  }, [info, pinned, calm])
  if (info === undefined) return <p className="hub-muted" data-avatar-sheet="loading" aria-busy="true">Loading the sheet…</p>
  if (!info) return <p className="hub-muted" data-avatar-sheet="missing">This sheet is not ready or failed its check, so it cannot be used.</p>
  const sprite: CustomSprite = { kind: 'custom', sheet: info.sheet, url: info.url, frame: { w: 192, h: 208 }, cols: 8, rows: info.rows }
  const state = PLAY[index]
  return (
    <div className="avatar-sheet" data-avatar-sheet={info.sheet}>
      <span className="avatar-stage"><AgentSprite sprite={sprite} size={104} name={agent} state={state} /></span>
      <div className="avatar-states" role="group" aria-label="Preview a state">
        {PLAY.map((item, at) => (
          <button key={item} type="button" className="hub-btn" aria-pressed={at === index} data-avatar-state={item} onClick={() => { setPinned(true); setIndex(at) }}>{STATE_LABEL[item]}</button>
        ))}
      </div>
      <p className="hub-muted">This is the file that will be used. {calm ? 'Pick a state to see it.' : 'It plays each state in turn.'}</p>
    </div>
  )
}

/** The note an avatar Ask carries: what a pick starts, or the real sheet to check. */
export default function AvatarNote({ ask }: { ask: Ask }) {
  const avatar = avatarOf(ask)
  if (!avatar) return null
  if ('sheet' in avatar) return <section className="avatar-note" data-avatar-note="sheet" aria-label="The sheet to check"><SheetPreview agent={avatar.agent} sheet={avatar.sheet} /></section>
  if (ask.state !== 'open' && ask.state !== 'snoozed') return null
  return <p className="avatar-note" data-avatar-note="pick">Picking one starts the sprite sheet on the Gaming PC within a few minutes.</p>
}
