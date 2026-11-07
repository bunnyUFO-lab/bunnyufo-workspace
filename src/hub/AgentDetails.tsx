import { openSpawn } from './spawnStore'
import { useCallback, useState } from 'react'
import { ago } from '../lib/hub'
import { hubHash } from '../lib/route'
import { host } from '../lib/host'
import { startChat } from './chatStart'
import type { AgentDetailsView, DetailsFreshness, DetailsPrompt, ProfileChange, ProfileSettings, TeamAction, TeamAgent } from '../lib/hubTeam'
import { AgentSprite } from './team/AgentSprite'
import SessionRow from './team/SessionRow'
import { useRoute } from './team/useRoute'
import { PLUGINS_LINE, SHARED_LINE, skillHash } from './team/skillsModel'
import { List } from '../ui/Layout'
import { STATUS_DOT, STATUS_LABEL } from './team/teamModel'
import { stateOf } from './team/spriteState'
import { NOT_PICKED_UP_TEXT, replacedText, runningText, waitingText, WAITING_TOO_LONG_MS } from './profileChangeWords'
import { useWaitingPoll } from './useWaitingPoll'
import './team/agentDetails.css'

const SOURCE_TAG: Record<DetailsPrompt['source'], string> = { 'hermes-host': 'Hermes host', app: 'App' }

function Chips({ items, label }: { items: string[] | undefined; label: string }) {
  if (!items?.length) return <span className="team-dim" data-none>None</span>
  return <ul className="ad-chips" aria-label={label}>{items.map(item => <li key={item}>{item}</li>)}</ul>
}

function FreshnessNote({ freshness, hasPrompts }: { freshness: DetailsFreshness; hasPrompts: boolean }) {
  if (freshness.state === 'none') return <p className="ad-note team-dim" data-details-freshness="none">Claude Code&apos;s settings live on the PC and are not shown here yet.</p>
  if (freshness.state === 'missing') return <p className="hub-banner ad-note" role="note" data-details-freshness="missing">The Hermes host has not published its settings yet.{hasPrompts ? ' The prompts from the app are below.' : ''}</p>
  const checked = freshness.exportedAt ? ago(freshness.exportedAt) : ''
  if (freshness.state === 'stale') return <p className="hub-banner ad-note" role="note" data-details-freshness="stale">Last read from the Hermes host {checked}. Its export may have stopped, so these settings may be out of date.</p>
  return (
    <p className="ad-note team-dim" data-details-freshness="fresh">
      Settings checked {checked}{freshness.changedAt ? ` · last changed ${ago(freshness.changedAt)}` : ''}
    </p>
  )
}

/** What happened to the owner's last change of this profile's model, in words. A failure says the old settings stay. `now` is when the page last asked. */
export function ChangeBanner({ change, now }: { change: ProfileChange; now: number }) {
  const model = change.to.model
  const when = ago(change.resultAt ?? change.at)
  if (change.state === 'failed') {
    const hung = change.code === 'rollback-failed'
    return (
      <p className="hub-banner ad-note" role="alert" data-details-change="failed">
        The change to {model} failed: {change.reason ?? 'the host gave no reason'}. {hung ? 'Hermes may be down.' : 'The old settings stay.'} <span className="team-dim">{when}</span>
      </p>
    )
  }
  if (change.state === 'late') return <p className="hub-banner ad-note" role="note" data-details-change="late">The change to {model} was signed {ago(change.at)}. {change.reason ?? 'The Hermes host did not pick this up.'} The old settings stay.</p>
  if (change.replaced) return <p className="ad-note" role="status" data-details-change={change.state} data-replaced>{replacedText(change, ago(change.runningAt ?? change.resultAt ?? change.at))}</p>
  if (change.state === 'live') return <p className="ad-note" role="status" data-details-change="live">{runningText(change, true)}</p>
  if (change.state === 'applied') return <p className="ad-note" role="status" data-details-change="applied">{runningText(change, false)}</p>
  if (now - Date.parse(change.at) > WAITING_TOO_LONG_MS) return <p className="hub-banner ad-note" role="note" data-details-change="waiting" data-waiting-long>{NOT_PICKED_UP_TEXT}</p>
  return <p className="ad-note" role="status" data-details-change="waiting">{waitingText(change, ago(change.at, now))}</p>
}

