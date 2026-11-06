// Buttons, chips and the segment control: the one set every screen draws from (ui.css). Each is 44 px high.
import type { ButtonHTMLAttributes, ReactNode } from 'react'
import Icon, { type IconName } from './Icon'

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement>

export function Button({ tone, small, wide, className = '', type = 'button', ...rest }: ButtonProps & { tone?: 'primary' | 'good' | 'ghost' | 'danger'; small?: boolean; wide?: boolean }) {
  return <button type={type} className={`ui-btn${tone ? ` ${tone}` : ''}${small ? ' sm' : ''}${wide ? ' wide' : ''} ${className}`.trim()} {...rest} />
}

export function IconButton({ icon, label, primary, className = '', type = 'button', ...rest }: ButtonProps & { icon: IconName; label: string; primary?: boolean }) {
  return <button type={type} className={`ui-icobtn${primary ? ' pri' : ''} ${className}`.trim()} aria-label={label} title={label} {...rest}><Icon name={icon} /></button>
}

export function Chip({ on, count, className = '', type = 'button', children, ...rest }: ButtonProps & { on?: boolean; count?: number | string; children: ReactNode }) {
  return <button type={type} className={`ui-chip${on ? ' on' : ''} ${className}`.trim()} aria-pressed={on} {...rest}>{children}{count !== undefined && <small>{count}</small>}</button>
}

/** A row of chips that scrolls sideways inside itself, so the page never does. */
export function ChipRow({ children, label }: { children: ReactNode; label: string }) {
  return <div className="ui-chips" role="group" aria-label={label}>{children}</div>
}

export function Segment<T extends string>({ value, options, onChange, label, className = '' }: { value: T; options: { id: T; label: string; count?: number }[]; onChange: (id: T) => void; label: string; className?: string }) {
  return (
    <div className={`ui-seg ${className}`.trim()} role="group" aria-label={label}>
      {options.map(option => (
        <button key={option.id} type="button" className={option.id === value ? 'on' : undefined} aria-pressed={option.id === value} onClick={() => onChange(option.id)}>
          {option.label}{option.count !== undefined && <small>{option.count}</small>}
        </button>
      ))}
    </div>
  )
}
