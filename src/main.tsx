import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { lazy, Suspense } from 'react'
import { host, probeHost, signedOut } from './lib/host'
import { registerServiceWorker } from './lib/serviceWorker'
import { resolveSite, unknownSiteId } from './lib/sites'
import Shell from './Shell'
import UnknownSite from './components/UnknownSite'
import WorkspaceTheme from './components/WorkspaceTheme'
import './styles/tokens.css'
import './styles/global.css'
import './styles/workspace-theme.css'

// This entrypoint mounts once; it is not a Fast Refresh component module.
// eslint-disable-next-line react-refresh/only-export-components
const SignedOut = lazy(() => import('./components/SignedOut'))

// A published site may serve several workspaces; which one this page shows comes from /sites.json and the path.
// Resolved first so that card URLs, which are built all over the app, can stay synchronous. Without that file
// (the local preview, or a site published before this existed) it resolves instantly to the single workspace.
const mount = () => createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <WorkspaceTheme />
    <Suspense fallback={<div className="boot" />}>
      {signedOut ? <SignedOut message={signedOut} />
        : unknownSiteId && !host.live ? <UnknownSite /> : <Shell />}
    </Suspense>
  </StrictMode>,
)

// What the host can do is asked once, together with the site list, so nothing renders before both are known.
// The card API passphrase is gone: card pages save through the app now (workspace/_shared/card-data.js).
try { localStorage.removeItem('buw.cardApiPassphrase') } catch { /* blocked storage */ }
const probed = probeHost()
void Promise.all([probed, resolveSite()]).then(mount, mount)
// The phone app's worker, once it is known whether this is the published site.
void probed.then(registerServiceWorker, () => {})
