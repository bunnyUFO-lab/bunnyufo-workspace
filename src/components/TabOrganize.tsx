import { useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import type { WorkspaceCard, WorkspaceStep } from '../types'
import { deleteSection, moveSection, renameSection, restoreSection } from '../lib/cards'
import { overlayDepth, swap } from '../lib/entries'
import { entityHash } from '../lib/route'
import { Sheet } from '../ui/Sheet'
import { Button } from '../ui/Controls'

const message = (problem: unknown) => problem instanceof Error ? problem.message : String(problem)
const same = (a: WorkspaceStep[], b: WorkspaceStep[]) => a.length === b.length && a.every((step, i) => step.path === b[i].path && step.name === b[i].name)

interface Drag { path: string; from: number; to: number; dy: number; size: number }

/**
 * The Organize sheet: every tab of a card in order, one row each. Drag the handle (touch or mouse) or press
 * the up and down buttons to reorder; tap a name to rename it; Remove takes the tab off the card but keeps
 * its file, so it can be brought back from the "Removed tabs" list. Saves go through the card routes, one at
 * a time; a refused one puts the row back and says why.
 */
export default function TabOrganize({ card, activePath, onClose }: {
  card: WorkspaceCard
  activePath: string
  onClose: () => void
}) {
  const ws = card.workspace.id
  // The open tab follows its page when the order changes. In place, keeping the sheet's own history entry: going to the
  // tab like a click would drop the sheet.
  const onStep = (id: string, index: number) => swap(entityHash(id, index) + '/~o'.repeat(overlayDepth(window.location.hash)))
  // The order shown while a save is on its way and until the card itself catches up.
  const [shown, setShown] = useState<WorkspaceStep[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [note, setNote] = useState('')
  const [renaming, setRenaming] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [drag, setDrag] = useState<Drag | null>(null)
  const list = useRef<HTMLUListElement>(null)
  // Our copy only stands in until the card shows the same thing.
  const rows = shown && !(!busy && same(shown, card.steps)) ? shown : card.steps
  const removed = (card.removedTabs ?? []).filter(tab => !tab.pending)

  // If the card never reports the change, stop showing our own copy.
  useEffect(() => {
    if (busy || !shown) return
    const timer = window.setTimeout(() => setShown(null), 2500)
    return () => window.clearTimeout(timer)
  }, [busy, shown])

  const follow = (order: WorkspaceStep[]) => {
    const at = order.findIndex(step => step.path === activePath)
    if (at >= 0) onStep(card.id, at)
  }

  const move = async (from: number, to: number) => {
    if (busy || to < 0 || to >= rows.length || to === from) return
    const next = [...rows]
    const [one] = next.splice(from, 1)
    next.splice(to, 0, one)
    setShown(next); setBusy(true); setError(''); setNote('')
    try {
      await moveSection(ws, card.id, from, to, one.path)
      follow(next)
    } catch (problem) { setShown(null); setError(`Could not move “${one.name}”: ${message(problem)}`) } finally { setBusy(false) }
  }

  const save = async (index: number) => {
    const step = rows[index]
    const next = name.trim()
    setRenaming(null)
    if (!next || next === step.name || busy) return
    setShown(rows.map((row, i) => i === index ? { ...row, name: next } : row)); setBusy(true); setError(''); setNote('')
    try { await renameSection(ws, card.id, index, next) } catch (problem) {
      setShown(null); setError(`Could not rename “${step.name}”: ${message(problem)}`)
    } finally { setBusy(false) }
  }

  const remove = async (index: number) => {
    const step = rows[index]
    if (busy || rows.length < 2) return
    const next = rows.filter((_, i) => i !== index)
    setShown(next); setBusy(true); setError(''); setNote('')
    try {
      await deleteSection(ws, card.id, index, step.path)
      const keep = next.findIndex(row => row.path === activePath)
      onStep(card.id, keep >= 0 ? keep : Math.min(index, next.length - 1))
      setNote(`Removed “${step.name}”. Its file is kept: bring it back from Removed tabs.`)
    } catch (problem) { setShown(null); setError(`Could not remove “${step.name}”: ${message(problem)}`) } finally { setBusy(false) }
  }

  const restore = async (path: string, label: string) => {
    if (busy) return
    setBusy(true); setError(''); setNote('')
    try { await restoreSection(ws, card.id, path); setShown(null); setNote(`Brought back “${label}”.`) } catch (problem) {
      setError(`Could not bring back “${label}”: ${message(problem)}`)
    } finally { setBusy(false) }
  }

  // A drag: the row follows the pointer, the rows it passes slide aside, and one save is made on release.
  const startDrag = (event: ReactPointerEvent<HTMLElement>, from: number) => {
    if (busy || rows.length < 2 || (event.pointerType === 'mouse' && event.button !== 0)) return
    const els = list.current?.querySelectorAll<HTMLElement>('li[data-tab-row]')
    const a = els?.[0]?.getBoundingClientRect()
    const b = els?.[1]?.getBoundingClientRect()
    const size = a && b ? b.top - a.top : (a?.height ?? 48)
    const handle = event.currentTarget
    handle.setPointerCapture(event.pointerId)
    const startY = event.clientY
    const path = rows[from].path
    const last = rows.length - 1
    let to = from
    setDrag({ path, from, to, dy: 0, size })
    const track = (ev: PointerEvent) => {
      const dy = ev.clientY - startY
      to = Math.max(0, Math.min(last, from + Math.round(dy / size)))
      setDrag({ path, from, to, dy, size })
    }
    const stop = (commit: boolean) => {
      handle.removeEventListener('pointermove', track)
      handle.removeEventListener('pointerup', up)
      handle.removeEventListener('pointercancel', cancel)
      setDrag(null)
      if (commit && to !== from) void move(from, to)
    }
    const up = () => stop(true)
    const cancel = () => stop(false)
    handle.addEventListener('pointermove', track)
    handle.addEventListener('pointerup', up)
    handle.addEventListener('pointercancel', cancel)
  }

  const shift = (index: number) => {
    if (!drag) return undefined
    if (index === drag.from) return { transform: `translateY(${drag.dy}px)` }
    if (drag.to > drag.from && index > drag.from && index <= drag.to) return { transform: `translateY(${-drag.size}px)` }
    if (drag.to < drag.from && index < drag.from && index >= drag.to) return { transform: `translateY(${drag.size}px)` }
    return undefined
  }

  return (
    <Sheet title="Organize tabs" onClose={onClose}>
      <p className="tab-org-hint">Drag to reorder, or use the arrows. Tap a name to rename it.</p>
      <ul className="tab-org-list" ref={list} aria-label="Tabs, in order">
        {rows.map((step, i) => (
          <li
            key={step.path}
            data-tab-row={step.path}
            className={`tab-org-row${drag?.path === step.path ? ' dragging' : ''}${drag && drag.path !== step.path ? ' shifting' : ''}`}
            style={shift(i)}
          >
            <span
              className="tab-org-handle"
              role="img"
              aria-label={`Drag the ${step.name} tab`}
              title="Drag to reorder"
              onPointerDown={event => startDrag(event, i)}
            >
              <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="currentColor"><circle cx="9" cy="6" r="1.6" /><circle cx="15" cy="6" r="1.6" /><circle cx="9" cy="12" r="1.6" /><circle cx="15" cy="12" r="1.6" /><circle cx="9" cy="18" r="1.6" /><circle cx="15" cy="18" r="1.6" /></svg>
            </span>
            {renaming === step.path ? (
              <input
                className="tab-org-name-input"
                autoFocus
                value={name}
                maxLength={60}
                aria-label={`Rename the ${step.name} tab`}
                onChange={event => setName(event.target.value)}
                onFocus={event => event.currentTarget.select()}
                onBlur={() => void save(i)}
                onKeyDown={event => {
                  if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur() }
                  else if (event.key === 'Escape') { event.stopPropagation(); event.preventDefault(); setName(step.name); setRenaming(null) }
                }}
              />
            ) : (
              <button
                type="button"
                className="tab-org-name"
                title="Rename"
                aria-label={`Rename the ${step.name} tab`}
                onClick={() => { setName(step.name); setRenaming(step.path) }}
              >
                <span>{step.name}</span>
                {step.agentTab && <small className="tab-org-mark">Added by an agent</small>}
              </button>
            )}
            <button type="button" className="tab-org-step" aria-label={`Move ${step.name} up`} aria-disabled={i === 0 || busy} onClick={() => void move(i, i - 1)}>↑</button>
            <button type="button" className="tab-org-step" aria-label={`Move ${step.name} down`} aria-disabled={i === rows.length - 1 || busy} onClick={() => void move(i, i + 1)}>↓</button>
            <Button
              small
              tone="danger"
              className="tab-org-remove"
              aria-label={`Remove the ${step.name} tab`}
              aria-disabled={rows.length < 2 || busy}
              title={rows.length < 2 ? 'A card keeps at least one tab' : 'Remove this tab. It can be brought back.'}
              onClick={() => void remove(i)}
            >Remove</Button>
          </li>
        ))}
      </ul>
      {rows.length < 2 && <p className="tab-org-hint">A card keeps at least one tab, so this one cannot be removed.</p>}
      {error && <p className="tab-org-error" role="alert">{error}</p>}
      {note && <p className="tab-org-note" role="status">{note}</p>}
      {removed.length > 0 && (
        <section className="tab-org-removed" aria-label="Removed tabs">
          <h3>Removed tabs ({removed.length})</h3>
          <ul>
            {removed.map(tab => (
              <li key={tab.path}>
                <span>{tab.name}</span>
                <Button small onClick={() => void restore(tab.path, tab.name)} aria-label={`Bring back the ${tab.name} tab`}>Bring back</Button>
              </li>
            ))}
          </ul>
        </section>
      )}
      <div className="tab-org-done"><Button tone="primary" wide onClick={() => window.history.back()}>Done</Button></div>
    </Sheet>
  )
}
