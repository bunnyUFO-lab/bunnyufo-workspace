import { useEffect, useRef, useState } from 'react'
import type { Item } from '../lib/hub'
import { KIND_LABEL, canonicalFilter } from '../lib/needsKinds'
import { hubHash } from '../lib/route'
import { takeFlash } from './flash'
import ItemRow from './ItemRow'
import NeedsItem from './NeedsItem'
import type { SettleVerb } from './NeedsItem'
import { itemKey, takeFocus } from './needsFocus'
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
const NOTE: Record<SettleVerb, string> = {
  answered: 'Answered.', snoozed: 'Snoozed for a day.', submitted: 'Submitted. The agent sees it at its next session.', done: 'Marked done. It is gone from Needs you.', cancelled: 'Cancelled.',
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
  const [status, setStatus] = useState(takeFlash)
  const [settled, setSettled] = useState<ReadonlySet<string>>(new Set())
  const [leaving, setLeaving] = useState<{ item: Item; index: number }[]>([])
  const root = useRef<HTMLDivElement>(null)
  const wanted = useRef<string | null>(null)
  if (wanted.current === null) wanted.current = takeFocus()

  // An old filter name in the address becomes the new one, in place: the address stays one entry in the history.
  useEffect(() => {
    if (filter && filter !== active) window.history.replaceState(window.history.state, '', hubHash('needs', active))
  }, [filter, active])

  // A row on Today opens the list on its item: scroll to it and flash it. A key the list does not hold is ignored.
  useEffect(() => {
    if (!data || !wanted.current) return
    const key = wanted.current
    wanted.current = ''
    const card = [...(root.current?.querySelectorAll<HTMLElement>('[data-need]') ?? [])].find(node => node.dataset.need === key)
    if (!card) return
    card.scrollIntoView({ block: 'start', behavior: 'auto' })
    card.classList.add('flash')
    window.setTimeout(() => card.classList.remove('flash'), 1600)
  }, [data])

  const base = (data?.items ?? []).filter((item): item is Item => !!item && typeof item === 'object' && !settled.has(itemKey(item)))
  const shown = [...base]
  for (const ghost of leaving) shown.splice(Math.min(ghost.index, shown.length), 0, ghost.item)

  function handleSettled(item: Item, verb: SettleVerb) {
    const key = itemKey(item)
    setSettled(previous => new Set(previous).add(key))
    setLeaving(previous => [...previous, { item, index: Math.max(0, shown.findIndex(other => itemKey(other) === key)) }])
    setStatus(NOTE[verb])
    window.setTimeout(() => setLeaving(previous => previous.filter(ghost => itemKey(ghost.item) !== key)), reducedMotion() ? 0 : LEAVE_MS)
  }

  function answerNext() {
    const first = root.current?.querySelector<HTMLElement>('.ni:not(.leaving) .ni-t')
    if (!first) return
    first.focus({ preventScroll: true })
    first.scrollIntoView({ block: 'center', behavior: reducedMotion() ? 'auto' : 'smooth' })
  }

  const counts = data?.counts
  const waiting = counts?.all ?? 0
  const visible = CHIPS.filter(([key]) => key === 'all' || key === 'answered' || key === active || (counts?.[key] ?? 0) > 0)
  if (active === 'requests') visible.push(['requests', 'Requests'])

  return (
    <div className="needs" ref={root}>
      <header className="needs-head">
        <div>
          <div className="needs-eyebrow">Review queue</div>
          <h2>Needs you</h2>
          <p>Everything that waits on you, in one place. Your answer goes straight back to whoever asked.</p>
        </div>
        {waiting > 0 && <button type="button" className="hub-btn needs-next" data-answer-next onClick={answerNext}>Answer the next one</button>}
      </header>
      <div className="hub-chips one-row" role="group" aria-label="Needs you filter">
        {visible.map(([key, label]) => {
          const count = key === 'answered' || key === 'requests' ? undefined : counts?.[key]
          return (
            <a key={key} className={`hub-chip${key === active ? ' on' : ''}`} href={hubHash('needs', key)} aria-current={key === active ? 'true' : undefined} data-filter={key}>
              {label}{count !== undefined && <span className="n">{count}</span>}
            </a>
          )
        })}
      </div>
      {status && <p className="ni-status" role="status" data-marked-done>{status}</p>}
      {error && <p className="hub-error" role="alert">{error}</p>}
      {data ? (
        isHistory ? (
          <section className="hub-panel">
            {shown.length ? shown.map(item => <ItemRow key={itemKey(item)} item={item} />) : <p className="hub-empty">{EMPTY[active]}</p>}
          </section>
        ) : shown.length ? (
          <div className="nq">
            {shown.map(item => <NeedsItem key={itemKey(item)} item={item} at={at} reload={reload} onSettled={handleSettled} leaving={leaving.some(ghost => itemKey(ghost.item) === itemKey(item))} />)}
          </div>
        ) : <p className="hub-empty needs-empty">{EMPTY[active]}</p>
      ) : !error && loading && <p className="hub-empty">Loading…</p>}
    </div>
  )
}
