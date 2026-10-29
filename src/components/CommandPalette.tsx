import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { WorkspaceCard } from '../types'
import { host } from '../lib/host'
import { hubRows } from '../lib/hubNav'
import { hubGet, type HubProject, type Item } from '../lib/hub'
import { entityHash, hubHash, mapHash, reviewHash } from '../lib/route'
import { openSpawn } from '../hub/spawnStore'
import { askHermes } from '../hub/askHermes'
import './palette.css'

/** One row of the palette: a group, a label, an optional hint on the right, and where it goes. */
interface Row {
  group: string
  label: string
  hint?: string
  icon: string
  /** A hash to go to; a row with none runs `run`. */
  hash?: string
  /** Listed before the rest of its group, whatever the match: a card of the open section. */
  first?: boolean
  run?: () => void
}

const PROJECTS_TTL = 60_000
let projectsCache: { at: number; projects: HubProject[] } | null = null

/** The Hub's route for an open item. */
function itemHash(item: Item): string {
  if (item.kind === 'ask') return hubHash('ask', item.id)
  if (item.kind === 'checklist') return hubHash('checklist', item.id)
  if (item.kind === 'review') return reviewHash(item.id)
  if (item.kind === 'approval' || item.kind === 'request') return hubHash('request', item.id)
  return hubHash('needs', 'unstick')
}

/** Every word of the query must be in the label or the group. Prefix matches rank first. */
function matchRank(row: Pick<Row, 'group' | 'label'>, words: string[]): number | null {
  if (!words.length) return 1
  const label = row.label.toLowerCase()
  const hay = `${label} ${row.group.toLowerCase()}`
  if (!words.every(word => hay.includes(word))) return null
  if (label.startsWith(words[0])) return 0
  return label.split(/[\s\-_/·:]+/).some(part => part.startsWith(words[0])) ? 1 : 2
}

