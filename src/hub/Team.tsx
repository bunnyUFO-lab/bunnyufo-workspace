import { useCallback, useEffect, useRef, useState } from 'react'
import { ago, appUrl, hubPost, remember, sessionUrl } from '../lib/hub'
import { host } from '../lib/host'
import type { TeamAgent, TeamView } from '../lib/hubTeam'
import { stateOf, type AgentActivity } from './team/spriteState'
import type { WorkingItem } from '../lib/hubPc'
import { AgentSprite } from './team/AgentSprite'
import SpriteSheet from './team/SpriteSheet'
import Floor from './team/Floor'
import { VIEW_KEY, viewOf, type TeamViewMode } from './team/floorModel'
import { openSpawn } from './spawnStore'
import { choiceOf, rosterCounts, STATUS_DOT, STATUS_LABEL, type AnySprite } from './team/teamModel'
import './team/team.css'
import { useHubData } from './useHub'

interface Toast { text: string; undo?: () => void }

const bare = (text: string) => text.replace(/ ago$/, '')
const SESSION_STATE = { working: 'Working', 'needs-you': 'Needs you', stopping: 'Stopping', idle: 'Idle' } as const

/** A Claude Code session, compact: state, title, where it runs, and a link to open it. */
function SessionRow({ item }: { item: WorkingItem }) {
  const link = sessionUrl(item.url) ?? appUrl(item.appUrl)
  const where = [item.project, item.branch].filter(Boolean).join(' · ')
  const body = (
    <>
      <span className={`dot st-${item.state === 'needs-you' ? 'needs' : item.state === 'stopping' ? 'working' : item.state}`} aria-hidden="true" />
      <span className="team-session-text">
        <b>{item.title}</b>
        <small>{[where, SESSION_STATE[item.state], `for ${bare(ago(item.since))}`].filter(Boolean).join(' · ')}</small>
      </span>
    </>
  )
  return link
    ? <li><a className="team-session" href={link} target={link.startsWith('http') ? '_blank' : undefined} rel="noopener noreferrer" aria-label={`Open session: ${item.title}`}>{body}</a></li>
    : <li><span className="team-session">{body}</span></li>
}

function AgentCard({ agent, now, canPick, onSprite, opener }: { agent: TeamAgent; now: number; canPick: boolean; onSprite: (agent: TeamAgent) => void; opener: (node: HTMLButtonElement | null) => void }) {
  const dot = STATUS_DOT[agent.status]
  const live = agent as TeamAgent & AgentActivity
  const state = stateOf({ status: agent.status, doneAt: live.doneAt, review: live.review, now })
  const sprite = agent.sprite
  return (
    <article className={`team-card st-${agent.status}`} data-agent={agent.id} data-status={agent.status}>
      <header className="team-card-head">
        <span className="team-tile"><AgentSprite sprite={sprite} size={sprite.kind === 'custom' ? 52 : 44} name={agent.name} state={state} /></span>
        <span className="team-card-name">
          <h3>{agent.name}</h3>
          <span className="team-status"><span className={`dot st-${dot}${agent.status === 'working' ? ' live' : ''}`} aria-hidden="true" />{STATUS_LABEL[agent.status]}</span>
        </span>
        <span className="team-chip">{agent.room}</span>
      </header>
      <p className="team-task">{agent.status === 'offline' ? <span className="team-dim">{agent.task}</span> : <><b>Now</b> · {agent.task}</>}</p>
      <dl className="team-facts">
        <div><dt>Model</dt><dd>{agent.model}</dd></div>
        <div><dt>Runs as</dt><dd>{agent.runtime}</dd></div>
      </dl>
      {agent.sessions && agent.sessions.length > 0 && <ul className="team-sessions" aria-label={`${agent.name} sessions`}>{agent.sessions.map(item => <SessionRow key={item.id} item={item} />)}</ul>}
      <footer className="team-card-foot">
        <span className="team-dim">{agent.role}</span>
        {canPick && agent.presets?.length ? <button type="button" className="hub-btn" onClick={() => openSpawn({ preset: agent.presets?.[0] })} data-give-work={agent.id}>Give work</button> : null}
        {canPick
          ? <button type="button" className="hub-btn team-sprite-btn" ref={opener} onClick={() => onSprite(agent)} data-sprite-open={agent.id}>Sprite</button>
          : <span className="team-dim" data-sprite-signin>Sign in to change sprites</span>}
      </footer>
    </article>
  )
}

