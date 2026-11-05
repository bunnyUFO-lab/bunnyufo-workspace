import { Fragment, useEffect, useRef, useState } from 'react'
import type { Item } from '../lib/hub'
import { host } from '../lib/host'
import { useOverflowEdges } from '../lib/useOverflowEdges'
import type { NeedsKind } from '../lib/needsKinds'
import { FILTER_SUBTYPES, KIND_LABEL, KIND_PLURAL, SUBTYPE_LABEL, canonicalFilter, isKnownFilter, splitFilter } from '../lib/needsKinds'
import { filterSlug, needsHref, parseNeedsRoute, projectOptions } from '../lib/needsView.mjs'
import type { Handoff } from './flash'
import { takeHandoff } from './flash'
import { NOTE_VERB } from '../lib/nextItem.mjs'
import { pickNext } from '../lib/nextItem.mjs'
import NextNote from './NextNote'
import ProjectPicker from './ProjectPicker'
import { ProjectLink, useProjectNames } from './ProjectChip'
import { itemPage } from './needsFocus'
import ItemRow from './ItemRow'
import AwayToggle from './AwayToggle'
import NeedsItem from './NeedsItem'
import type { SettleExtra, SettleVerb } from './NeedsItem'
import { itemKey, rememberFilter, takeFocus } from './needsFocus'
import { openSpawn } from './spawnStore'
import RefreshNote from './RefreshNote'
import { useHubData } from './useHub'
import './needs.css'

interface Inbox { items: Item[]; counts?: Record<string, number>; subCounts?: Record<string, number>; projects?: Record<string, number> }

const CHIPS: [string, string][] = [
  ['all', 'All'], ['approvals', 'Approvals'], ['question', KIND_LABEL.question], ['steps', KIND_LABEL.steps], ['design', KIND_LABEL.design],
  ['playtest', KIND_LABEL.playtest], ['unstick', KIND_LABEL.unstick], ['pr', KIND_LABEL.pr], ['answered', 'Answered'],
]
const EMPTY: Record<string, string> = {
  all: 'Nothing waits on you. Agents ping #needs-you when something does.',
  approvals: 'No request waits for your approval.',
  question: 'No question waits on you.',
  design: 'No design review waits on you.',
  steps: 'No steps wait on you. When an agent needs you to do a set of steps, it posts them here.',
  playtest: 'No playtest waits on you.',
  unstick: 'No session is waiting on you.',
  pr: 'No pull request is waiting for review.',
  answered: 'Nothing has been answered yet.',
  requests: 'No requests. Ask an agent to do something from Work.',
}
const LEAVE_MS = 260
const reducedMotion = () => typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches

/**
 * Needs you: one list of cards, one per thing that waits on the owner, each answered where it stands. A chip narrows
 * the list to one kind; the old filter names in links still land on the right chip.
 */
