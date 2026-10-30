import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import { ago, hubGet } from '../../lib/hub'
import type { HubEvent } from '../../lib/hub'
import type { CustomSprite, TeamAgent } from '../../lib/hubTeam'
import { AgentSprite } from './AgentSprite'
import { floorRooms, lineAt, mergeEvents, nextSince, tickerLines, TICKER_POLL_MS, TICKER_ROTATE_MS } from './floorModel'
import { rowSpec, sheetSrc, STATE_LABEL, stateOf, type AgentActivity, type SpriteState } from './spriteState'
import './floor.css'

const ART = { w: 48, h: 52 }
const SHEET_ROW_COUNT = 9
const KEEP_EVENTS = 200

/** The desk class (and dot) for a sprite state. */
const DESK_CLASS: Record<SpriteState, string> = {
  working: 'working', 'needs-you': 'waiting', failed: 'failed', done: 'idle', review: 'idle', idle: 'idle', offline: 'offline',
}

const reducedMotion = () => typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches

/**
 * An idle agent with a custom sheet. Three layers of the sheet (run-right, run-left, idle) take turns
 * under one CSS animation, so it walks a few pixels and back, then stands. No script moves it.
 */
function WalkSprite({ sprite, size, label, seed }: { sprite: CustomSprite; size: number; label: string; seed: number }) {
  const src = sheetSrc(sprite.url)
  const h = size
  const w = Math.round((size * ART.w) / ART.h)
  const crisp = size % ART.h === 0
  const layer = (row: 'run-right' | 'run-left' | 'idle', name: string) => {
    const spec = rowSpec(sprite, row)
    const style = {
      width: w, height: h,
      backgroundImage: src ? `url("${src}")` : undefined,
      backgroundSize: `${sprite.cols * w}px ${SHEET_ROW_COUNT * h}px`,
      '--spr-w': `${w}px`, '--spr-y': `${-spec.index * h}px`, '--spr-n': spec.frames, '--spr-dur': `${spec.frames / spec.fps}s`,
    } as CSSProperties
    return (
      <span className={`floor-layer ${name}`} aria-hidden="true">
        <div className={`px-sheet${crisp ? ' crisp' : ''}${spec.frames > 1 ? ' play' : ''}`} style={style} data-row={row} />
      </span>
    )
  }
  // A different start per agent, so the desks do not walk in step.
  const style = { '--walk-delay': `${-((seed * 3.7) % 12)}s`, width: w, height: h } as CSSProperties
  return (
    <span className="floor-walk" style={style} role="img" aria-label={label} data-floor-walk data-state="idle">
      {layer('idle', 'idle')}{layer('run-right', 'right')}{layer('run-left', 'left')}
    </span>
  )
}

function Desk({ agent, now, seed, onOpen }: { agent: TeamAgent; now: number; seed: number; onOpen: (id: string) => void }) {
  const live = agent as TeamAgent & AgentActivity
  const state = stateOf({ status: agent.status, doneAt: live.doneAt, review: live.review, now })
  const sprite = agent.sprite
  const label = `${agent.name}, ${STATE_LABEL[state]}`
  const task = agent.task || STATE_LABEL[state]
  const kind = DESK_CLASS[state]
  return (
    <li className="floor-desk-item">
      <button
        type="button"
        className={`floor-desk st-${kind}`}
        data-desk={agent.id} data-status={agent.status} data-state={state}
        aria-label={`${label}. ${task}. Open the card.`}
        onClick={() => onOpen(agent.id)}
      >
        <span className="floor-bub" aria-hidden="true" data-desk-bubble><b>{agent.name}</b>{task}</span>
        {state === 'needs-you' && <span className="floor-excl" aria-hidden="true" data-desk-excl>!</span>}
        <span className={`floor-spr${sprite.kind !== 'custom' && state === 'idle' ? ' bob' : ''}`}>
          {sprite.kind === 'custom' && state === 'idle'
            ? <WalkSprite sprite={sprite} size={52} label={label} seed={seed} />
            : <AgentSprite sprite={sprite} size={sprite.kind === 'custom' ? 52 : 48} name={agent.name} state={state} />}
        </span>
        <span className="floor-mon" aria-hidden="true" />
        <span className="floor-tbl" aria-hidden="true" />
        <span className="floor-plate"><span className={`dot st-${kind}`} aria-hidden="true" /><span className="floor-name">{agent.name}</span></span>
        {/* A touch screen has no hover and a tap opens the card, so there the task shows under the name (see floor.css). */}
        <span className="floor-task" aria-hidden="true" data-desk-task>{task}</span>
      </button>
    </li>
  )
}