/** The Team screen: one card per agent (the Roster view), and the Sprite sheet. */
export default function Team() {
  const { data, error, loading, reload } = useHubData<TeamView>('/team')
  const [sheetFor, setSheetFor] = useState<string | null>(null)
  const [toast, setToast] = useState<Toast | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const openers = useRef(new Map<string, HTMLButtonElement | null>())
  const timer = useRef(0)
  // Roster or Floor: remembered in this browser only. Opening an agent from a desk shows its card without changing the choice.
  const [view, setView] = useState<TeamViewMode>(() => viewOf(remember(VIEW_KEY)))
  const focusId = useRef<string | null>(null)
  // The Done window ends on its own, so the clock ticks even when no new data arrives.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => { const tick = window.setInterval(() => setNow(Date.now()), 30_000); return () => window.clearInterval(tick) }, [])
  useEffect(() => () => window.clearTimeout(timer.current), [])
  // The Roster card of the agent a desk opened: scrolled to and focused once the Roster is drawn.
  useEffect(() => {
    if (!focusId.current || view !== 'roster') return
    const card = document.querySelector<HTMLElement>(`.team-card[data-agent="${CSS.escape(focusId.current)}"]`)
    if (card) {
      card.tabIndex = -1
      card.scrollIntoView({ block: 'center', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
      card.focus({ preventScroll: true })
    }
    focusId.current = null
  }, [view, data])
  const pick = (next: TeamViewMode) => { setView(next); remember(VIEW_KEY, next) }

  const say = useCallback((next: Toast | null) => {
    window.clearTimeout(timer.current)
    setToast(next)
    if (next) timer.current = window.setTimeout(() => setToast(null), 10_000)
  }, [])

  const save = useCallback(async (agent: TeamAgent, sprite: AnySprite): Promise<boolean> => {
    setFailure(null)
    try {
      await hubPost(`/team/${encodeURIComponent(agent.id)}/avatar`, choiceOf(sprite))
      reload()
      return true
    } catch (problem) {
      setFailure(problem instanceof Error ? problem.message : 'The sprite was not saved.')
      return false
    }
  }, [reload])

  /** Use a sprite; the toast's Undo posts the previous choice again. */
  const choose = useCallback(async (agent: TeamAgent, next: AnySprite, previous: AnySprite): Promise<boolean> => {
    if (!(await save(agent, next))) return false
    say({
      text: `${agent.name} has a new sprite. No job needed.`,
      undo: () => { void save(agent, previous).then(done => { if (done) say({ text: `${agent.name} has its old sprite back.` }) }) },
    })
    return true
  }, [save, say])

  if (!data) return <p className="hub-empty">{error ?? (loading ? 'Loading…' : '')}</p>
  const counts = rosterCounts(data.agents)
  const sheetAgent = data.agents.find(agent => agent.id === sheetFor) ?? null
  return (
    <div className="team">
      <header className="team-head">
        <div>
          <div className="team-eyebrow">Your AI team</div>
          <h2>Team</h2>
        </div>
        <dl className="team-counts">
          <div><dt>Online</dt><dd data-team-online>{counts.online}<span className="team-dim">/{counts.total}</span></dd></div>
          <div><dt>Working</dt><dd data-team-working className={counts.working ? 'on' : undefined}>{counts.working}</dd></div>
        </dl>
        <div className="hub-seg team-view" role="group" aria-label="View">
          <button type="button" className={view === 'roster' ? 'on' : ''} aria-pressed={view === 'roster'} onClick={() => pick('roster')} data-team-view="roster">Roster</button>
          <button type="button" className={view === 'floor' ? 'on' : ''} aria-pressed={view === 'floor'} onClick={() => pick('floor')} data-team-view="floor">Floor</button>
        </div>
      </header>
      {error && <p className="hub-error" role="alert">{error}</p>}
      {failure && <p className="hub-error" role="alert">{failure}</p>}
      {view === 'floor'
        ? <Floor agents={data.agents} now={now} onOpen={id => { focusId.current = id; setView('roster') }} />
        : (
          <div className="team-roster">
            {data.agents.map(agent => (
              <AgentCard key={agent.id} agent={agent} now={now} canPick={host.write} onSprite={item => setSheetFor(item.id)} opener={node => { openers.current.set(agent.id, node) }} />
            ))}
          </div>
        )}
      {sheetAgent && (
        <SpriteSheet
          key={sheetAgent.id}
          agent={sheetAgent}
          onClose={() => { const id = sheetAgent.id; setSheetFor(null); window.setTimeout(() => openers.current.get(id)?.focus(), 0) }}
          onUse={next => choose(sheetAgent, next, sheetAgent.sprite)}
        />
      )}
      {toast && (
        <div className="team-toast" role="status" data-team-toast>
          <span>{toast.text}</span>
          {toast.undo && <button type="button" className="hub-btn" onClick={() => { toast.undo?.() }} data-team-undo>Undo</button>}
        </div>
      )}
    </div>
  )
}
