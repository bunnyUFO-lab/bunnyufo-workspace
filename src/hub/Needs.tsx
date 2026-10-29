import { Fragment, useEffect, useRef, useState } from 'react'
import type { Item } from '../lib/hub'
import { host } from '../lib/host'
import { useOverflowEdges } from '../lib/useOverflowEdges'
import type { NeedsKind } from '../lib/needsKinds'
import { KIND_LABEL, KIND_PLURAL, canonicalFilter, isKnownFilter } from '../lib/needsKinds'
import { hubHash } from '../lib/route'
import type { Handoff } from './flash'
import { takeHandoff } from './flash'
import { NOTE_VERB } from '../lib/nextItem.mjs'
import { pickNext } from '../lib/nextItem.mjs'
import NextNote from './NextNote'
import { itemPage } from './needsFocus'
import ItemRow from './ItemRow'
import NeedsItem from './NeedsItem'
import type { SettleExtra, SettleVerb } from './NeedsItem'
import { itemKey, takeFocus } from './needsFocus'
import { openSpawn } from './spawnStore'
import { useHubData } from './useHub'
import './needs.css'

interface Inbox { items: Item[]; counts?: Record<string, number> }

const CHIPS: [string, string][] = [
  ['all', 'All'], ['question', KIND_LABEL.question], ['design', KIND_LABEL.design], ['steps', KIND_LABEL.steps],
  ['playtest', KIND_LABEL.playtest], ['unstick', KIND_LABEL.unstick], ['pr', KIND_LABEL.pr], ['answered', 'Answered'],
]
const EMPTY: Record<string, string> = {
  all: 'Nothing waits on you. Agents ping #needs-you when something does.',
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
export default function Needs({ filter }: { filter?: string }) {
  const active = canonicalFilter(filter)
  const isHistory = active === 'answered' || active === 'requests'
  const { data, error, loading, reload, at } = useHubData<Inbox>(`/inbox?filter=${active}${isHistory ? '' : '&detail=1'}`)
  // The note after the last action: from this list, or handed over by the page the owner settled an item on.
  const [note, setNote] = useState<{ handoff: Handoff; index: number; nextKey: string | null } | null>(() => { const handed = takeHandoff(); return handed ? { handoff: handed, index: 0, nextKey: null } : null })
  const [settled, setSettled] = useState<ReadonlySet<string>>(new Set())
  const [leaving, setLeaving] = useState<{ item: Item; index: number }[]>([])
  const root = useRef<HTMLDivElement>(null)
  const wanted = useRef<string | null>(null)
  if (wanted.current === null) wanted.current = takeFocus()
  // A link to one item (#/~hub/needs/<event file>, from Working now) names it where a filter would go: the list opens on All, focused on it.
  const linked = useRef(filter && !isKnownFilter(filter) ? filter : '')

  // The note belongs to the list it was left on: another chip starts clean.
  const lastFilter = useRef(active)
  useEffect(() => {
    if (lastFilter.current === active) return
    lastFilter.current = active
    setNote(null)
  }, [active])

  // An old filter name in the address becomes the new one, in place: the address stays one entry in the history.
  useEffect(() => {
    if (filter && filter !== active) window.history.replaceState(window.history.state, '', hubHash('needs', active))
  }, [filter, active])

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
    const plural = KIND_PLURAL[active as NeedsKind] as string | undefined
    setNote({
      handoff: { verb: NOTE_VERB[verb], ...(extra?.detail ? { detail: extra.detail } : {}), ...(extra?.link ? { link: extra.link } : {}), title: item.title, next: next?.title ?? null, nothingLeft: !next && elsewhere === 0, ...(elsewhere > 0 ? { elsewhere, ...(plural ? { kindPlural: plural } : {}) } : {}), backHash: page ?? hubHash('needs', 'unstick') },
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
  const visible = CHIPS.filter(([key]) => key === 'all' || key === 'answered' || key === active || (counts?.[key] ?? 0) > 0)
  if (active === 'requests') visible.push(['requests', 'Requests'])
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
        {(waiting > 0 || host.write) && (
          <div className="needs-actions">
            {host.write && <button type="button" className="hub-btn" data-spawn-open onClick={() => openSpawn()}>Spawn</button>}
            {waiting > 0 && <button type="button" className="hub-btn needs-next" data-answer-next onClick={answerNext}>Answer the next one</button>}
          </div>
        )}
      </header>
      <div className="hub-chips-wrap" data-overflow={overflow}>
      <div className="hub-chips one-row" role="group" aria-label="Needs you filter" ref={chipRow}>
        {visible.map(([key, label]) => {
          const count = key === 'answered' || key === 'requests' ? undefined : counts?.[key]
          return (
            <a key={key} className={`hub-chip${key === active ? ' on' : ''}`} href={hubHash('needs', key)} aria-current={key === active ? 'true' : undefined} data-filter={key}>
              {label}{count !== undefined && <span className="n">{count}</span>}
            </a>
          )
        })}
      </div>
      </div>
      {error && <p className="hub-error" role="alert">{error}</p>}
      {data ? (
        isHistory ? (
          <section className="hub-panel">
            {shown.length ? shown.map(item => <ItemRow key={itemKey(item)} item={item} />) : <p className="hub-empty">{EMPTY[active]}</p>}
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
                      <NeedsItem item={item} at={at} reload={reload} onSettled={handleSettled} leaving={ghost} />
                    </Fragment>
                  )
                })}
                {note && shown.length > 0 && noteSlot >= shown.length && <NextNote note={note.handoff} />}
              </div>
            ) : <p className="hub-empty needs-empty">{EMPTY[active]}</p>}
          </>
        )
      ) : !error && loading && <p className="hub-empty">Loading…</p>}
    </div>
  )
}