export default function CommandPalette({ cards, items, waiting, onHome, onClose }: {
  /** Every card. Those of the open section (`workspace.active`) are listed first. */
  cards: WorkspaceCard[]
  /** The open items from the Hub's Today. */
  items: Item[]
  waiting: number
  onHome: () => void
  onClose: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const uid = useId()
  const listId = `${uid}-list`
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const [projects, setProjects] = useState<HubProject[]>(() => projectsCache?.projects ?? [])

  // Open modally, and give the focus back to where it was when the palette goes.
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null
    const el = dialog.current
    if (el && !el.open) el.showModal()
    input.current?.focus()
    return () => {
      if (el?.open) el.close()
      const now = document.activeElement
      if (before && document.contains(before) && (!now || now === document.body || now === el)) before.focus({ preventScroll: true })
    }
  }, [])

  // Roadmaps come from the Hub; read once a minute at most.
  useEffect(() => {
    if (!host.hub) return undefined
    if (projectsCache && Date.now() - projectsCache.at < PROJECTS_TTL) return undefined
    const controller = new AbortController()
    hubGet<{ projects: HubProject[] }>('/projects', controller.signal).then(
      answer => { projectsCache = { at: Date.now(), projects: answer.projects }; setProjects(answer.projects) },
      () => { /* no roadmaps listed; the rest still works */ },
    )
    return () => controller.abort()
  }, [])

  const rows = useMemo(() => {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
    const goTo: Row[] = [
      ...(host.hub ? hubRows(host).map(([screen, label, icon]): Row => ({ group: 'Go to', label, icon, hash: hubHash(screen), hint: screen === 'needs' && waiting > 0 ? `${waiting} waiting` : undefined })) : []),
      { group: 'Go to', label: 'Library', icon: '▤', run: onHome },
    ]
    const needs: Row[] = host.hub ? items.map(item => ({
      group: 'Needs you', label: item.title, icon: '✉', hash: itemHash(item), hint: item.project,
    })) : []
    const maps: Row[] = host.hub ? projects.map(project => ({ group: 'Roadmaps', label: project.name || project.id, icon: '◈', hash: mapHash(project.id) })) : []
    // With more than one section, the hint names the card's section; with one, its category.
    const sections = new Set(cards.map(card => card.workspace.id)).size > 1
    const found: Row[] = cards.map(card => ({ group: 'Cards', label: card.title, icon: '▢', hash: entityHash(card.id), hint: sections ? card.workspace.name : card.category, first: card.workspace.active }))
    const pick = (all: Row[], limit: number) => all
      .map((row, index) => ({ row, index, rank: matchRank(row, words) }))
      .filter((entry): entry is { row: Row; index: number; rank: number } => entry.rank !== null)
      .sort((a, b) => Number(!a.row.first) - Number(!b.row.first) || a.rank - b.rank || a.index - b.index)
      .slice(0, limit)
      .map(entry => entry.row)
    // A command, not a place: "Spawn: <what you typed>" opens the Spawn sheet with it. Typing "spawn" puts it first.
    const typed = query.trim().replace(/^spawn\b[:\s]*/i, '').trim()
    const spawn: Row[] = host.hub && host.write
      ? [{ group: 'Commands', label: typed ? `Spawn: ${typed}` : 'Spawn work', icon: '✦', run: () => openSpawn(typed ? { text: typed } : {}) }]
      : []
    // An empty query shows where to go and what waits; Roadmaps and Cards need a word.
    if (!words.length) return [...goTo, ...pick(needs, 8), ...spawn]
    // Whatever is typed can be asked of Hermes: a new Chat conversation that sends it.
    const ask: Row[] = host.chat ? [{ group: 'Ask', label: `Ask Hermes: ${query.trim()}`, icon: '✎', run: () => askHermes(query, () => { window.location.hash = hubHash('chat') }) }] : []
    const rest = [...pick(goTo, 12), ...pick(needs, 8), ...pick(maps, 8), ...pick(found, 8)]
    return /^spawn\b/i.test(query.trim()) ? [...spawn, ...rest, ...ask] : [...rest, ...spawn, ...ask]
  }, [query, cards, items, projects, waiting, onHome])

  const at = Math.min(selected, Math.max(rows.length - 1, 0))
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [at, rows])

  const choose = (row: Row | undefined) => {
    if (!row) return
    onClose()
    if (row.hash) window.location.hash = row.hash
    else row.run?.()
  }

  const onKey = (event: ReactKeyboardEvent) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (rows.length) setSelected((at + (event.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      choose(rows[at])
    } else if (event.key === 'Tab') {
      // The input is the only stop: the rows are reached with the arrows.
      event.preventDefault()
    }
  }

  // Rows arrive grouped in order; each run of one group is a labelled group for screen readers.
  const groups: { name: string; start: number; rows: Row[] }[] = []
  rows.forEach((row, index) => {
    const last = groups[groups.length - 1]
    if (last && last.name === row.group) last.rows.push(row)
    else groups.push({ name: row.group, start: index, rows: [row] })
  })

  return (
    <dialog
      ref={dialog}
      className="pal"
      aria-label="Command palette"
      onClose={onClose}
      onCancel={event => { event.preventDefault(); onClose() }}
      onClick={event => { if (event.target === event.currentTarget) onClose() }}
    >
      <div className="pal-in">
        <span className="pal-icon" aria-hidden="true">⌕</span>
        <input
          ref={input}
          value={query}
          onChange={event => { setQuery(event.target.value); setSelected(0) }}
          onKeyDown={onKey}
          placeholder="Go to a screen, an item, a roadmap or a card"
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={rows.length ? `${uid}-row-${at}` : undefined}
          aria-label="Search"
          autoComplete="off"
          spellCheck={false}
        />
      </div>
      <div className="pal-list" role="listbox" id={listId} aria-label="Results" ref={list}>
        {groups.map(group => (
          <div key={group.name} role="group" aria-labelledby={`${uid}-g-${group.start}`}>
            <div className="pal-g" id={`${uid}-g-${group.start}`}>{group.name}</div>
            {group.rows.map((row, offset) => {
              const index = group.start + offset
              return (
                <div
                  key={index}
                  id={`${uid}-row-${index}`}
                  role="option"
                  aria-selected={index === at}
                  className={`pal-i${index === at ? ' on' : ''}`}
                  onMouseMove={() => { if (index !== at) setSelected(index) }}
                  onClick={() => choose(row)}
                >
                  <span className="pal-i-icon" aria-hidden="true">{row.icon}</span>
                  <span className="pal-i-label">{row.label}</span>
                  {row.hint && <span className="pal-hint">{row.hint}</span>}
                </div>
              )
            })}
          </div>
        ))}
        {!rows.length && <div className="pal-empty">Nothing matches.</div>}
      </div>
      <div className="pal-f" aria-hidden="true">
        <span><kbd>↑</kbd><kbd>↓</kbd> move</span>
        <span><kbd>Enter</kbd> open</span>
        <span><kbd>Esc</kbd> close</span>
      </div>
    </dialog>
  )
}