/**
 * The newest events as a rotating line. It polls `/hub/events?since=` once a minute while it is mounted
 * and the tab is visible, and rotates one line every four seconds; under reduced motion the newest line
 * updates in place.
 */
function Ticker({ agents }: { agents: TeamAgent[] }) {
  const [events, setEvents] = useState<HubEvent[]>([])
  const [step, setStep] = useState(0)
  const [reduced] = useState(reducedMotion)

  useEffect(() => {
    const controller = new AbortController()
    let held: HubEvent[] = []
    const run = () => {
      if (document.visibilityState !== 'visible') return
      const since = nextSince(held)
      hubGet<{ events: HubEvent[] }>(`/events${since ? `?since=${encodeURIComponent(since)}` : ''}`, controller.signal).then(
        body => { held = mergeEvents(held, body.events ?? []).slice(-KEEP_EVENTS); setEvents(held) },
        () => { /* the ticker is a nicety: a miss is tried again at the next poll */ },
      )
    }
    run()
    const poll = window.setInterval(run, TICKER_POLL_MS)
    document.addEventListener('visibilitychange', run)
    return () => { controller.abort(); window.clearInterval(poll); document.removeEventListener('visibilitychange', run) }
  }, [])

  useEffect(() => {
    if (reduced) return undefined
    const turn = window.setInterval(() => { if (document.visibilityState === 'visible') setStep(value => value + 1) }, TICKER_ROTATE_MS)
    return () => window.clearInterval(turn)
  }, [reduced])

  const lines = useMemo(() => tickerLines(events, agents), [events, agents])
  const line = lineAt(lines, step, reduced)
  const agent = line ? agents.find(item => item.id === line.agent) : null
  return (
    <div className="floor-ticker" data-floor-ticker aria-live="off">
      {line
        ? (
          // An event whose agent is not on the team (the hooks' events name none, and Claude Code may not be on it) still shows, without a sprite or a name.
          <span className="floor-tick" key={reduced ? 'still' : line.key} data-ticker-agent={agent?.id ?? ''}>
            {agent && <span className="floor-tick-sprite"><AgentSprite sprite={agent.sprite} size={agent.sprite.kind === 'custom' ? 26 : 24} /></span>}
            <span>{agent && <><b>{agent.name}</b> </>}{line.text} <span className="floor-ghost">· {ago(line.ts)}</span></span>
          </span>
        )
        : <span className="floor-ghost">Nothing has happened lately.</span>}
    </div>
  )
}

/** The Floor: a room per group of agents, a desk per agent, and the ticker. */
export default function Floor({ agents, now, onOpen }: { agents: TeamAgent[]; now: number; onOpen: (id: string) => void }) {
  const rooms = floorRooms(agents)
  const order = new Map(rooms.flatMap(entry => entry.agents).map((agent, index) => [agent.id, index]))
  return (
    <div className="floor" data-team-floor>
      <div className="floor-sign"><span><span className="dot st-working live" aria-hidden="true" />agent floor</span></div>
      <div className="floor-rooms">
        {rooms.map(({ room, agents: list }) => (
          <section key={room.id} className="floor-room" style={{ '--span': room.span } as CSSProperties} data-room={room.id} aria-label={`${room.label} room`}>
            <div className="floor-room-h"><span>{room.label}</span><small>{room.note}</small></div>
            <ul className="floor-desks">
              {list.map(agent => <Desk key={agent.id} agent={agent} now={now} seed={order.get(agent.id) ?? 0} onOpen={onOpen} />)}
            </ul>
          </section>
        ))}
      </div>
      <Ticker agents={agents} />
      <div className="floor-legend">
        <span><span className="dot st-working" aria-hidden="true" />Working</span>
        <span><span className="dot st-waiting" aria-hidden="true" />Needs you</span>
        <span><span className="dot st-idle" aria-hidden="true" />Idle</span>
        <span><span className="dot st-failed" aria-hidden="true" />Failed</span>
        <span><span className="dot st-offline" aria-hidden="true" />Offline</span>
        <span className="floor-ghost">Tap a desk for its card</span>
      </div>
    </div>
  )
}
