import type { WorkspaceCard } from '../types'

/**
 * One tab of an open card: its name and nothing else, so no control sits over a label. A click opens
 * it. Where the card can be edited, a right-click (or a long press) opens the Organize sheet on this
 * tab (TabOrganize); renaming, order and removal all live there.
 */
export default function StepTab({ card, index, active, onStep, onOrganize }: {
  card: WorkspaceCard
  index: number
  active: boolean
  onStep: (id: string, index: number) => void
  /** Set where the card can be edited. */
  onOrganize?: (index: number) => void
}) {
  const step = card.steps[index]
  return (
    <button
      role="tab"
      aria-selected={active}
      className={`step-tab${active ? ' active' : ''}`}
      onClick={() => onStep(card.id, index)}
      onContextMenu={onOrganize ? event => { event.preventDefault(); onOrganize(index) } : undefined}
      title={step.name}
    >
      {step.name}
    </button>
  )
}
