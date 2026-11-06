import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { hubPost, remember } from '../lib/hub'
import { go } from '../lib/entries'
import { hubHash } from '../lib/route'
import { host } from '../lib/host'
import { useIsDesktop } from '../lib/chrome'
import type { TeamAgent, TeamView } from '../lib/hubTeam'
import { stateOf, type AgentActivity } from './team/spriteState'
import { AgentSprite } from './team/AgentSprite'
import SpriteSheet from './team/SpriteSheet'
import NewPersona from './team/NewPersona'
import Floor from './team/Floor'
import SkillsTab from './team/SkillsTab'
import { isSkillsRoute, skillOf } from './team/skillsModel'
import { VIEW_KEY, viewOf, type TeamViewMode } from './team/floorModel'
import { choiceOf, rosterCounts, STATUS_DOT, STATUS_LABEL, type AnySprite } from './team/teamModel'
import { List, Split } from '../ui/Layout'
import './team/team.css'
import RefreshNote from './RefreshNote'
import AgentCardSettings from './AgentCardSettings'
import AgentDetails from './AgentDetails'
import { useHubData } from './useHub'

interface Toast { text: string; undo?: () => void }

/** One agent as a row: its sprite, name, role and state. A link to its page, which opens beside the list from 900 px. */
function AgentRow({ agent, now, on }: { agent: TeamAgent; now: number; on: boolean }) {
  const live = agent as TeamAgent & AgentActivity
  const state = stateOf({ status: agent.status, doneAt: live.doneAt, review: live.review, now })
  return (
    <a role="listitem" className={`ui-row team-row st-${agent.status}${on ? ' on' : ''}`} href={hubHash('agent', agent.id)} data-agent={agent.id} data-status={agent.status} aria-current={on ? 'page' : undefined}>
      <span className="team-tile"><AgentSprite sprite={agent.sprite} size={agent.sprite.kind === 'custom' ? 52 : 44} name={agent.name} state={state} /></span>
      <span className="ui-row-body">
        <b>{agent.name}</b>
        <small className="team-row-role">{agent.role}</small>
        <small className="team-status"><span className={`dot st-${STATUS_DOT[agent.status]}${agent.status === 'working' ? ' live' : ''}`} aria-hidden="true" />{STATUS_LABEL[agent.status]}</small>
      </span>
    </a>
  )
}

/**
 * The Team screen. Two halves, each its own address: Agents (`#/~hub/team`, an agent's page at `#/~hub/agent/<id>`) and Skills and
 * plugins (`#/~hub/team/skills[/<skill>]`). Agents is a list with the agent's page beside it from 900 px, or the Floor (the pixel
 * office) on its own; the choice is remembered in this browser. Nothing here switches a skill.
 */
