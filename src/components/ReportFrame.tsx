import { useCallback, useEffect, useRef, useState, type IframeHTMLAttributes } from 'react'
import { useWorkspaceTheme } from '../lib/workspace-theme'
import { reportThemeCSS } from '../../server/report-theme.mjs'

type Props = Omit<IframeHTMLAttributes<HTMLIFrameElement>, 'src' | 'onLoad'> & { url: string; onLoad?: () => void }

function ThemedFrame({ url, onLoad, ...props }: Props) {
  const { resolved } = useWorkspaceTheme()
  const frame = useRef<HTMLIFrameElement>(null)
  // A targeted postMessage to a frame that has not loaded yet is still about:blank, and warns.
  const loaded = useRef(false)
  // Set the initial colour before a local report paints. Later theme changes
  // use a message, preserving scroll position and the report's interactive state.
  const [src] = useState(() => {
    const target = new URL(url, location.href)
    target.searchParams.set('buw-theme', resolved)
    return target.href
  })
  const applyTheme = useCallback(() => {
    const element = frame.current
    if (!element) return
    // Vite serves reports on the same origin. Local app content is isolated on a
    // second origin, whose prelude accepts theme messages only from its UI.
    try {
      const doc = element.contentDocument
      if (doc?.documentElement) {
        if (!doc.querySelector('style[data-buw-report-theme]')) {
          const style = doc.createElement('style')
          style.dataset.buwReportTheme = ''
          style.textContent = reportThemeCSS
          ;(doc.head || doc.documentElement).append(style)
        }
        doc.documentElement.dataset.buwTheme = resolved
      }
    } catch { /* Cross-origin reports use the message below. */ }
    element.contentWindow?.postMessage({ type: 'buw:theme', theme: resolved }, new URL(url, location.href).origin)
  }, [resolved, url])
  useEffect(() => { if (loaded.current) applyTheme() }, [applyTheme])
  return <iframe {...props} ref={frame} src={src} onLoad={() => { loaded.current = true; applyTheme(); onLoad?.() }} />
}

export default function ReportFrame(props: Props) {
  return <ThemedFrame key={props.url} {...props} />
}
