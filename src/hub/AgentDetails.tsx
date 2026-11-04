import { useEffect, useState } from 'react'
import { ago, HubError, hubGet } from '../lib/hub'
import { hubHash } from '../lib/route'
import { host } from '../lib/host'
import type { AgentDetailsView, DetailsFreshness, DetailsPrompt, ProfileSettings, TeamView } from '../lib/hubTeam'
import { AgentSprite } from './team/AgentSprite'
import { STATUS_DOT, STATUS_LABEL } from './team/teamModel'
import { stateOf } from './team/spriteState'
import './team/agentDetails.css'

const SOURCE_TAG: Record<DetailsPrompt['source'], string> = { 'hermes-host': 'Hermes host', app: 'App' }

type Load<T> = { data: T | null; error: string | null; status: number | null }

/** One Hub route, fetched on mount. The status is kept so a 401 can say "sign in" instead of a bare error. */
function useRoute<T>(path: string): Load<T> {
  const [state, setState] = useState<Load<T> & { path: string }>({ path, data: null, error: null, status: null })
  useEffect(() => {
    const controller = new AbortController()
    hubGet<T>(path, controller.signal).then(
      data => setState({ path, data, error: null, status: 200 }),
      (problem: unknown) => {
        if ((problem as { name?: string }).name === 'AbortError') return
        setState({ path, data: null, error: problem instanceof Error ? problem.message : 'Could not load this.', status: problem instanceof HubError ? problem.status : 0 })
      },
    )
    return () => controller.abort()
  }, [path])
  return state.path === path ? state : { data: null, error: null, status: null }
}

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
          <div><dt>Skills loaded on every reply</dt><dd><Chips items={settings.skills.autoLoad} label="Skills loaded on every reply" /></dd></div>
          <div><dt>Installed skills</dt><dd><Chips items={settings.skills.installed} label="Installed skills" /></dd></div>
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

/** `#/~hub/agent/<id>`: who an agent is, the settings of its Hermes profile and its prompts. Read-only. */
export default function AgentDetails({ id }: { id: string }) {
  const details = useRoute<AgentDetailsView>(`/team/${encodeURIComponent(id)}/details`)
  const team = useRoute<TeamView>('/team')
  const body = details.data
  const live = team.data?.agents.find(agent => agent.id === id) ?? null
  const [now] = useState(() => Date.now())

  const back = <a className="ad-back" href={hubHash('team')} data-details-back>← Team</a>
  if (!body) {
    return (
      <div className="ad team" data-agent-details={id}>
        {back}
        {details.status === 401
          ? <p className="hub-empty" role="status" data-details-signin>Sign in to see this agent&apos;s prompts.</p>
          : <p className={details.error ? 'hub-error' : 'hub-empty'} role={details.error ? 'alert' : undefined}>{details.error ?? 'Loading…'}</p>}
      </div>
    )
  }
  const { agent } = body
  return (
    <div className="ad team" data-agent-details={agent.id}>
      {back}
      <header className="ad-head">
        {live && <span className="team-tile big"><AgentSprite sprite={live.sprite} size={live.sprite.kind === 'custom' ? 62 : 54} name={live.name} state={stateOf({ status: live.status, now })} /></span>}
        <div className="ad-title">
          <h2>{agent.name}</h2>
          {live && <span className="team-status" data-details-status><span className={`dot st-${STATUS_DOT[live.status]}`} aria-hidden="true" />{STATUS_LABEL[live.status]}</span>}
          <p className="team-dim">{agent.role}</p>
          {agent.editable?.persona && host.write && <a className="team-details-link" href={hubHash('agent-edit', agent.id)} data-edit-open={agent.id}>Edit the chat persona</a>}
        </div>
      </header>
      <dl className="ad-facts">
        <div><dt>Room</dt><dd>{agent.room}</dd></div>
        <div><dt>Runs as</dt><dd>{agent.runtime}</dd></div>
        <div><dt>Profile</dt><dd data-details-profile-name>{agent.profile ?? 'None'}</dd></div>
        {agent.chatModel && <div><dt>Chat model</dt><dd data-details-chat-model>{agent.chatModel}</dd></div>}
      </dl>
      <FreshnessNote freshness={body.freshness} hasPrompts={body.prompts.length > 0} />
      {body.settings && <Settings settings={body.settings} />}
      {body.prompts.length > 0 && (
        <section className="ad-section" aria-labelledby="ad-prompts" data-details-prompts>
          <h3 id="ad-prompts">Prompts</h3>
          {body.prompts.map(prompt => <Prompt key={prompt.id} prompt={prompt} />)}
        </section>
      )}
      {body.jobs.length > 0 && (
        <section className="ad-section" aria-labelledby="ad-jobs" data-details-jobs>
          <h3 id="ad-jobs">Scheduled jobs</h3>
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