function Settings({ settings }: { settings: ProfileSettings }) {
  const model = settings.model
  const primary = [model?.provider, model?.default].filter(Boolean).join(' · ')
  const platforms = Object.entries(settings.platformToolsets ?? {})
  const sandbox = [settings.terminal?.backend, settings.terminal?.containerMemoryMb ? `${settings.terminal.containerMemoryMb} MB` : ''].filter(Boolean).join(' · ')
  return (
    <>
      <section className="ad-section" aria-labelledby="ad-model" data-details-model>
        <h3 id="ad-model">Model</h3>
        <dl className="ad-list">
          <div><dt>Primary</dt><dd data-model-primary>{primary || <span className="team-dim">Not set</span>}</dd></div>
          <div>
            <dt>Fallbacks</dt>
            <dd>
              {settings.fallbacks.length
                ? <ol className="ad-fallbacks" data-model-fallbacks>{settings.fallbacks.map((item, index) => <li key={`${item.provider}/${item.model}/${index}`}>then {item.provider} · {item.model}</li>)}</ol>
                : <span className="team-dim">None</span>}
            </dd>
          </div>
        </dl>
      </section>
      <section className="ad-section" aria-labelledby="ad-profile" data-details-profile>
        <h3 id="ad-profile">Profile</h3>
        <dl className="ad-list">
          <div><dt>Toolsets</dt><dd><Chips items={settings.toolsets} label="Toolsets" /></dd></div>
          <div>
            <dt>Per platform</dt>
            <dd>
              {platforms.length
                ? platforms.map(([name, items]) => <div className="ad-platform" key={name}><b>{name}</b><Chips items={items} label={`Toolsets on ${name}`} /></div>)
                : <span className="team-dim" data-none>None</span>}
            </dd>
          </div>
          <div><dt>Sandbox</dt><dd>{sandbox || <span className="team-dim">None</span>}</dd></div>
        </dl>
      </section>
    </>
  )
}

/** A prompt, closed until opened. The text is shown as text: never as HTML or Markdown. */
function Prompt({ prompt }: { prompt: DetailsPrompt }) {
  return (
    <details className="ad-prompt" data-prompt={prompt.id}>
      <summary><span className="ad-prompt-title">{prompt.title}</span><span className="ad-tag" data-source={prompt.source}>{SOURCE_TAG[prompt.source]}</span></summary>
      <pre className="ad-pre">{prompt.text || '(empty)'}</pre>
      {prompt.note && <p className="ad-prompt-note team-dim">{prompt.note}</p>}
    </details>
  )
}

/** What an agent can use, as rows from the Hermes profile's export. Nothing here switches a skill: the Hub holds no list of who can use what. */
function CanUse({ settings, hasProfile }: { settings: ProfileSettings | null; hasProfile: boolean }) {
  if (!settings) {
    return (
      <section className="ad-section" aria-labelledby="ad-can" data-details-can-use>
        <h3 id="ad-can">Can use</h3>
        <p className="ad-note team-dim" data-can-use-unknown>{hasProfile ? 'Not known: the Hermes host has not published the skills of this profile.' : PLUGINS_LINE}</p>
      </section>
    )
  }
  const every = new Set(settings.skills.autoLoad)
  const names = [...new Set([...settings.skills.installed, ...settings.skills.autoLoad])].sort()
  return (
    <section className="ad-section" aria-labelledby="ad-can" data-details-can-use>
      <h3 id="ad-can">Can use<span>{names.length}</span></h3>
      {names.length
        ? (
          <List label="Can use">
            {names.map(name => (
              <a key={name} role="listitem" className="ui-row ad-skill" href={skillHash(name)} data-can-use={name}>
                <span className="ui-row-body"><b>{name}</b></span>
                {every.has(name) && <span className="ad-tag" data-tag="every-reply">Every reply</span>}
              </a>
            ))}
          </List>
        )
        : <span className="team-dim" data-none>None</span>}
      <p className="ad-note team-dim" data-can-use-shared>{SHARED_LINE}</p>
    </section>
  )
}

/** The main button's work: Chat on a persona (a fresh conversation, empty composer), or Spawn on a preset. */
function runAction(action: TeamAction) {
  if ('chat' in action) {
    startChat({ persona: action.chat, draft: '' })
    window.location.hash = hubHash('chat')
  } else {
    openSpawn({ preset: action.preset, ...(action.project ? { project: action.project } : {}), ...(action.text ? { text: action.text } : {}) })
  }
}

/**
 * An agent's page (`#/~hub/agent/<id>`, or beside the list on Team from 900 px): who it is, Chat and New job, what it is working on,
 * the settings of its Hermes profile, what it can use, and its prompts. Read-only except the buttons that start work and the sprite.
 * `live` is the agent as the Team list has it (status, sprite, sessions, main action).
 */
