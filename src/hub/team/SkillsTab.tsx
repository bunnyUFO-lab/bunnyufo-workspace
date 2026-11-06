import { useMemo, useState, type ReactNode } from 'react'
import { ago, remember } from '../../lib/hub'
import { swap } from '../../lib/entries'
import { hubHash } from '../../lib/route'
import type { TeamPlugin, TeamSkill, TeamSkillsView } from '../../lib/hubTeam'
import { List, Row, Section, Split } from '../../ui/Layout'
import { Segment } from '../../ui/Controls'
import SearchField from '../SearchField'
import { useRoute } from './useRoute'
import { agentCount, agentGroups, BY_KEY, byOf, exportLine, GUEST_LINE, groupByFolder, NO_PLUGINS_LINE, PLUGINS_LINE, pluginRows, profileText, SHARED_LINE, sharedText, skillHash, skillMatches, sourceText, type AgentGroup, type PluginRow, type SkillsBy } from './skillsModel'

const Tags = ({ skill }: { skill: TeamSkill }) => (
  <span className="tk-tags">
    {skill.autoLoad && <span className="ad-tag" data-tag="every-reply">Every reply</span>}
    {skill.owner && <span className="ad-tag" data-tag="yours">Yours</span>}
  </span>
)

function SkillRow({ skill, on }: { skill: TeamSkill; on: boolean }) {
  return (
    <a role="listitem" className={`ui-row${on ? ' on' : ''}`} href={skillHash(skill.id)} data-skill={skill.id} aria-current={on ? 'page' : undefined}>
      <span className="ui-row-body"><b>{skill.id}</b><small>{skill.agents.length ? agentCount(skill) : 'No agent known'}{sourceText(skill) ? ` · ${sourceText(skill)}` : ''}</small></span>
      <Tags skill={skill} />
    </a>
  )
}

/** One skill: who can use it, by profile, and why the profile's agents are listed together. Read-only. */
function SkillPage({ skill }: { skill: TeamSkill | null }) {
  if (!skill) return <div className="team-detail tk-page" data-skill-page=""><p className="hub-empty" data-skill-gone>This skill is not in the Hermes host&apos;s export.</p></div>
  return (
    <div className="team-detail tk-page" data-skill-page={skill.id}>
      <header className="tk-head">
        <h2>{skill.id}</h2>
        <Tags skill={skill} />
        <p className="team-dim">{profileText(skill)}</p>
      </header>
      <Section title="Which agents can use it">
        {skill.agents.length
          ? <List label="Agents">{skill.agents.map(agent => <Row key={agent.id} title={agent.name} sub={`Profile ${agent.profile}`} href={hubHash('agent', agent.id)} />)}</List>
          : <p className="hub-empty" data-skill-no-agents>No agent is known to use it. The export does not say who can use a skill nobody has installed.</p>}
      </Section>
      <p className="ad-note team-dim" data-skill-shared>{SHARED_LINE}</p>
      <p className="ad-note team-dim" data-skill-plugins>{PLUGINS_LINE}</p>
    </div>
  )
}

const STATUS_WORD = { enabled: 'On', disabled: 'Off', 'not enabled': 'Not on' } as const

function PluginRowView({ row }: { row: PluginRow }) {
  const detail = [row.version && `v${row.version}`, row.source].filter(Boolean).join(' · ')
  return (
    <div role="listitem" className={`ui-row tk-plugin${row.status === 'enabled' ? '' : ' off'}`} data-plugin={row.name} data-plugin-status={row.status}>
      <span className="ui-row-body"><b>{row.name}</b><small>{detail}</small>{row.description && <small className="tk-desc">{row.description}</small>}</span>
      <span className={`ad-tag${row.status === 'enabled' ? ' on' : ''}`}>{STATUS_WORD[row.status]}</span>
    </div>
  )
}

/** One agent group: who shares the list, what they can use by folder, and the plugins the export lists for the profile. */
function GroupCard({ group, data, query }: { group: AgentGroup; data: TeamSkillsView; query: string }) {
  const owned = useMemo(() => new Set(data.skills.filter(skill => skill.owner).map(skill => skill.id)), [data.skills])
  const every = useMemo(() => new Set(group.autoLoad), [group.autoLoad])
  const shown = (group.skills ?? []).filter(id => skillMatches(id, query))
  const plugins = (pluginRows(data, group.profile) ?? []).filter(row => skillMatches(`${row.name} ${row.description}`, query))
  const names = group.agents.map(agent => agent.name).join(', ')
  const shared = sharedText(group)
  return (
    <section className="tk-group" data-agent-group={group.key} aria-label={names}>
      <header className="tk-ghead">
        <h3>{names}</h3>
        <p className="team-dim" data-group-shared={shared ? '' : undefined}>
          {shared ?? (group.profile ? 'Has its own list.' : group.note)}
          {group.skills && ` ${group.skills.length === 1 ? '1 skill' : `${group.skills.length} skills`}.`}
        </p>
      </header>
      {group.skills === null && <p className="hub-empty" data-group-unknown>{group.profile ? 'Not known: the Hermes host has not published the skills of this profile.' : group.note}</p>}
      {group.skills !== null && shown.length === 0 && <p className="hub-empty" data-group-none>{query ? 'No skill here matches.' : 'No skill is installed.'}</p>}
      {groupByFolder(shown.map(id => ({ id }))).map(folder => (
        <div key={folder.folder} className="tk-folder" data-folder={folder.folder}>
          <h4>{folder.label}</h4>
          <List label={folder.label}>
            {folder.items.map(({ id }) => (
              <a key={id} role="listitem" className="ui-row" href={skillHash(id)} data-skill={id}>
                <span className="ui-row-body"><b>{folder.folder ? id.slice(folder.folder.length + 1) : id}</b></span>
                <span className="tk-tags">
                  {every.has(id) && <span className="ad-tag" data-tag="every-reply">Every reply</span>}
                  {owned.has(id) && <span className="ad-tag" data-tag="yours">Yours</span>}
                </span>
              </a>
            ))}
          </List>
        </div>
      ))}
      {plugins.length > 0 && (
        <div className="tk-folder" data-group-plugins="">
          <h4>Plugins</h4>
          <List label="Plugins">{plugins.map(row => <PluginRowView key={row.name} row={row} />)}</List>
        </div>
      )}
    </section>
  )
}

