import { useState } from 'react'
import type { MenuItem } from '../components/ItemMenu'
import { afterPop } from '../lib/entries'
import { IconButton } from './Controls'
import { Sheet } from './Sheet'
import './rowmenu.css'

/**
 * The "..." at the end of a row: the row's actions in a sheet (a bottom sheet on a phone, a dialog at 900 px and up). Open adds one
 * history entry and Back closes it. An action closes the sheet first and runs once the address has settled (`afterPop`), so an action
 * that opens a dialog of its own, or leaves the screen, cannot leave this sheet for Back to reopen. Where there is nothing the
 * person may do (`items` is null), no button is drawn.
 */
export default function RowMenu({ label, items, title }: { label: string; items: MenuItem[] | null; title?: string }) {
  const [open, setOpen] = useState(false)
  if (!items || items.length === 0) return null
  return (
    <>
      <IconButton icon="more" label={label} aria-haspopup="dialog" aria-expanded={open} data-row-menu="" onClick={() => setOpen(true)} />
      {open && (
        <Sheet title={title ?? label} onClose={() => setOpen(false)}>
          <div className="ui-menu" role="menu" aria-label={label}>
            {items.map(item => (
              <button
                key={item.label}
                type="button"
                role="menuitem"
                className={`ui-menuitem${item.danger ? ' danger' : ''}`}
                disabled={item.disabled}
                onClick={() => afterPop(() => { setOpen(false); item.onSelect() })}
              >
                {item.label}
              </button>
            ))}
          </div>
        </Sheet>
      )}
    </>
  )
}
