import { useEffect, useRef } from 'react'
import { SHORTCUT_GROUPS } from '../lib/shortcuts'

/** The Ctrl+H sheet: every shortcut, from lib/shortcuts. A modal dialog, so Esc closes it. */
export default function Shortcuts({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const el = dialog.current
    if (el && !el.open) el.showModal()
  }, [])
  return (
    <dialog
      ref={dialog}
      className="shortcuts"
      aria-label="Keyboard shortcuts"
      onClose={onClose}
      // A click on the backdrop lands on the dialog itself, not on anything inside it.
      onClick={event => { if (event.target === event.currentTarget) event.currentTarget.close() }}
    >
      <header className="shortcuts-head">
        <h2>Keyboard shortcuts</h2>
        <button type="button" onClick={() => dialog.current?.close()} aria-label="Close">×</button>
      </header>
      {SHORTCUT_GROUPS.map(group => (
        <section key={group.title}>
          <h3>{group.title}</h3>
          <dl>
            {group.items.map(item => (
              <div key={item.keys.join('+') + item.does} className="shortcut-row">
                <dt>{item.keys.map((k, i) => <span key={i}>{i > 0 && '+'}<kbd>{k}</kbd></span>)}</dt>
                <dd>{item.does}</dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </dialog>
  )
}
