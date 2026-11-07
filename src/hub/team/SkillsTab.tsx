import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ago, remember } from '../../lib/hub'
import { swap } from '../../lib/entries'
import { hubHash } from '../../lib/route'
import type { TeamPlugin, TeamSkill, TeamSkillsView } from '../../lib/hubTeam'
import { Fold, List, Row, Section, Split } from '../../ui/Layout'
import { Button, Segment } from '../../ui/Controls'
import SearchField from '../SearchField'
import { useRoute } from './useRoute'
import {
  agentsLine, autoOf, BY_KEY, byOf, exportLine, folderOf, foldOpen, groupByFolder, groupPluginRows, GUEST_LINE, listGroups, NO_PLUGINS_LINE, openSkill, OPEN_KEY, PLUGINS_LINE,
  previewOf, profileText, readOpen, SHARED_LINE, SHORT_LIST, sharedText, skillHash, skillMatches, type AgentGroup, type GroupPluginRow, type SkillsBy,
} from './skillsModel'

const Tags = ({ skill }: { skill: TeamSkill }) => (
  <span className="tk-tags">
    {skill.autoLoad && <span className="ad-tag" data-tag="every-reply">Every reply</span>}
    {skill.owner && <span className="ad-tag" data-tag="yours">Yours</span>}
  </span>
)

const leafOf = (id: string, folder: string) => (folder ? id.slice(folder.length + 1) : id)

