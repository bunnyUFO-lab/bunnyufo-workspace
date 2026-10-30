import { useState } from 'react'
import type { WorkspaceCard } from '../types'
import { deleteSection, moveSection, renameSection, restoreSection } from '../lib/cards'
import { reportError } from '../local/client'
import ItemMenu, { useContextMenu, type MenuItem } from './ItemMenu'
import { showUndo } from '../lib/undo'

/**
 * One tab of an open card. A click opens it. Where the card can be edited, the active tab carries a
 * "⋯" menu and any tab answers a right-click: Rename (in place), Move left, Move right, Delete.
 * Delete keeps the file and offers Undo; the last tab cannot be deleted.
 */
export default function StepTab({ card, index, active, activeIndex, onStep, editable }: {
  card: WorkspaceCard
  index: number
  active: boolean
  activeIndex: number
  onStep: (id: string, index: number) => void
  editable: boolean
}) {
  const step = card.steps[index]
  const ws = card.workspace.id
  const last = card.steps.length - 1
  const [renaming, setRenaming] = useState(false)
  const [name, setName] = useState(step.name)

  const move = async (to: number) => {
    try {
      await moveSection(ws, card.id, index, to, step.path)
      onStep(card.id, to)
      showUndo(`Moved the “${step.name}” tab ${to < index ? 'left' : 'right'}`, async () => {
        await moveSection(ws, card.id, to, index, step.path)
        onStep(card.id, index)
      })
    } catch (problem) { reportError(problem) }
  }
  const remove = async () => {
    try {
      await deleteSection(ws, card.id, index, step.path)
      const left = card.steps.length - 1
      onStep(card.id, activeIndex > index ? activeIndex - 1 : activeIndex === index ? Math.min(index, left - 1) : activeIndex)
      showUndo(`Deleted the “${step.name}” tab`, async () => {
        const back = await restoreSection(ws, card.id, step.path)
        onStep(card.id, back.step)
      })
    } catch (problem) { reportError(problem) }
  }
  const save = async () => {
    const next = name.trim()
    setRenaming(false)
    if (!next || next === step.name) return
    try {
      await renameSection(ws, card.id, index, next)
      showUndo(`Renamed the tab to “${next}”`, () => renameSection(ws, card.id, index, step.name))
    } catch (problem) { reportError(problem) }
  }

  const items: MenuItem[] | null = editable ? [
    { label: 'Rename', onSelect: () => { setName(step.name); setRenaming(true) } },
    { label: 'Move left', onSelect: () => void move(index - 1), disabled: index === 0 },
    { label: 'Move right', onSelect: () => void move(index + 1), disabled: index === last },
    { label: 'Delete', onSelect: () => void remove(), danger: true, disabled: card.steps.length < 2 },
  ] : null
  const context = useContextMenu(`Tab ${step.name}`, items)

  if (renaming) {
    return (
      <input
        className="step-tab step-tab-rename"
        autoFocus
        value={name}
        maxLength={60}
        aria-label={`Rename the ${step.name} tab`}
        onChange={event => setName(event.target.value)}
        onFocus={event => event.currentTarget.select()}
        onBlur={() => setRenaming(false)}
        onKeyDown={event => {
          if (event.key === 'Enter') { event.preventDefault(); void save() }
          else if (event.key === 'Escape') { event.stopPropagation(); setRenaming(false) }
        }}
      />
    )
  }
  return (
    <>
      <button
        role="tab"
        aria-selected={active}
        className={`step-tab${active ? ' active' : ''}${active && items ? ' has-more' : ''}`}
        onClick={() => onStep(card.id, index)}
        title={step.name}
        {...context.props}
      >
        {step.name}
      </button>
      {active && <ItemMenu label={`More for the ${step.name} tab`} items={items} className="step-tab-more" />}
      {context.menu}
    </>
  )
}
