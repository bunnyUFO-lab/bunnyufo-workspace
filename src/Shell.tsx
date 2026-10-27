import { lazy, Suspense, useEffect } from 'react'
import App from './App'
import { dismissError, sendEvent, startService, useService } from './local/client'
import FilesRail from './local/FilesRail'
import { BrandMark } from './local/Icons'
import { host } from './lib/host'
import './local/local.css'

// Reading a file is not part of first paint.
const FilePreview = lazy(() => import('./local/FilePreview'))

/**
 * The one shell, on every host: the app, a file preview over it, the tool rail beside it and
 * the single error bar. What the host can do (lib/host) decides which tools the rail offers and
 * whether the shell also follows the local service live.
 */
export default function Shell() {
  const state = useService()
  useEffect(() => { if (host.live) void startService() }, [])
  useEffect(() => {
    if (!host.live) return
    const route = () => sendEvent({ type: 'workspace-route', route: location.hash })
    window.addEventListener('hashchange', route)
    return () => window.removeEventListener('hashchange', route)
  }, [])
  if (host.live && !state.ready) return <div className="app-boot"><BrandMark size={70} /><h1>bunnyUFO Workspace</h1><p>{state.error || 'Opening your workspace…'}</p>{state.error && <button className="desk-secondary" onClick={() => startService()}>Reconnect</button>}</div>
  return <div className="workspace-root app-shell">
    <div className="workspace-surface">
      <App />
      {state.preview && <Suspense fallback={null}><FilePreview file={state.preview} /></Suspense>}
      {/* A failed pin, archive or save. Here rather than inside App, whose stacking context sits under the preview. */}
      {state.error && <div className="write-error" role="alert"><span>{state.error}</span><button onClick={dismissError} aria-label="Dismiss">×</button></div>}
    </div>
    <FilesRail />
    {host.live && !state.connected && <div className="app-offline">Reconnecting to the local service…</div>}
  </div>
}
