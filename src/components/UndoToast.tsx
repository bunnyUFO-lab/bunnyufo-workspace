import { useEffect, useSyncExternalStore } from 'react'
import { reportError } from '../local/client'
import { dismiss, getToast, subscribe } from '../lib/undo'

/** The one toast host, mounted once by the app. */
export default function UndoToast() {
  const toast = useSyncExternalStore(subscribe, getToast)
  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => dismiss(toast.id), 8000)
    return () => window.clearTimeout(timer)
  }, [toast])
  if (!toast) return null
  return (
    <div className="undo-toast" role="status" aria-live="polite" data-undo-toast>
      <span>{toast.message}</span>
      {toast.undo && (
        <button
          type="button"
          onClick={async () => {
            dismiss(toast.id)
            try { await toast.undo?.() } catch (error) { reportError(error) }
          }}
        >
          Undo
        </button>
      )}
      <button type="button" className="undo-close" aria-label="Dismiss" onClick={() => dismiss(toast.id)}>✕</button>
    </div>
  )
}