/** A row of By skill: the skill and, under it, who has it. */
function SkillRow({ skill, on, line, folder }: { skill: TeamSkill; on: boolean; line: string; folder: string }) {
  return (
    <a role="listitem" className={`ui-row tk-skill${on ? ' on' : ''}`} href={skillHash(skill.id)} data-skill={skill.id} aria-current={on ? 'page' : undefined}>
      <span className="ui-row-body"><b>{leafOf(skill.id, folder)}</b><small>{line}</small></span>
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

function PluginRowView({ row }: { row: GroupPluginRow }) {
  const detail = [row.version && `v${row.version}`, row.source].filter(Boolean).join(' · ')
  return (
    <div role="listitem" className={`ui-row tk-skill tk-plugin${row.status === 'enabled' ? '' : ' off'}`} data-plugin={row.name} data-plugin-status={row.status}>
      <span className="ui-row-body"><b>{row.name}</b><small>{detail}</small>{row.description && <small className="tk-desc">{row.description}</small>}{row.line && <small className="tk-desc" data-plugin-line>{row.line}</small>}</span>
      <span className={`ad-tag${row.status === 'enabled' ? ' on' : ''}`}>{row.status === 'differs' ? 'Differs' : STATUS_WORD[row.status]}</span>
    </div>
  )
}

/** A group with nothing to fold: Claude Code (the Hub has no list), a group with no skill, or one nothing matches. */
function GroupCard({ group, children, data }: { group: AgentGroup; children: ReactNode; data?: Record<string, string> }) {
  const names = group.agents.map(agent => agent.name).join(', ')
  return (
    <section className="tk-card" data-agent-group={group.key} aria-label={names} {...data}>
      <h3 className="tk-card-h">{names}</h3>
      {children}
    </section>
  )
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/** What closes a section's head: the number of rows (or "2 of 6" while a search narrows it), and "2 every reply" so a closed section never hides what loads on each reply. */
function End({ shown, total, auto, on }: { shown: number; total: number; auto?: number; on?: number }) {
  return (
    <span className="tk-end">
      {!!auto && <span className="ad-tag" data-fold-auto>{auto} every reply</span>}
      <span className="tk-n" data-fold-count>{shown === total ? total : `${shown} of ${total}`}</span>
      {on !== undefined && <span className="tk-n" data-fold-on>{on} on</span>}
    </span>
  )
}

interface Cat { key: string; fallback: boolean }
interface Plan { groupKey: string | null; cats: Cat[] }

/**
 * Team's second half: what the Hermes host has installed, and who can use it. Two ways to read it, By agent (agents that share a
 * list are one group, folded by category) and By skill (each skill with its agents). A search box covers both and opens whatever
 * matches without writing what the user opened or closed. Nothing here switches a skill: the Hub holds no list of who can use
 * what, only what the export says. `head` is the Team heading and tabs.
 */
export default function SkillsTab({ id, head, desktop }: { id: string | null; head: ReactNode; desktop: boolean }) {
  const load = useRoute<TeamSkillsView>('/team/skills')
  const data = load.data
  const guest = load.status === 401
  const [stored, setStored] = useState<SkillsBy>(() => byOf(remember(BY_KEY)))
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState<Record<string, boolean>>(() => readOpen(remember(OPEN_KEY)))
  const pending = useRef<{ id: string; block: ScrollLogicalPosition } | null>(null)
  const lastId = useRef<string | null>(null)
  // A skill's address always reads By skill. The choice is kept in this browser; switching adds no back step.
  const by: SkillsBy = id ? 'skill' : stored
  const pick = (next: SkillsBy) => {
    setStored(next)
    remember(BY_KEY, next)
    if (next === 'agent' && id) swap(hubHash('team', 'skills'))
  }
  const q = query.trim()
  const searching = q !== ''
  const match = (text: string) => skillMatches(text, q)
  // Beside the list (900 px and up) the open skill is the current one while it matches the search, else the first match. An address with no search is kept as it is.
  const shownId = !data ? id : (id && !searching) || !desktop ? id : openSkill(data.skills.map(item => item.id), id, query)
  const selected = by === 'skill' ? shownId : null
  const note = data ? exportLine(data, data.exportedAt ? ago(data.exportedAt) : '') : null

  const groups = useMemo(() => (data ? listGroups(data) : []), [data])
  const owned = useMemo(() => new Set((data?.skills ?? []).filter(skill => skill.owner).map(skill => skill.id)), [data])
  // What there is to fold, whatever is searched: the groups and categories with the state each starts in.
  const plan = useMemo<Plan[]>(() => {
    if (!data) return []
    const cats = (prefix: string, ids: string[], plugins: number): Cat[] => {
      const folders = groupByFolder(ids.map(item => ({ id: item })))
      const keys = [...folders.map(folder => ({ key: `${prefix}/${folder.folder}` })), ...(plugins ? [{ key: `${prefix}/plugins` }] : [])]
      const fallback = ids.length + plugins <= SHORT_LIST || keys.length === 1
      return keys.map(item => ({ ...item, fallback }))
    }
    if (by === 'agent') return groups.filter(group => group.skills).map(group => ({ groupKey: `group:${group.key}`, cats: cats(group.key, group.skills ?? [], groupPluginRows(data, group)?.length ?? 0) }))
    return [{ groupKey: null, cats: cats('skill', data.skills.map(skill => skill.id), data.plugins.known ? data.plugins.items.length : 0) }]
  }, [data, groups, by])
  const allCats = plan.flatMap(item => item.cats)
  const isOpen = (key: string, fallback: boolean) => searching || foldOpen(key, open, fallback)
  const catsOpen = (item: Plan) => item.cats.every(cat => foldOpen(cat.key, open, cat.fallback))
  const liveGroups = plan.filter(item => item.groupKey === null || foldOpen(item.groupKey, open, true))
  const allOpen = liveGroups.length > 0 && liveGroups.every(catsOpen)

  const write = (next: Record<string, boolean>) => { setOpen(next); remember(OPEN_KEY, JSON.stringify(next)) }
  const toggle = (key: string, now: boolean) => write({ ...open, [key]: !now })
  const foldAll = () => {
    const next = { ...open }
    if (allOpen) for (const cat of allCats) next[cat.key] = false
    else {
      for (const item of plan) { if (item.groupKey) next[item.groupKey] = true }
      for (const cat of allCats) next[cat.key] = true
    }
    write(next)
  }

  // A section holding the open skill is open: after an address change, and for the first skill beside the list unless the user chose.
  const revealId = by === 'skill' && data ? id ?? (desktop && !searching ? shownId : null) : null
  const forced = !!id
  const [revealed, setRevealed] = useState('')
  // Set while drawing, not in an effect, so the section is open in the same frame (React's pattern for state that follows a prop).
  const revealKey = revealId ? `${forced ? 'go' : 'first'}:${revealId}` : ''
  if (revealKey !== revealed) {
    setRevealed(revealKey)
    if (revealId) {
      const key = `skill/${folderOf(revealId)}`
      if (forced ? open[key] !== true : typeof open[key] !== 'boolean') setOpen({ ...open, [key]: true })
    }
  }
  useEffect(() => {
    if (id) { lastId.current = id; pending.current = { id, block: 'nearest' } }
    else if (!desktop && lastId.current) { pending.current = { id: lastId.current, block: 'center' }; lastId.current = null }
  }, [id, desktop])
  // After every draw: once the wanted row is on screen (a phone's list is hidden while a page shows), bring it into view.
  useEffect(() => {
    const want = pending.current
    if (!want || !data) return
    const row = Array.from(document.querySelectorAll<HTMLElement>('[data-skill]')).find(node => node.dataset.skill === want.id)
    if (row && row.offsetParent !== null) { row.scrollIntoView({ block: want.block }); pending.current = null }
  })

  /** One category: a fold in a group (level 4) or in By skill (level 3). Not drawn during a search when nothing in it matches. */
  const category = (key: string, fallback: boolean, c: { level: 3 | 4; title: string; data: Record<string, string>; names: string[]; total: number; shown: number; auto?: number; on?: number; rows: () => ReactNode; label: string }) => {
    if (searching && c.shown === 0) return null
    const opened = isOpen(key, fallback)
    return (
      <Fold key={key} level={c.level} title={c.title} sub={opened ? undefined : previewOf(c.names)} end={<End shown={c.shown} total={c.total} auto={c.auto} on={c.on} />}
        open={opened} onToggle={searching ? undefined : () => toggle(key, opened)} data={{ ...c.data, 'data-fold': key }}>
        <List label={c.label}>{c.rows()}</List>
      </Fold>
    )
  }

  const groupNode = (group: AgentGroup) => {
    if (!data) return null
    const names = group.agents.map(agent => agent.name).join(', ')
    if (group.skills === null) return <GroupCard key={group.key} group={group}><p className="hub-empty" data-group-unknown>{group.profile ? 'Not known: the Hermes host has not published the skills of this profile.' : group.note}</p></GroupCard>
    const all = group.skills
    const shownIds = searching ? all.filter(item => match(item)) : all
    const pluginsAll = groupPluginRows(data, group) ?? []
    const pluginsShown = searching ? pluginsAll.filter(row => match(`${row.name} ${row.description}`)) : pluginsAll
    if (!all.length && !pluginsAll.length) return <GroupCard key={group.key} group={group}><p className="hub-empty" data-group-none>No skill is installed.</p></GroupCard>
    if (searching && !shownIds.length && !pluginsShown.length) return <GroupCard key={group.key} group={group}><p className="hub-empty" data-group-none>No skill here matches.</p></GroupCard>
    const fallbacks = new Map((plan.find(item => item.groupKey === `group:${group.key}`)?.cats ?? []).map(cat => [cat.key, cat.fallback]))
    const full = groupByFolder(all.map(item => ({ id: item })))
    const every = new Set(group.autoLoad)
    const shared = sharedText(group)
    const on = pluginsAll.filter(row => row.status === 'enabled').length
    const key = `group:${group.key}`
    const opened = isOpen(key, true)
    return (
      <Fold key={group.key} level={3} title={names} open={opened} onToggle={searching ? undefined : () => toggle(key, opened)} data={{ 'data-agent-group': group.key, 'data-fold': key }}
        sub={<>
          <span data-group-shared={shared ? '' : undefined}>{shared ?? 'Has its own list.'}{` ${count(all.length, 'skill', 'skills')}.`}</span>
          {pluginsAll.length > 0 && ` ${count(on, 'plugin', 'plugins')} on.`}
        </>}>
        {groupByFolder(shownIds.map(item => ({ id: item }))).map(folder => {
          const catKey = `${group.key}/${folder.folder}`
          const whole = full.find(item => item.folder === folder.folder)?.items ?? []
          return category(catKey, fallbacks.get(catKey) ?? true, {
            level: 4, title: folder.label, data: { 'data-folder': folder.folder }, label: folder.label,
            names: whole.map(item => leafOf(item.id, folder.folder)), total: whole.length, shown: folder.items.length, auto: whole.filter(item => every.has(item.id)).length,
            rows: () => folder.items.map(({ id: skill }) => {
              const auto = autoOf(group, skill)
              return (
                <a key={skill} role="listitem" className="ui-row tk-skill" href={skillHash(skill)} data-skill={skill}>
                  <span className="ui-row-body"><b>{leafOf(skill, folder.folder)}</b>{auto?.only && <small data-tag-only>{auto.only}</small>}</span>
                  <span className="tk-tags">
                    {auto && <span className="ad-tag" data-tag="every-reply">Every reply</span>}
                    {owned.has(skill) && <span className="ad-tag" data-tag="yours">Yours</span>}
                  </span>
                </a>
              )
            }),
          })
        })}
        {pluginsAll.length > 0 && category(`${group.key}/plugins`, fallbacks.get(`${group.key}/plugins`) ?? true, {
          level: 4, title: 'Plugins', data: { 'data-group-plugins': '' }, label: 'Plugins', names: pluginsAll.map(row => row.name), total: pluginsAll.length, shown: pluginsShown.length, on,
          rows: () => pluginsShown.map(row => <PluginRowView key={row.name} row={row} />),
        })}
      </Fold>
    )
  }

  const bySkillNode = () => {
    if (!data) return null
    if (!data.skills.length && !(data.plugins.known && data.plugins.items.length)) return <p className="hub-empty" data-skills-none>The export names no skills.</p>
    const shownSkills = data.skills.filter(skill => match(skill.id))
    const plugins = data.plugins.known ? data.plugins.items : []
    const shownPlugins = searching ? plugins.filter((item: TeamPlugin) => match(`${item.name} ${item.description}`)) : plugins
    if (searching && !shownSkills.length && !shownPlugins.length) return <p className="hub-empty" data-skills-no-match>No skill or plugin matches.</p>
    const fallbacks = new Map((plan[0]?.cats ?? []).map(cat => [cat.key, cat.fallback]))
    const full = groupByFolder(data.skills)
    const peopleOn = (item: TeamPlugin) => data.agents.filter(agent => item.profiles.some(entry => entry.profile === agent.profile && entry.status === 'enabled')).map(agent => agent.name)
    return (
      <>
        {groupByFolder(shownSkills).map(folder => {
          const catKey = `skill/${folder.folder}`
          const whole = full.find(item => item.folder === folder.folder)?.items ?? []
          return category(catKey, fallbacks.get(catKey) ?? true, {
            level: 3, title: folder.label, data: { 'data-folder': folder.folder }, label: folder.label,
            names: whole.map(item => leafOf(item.id, folder.folder)), total: whole.length, shown: folder.items.length, auto: whole.filter(item => item.autoLoad).length,
            rows: () => folder.items.map(skill => <SkillRow key={skill.id} skill={skill} on={skill.id === selected} line={agentsLine(skill, data)} folder={folder.folder} />),
          })
        })}
        {plugins.length > 0 && category('skill/plugins', fallbacks.get('skill/plugins') ?? true, {
          level: 3, title: 'Plugins', data: { 'data-by-plugins': '' }, label: 'Plugins', names: plugins.map(item => item.name), total: plugins.length, shown: shownPlugins.length, on: plugins.filter(item => peopleOn(item).length).length,
          rows: () => shownPlugins.map(item => {
            const people = peopleOn(item)
            return (
              <div key={item.name} role="listitem" className="ui-row tk-skill tk-plugin" data-plugin={item.name}>
                <span className="ui-row-body"><b>{item.name}</b><small>{people.length ? `On for ${people.join(', ')}` : 'Not on for any agent'}</small></span>
              </div>
            )
          }),
        })}
      </>
    )
  }

  // While a search runs, the Expand all button gives way to what it found, in the same place.
  const found = (() => {
    if (!data || !searching) return ''
    const skillIds = new Set<string>()
    const pluginNames = new Set<string>()
    if (by === 'agent') {
      for (const group of groups) {
        for (const item of group.skills ?? []) if (match(item)) skillIds.add(item)
        for (const row of groupPluginRows(data, group) ?? []) if (match(`${row.name} ${row.description}`)) pluginNames.add(row.name)
      }
    } else {
      for (const skill of data.skills) if (match(skill.id)) skillIds.add(skill.id)
      for (const item of data.plugins.known ? data.plugins.items : []) if (match(`${item.name} ${item.description}`)) pluginNames.add(item.name)
    }
    const parts = [skillIds.size && count(skillIds.size, 'skill', 'skills'), pluginNames.size && count(pluginNames.size, 'plugin', 'plugins')].filter(Boolean)
    return parts.length ? parts.join(', ') : 'No match'
  })()

  const tools = data && (
    <div className="tk-tools">
      <Segment<SkillsBy> label="Read by" value={by} onChange={pick} options={[{ id: 'agent', label: 'By agent' }, { id: 'skill', label: 'By skill' }]} />
      <div className="tk-find">
        <SearchField value={query} onChange={setQuery} label="Search skills and plugins" placeholder="Search skills and plugins" data={{ 'data-skills-search': '' }}
          onKeyDown={event => { if (event.key === 'Escape' && query) { event.preventDefault(); setQuery('') } }} />
        {searching
          ? <span className="tk-found" role="status" data-skills-found>{found}</span>
          : allCats.length > 0 && <Button tone="ghost" className="tk-all" data-skills-all onClick={foldAll}>{allOpen ? 'Collapse all' : 'Expand all'}</Button>}
      </div>
    </div>
  )
  // From 900 px the heading, tabs and tools are a band above both panes, so the switch never moves; on a phone they lead the one pane.
  const top = <>{head}{tools}</>

  const body = (
    <>
      {guest && <p className="hub-empty" role="status" data-skills-signin>{GUEST_LINE}</p>}
      {!data && !guest && <p className={load.error ? 'hub-error' : 'hub-empty'} role={load.error ? 'alert' : undefined}>{load.error ?? 'Loading…'}</p>}
      {data && (
        <>
          {note?.warn && <p className="hub-banner ad-note" role="note" data-skills-freshness={data.exportedAt ? (data.fresh ? 'fresh' : 'stale') : 'none'}>{note.text}</p>}
          {by === 'agent'
            ? <div className="tk-groups" data-skills-by="agent">{groups.map(groupNode)}</div>
            : <div className="tk-bysk" data-skills-by="skill">{bySkillNode()}</div>}
        </>
      )}
      <div className="tk-foot">
        {note && !note.warn && data && <p className="ad-note team-dim" data-skills-freshness={data.exportedAt ? (data.fresh ? 'fresh' : 'stale') : 'none'}>{note.text}</p>}
        {data && !data.plugins.known && <p className="ad-note team-dim" data-plugins-unknown>{NO_PLUGINS_LINE}</p>}
        {data?.maybeCut && <p className="ad-note team-dim" data-skills-cut>The export keeps only the first names of a long list, so a skill may be missing.</p>}
        <p className="ad-note team-dim" data-plugins-line>{data?.plugins.text ?? PLUGINS_LINE}</p>
      </div>
    </>
  )
  const list = <div className="team-pane tk-pane">{!desktop && top}{body}</div>
  const split = by === 'agent'
    ? <Split list={list} fill />
    : <Split list={list} empty="Pick a skill from the list." detail={id && !data
      ? <div className="team-detail">{guest ? <p className="hub-empty">{GUEST_LINE}</p> : <p className={load.error ? 'hub-error' : 'hub-empty'}>{load.error ?? 'Loading…'}</p>}</div>
      : data && shownId !== null ? <SkillPage skill={data.skills.find(item => item.id === shownId) ?? null} /> : undefined} />
  return desktop ? <div className="tk-shell"><div className="tk-top">{top}</div>{split}</div> : split
}
