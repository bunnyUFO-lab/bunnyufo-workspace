// Sections, lists, rows and the master-detail split. Phone first: one column; at 900 px and up a split shows both.
import { useId, type ReactNode } from 'react'
import { direction } from '../lib/entries'
import Icon from './Icon'

export function Section({ title, action, children }: { title?: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="ui-sec">
      {(title || action) && <div className="ui-sechead">{title && <h2>{title}</h2>}{action}</div>}
      {children}
    </section>
  )
}

export function List({ children, label }: { children: ReactNode; label?: string }) {
  return <div className="ui-list" role="list" aria-label={label}>{children}</div>
}

/** One row: a title, a quiet line under it, and what sits at the end (a count, a button, a chevron). */
export function Row({ title, sub, end, onClick, href, on }: { title: ReactNode; sub?: ReactNode; end?: ReactNode; onClick?: () => void; href?: string; on?: boolean }) {
  const body = <><span className="ui-row-body"><b>{title}</b>{sub && <small>{sub}</small>}</span>{end}</>
  const className = `ui-row${on ? ' on' : ''}`
  if (href) return <a role="listitem" className={className} href={href}>{body}</a>
  if (onClick) return <button type="button" role="listitem" className={className} onClick={onClick}>{body}</button>
  return <div role="listitem" className={className}>{body}</div>
}

/**
 * A section that folds, as the WAI-ARIA accordion has it: a real button in a real heading. With `onToggle` the head is that button;
 * without it (a search forces the section open) the same content is plain text, with no chevron and no `aria-expanded`, since it
 * cannot be closed. The body is drawn only while open. `data` puts `data-*` hooks on the section.
 */
export function Fold({ title, sub, end, open, onToggle, level = 3, data, children }: {
  title: ReactNode; sub?: ReactNode; end?: ReactNode; open: boolean; onToggle?: () => void; level?: 3 | 4; data?: Record<string, string>; children?: ReactNode
}) {
  const panel = useId()
  const Heading = `h${level}` as const
  const content = <><span className="ui-row-body"><b>{title}</b>{sub && <small>{sub}</small>}</span>{end}</>
  return (
    <section className="ui-fold" data-open={open} {...data}>
      <Heading className="ui-fold-h">
        {onToggle
          ? <button type="button" className="ui-fold-head" aria-expanded={open} aria-controls={open ? panel : undefined} onClick={onToggle}>{content}<span className="ui-fold-chev" aria-hidden="true"><Icon name="chev" size={18} /></span></button>
          : <div className="ui-fold-head">{content}</div>}
      </Heading>
      {open && <div className="ui-fold-body" id={panel}>{children}</div>}
    </section>
  )
}

/** Master and detail: the phone shows `detail` when there is one, else `list`; 900 px and up shows both side by side. `fill`: a page with no detail, whose list takes the whole pane. */
export function Split({ list, detail, empty = 'Pick something from the list.', folded = false, fill = false }: { list: ReactNode; detail?: ReactNode; empty?: ReactNode; folded?: boolean; fill?: boolean }) {
  return (
    <div className={`ui-split${detail ? ' has-detail' : ''}${folded ? ' folded' : ''}${fill ? ' fill' : ''}`}>
      <section className="ui-pane ui-pane-list">{list}</section>
      {!(fill && !detail) && <section className="ui-pane ui-pane-detail">{detail ?? <p className="ui-placeholder">{empty}</p>}</section>}
    </div>
  )
}

/**
 * The screen wrapper. Going deeper moves the screen 14 px in 0.12 s; coming back moves it the other way. No fade: a half-faded
 * frame was seen in QA. The caller keys it on the same key its content is keyed on, so it never remounts anything extra.
 */
export function Screen({ children }: { children: ReactNode }) {
  return <div className={`ui-screen ${direction() === 'back' ? 'ui-from-left' : 'ui-from-right'}`}>{children}</div>
}
