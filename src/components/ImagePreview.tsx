import { useContext, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import '../styles/report.css'
import { downloadImage } from '../lib/download'
import { annotatable, AnnotateContext } from '../lib/annotate'

export default function ImagePreview({ url, title, onClose, plain = false }: { url: string; title: string; onClose: () => void; plain?: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [actual, setActual] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const picture = useRef<HTMLImageElement>(null)
  const context = useContext(AnnotateContext)
  const path = plain ? null : annotatable(context, url)
  const annotate = () => {
    const image = picture.current
    if (!context || !path || !image) return
    setBusy(true); setError('')
    context.annotate(path, image.naturalWidth, image.naturalHeight).catch(problem => { setError(problem.message); setBusy(false) })
  }
  useEffect(() => { const current = dialog.current; current?.showModal(); return () => current?.close() }, [])
  // StrictMode closes and reopens the dialog during its effect check. Ignore a
  // queued close event if the dialog has already reopened.
  return createPortal(<dialog ref={dialog} className="buw-lightbox" aria-label="Image preview" onClose={event => { if (!event.currentTarget.open) onClose() }}><div className="buw-lightbox-toolbar"><span className="buw-lightbox-caption">{title}</span><button onClick={() => setActual(value => !value)}>{actual ? 'Fit' : '100%'}</button><a href={url} target="_blank" rel="noreferrer">Open original</a>{path && <button onClick={annotate} disabled={busy}>✎ Annotate</button>}<button onClick={() => void downloadImage(url).catch(error => setError(error.message))}>Download</button><button onClick={() => dialog.current?.close()}>Close</button></div><div className={`buw-lightbox-stage${actual ? ' actual' : ''}`}><img ref={picture} src={url} alt={title} onClick={() => setActual(value => !value)} onError={() => setError('This image could not be loaded.')} /></div><p className="buw-lightbox-note" role="status">{error || 'Esc to close'}</p></dialog>, document.body)
}

/** `plain`: no ✎ on the picture itself, for a page that already has its own Annotate button. */
export function ZoomImage({ src, alt = '', plain = false }: { src?: string; alt?: string; plain?: boolean }) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const picture = useRef<HTMLImageElement>(null)
  const context = useContext(AnnotateContext)
  const path = plain ? null : annotatable(context, src)
  if (!src) return <span>{alt}</span>
  const annotate = () => {
    const image = picture.current
    if (!context || !path || !image) return
    setBusy(true); setError('')
    context.annotate(path, image.naturalWidth, image.naturalHeight).catch(problem => { setError(problem.message); setBusy(false) })
  }
  const link = <a href={src} target="_blank" rel="noreferrer" title="Open image" onClick={event => { if (!event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) { event.preventDefault(); setOpen(true) } }}><img ref={picture} src={src} alt={alt} loading="lazy" /></a>
  return <>{path
    ? <span className="annotatable">{link}<button type="button" className="annotate-badge" onClick={annotate} disabled={busy} title="Draw on this picture" aria-label="Annotate this picture">✎</button>{error && <small className="annotate-error" role="alert">{error}</small>}</span>
    : link}{open && <ImagePreview url={src} title={alt || 'Image'} onClose={() => setOpen(false)} plain={plain} />}</>
}
