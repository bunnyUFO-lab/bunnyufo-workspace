import type { Item } from '../lib/hub'
import { subBadge, typeBadge } from '../lib/needsKinds'
import './badges.css'

/** The inner markup of a stroke icon is ours (needsKinds.ts), never an agent's. */
function Icon({ paths }: { paths: string }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" dangerouslySetInnerHTML={{ __html: paths }} />
}

/**
 * The badges of a Needs you item: its type, filled, with its icon and a word; then, for a Question or Steps, its
 * sub-type, outlined. The type is also a `ni-chip`, so what reads the first chip of a card still finds the type there.
 */
export default function NeedBadges({ item, className = '' }: { item: Item; className?: string }) {
  const type = typeBadge(item)
  const sub = subBadge(item)
  return (
    <>
      <span className={`ni-chip nb nb-type ${className}`.trim()} data-type={type.type} data-badge="type"><Icon paths={type.icon} />{type.label}</span>
      {sub && (
        <span className={`nb nb-sub ${className}`.trim()} data-sub={sub.sub} data-group={sub.group} data-badge="sub" data-inferred={sub.inferred ? '' : undefined} title={sub.inferred ? 'Guessed from the wording: the sender did not say' : undefined}>{sub.label}</span>
      )}
    </>
  )
}