/** In By skill: each plugin with the agents of the profiles that have it on. */
function PluginsBySkill({ data, query }: { data: TeamSkillsView; query: string }) {
  const items = data.plugins.items.filter((item: TeamPlugin) => skillMatches(`${item.name} ${item.description}`, query))
  if (!items.length) return null
  const peopleOn = (item: TeamPlugin) => data.agents.filter(agent => item.profiles.some(entry => entry.profile === agent.profile && entry.status === 'enabled')).map(agent => agent.name)
  return (
    <Section title="Plugins">
      <List label="Plugins">
        {items.map(item => {
          const people = peopleOn(item)
          return (
            <div key={item.name} role="listitem" className="ui-row tk-plugin" data-plugin={item.name}>
              <span className="ui-row-body"><b>{item.name}</b><small>{people.length ? `On for ${people.join(', ')}` : 'Not on for any agent'}</small></span>
            </div>
          )
        })}
      </List>
    </Section>
  )
}

/**
 * Team's second half: what the Hermes host has installed, and who can use it. Two ways to read it, By agent (agents that share a
 * profile share one list, so they are one group) and By skill (each skill with its agents). A search box covers both. Nothing here
 * switches a skill: the Hub holds no list of who can use what, only what the export says. `head` is the Team heading and tabs.
 */
export default function SkillsTab({ id, head, desktop }: { id: string | null; head: ReactNode; desktop: boolean }) {
  const load = useRoute<TeamSkillsView>('/team/skills')
  const data = load.data
  const guest = load.status === 401
  const [stored, setStored] = useState<SkillsBy>(() => byOf(remember(BY_KEY)))
  const [query, setQuery] = useState('')
  // A skill's address always reads By skill. The choice is kept in this browser; switching adds no back step.
  const by: SkillsBy = id ? 'skill' : stored
  const pick = (next: SkillsBy) => {
    setStored(next)
    remember(BY_KEY, next)
    if (next === 'agent' && id) swap(hubHash('team', 'skills'))
  }
  const selected = id ?? (desktop && by === 'skill' && data?.skills[0]?.id) ?? null
  const note = data ? exportLine(data, data.exportedAt ? ago(data.exportedAt) : '') : null
  const skills = data ? data.skills.filter(skill => skillMatches(skill.id, query)) : []

  const list = (
    <div className="team-pane tk-pane">
      {head}
      {guest && <p className="hub-empty" role="status" data-skills-signin>{GUEST_LINE}</p>}
      {!data && !guest && <p className={load.error ? 'hub-error' : 'hub-empty'} role={load.error ? 'alert' : undefined}>{load.error ?? 'Loading…'}</p>}
      {data && (
        <>
          {note && <p className={note.warn ? 'hub-banner ad-note' : 'ad-note team-dim'} role={note.warn ? 'note' : undefined} data-skills-freshness={data.exportedAt ? (data.fresh ? 'fresh' : 'stale') : 'none'}>{note.text}</p>}
          <div className="tk-tools">
            <Segment<SkillsBy> label="Read by" value={by} onChange={pick} options={[{ id: 'agent', label: 'By agent' }, { id: 'skill', label: 'By skill' }]} />
            <SearchField value={query} onChange={setQuery} label="Search skills and plugins" placeholder="Search skills and plugins" data={{ 'data-skills-search': '' }} />
          </div>
          {!data.plugins.known && <p className="ad-note team-dim" data-plugins-unknown>{NO_PLUGINS_LINE}</p>}
          {by === 'agent' ? (
            <div className="tk-groups" data-skills-by="agent">
              {agentGroups(data).map(group => <GroupCard key={group.key} group={group} data={data} query={query} />)}
            </div>
          ) : (
            <div data-skills-by="skill">
              <Section title="Skills">
                {data.skills.length
                  ? (skills.length
                    ? <List label="Skills">{skills.map(skill => <SkillRow key={skill.id} skill={skill} on={skill.id === selected} />)}</List>
                    : <p className="hub-empty" data-skills-no-match>No skill matches.</p>)
                  : <p className="hub-empty" data-skills-none>The export names no skills.</p>}
                {data.maybeCut && <p className="ad-note team-dim" data-skills-cut>The export keeps only the first names of a long list, so a skill may be missing.</p>}
              </Section>
              {data.plugins.known && <PluginsBySkill data={data} query={query} />}
            </div>
          )}
        </>
      )}
      <p className="ad-note team-dim" data-plugins-line>{data?.plugins.text ?? PLUGINS_LINE}</p>
    </div>
  )
  if (by === 'agent') return <Split list={list} fill />
  const skill = id && data ? data.skills.find(item => item.id === id) ?? null : null
  const detail = id
    ? (data ? <SkillPage skill={skill} /> : <div className="team-detail">{guest ? <p className="hub-empty">{GUEST_LINE}</p> : <p className={load.error ? 'hub-error' : 'hub-empty'}>{load.error ?? 'Loading…'}</p>}</div>)
    : desktop && data?.skills[0] ? <SkillPage skill={data.skills[0]} /> : undefined
  return <Split list={list} detail={detail} empty="Pick a skill from the list." />
}
