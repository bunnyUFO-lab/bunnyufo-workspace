import { lazy, Suspense, useEffect, useState } from 'react'
import { host } from '../lib/host'
import { downloadFile } from '../lib/download'
import { ZoomImage } from './ImagePreview'
import type { EditableCard } from './ReportViewer'

// Excalidraw is a large lazy chunk that is fetched only when a drawing needs it: to edit, or to
// show a scene that has no picture yet. Opening a drawing that has its PNG loads none of it.
const DrawingEditor = lazy(() => {
  // Where the canvas finds its fonts: the build copies them to /assets/excalidraw/fonts (vite.config.ts),
  // so a private site makes no CDN call. Set before the editor is imported.
  if (import.meta.env.PROD) window.EXCALIDRAW_ASSET_PATH = '/assets/excalidraw/'
  return import('./DrawingEditor')
})

const UNSUPPORTED = 'Copying images isn’t supported here — use Download'

/** A drawing section: its picture (the PNG saved beside the scene) with the tools to edit, copy and share it. */
/** `startEditing`: the section was just made, so it opens in the editor (ReportViewer already took the flag). */
export default function DrawingSection({ url, title, card, startEditing = false }: { url: string; title: string; card?: EditableCard; startEditing?: boolean }) {
  const canEdit = host.cards && !!card
  const [editing, setEditing] = useState(canEdit && startEditing)
  const [version, setVersion] = useState('')
  const [probe, setProbe] = useState<{ src: string; ok: boolean } | null>(null)
  const [note, setNote] = useState('')

  const base = url.replace(/\.excalidraw(?=$|[?#])/i, '.png')
  // A saved picture has a new etag; asking for it by name keeps the browser from showing the old one.
  const picture = version ? `${base}${base.includes('?') ? '&' : '?'}v=${encodeURIComponent(version)}` : base
  useEffect(() => {
    let live = true
    const image = new Image()
    image.onload = () => { if (live) setProbe({ src: picture, ok: true }) }
    image.onerror = () => { if (live) setProbe({ src: picture, ok: false }) }
    image.src = picture
    return () => { live = false }
  }, [picture])
  const state = probe?.src === picture ? (probe.ok ? 'shown' : 'missing') : 'checking'

  if (editing && card) return <Suspense fallback={<div className="report-loading" role="status">Opening editor…</div>}>
    <DrawingEditor url={url} title={title} card={card} onClose={saved => { setEditing(false); if (saved) setVersion(saved.png) }} />
  </Suspense>

  const copyLink = () => {
    navigator.clipboard?.writeText(window.location.href).then(() => setNote('Link copied'), () => setNote('The link could not be copied.'))
    if (!navigator.clipboard) setNote('The link could not be copied.')
  }
  // The picture goes in as a promise made inside the click: Safari refuses a clipboard write that waits first.
  const copyImage = () => {
    if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) { setNote(UNSUPPORTED); return }
    try {
      const blob = fetch(picture).then(response => {
        if (!response.ok) throw new Error('No picture')
        return response.blob()
      })
      navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]).then(() => setNote('Image copied'), () => setNote(UNSUPPORTED))
    } catch { setNote(UNSUPPORTED) }
  }

  return <div className="report-image drawing-section">
    <nav>
      <span>{title}</span>
      {canEdit && <button type="button" onClick={() => setEditing(true)} title="Edit this drawing">✎ Edit</button>}
      <button type="button" onClick={copyLink} title="Copy this page's address, to give to Claude">🔗 Copy link for Claude</button>
      {state === 'shown' && <button type="button" onClick={copyImage}>⧉ Copy image</button>}
      <a href={state === 'shown' ? picture : url} onClick={event => { event.preventDefault(); void downloadFile(state === 'shown' ? picture : url).catch(problem => setNote(problem.message)) }}>Download</a>
      {note && <small role="status">{note}</small>}
    </nav>
    {state === 'shown' ? <ZoomImage src={picture} alt={title} plain />
      : state === 'missing' ? <Suspense fallback={<div className="report-loading" role="status">Opening drawing…</div>}><DrawingEditor url={url} title={title} /></Suspense>
        : <div className="report-loading" role="status">Opening drawing…</div>}
  </div>
}
