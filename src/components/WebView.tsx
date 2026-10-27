import { lazy, Suspense, useEffect, useState } from 'react'
import BrandLogo from './BrandLogo'

const ReportViewer = lazy(() => import('./ReportViewer'))

/**
 * A live web app as a card tab (a step with `url`), such as a local tool's UI.
 * The step's Markdown page doubles as its instructions: shown on demand, and
 * automatically when the app does not answer.
 */
export default function WebView({ url, title, helpUrl, helpPath }: { url: string; title: string; helpUrl: string | null; helpPath: string }) {
  const [reachable, setReachable] = useState<boolean | null>(null)
  const [showHelp, setShowHelp] = useState<boolean | null>(null)
  const [frame, setFrame] = useState(0)
  // Remounted per URL (keyed by the caller); Reload resets `reachable` and bumps `frame`.
  useEffect(() => {
    const controller = new AbortController()
    // An opaque no-cors response still proves the server answered; a refused connection rejects.
    fetch(url, { mode: 'no-cors', cache: 'no-store', signal: controller.signal })
      .then(() => setReachable(true), () => { if (!controller.signal.aborted) setReachable(false) })
    return () => controller.abort()
  }, [url, frame])
  const help = showHelp ?? reachable === false
  return <div className="web-view">
    <div className="web-view-bar">
      <strong>{title}</strong>
      <code>{url}</code>
      {reachable === false && <span className="web-view-down">Not reachable. Start it, then Reload.</span>}
      <span className="web-view-spacer" />
      {helpUrl && <button type="button" aria-pressed={help} onClick={() => setShowHelp(!help)}>{help ? 'Live app' : 'Instructions'}</button>}
      <button type="button" onClick={() => { setShowHelp(null); setReachable(null); setFrame(value => value + 1) }}>Reload</button>
      <a href={url} target="_blank" rel="noreferrer">Open in browser ↗</a>
    </div>
    {help && helpUrl
      ? <Suspense fallback={<div className="boot"><BrandLogo size={56} animated={false} /></div>}><ReportViewer key={helpUrl} url={helpUrl} title={title} relativePath={helpPath} /></Suspense>
      : reachable === false
        ? <div className="report-error"><strong>{title}</strong><p>{url} is not answering. Start it and press Reload.</p></div>
        : <iframe key={frame} src={url} title={title} allow="clipboard-read; clipboard-write; fullscreen" />}
  </div>
}