export default function Needs({ filter: address }: { filter?: string }) {
  // The address is `<filter>[/<project>]`, or the name of one item to focus where a filter would go.
  const route = parseNeedsRoute(address, isKnownFilter)
  const filter = route.filter
  const project = route.project
  const active = canonicalFilter(filter)
  // `question:verify` is the Question chip with its Verify sub-chip: `kind` is the chip, `sub` the second row's.
  const [kind, sub] = splitFilter(active)
  const isHistory = kind === 'answered' || kind === 'requests'
  const { data, error, loading, reload, at } = useHubData<Inbox>(`/inbox?filter=${encodeURIComponent(active)}${project ? `&project=${encodeURIComponent(project)}` : ''}${isHistory ? '' : '&detail=1'}`)
  const names = useProjectNames()
  // The note after the last action: from this list, or handed over by the page the owner settled an item on.
  const [note, setNote] = useState<{ handoff: Handoff; index: number; nextKey: string | null } | null>(() => { const handed = takeHandoff(); return handed ? { handoff: handed, index: 0, nextKey: null } : null })
  const [settled, setSettled] = useState<ReadonlySet<string>>(new Set())
  const [leaving, setLeaving] = useState<{ item: Item; index: number }[]>([])
  const root = useRef<HTMLDivElement>(null)
  const wanted = useRef<string | null>(null)
  if (wanted.current === null) wanted.current = takeFocus()
  // A link to one item (#/~hub/needs/<event file>, from Working now) names it where a filter would go: the list opens on All, focused on it.
  const linked = useRef(route.linked)

  useEffect(() => { rememberFilter(active, project) }, [active, project])

  // The note belongs to the list it was left on: another chip starts clean.
  const listKey = `${active}/${project}`
  const lastFilter = useRef(listKey)
  useEffect(() => {
    if (lastFilter.current === listKey) return
    lastFilter.current = listKey
    setNote(null)
  }, [listKey])

  // An old filter name in the address becomes the new one, in place: the address stays one entry in the history.
  useEffect(() => {
    if (address && filter !== filterSlug(active)) window.history.replaceState(window.history.state, '', needsHref(active, project))
  }, [address, filter, active, project])

  // A row on Today opens the list on its item: scroll to it and flash it. A key the list does not hold is ignored.
  useEffect(() => {
    if (!data || (!wanted.current && !linked.current)) return
    let key = wanted.current
    wanted.current = ''
    if (linked.current) {
      const target = data.items.find(item => item && item.kind === 'blocked' && (item.file === linked.current || item.id === linked.current))
      key = target ? itemKey(target) : key
      linked.current = ''
    }
    const card = [...(root.current?.querySelectorAll<HTMLElement>('[data-need]') ?? [])].find(node => node.dataset.need === key)
    if (!card) return
    card.scrollIntoView({ block: 'start', behavior: 'auto' })
    card.classList.add('flash')
    window.setTimeout(() => card.classList.remove('flash'), 1600)
  }, [data])

  const base = (data?.items ?? []).filter((item): item is Item => !!item && typeof item === 'object' && !settled.has(itemKey(item)))
  const shown = [...base]
  for (const ghost of leaving) shown.splice(Math.min(ghost.index, shown.length), 0, ghost.item)

  function handleSettled(item: Item, verb: SettleVerb, extra?: SettleExtra) {
    const key = itemKey(item)
    const order = shown.filter(other => !leaving.some(ghost => itemKey(ghost.item) === itemKey(other)) || itemKey(other) === key)
    const index = Math.max(0, order.findIndex(other => itemKey(other) === key))
    const remaining = base.filter(other => itemKey(other) !== key)
    const next = pickNext(remaining, key, order.map(itemKey))
    const page = itemPage(item)
    setSettled(previous => new Set(previous).add(key))
    setLeaving(previous => [...previous, { item, index }])
    // The last item of a chip is not the last item of the queue: the counts from before this action say how many wait in other kinds.
    const elsewhere = !next && active !== 'all' && !isHistory ? Math.max(0, (data?.counts?.all ?? 0) - (data?.counts?.[active] ?? 0)) : 0
    const plural = sub ? undefined : KIND_PLURAL[kind as NeedsKind] as string | undefined
    setNote({
      handoff: { verb: NOTE_VERB[verb], ...(extra?.detail ? { detail: extra.detail } : {}), ...(extra?.link ? { link: extra.link } : {}), title: item.title, next: next?.title ?? null, nothingLeft: !next && elsewhere === 0, ...(elsewhere > 0 ? { elsewhere, ...(plural ? { kindPlural: plural } : {}) } : {}), backHash: page ?? needsHref('unstick') },
      index, nextKey: next ? itemKey(next) : null,
    })
    window.setTimeout(() => setLeaving(previous => previous.filter(ghost => itemKey(ghost.item) !== key)), reducedMotion() ? 0 : LEAVE_MS)
    // The next card takes focus on its title; the note, in the slot the settled card left, is what the page scrolls to.
    window.setTimeout(() => {
      const card = [...(root.current?.querySelectorAll<HTMLElement>('[data-need]') ?? [])].find(node => node.dataset.need === (next ? itemKey(next) : ''))
      card?.querySelector<HTMLElement>('.ni-t')?.focus({ preventScroll: true })
      root.current?.querySelector<HTMLElement>('.nq-next')?.scrollIntoView({ block: 'start', behavior: 'auto' })
    }, reducedMotion() ? 20 : LEAVE_MS + 20)
  }

  function answerNext() {
    const first = root.current?.querySelector<HTMLElement>('.ni:not(.leaving) .ni-t')
    if (!first) return
    first.focus({ preventScroll: true })
    first.scrollIntoView({ block: 'center', behavior: reducedMotion() ? 'auto' : 'smooth' })
  }

  // The slot is a position among the cards that stay; a collapsing card sits just before it.
  const noteSlot = note ? Math.min(note.index + leaving.filter(ghost => ghost.index <= note.index).length, shown.length) : -1
  const counts = data?.counts
  const waiting = counts?.all ?? 0
  const visible = CHIPS.filter(([key]) => key === 'all' || key === 'answered' || key === kind || (counts?.[key] ?? 0) > 0)
  if (kind === 'requests') visible.push(['requests', 'Requests'])
  const options = projectOptions(data?.projects, names, project)
  const total = Object.values(data?.projects ?? {}).reduce((sum, n) => sum + n, 0)
  const chosenName = names?.[project] || project
  // With a project chosen the empty list says so and offers the way out; the link keeps the kind chip.
  const empty = (className: string) => project
    ? <p className={className} data-project-empty>Nothing for {chosenName} waits on you. <a href={needsHref(active, '')} data-show-all-projects>Show all projects</a></p>
    : <p className={className}>{sub ? `No ${SUBTYPE_LABEL[kind]?.[sub]?.toLowerCase()} ${kind === 'steps' ? 'steps wait' : 'question waits'} on you.` : EMPTY[kind]}</p>
  const chipRow = useRef<HTMLDivElement>(null)
  const overflow = useOverflowEdges(chipRow, [visible.length, active])
  // Only the row scrolls, never the page: a scrollIntoView would undo the jump to a linked card.
  useEffect(() => {
    const row = chipRow.current
    const chip = row?.querySelector<HTMLElement>('.hub-chip.on')
    if (!row || !chip) return
    if (chip.offsetLeft < row.scrollLeft) row.scrollLeft = chip.offsetLeft
    else if (chip.offsetLeft + chip.offsetWidth > row.scrollLeft + row.clientWidth) row.scrollLeft = chip.offsetLeft + chip.offsetWidth - row.clientWidth
  }, [visible.length, active])

  return (
    <div className="needs" ref={root}>
      <header className="needs-head">
        <div>
          <div className="needs-eyebrow">Review queue</div>
          <h2>Needs you</h2>
          <p>Everything that waits on you, in one place. Your answer goes straight back to whoever asked.</p>
        </div>
        <AwayToggle />
        {(waiting > 0 || host.write) && (
          <div className="needs-actions">
            {host.write && <button type="button" className="hub-btn" data-spawn-open onClick={() => openSpawn()}>Spawn</button>}
            {waiting > 0 && <button type="button" className="hub-btn needs-next" data-answer-next onClick={answerNext}>Answer the next one</button>}
          </div>
        )}
      </header>
      <div className="needs-bar">
      {(options.length > 0 || project) && (
        <div className="needs-project" data-needs-project>
          <ProjectPicker id="hub-needs-project" projects={options} value={project || 'all'} allValue="all" allLabel="All projects" counts={Object.fromEntries(options.map(option => [option.id, option.count]))} allCount={total}
            onChange={id => { window.location.hash = needsHref(active, id === 'all' ? '' : id) }} alwaysList inRow />
          {project && <ProjectLink id={project} name={chosenName} />}
        </div>
      )}
      <div className="hub-chips-wrap" data-overflow={overflow}>
      <div className="hub-chips one-row" role="group" aria-label="Needs you filter" ref={chipRow}>
        {visible.map(([key, label]) => {
          const count = key === 'answered' || key === 'requests' ? undefined : counts?.[key]
          return (
            <a key={key} className={`hub-chip${key === kind ? ' on' : ''}`} href={needsHref(key, project)} aria-current={key === kind ? 'true' : undefined} data-filter={key}>
              {label}{count !== undefined && <span className="n">{count}</span>}
            </a>
          )
        })}
      </div>
      </div>
      </div>
      {FILTER_SUBTYPES[kind] && (
        <div className="hub-chips needs-subs" role="group" aria-label={`${KIND_LABEL[kind as NeedsKind]} kinds`} data-subs={kind}>
          {[['', kind === 'steps' ? 'All steps' : 'All questions'] as const, ...FILTER_SUBTYPES[kind].map(name => [name, SUBTYPE_LABEL[kind][name]] as const)].map(([name, label]) => {
            const key = name ? `${kind}:${name}` : kind
            const count = data?.subCounts?.[key] ?? (name ? undefined : counts?.[kind])
            return (
              <a key={key} className={`hub-chip${name === sub ? ' is-on' : ''}`} href={needsHref(key, project)} aria-current={name === sub ? 'true' : undefined} data-sub-filter={name || 'all'}>
                {label}{count !== undefined && <span className="n">{count}</span>}
              </a>
            )
          })}
        </div>
      )}
      <RefreshNote error={error} hasData={!!data} at={at} />
      {data ? (
        isHistory ? (
          <section className="hub-panel">
            {shown.length ? shown.map(item => <ItemRow key={itemKey(item)} item={item} />) : empty('hub-empty')}
          </section>
        ) : (
          <>
            {note && !shown.length && <NextNote note={note.handoff} />}
            {shown.length ? (
              <div className="nq">
                {shown.map((item, index) => {
                  const ghost = leaving.some(entry => itemKey(entry.item) === itemKey(item))
                  // The note sits in the slot the settled card left: before the card that took its place.
                  const slot = note && shown.length && index === noteSlot ? <NextNote key="note" note={note.handoff} /> : null
                  return (
                    <Fragment key={itemKey(item)}>
                      {slot}
                      <NeedsItem item={item} at={at} reload={reload} onSettled={handleSettled} leaving={ghost} names={names} filter={active} />
                    </Fragment>
                  )
                })}
                {note && shown.length > 0 && noteSlot >= shown.length && <NextNote note={note.handoff} />}
              </div>
            ) : empty('hub-empty needs-empty')}
          </>
        )
      ) : !error && loading && <p className="hub-empty">Loading…</p>}
    </div>
  )
}
