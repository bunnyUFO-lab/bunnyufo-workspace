import { Fragment, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { host } from '../lib/host'
import { useLibrary } from '../lib/library'
import { isArchived } from '../library/libraryModel'
import type { ChatSummary, HubProject, JobsView } from '../lib/hub'
import type { TeamSkillsView, TeamView } from '../lib/hubTeam'
import type { SearchRow } from '../hub/beadSearch'
import { TodayContext, useHubData } from '../hub/useHub'
import { openSpawn } from '../hub/spawnStore'
import { askHermes } from '../hub/askHermes'
import { afterBack, go, useEntryMemo } from '../lib/entries'
import { hubHash } from '../lib/route'
import { Chip, ChipRow } from '../ui/Controls'
import Icon from '../ui/Icon'
import SearchIcon from './SearchIcon'
import {
  FILTERS, KIND_NOUN, KIND_SCREEN, KIND_TITLE, PAGE, countsOf, groupsFor, pushRecent, queryWords, readRecent, searchRows, segments, tileRows,
  type ChatHit, type Group, type Hit, type HitIcon, type Kind, type Recent,
} from './searchIndex'
import './search.css'

type Chosen = 'all' | Kind

/** One thing a key or a tap can open: a result, a tile, a recent pick, or a command. A command has no address; it leaves Search first, then runs. */
interface Option {
  id: string
  title: string
  sub?: string
  icon: HitIcon
  hash?: string
  run?: () => void
  /** Picked from here, it is remembered in Recent. A command is not. */
  record?: boolean
  tile?: boolean
}

interface Section { id: string; title: string; kind?: Kind; link?: { label: string; onClick: () => void; data: string }; options: Option[]; tiles?: boolean; more?: () => void }

const NO_HITS: ChatHit[] = []
const NONE: never[] = []
const MIN_TEXT = 2
const DEBOUNCE_MS = 300

const optionOf = (row: Hit): Option => ({ id: `${row.kind}:${row.key}`, title: row.title, sub: row.sub, icon: row.icon, hash: row.hash, record: true })

/** Text with the words of the query marked. The marks are elements, never HTML from the text. */
function Marked({ text, q }: { text: string; q: string }) {
  return <>{segments(text, q).map((part, index) => (part.mark ? <mark key={index}>{part.text}</mark> : <Fragment key={index}>{part.text}</Fragment>))}</>
}

const plural = (count: number, kind: Kind) => (count === 1 ? `1 ${KIND_NOUN[kind][0]}` : `${count} ${KIND_NOUN[kind][1]}`)

/**
 * Search: one screen, two drawings. On a phone it is a full screen with the tab bar under it; from 900 px it is a dialog over the
 * screen it was opened from (App keeps that screen mounted). The text, the chip and the scroll are kept against the history entry
 * (`useEntryMemo`), so Back from a result finds them again. A result opens with `go`, so search stays behind it.
 */
export default function Search({ desktop, onClose }: {
  desktop: boolean
  /** Cancel, Esc and the backdrop: one step back. Picking a result does not call it. */
  onClose: () => void
}) {
  const { cards } = useLibrary()
  const today = useContext(TodayContext)
  const dialog = useRef<HTMLDialogElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const uid = useId()
  const [q, setQ] = useEntryMemo('q', '')
  const [chip, setChip] = useEntryMemo<Chosen>('chip', 'all')
  const [savedScroll, saveScroll] = useEntryMemo('scroll', 0)
  const [selected, setSelected] = useState(0)
  const [recent, setRecent] = useState<Recent[]>(() => readRecent(safeStorage()))
  const [paged, setPaged] = useState({ key: '', pages: 1 })

  const typed = q.trim()
  const words = queryWords(q)
  const textTyped = typed.length >= MIN_TEXT

  // Open as a modal dialog on a desktop, and give the focus back to where it was when Search goes. A phone's keyboard stays closed until the field is tapped.
  useEffect(() => {
    if (!desktop) return undefined
    const before = document.activeElement as HTMLElement | null
    const el = dialog.current
    if (el && !el.open) el.showModal()
    input.current?.focus()
    return () => {
      if (el?.open) el.close()
      const now = document.activeElement
      if (before && document.contains(before) && (!now || now === document.body || now === el)) before.focus({ preventScroll: true })
    }
  }, [desktop])

  // What is read, only while Search is open (this component is only mounted then). One request each; useHubData stops them on unmount.
  const projects = useHubData<{ projects: HubProject[] }>(host.hub ? '/projects' : null)
  const jobs = useHubData<JobsView>(host.hub ? '/jobs' : null)
  const team = useHubData<TeamView>(host.hub ? '/team' : null)
  // Skills need sign-in: a guest's 401 reads as no skills, and the rest of Search works.
  const skills = useHubData<TeamSkillsView>(host.hub ? '/team/skills' : null)
  const chats = useHubData<{ conversations: ChatSummary[] }>(host.chat ? '/chat?view=all&limit=100' : null)
  // Tasks and message hits are read only while text is typed, and only where their chip is showing.
  const wantsTasks = host.hub && textTyped && (chip === 'all' || chip === 'tasks')
  const beads = useHubData<{ rows: SearchRow[] }>(wantsTasks ? '/search-text' : null)
  const [settled, setSettled] = useState(typed)
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(typed), DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [typed])
  const messageText = settled.length >= MIN_TEXT && settled.length <= 200 && typed.length >= MIN_TEXT
  const wantsMessages = host.chat && messageText && (chip === 'all' || chip === 'chats')
  const found = useHubData<{ hits: ChatHit[]; warming?: boolean }>(wantsMessages ? `/chat/search?q=${encodeURIComponent(settled)}&limit=50` : null)
  // The last answer stays up while the next one is on its way, so the chips' counts do not blink at every pause.
  const [lastHits, setLastHits] = useState<ChatHit[]>(NO_HITS)
  const answered = Array.isArray(found.data?.hits) ? found.data!.hits : null
  if (answered && answered !== lastHits) setLastHits(answered)
  const hits = !messageText ? NO_HITS : answered ?? lastHits
  // Right after a deploy the Hub may still be reading older chats: look once more, a few seconds on.
  const warming = !!found.data?.warming
  const retried = useRef('')
  const reloadHits = found.reload
  useEffect(() => {
    if (!warming || retried.current === settled) return undefined
    const timer = window.setTimeout(() => { retried.current = settled; reloadHits() }, 4000)
    return () => window.clearTimeout(timer)
  }, [warming, settled, reloadHits])

  const cardSources = useMemo(() => cards.map(card => ({ id: card.id, title: card.title, description: card.description, category: card.category, archived: isArchived(card), workspace: { id: card.workspace.id, name: card.workspace.name, active: card.workspace.active } })), [cards])
  // An answer that is not what was asked for (a page, a null) reads as nothing: no error, and the rest of Search works.
  const todayData = today?.data ?? null
  const needsList = useMemo(() => (Array.isArray(todayData?.needsYou) ? todayData.needsYou : NONE), [todayData])
  const projectList = useMemo(() => (Array.isArray(projects.data?.projects) ? projects.data!.projects : NONE), [projects.data])
  const jobList = useMemo(() => (Array.isArray(jobs.data?.jobs) ? jobs.data!.jobs : NONE), [jobs.data])
  const agentList = useMemo(() => (Array.isArray(team.data?.agents) ? team.data!.agents : NONE), [team.data])
  const skillList = useMemo(() => (Array.isArray(skills.data?.skills) ? skills.data!.skills.map(skill => skill.id).filter(id => typeof id === 'string' && id) : NONE), [skills.data])
  const chatList = useMemo(() => (Array.isArray(chats.data?.conversations) ? chats.data!.conversations.map(chat => ({ id: chat.id, title: chat.title, persona: chat.persona ?? null, archived: !!(chat as { archived?: unknown }).archived })) : NONE), [chats.data])
  const beadRows = useMemo(() => (wantsTasks && Array.isArray(beads.data?.rows) ? beads.data!.rows : NONE), [wantsTasks, beads.data])
  const rows = useMemo(() => searchRows({
    caps: { hub: host.hub, write: host.write, chat: host.chat },
    cards: cardSources,
    items: needsList,
    projects: projectList,
    jobs: jobList,
    agents: agentList,
    skills: skillList,
    chats: chatList,
    beads: beadRows,
    hits,
  }, q), [cardSources, needsList, projectList, jobList, agentList, skillList, chatList, beadRows, hits, q])
  const counts = useMemo(() => countsOf(rows), [rows])
  const needs = needsList.length

  const chips = FILTERS.filter(kind => (kind === 'library' || kind === 'screens') || (kind === 'chats' ? host.chat : host.hub))
  const shownChip: Chosen = chip === 'all' || chips.includes(chip) ? chip : 'all'

  const startJob = (text?: string) => afterBack(hubHash('today'), () => openSpawn(text ? { text } : {}))

  // The sections, top to bottom. Before anything is typed (All): Recent, the screens, then what to start. Typed: groups, then what to start.
  const sections: Section[] = useMemo(() => {
    const out: Section[] = []
    const startOptions = (text: string): Option[] => {
      const list: Option[] = []
      const bare = text.replace(/^(?:spawn|new job)\b[:\s]*/i, '').trim()
      if (!text) {
        if (host.chat) list.push({ id: 'start:chat', title: 'New chat', sub: 'Talk to Hermes', icon: 'chat', run: () => go(hubHash('chat', 'new')) })
        if (host.hub && host.write) list.push({ id: 'start:job', title: 'New job', sub: 'Ask an agent to do something', icon: 'job', run: () => startJob() })
        return list
      }
      if (host.chat) list.push({ id: 'start:ask', title: `Ask Hermes: ${text}`, sub: 'Starts a new chat', icon: 'sparkle', run: () => askHermes(text, () => { go(hubHash('chat')) }) })
      if (host.hub && host.write) list.push({ id: 'start:job', title: bare ? `New job: ${bare}` : 'New job', sub: 'Ask an agent to do it', icon: 'job', run: () => startJob(bare) })
      return list
    }
    if (shownChip === 'all' && !typed) {
      if (recent.length) out.push({ id: 'recent', title: 'Recent', options: recent.map(entry => ({ id: `recent:${entry.hash}`, title: entry.title, sub: entry.sub, icon: entry.icon, hash: entry.hash, record: true })) })
      const tiles = tileRows({ hub: host.hub, write: host.write, chat: host.chat })
      out.push({ id: 'screens', title: 'Open a screen', tiles: true, options: tiles.map(row => ({ ...optionOf(row), tile: true })) })
      const start = startOptions('')
      if (start.length) out.push({ id: 'start', title: 'Start something', options: start })
      return out
    }
    const pages = paged.key === `${shownChip}|${q}` ? paged.pages : 1
    const groups: Group[] = groupsFor(rows, shownChip, PAGE * pages)
    const opening = (id: string, hash: string) => ({ id, onClick: () => go(hash) })
    for (const group of groups) {
      if (shownChip === 'all' && !group.rows.length) continue
      const screen = KIND_SCREEN[group.kind]
      const section: Section = { id: group.kind, kind: group.kind, title: shownChip === 'all' ? group.title : group.kind === 'team' && group.total !== 1 ? `${group.total} agents and skills` : plural(group.total, group.kind), options: group.rows.map(optionOf) }
      if (group.all) section.link = { label: `All ${group.total}`, data: `all-${group.kind}`, onClick: () => { setChip(group.kind); setSelected(0) } }
      else if (shownChip !== 'all' && screen) section.link = { label: screen[1], data: `open-${group.kind}`, onClick: opening(group.kind, screen[0]).onClick }
      if (shownChip !== 'all' && group.total > group.rows.length) section.more = () => setPaged({ key: `${shownChip}|${q}`, pages: pages + 1 })
      out.push(section)
    }
    const start = typed && shownChip === 'all' ? startOptions(typed) : []
    if (start.length) {
      const jobFirst = /^(?:spawn|new job)\b/i.test(typed)
      const section: Section = { id: 'start', title: 'Start something', options: jobFirst ? [...start].reverse() : start }
      if (jobFirst) out.unshift(section); else out.push(section)
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, shownChip, typed, q, recent, paged])

  const flat = useMemo(() => sections.flatMap(section => section.options), [sections])
  const at = Math.min(selected, Math.max(flat.length - 1, 0))
  const chosenId = flat[at]?.id
  useEffect(() => {
    if (!desktop) return
    scroller.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [at, desktop, sections])

  // Back from a result finds the list where it was. The rows may still be arriving, so the scroll is set once the content is tall enough.
  const lastScroll = useRef(savedScroll)
  const restoring = useRef(savedScroll > 0)
  useLayoutEffect(() => {
    const el = scroller.current
    if (!el || !restoring.current) return
    if (el.scrollHeight - el.clientHeight >= savedScroll) { el.scrollTop = savedScroll; restoring.current = false }
  })
  useEffect(() => {
    const timer = window.setTimeout(() => { restoring.current = false }, 2500)
    return () => {
      window.clearTimeout(timer)
      saveScroll(lastScroll.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const resetScroll = () => { lastScroll.current = 0; restoring.current = false; if (scroller.current) scroller.current.scrollTop = 0 }

  const choose = (option: Option | undefined) => {
    if (!option) return
    if (option.hash) {
      // A place is a step forward from the search, so Back returns to it. It is remembered, and Search closes because the address moves on.
      if (option.record) setRecent(pushRecent(safeStorage(), { title: option.title, sub: option.sub ?? '', icon: option.icon, hash: option.hash }))
      go(option.hash)
    } else {
      // A command (Ask Hermes, New job) leaves the search first, then runs.
      option.run?.()
    }
  }

  const pickChip = (next: Chosen) => {
    setChip(next)
    setSelected(0)
    resetScroll()
    if (desktop) input.current?.focus()
  }

  const onKey = (event: ReactKeyboardEvent) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (flat.length) setSelected((at + (event.key === 'ArrowDown' ? 1 : flat.length - 1)) % flat.length)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      choose(flat[at])
    } else if (event.key === 'Tab') {
      // The field is the only stop: the rows are reached with the arrows.
      event.preventDefault()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
    }
  }

  const listId = `${uid}-list`
  const optionNode = (option: Option, index: number) => {
    const on = option.id === chosenId
    const common = {
      id: `${uid}-row-${index}`, role: 'option', 'aria-selected': on, 'data-search-row': option.id, onClick: () => choose(option),
      onMouseMove: () => { if (desktop && !on) setSelected(index) },
    } as const
    if (option.tile) {
      return <button key={option.id} type="button" className={`srch-tile${on ? ' on' : ''}`} data-search-tile="" {...common}><SearchIcon name={option.icon} /><span>{option.title}</span></button>
    }
    return (
      <button key={option.id} type="button" className={`srch-i${on ? ' on' : ''}`} {...common}>
        <span className="srch-i-icon"><SearchIcon name={option.icon} /></span>
        <span className="srch-i-body"><b><Marked text={option.title} q={q} /></b>{option.sub && <small><Marked text={option.sub} q={q} /></small>}</span>
      </button>
    )
  }

  let index = -1
  const noText = shownChip !== 'all' && !typed
  const empty = shownChip !== 'all' && sections.every(section => !section.options.length)
  const body = (
    <>
      <div className="srch-head">
        <label className="srch-field">
          <Icon name="search" size={18} />
          <input
            ref={input}
            type="search"
            value={q}
            onChange={event => { setQ(event.target.value); setSelected(0); resetScroll() }}
            onKeyDown={onKey}
            placeholder={host.hub ? 'Search chats, cards, projects, jobs, agents' : 'Search cards'}
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={flat.length ? `${uid}-row-${at}` : undefined}
            aria-label="Search"
            autoComplete="off"
            spellCheck={false}
            enterKeyHint="go"
            data-search-input=""
          />
        </label>
        <button type="button" className="srch-cancel" data-search-cancel="" onClick={onClose}>Cancel</button>
      </div>
      <ChipRow label="Filter results">
        {host.hub && (
          <>
            <Chip data-search-jump="needs" onClick={() => go(hubHash('needs'))} count={needs || undefined}><SearchIcon name="inbox" size={18} />Needs you</Chip>
            <Chip data-search-jump="today" onClick={() => go(hubHash('today'))}><SearchIcon name="today" size={18} />Today</Chip>
            <span className="srch-gap" aria-hidden="true" />
          </>
        )}
        <Chip data-search-chip="all" on={shownChip === 'all'} onClick={() => pickChip('all')}>All</Chip>
        {chips.map(kind => <Chip key={kind} data-search-chip={kind} on={shownChip === kind} count={counts[kind]} onClick={() => pickChip(kind)}>{KIND_TITLE[kind]}</Chip>)}
      </ChipRow>
      <div
        className="srch-res"
        ref={scroller}
        role="listbox"
        id={listId}
        aria-label="Results"
        data-search-results=""
        onScroll={event => { if (!restoring.current) lastScroll.current = event.currentTarget.scrollTop }}
      >
        {sections.map(section => (
          <div key={section.id} role="group" aria-labelledby={`${uid}-g-${section.id}`} data-search-group={section.id}>
            <div className="srch-g"><span id={`${uid}-g-${section.id}`}>{section.title}</span>{section.link && <button type="button" data-search-link={section.link.data} onClick={section.link.onClick}>{section.link.label}</button>}</div>
            {section.tiles
              ? <div className="srch-tiles">{section.options.map(option => optionNode(option, ++index))}</div>
              : section.options.map(option => optionNode(option, ++index))}
            {section.more && <button type="button" className="srch-more" data-search-more="" onClick={section.more}>Show more</button>}
          </div>
        ))}
        {noText && <p className="srch-empty" data-search-empty="">{shownChip === 'tasks' ? 'Type two letters or more to search tasks.' : `Nothing in ${KIND_TITLE[shownChip]} yet.`}</p>}
        {empty && !noText && <p className="srch-empty" data-search-empty="">Nothing in {KIND_TITLE[shownChip as Kind]} for &ldquo;{typed}&rdquo;.</p>}
        {shownChip === 'all' && typed && !flat.some(option => !option.id.startsWith('start:')) && <p className="srch-empty" data-search-empty="">Nothing found for &ldquo;{typed}&rdquo;.</p>}
        {warming && (shownChip === 'all' || shownChip === 'chats') && <p className="srch-note" role="status" data-chat-warming="">Still reading older chats. More may show in a moment.</p>}
      </div>
      {desktop && (
        <div className="srch-foot" aria-hidden="true">
          <span><kbd>↑</kbd><kbd>↓</kbd> move</span>
          <span><kbd>Enter</kbd> open</span>
          <span><kbd>Esc</kbd> close</span>
        </div>
      )}
    </>
  )

  if (!desktop) {
    return <section className="srch srch-screen" aria-label="Search" data-search="screen" data-words={words.length}>{body}</section>
  }
  return (
    <dialog
      ref={dialog}
      className="srch srch-dialog"
      aria-label="Search"
      data-search="dialog"
      onCancel={event => { event.preventDefault(); onClose() }}
      onClick={event => { if (event.target === event.currentTarget) onClose() }}
    >
      {body}
    </dialog>
  )
}

function safeStorage(): Storage | null {
  try { return window.localStorage } catch { return null }
}
