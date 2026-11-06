import type { ReactNode } from 'react'
import { ago } from '../../lib/hub'
import { hubHash } from '../../lib/route'
import type { TeamSkill, TeamSkillsView } from '../../lib/hubTeam'
import { List, Row, Section, Split } from '../../ui/Layout'
import Packs from '../../components/SkillPacks'
import { useRoute } from './useRoute'
import { agentCount, exportLine, GUEST_LINE, PLUGINS_LINE, profileText, SHARED_LINE, skillHash, sourceText } from './skillsModel'

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

/**
 * Team's second half: every skill the Hermes host's export names, which agents can use it, and the install commands. Nothing here
 * switches a skill: the Hub holds no list of who can use what, only what the export says. `head` is the Team heading and tabs.
 */
export default function SkillsTab({ id, head, desktop }: { id: string | null; head: ReactNode; desktop: boolean }) {
  const load = useRoute<TeamSkillsView>('/team/skills')
  const data = load.data
  const guest = load.status === 401
  const selected = id ?? (desktop && data?.skills[0]?.id) ?? null
  const note = data ? exportLine(data, data.exportedAt ? ago(data.exportedAt) : '') : null

  const list = (
    <div className="team-pane">
      {head}
      {guest && <p className="hub-empty" role="status" data-skills-signin>{GUEST_LINE}</p>}
      {!data && !guest && <p className={load.error ? 'hub-error' : 'hub-empty'} role={load.error ? 'alert' : undefined}>{load.error ?? 'Loading…'}</p>}
      {data && (
        <>
          {note && <p className={note.warn ? 'hub-banner ad-note' : 'ad-note team-dim'} role={note.warn ? 'note' : undefined} data-skills-freshness={data.exportedAt ? (data.fresh ? 'fresh' : 'stale') : 'none'}>{note.text}</p>}
          <Section title="Skills">
            {data.skills.length
              ? <List label="Skills">{data.skills.map(skill => <SkillRow key={skill.id} skill={skill} on={skill.id === selected} />)}</List>
              : <p className="hub-empty" data-skills-none>The export names no skills.</p>}
            {data.maybeCut && <p className="ad-note team-dim" data-skills-cut>The export keeps only the first names of a long list, so a skill may be missing.</p>}
          </Section>
        </>
      )}
      <Section title="Plugins"><p className="ad-note team-dim" data-plugins-line>{data?.plugins.text ?? PLUGINS_LINE}</p></Section>
      <Section title="Install skills"><div className="tk-packs"><Packs /></div></Section>
    </div>
  )
  const skill = id && data ? data.skills.find(item => item.id === id) ?? null : null
  const detail = id
    ? (data ? <SkillPage skill={skill} /> : <div className="team-detail">{guest ? <p className="hub-empty">{GUEST_LINE}</p> : <p className={load.error ? 'hub-error' : 'hub-empty'}>{load.error ?? 'Loading…'}</p>}</div>)
    : desktop && data?.skills[0] ? <SkillPage skill={data.skills[0]} /> : undefined
  return <Split list={list} detail={detail} empty="Pick a skill from the list." />
}