export default function AgentDetails({ id, live, onSprite, opener }: { id: string; live?: TeamAgent; onSprite?: (agent: TeamAgent) => void; opener?: (node: HTMLButtonElement | null) => void }) {
  const details = useRoute<AgentDetailsView>(`/team/${encodeURIComponent(id)}/details`)
  const body = details.data
  const [now] = useState(() => Date.now())
  const [asked, setAsked] = useState(() => Date.now())
  // A change that waits for the host is read again every few seconds, so the page says Running when the result lands.
  const refresh = details.refresh
  useWaitingPoll(body?.change?.state === 'waiting', useCallback(async (signal: AbortSignal) => { await refresh(signal); setAsked(Date.now()) }, [refresh]))

  if (!body) {
    return (
      <div className="ad team" data-agent-details={id}>
        {details.status === 401
          ? (
            <>
              <p className="hub-empty" role="status" data-details-signin>Sign in to see this agent&apos;s prompts.</p>
              <p className="hub-empty" data-details-skills-signin>Skills need sign-in too.</p>
            </>
          )
          : <p className={details.error ? 'hub-error' : 'hub-empty'} role={details.error ? 'alert' : undefined}>{details.error ?? 'Loading…'}</p>}
      </div>
    )
  }
  const { agent } = body
  const action = live?.action
  // The main button needs a signed-in owner; Chat also needs Chat to be set up.
  const showMain = !!action && host.write && (!('chat' in action) || host.chat)
  const sessions = live?.sessions ?? []
  const working = live && live.status !== 'offline' ? live.task : ''
  return (
    <div className="ad team" data-agent-details={agent.id}>
      <header className="ad-head">
        {live && <span className="team-tile big"><AgentSprite sprite={live.sprite} size={live.sprite.kind === 'custom' ? 62 : 54} name={live.name} state={stateOf({ status: live.status, now })} /></span>}
        <div className="ad-title">
          <h2>{agent.name}</h2>
          {live && <span className="team-status" data-details-status><span className={`dot st-${STATUS_DOT[live.status]}`} aria-hidden="true" />{STATUS_LABEL[live.status]}</span>}
          <p className="team-dim">{agent.role}</p>
        </div>
      </header>
      <div className="ad-actions">
        {showMain && live && action && <button type="button" className="hub-btn pri" onClick={() => runAction(action)} data-main-action={live.id} {...(action.label === 'Give work' ? { 'data-give-work': live.id } : {})}>{action.label}</button>}
        {host.write && <button type="button" className="hub-btn" data-spawn-open onClick={() => openSpawn()}>New job</button>}
        {agent.editable && host.write && <a className="hub-btn" href={hubHash('agent-edit', agent.id)} data-edit-open={agent.id}>{agent.editable.persona ? 'Edit the persona and model' : 'Edit the model'}</a>}
        {live && host.write && onSprite && <button type="button" className="hub-btn team-sprite-btn" ref={opener} onClick={() => onSprite(live)} data-sprite-open={live.id}>Sprite</button>}
        {live && !host.write && <span className="team-dim" data-sprite-signin>Sign in to change sprites</span>}
      </div>
      {live && (working || sessions.length > 0) && (
        <section className="ad-section" aria-labelledby="ad-working" data-details-working>
          <h3 id="ad-working">Working on</h3>
          {sessions.length > 0
            ? <ul className="team-sessions" aria-label={`${live.name} sessions`}>{sessions.map(item => <SessionRow key={item.id} item={item} />)}</ul>
            : <p className="team-task">{working}</p>}
        </section>
      )}
      <dl className="ad-facts">
        <div><dt>Room</dt><dd>{agent.room}</dd></div>
        <div><dt>Runs as</dt><dd>{agent.runtime}</dd></div>
        {live && <div><dt>Model</dt><dd data-details-model-line>{live.model}{live.chatModel ? ` · chat: ${live.chatModel}` : ''}</dd></div>}
        <div><dt>Profile</dt><dd data-details-profile-name>{agent.profile ?? 'None'}</dd></div>
        {agent.chatModel && <div><dt>Chat model</dt><dd data-details-chat-model>{agent.chatModel}</dd></div>}
      </dl>
      <FreshnessNote freshness={body.freshness} hasPrompts={body.prompts.length > 0} />
      {body.change && <ChangeBanner change={body.change} now={asked} />}
      {body.settings && <Settings settings={body.settings} />}
      <CanUse settings={body.settings} hasProfile={!!agent.profile} />
      {body.prompts.length > 0 && (
        <section className="ad-section" aria-labelledby="ad-prompts" data-details-prompts>
          <h3 id="ad-prompts">Prompts</h3>
          {body.prompts.map(prompt => <Prompt key={prompt.id} prompt={prompt} />)}
        </section>
      )}
      {body.jobs.length > 0 && (
        <section className="ad-section" aria-labelledby="ad-jobs" data-details-jobs>
          <h3 id="ad-jobs">Scheduled jobs</h3>
          <a className="team-details-link" href={hubHash('team', 'schedules')} data-all-schedules>All schedules</a>
          <ul className="ad-jobs">
            {body.jobs.map(job => (
              <li key={`${job.name}/${job.schedule}`} data-job={job.name}>
                <div className="ad-job-head"><b>{job.name}</b><code>{job.schedule}</code><span className={`ad-tag${job.enabled ? ' on' : ''}`}>{job.enabled ? 'On' : 'Off'}</span></div>
                <details className="ad-prompt"><summary><span className="ad-prompt-title">Prompt</span></summary><pre className="ad-pre">{job.prompt || '(empty)'}</pre></details>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