export default function Team({ routeId, agentId }: { routeId?: string; agentId?: string }) {
  const { data, error, loading, reload, at } = useHubData<TeamView>('/team')
  const desktop = useIsDesktop()
  const [sheetFor, setSheetFor] = useState<string | null>(null)
  const [newOpen, setNewOpen] = useState(false)
  const newOpener = useRef<HTMLButtonElement>(null)
  const [toast, setToast] = useState<Toast | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const openers = useRef(new Map<string, HTMLButtonElement | null>())
  const timer = useRef(0)
  // List or Floor: remembered in this browser only. An agent's page always has the list beside it.
  const [view, setView] = useState<TeamViewMode>(() => viewOf(remember(VIEW_KEY)))
  // The Done window ends on its own, so the clock ticks even when no new data arrives.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => { const tick = window.setInterval(() => setNow(Date.now()), 30_000); return () => window.clearInterval(tick) }, [])
  useEffect(() => () => window.clearTimeout(timer.current), [])
  const pick = (next: TeamViewMode) => {
    setView(next)
    remember(VIEW_KEY, next)
    if (agentId) go(hubHash('team'))
  }

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

  const skills = isSkillsRoute(routeId)
  const counts = data ? rosterCounts(data.agents) : null
  // The heading, the two halves as links (one step each), and on Agents the list or floor choice and the buttons.
  const heading = (
    <div className="team-top">
      <div className="hub-top team-head">
        <h2>Team</h2>
        {counts && (
          <dl className="team-counts">
            <div><dt>Online</dt><dd data-team-online>{counts.online}<span className="team-dim">/{counts.total}</span></dd></div>
            <div><dt>Working</dt><dd data-team-working className={counts.working ? 'on' : undefined}>{counts.working}</dd></div>
          </dl>
        )}
      </div>
      <nav className="ui-seg ui-seg-tabs" role="tablist" aria-label="Team" data-team-tabs>
        <a role="tab" href={hubHash('team')} className={skills ? undefined : 'on'} aria-selected={!skills} data-team-tab="agents">Agents</a>
        <a role="tab" href={hubHash('team', 'skills')} className={skills ? 'on' : undefined} aria-selected={skills} data-team-tab="skills">Skills and plugins</a>
      </nav>
      {!skills && (
        <div className="team-tools">
          <div className="hub-seg team-view" role="group" aria-label="View">
            <button type="button" className={view === 'roster' ? 'on' : ''} aria-pressed={view === 'roster'} onClick={() => pick('roster')} data-team-view="roster">List</button>
            <button type="button" className={view === 'floor' ? 'on' : ''} aria-pressed={view === 'floor'} onClick={() => pick('floor')} data-team-view="floor">Floor</button>
          </div>
          {host.write && <button type="button" className="hub-btn team-new" ref={newOpener} onClick={() => setNewOpen(true)} data-new-persona>New persona</button>}
          <button type="button" className="hub-btn team-write" onClick={() => document.getElementById('cw-setting-title')?.scrollIntoView({ block: 'start', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })} data-team-write-setting>Where agents can write</button>
        </div>
      )}
    </div>
  )

  let body: ReactNode
  if (skills) {
    body = <SkillsTab id={skillOf(routeId)} head={heading} desktop={desktop} />
  } else if (!data) {
    body = <div className="team-pane">{heading}<p className="hub-empty">{error ?? (loading ? 'Loading…' : '')}</p></div>
  } else if (view === 'floor' && !agentId) {
    body = (
      <div className="team-pane team-solo" data-team-floor>
        {heading}
        <RefreshNote error={error} hasData={!!data} at={at} />
        {failure && <p className="hub-error" role="alert">{failure}</p>}
        <Floor agents={data.agents} now={now} onOpen={id => { window.location.hash = hubHash('agent', id) }} />
        <AgentCardSettings />
      </div>
    )
  } else {
    const shown = agentId ?? (desktop ? data.agents[0]?.id : undefined)
    const list = (
      <div className="team-pane">
        {heading}
        <RefreshNote error={error} hasData={!!data} at={at} />
        {failure && <p className="hub-error" role="alert">{failure}</p>}
        <List label="Agents">{data.agents.map(agent => <AgentRow key={agent.id} agent={agent} now={now} on={agent.id === shown} />)}</List>
        <AgentCardSettings />
      </div>
    )
    const open = shown ? data.agents.find(agent => agent.id === shown) : undefined
    body = (
      <Split
        list={list}
        detail={shown ? (
          <div className="team-detail">
            <AgentDetails key={shown} id={shown} live={open} onSprite={item => setSheetFor(item.id)} opener={node => { openers.current.set(shown, node) }} />
          </div>
        ) : undefined}
        empty="Pick an agent from the list."
      />
    )
  }

  const sheetAgent = data?.agents.find(agent => agent.id === sheetFor) ?? null
  return (
    <div className="team" data-team-half={skills ? 'skills' : 'agents'}>
      {body}
      {sheetAgent && (
        <SpriteSheet
          key={sheetAgent.id}
          agent={sheetAgent}
          onClose={() => { const id = sheetAgent.id; setSheetFor(null); window.setTimeout(() => openers.current.get(id)?.focus(), 0) }}
          onUse={next => choose(sheetAgent, next, sheetAgent.sprite)}
        />
      )}
      {newOpen && (
        <NewPersona
          onClose={() => { setNewOpen(false); window.setTimeout(() => newOpener.current?.focus(), 0) }}
          onBrought={who => { reload(); say({ text: `${who} is back on the Team.` }) }}
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
