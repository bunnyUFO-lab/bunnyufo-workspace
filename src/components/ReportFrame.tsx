import { useCallback, useEffect, useRef, useState, type IframeHTMLAttributes } from 'react'
import { useWorkspaceTheme } from '../lib/workspace-theme'
import { reportThemeCSS } from '../../server/report-theme.mjs'
import { attachCardBridge } from '../lib/card-bridge.mjs'
import { attachImageOpen } from '../lib/card-images.mjs'
import { host } from '../lib/host'
import { api } from '../local/client'

/** The card a framed page belongs to: the one card the page may save for, through the app. */
type Props = Omit<IframeHTMLAttributes<HTMLIFrameElement>, 'src' | 'onLoad'> & { url: string; onLoad?: () => void; bridge?: { workspace: string; id: string }; onImage?: ImageOpen }

/**
 * How a card page may reach the app's picture viewer (lib/card-images.mjs): it asks to open one of the card's own files and
 * nothing else. `resolve` turns the page's address into the app's address of a file of this card, or null.
 */
export interface ImageOpen {
  resolve: (src: string) => string | null
  open: (picture: { url: string; urls: string[] }) => void
  isOpen: () => boolean
  closedAt: () => number
}

function ThemedFrame({ url, onLoad, bridge, onImage, ...props }: Props) {
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
  // The card page saves through this app by postMessage: it holds no credential of its own. Detaching on
  // cleanup keeps StrictMode's second mount from leaving two listeners.
  const workspace = bridge?.workspace, id = bridge?.id
  useEffect(() => {
    const element = frame.current
    if (!element || !workspace || !id) return
    return attachCardBridge(element, { workspace, id }, { origin: new URL(src).origin, enabled: () => host.cards && !host.saves && window.top === window && !window.opener, call: api })
  }, [workspace, id, src])
  // The page can ask the app to open its picture viewer. Read through a ref, so the listener is attached once per frame.
  const image = useRef(onImage)
  useEffect(() => { image.current = onImage })
  const wantsImages = !!onImage
  useEffect(() => {
    const element = frame.current
    if (!element || !wantsImages) return
    return attachImageOpen(element, {
      origin: new URL(src).origin,
      resolve: address => image.current?.resolve(address) ?? null,
      open: picture => image.current?.open(picture),
      isOpen: () => image.current?.isOpen() ?? true,
      closedAt: () => image.current?.closedAt() ?? 0,
    })
  }, [wantsImages, src])
  return <iframe {...props} ref={frame} src={src} onLoad={() => { loaded.current = true; applyTheme(); onLoad?.() }} />
}

export default function ReportFrame(props: Props) {
  return <ThemedFrame key={props.url} {...props} />
}
