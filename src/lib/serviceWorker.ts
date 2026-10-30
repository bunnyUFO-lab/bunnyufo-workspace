import { host, signedOut } from './host'
import { reloadWhenIdle } from './reloadGate'

/**
 * The phone app: a worker that keeps the shell and the cards last read, so they open with no
 * signal. Only on the published site, and only in a build: the local app has a live websocket and a
 * dev server, and a cached copy of either would be wrong. Call after the host has been probed.
 */
export function registerServiceWorker() {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator) || host.files || signedOut) return
  // A page already under a worker that sees a new one take over is out of date: reload once. The
  // very first install also "takes control", and that page is up to date, so it is left alone. The
  // reload waits for a Chat reply that is streaming and for Hub writes in flight (reloadGate): a
  // reload would abort them, and the server stops a reply nobody is reading.
  const updating = !!navigator.serviceWorker.controller
  let reloaded = false
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!updating || reloaded) return
    reloaded = true
    reloadWhenIdle(() => window.location.reload())
  })
  navigator.serviceWorker.register('/sw.js').then(registration => registration.update()).catch(() => {})
}
