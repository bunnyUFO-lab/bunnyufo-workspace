import { useContext, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import '../styles/report.css'
import { downloadImage } from '../lib/download'
import { annotatable, AnnotateContext, cardPicture } from '../lib/annotate'
import { askDraft, copyImage, CopyError, fetchCardImage, toPictureFile, UNSUPPORTED } from '../lib/cardImage'
import { host } from '../lib/host'
import { startChat } from '../hub/chatStart'
import { hubHash } from '../lib/route'
import { openSpawn } from '../hub/spawnStore'

/** A press in the first moments after the viewer opens is ignored: a page that opens the viewer under a person's double click gets nothing. */
const ARM_MS = 500

/** Other pictures of the same page, for Previous and Next. */
export interface Gallery { items: { url: string; title: string }[]; index: number; onIndex: (index: number) => void }

export default function ImagePreview({ url, title, onClose, plain = false, gallery }: { url: string; title: string; onClose: () => void; plain?: boolean; gallery?: Gallery }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [actual, setActual] = useState(false)
  // What the note under the picture says, and whether an action is running, belong to one picture: stepping to another starts clean.
  const [state, setState] = useState({ url, error: '', failedCopy: false, busy: false })
  const here = state.url === url ? state : { url, error: '', failedCopy: false, busy: false }
  const { error, failedCopy, busy } = here
  const patch = (change: Partial<typeof here>) => setState({ ...here, ...change })
  const picture = useRef<HTMLImageElement>(null)
  const openedAt = useRef(0)
  const context = useContext(AnnotateContext)
  const own = cardPicture(context, url)
  const path = plain ? null : annotatable(context, url)
  // Every open, and every step to another picture, starts the arming time again.
  useEffect(() => { openedAt.current = Date.now() }, [url])
  const armed = () => Date.now() - openedAt.current >= ARM_MS
  const edit = () => {
    const image = picture.current
    if (!armed() || !context?.annotate || !path || !image) return
    patch({ busy: true, error: '' })
    context.annotate(path, image.naturalWidth, image.naturalHeight).then(() => dialog.current?.close(), problem => patch({ error: problem.message, busy: false }))
  }
  const copy = () => {
    if (!armed()) return
    patch({ error: '', failedCopy: false })
    copyImage(url).then(() => patch({ error: 'Image copied' }), problem => patch({ error: problem instanceof CopyError ? problem.message : UNSUPPORTED, failedCopy: true }))
  }
  const ask = async () => {
    if (!armed() || !context || !own) return
    patch({ busy: true, error: '' })
    try {
      const file = await toPictureFile(await fetchCardImage(url), own.split('/').pop() || 'picture')
      // An unsent draft: the picture goes in the tray and the line in the composer. Nothing is posted until the person presses Send.
      startChat({ persona: 'hermes', draft: askDraft(context.card.title, own, window.location.origin, context.card.workspace, context.card.id), files: [file] })
      window.location.hash = hubHash('chat')
      dialog.current?.close()
    } catch (problem) {
      patch({ error: problem instanceof Error ? problem.message : 'The picture could not be read.', busy: false })
    }
  }
  // A job's form opens with the picture, its source and an empty text box: no card text is copied into it.
  const newJob = async () => {
    if (!armed() || !context || !own) return
    patch({ busy: true, error: '' })
    try {
      const file = await toPictureFile(await fetchCardImage(url), own.split('/').pop() || 'picture')
      openSpawn({ project: context.card.workspace, reference: { file, source: { section: context.card.workspace, card: context.card.id, file: own, title: context.card.title.replace(/\s+/g, ' ').trim().slice(0, 120) || context.card.id } } })
      dialog.current?.close()
    } catch (problem) {
      patch({ error: problem instanceof Error ? problem.message : 'The picture could not be read.', busy: false })
    }
  }
  const go = (step: number) => { if (gallery) gallery.onIndex((gallery.index + step + gallery.items.length) % gallery.items.length) }
  useEffect(() => { const current = dialog.current; current?.showModal(); return () => current?.close() }, [])
  // The arrow keys belong to the viewer while it is open: they step through the page's pictures, and never walk the card's tabs behind it.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
      event.preventDefault(); event.stopImmediatePropagation()
      if (gallery && gallery.items.length > 1) go(event.key === 'ArrowLeft' ? -1 : 1)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  })
  // An action that cannot work here is left out, not greyed.
  const canEdit = !!path && !!context?.annotate
  const canAsk = !!own && host.chat
  const canJob = !!own && host.hub && host.write
  const many = !!gallery && gallery.items.length > 1
  // StrictMode closes and reopens the dialog during its effect check. Ignore a queued close event if the dialog has already reopened.
  return createPortal(<dialog ref={dialog} className="buw-lightbox" aria-label="Image preview" onClose={event => { if (!event.currentTarget.open) onClose() }}>
    <div className="buw-lightbox-toolbar">
      <span className="buw-lightbox-caption">{title}</span>
      {many && gallery && <span className="buw-lightbox-count" data-lightbox-count>{gallery.index + 1} / {gallery.items.length}</span>}
      <span className="buw-lightbox-tools">
        {many && <button onClick={() => go(-1)} data-lightbox-prev>Previous</button>}
        {many && <button onClick={() => go(1)} data-lightbox-next>Next</button>}
        <button onClick={() => setActual(value => !value)}>{actual ? 'Fit' : '100%'}</button>
        <a href={url} target="_blank" rel="noreferrer">Open original</a>
        <button onClick={() => void downloadImage(url).catch(problem => patch({ error: problem.message }))}>Download</button>
      </span>
      <button className="buw-lightbox-close" onClick={() => dialog.current?.close()}>Close</button>
    </div>
    <div className={`buw-lightbox-stage${actual ? ' actual' : ''}`}><img ref={picture} src={url} alt={title} onClick={() => setActual(value => !value)} onError={() => patch({ error: 'This image could not be loaded.' })} /></div>
    {own && <div className="buw-lightbox-actions" data-lightbox-actions>
      {canEdit && <button onClick={edit} disabled={busy} data-action="edit">✎ Edit</button>}
      {canAsk && <button onClick={() => void ask()} disabled={busy} data-action="ask">Ask in chat</button>}
      {canJob && <button onClick={() => void newJob()} disabled={busy} data-action="job">New job</button>}
      <button onClick={copy} data-action="copy">Copy image</button>
    </div>}
    <p className="buw-lightbox-note" role="status">{error || 'Esc to close'}{failedCopy && <> <button type="button" className="buw-lightbox-note-download" onClick={() => void downloadImage(url).catch(problem => patch({ error: problem.message }))}>Download</button></>}</p>
  </dialog>, document.body)
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
    if (!context?.annotate || !path || !image) return
    setBusy(true); setError('')
    context.annotate(path, image.naturalWidth, image.naturalHeight).catch(problem => { setError(problem.message); setBusy(false) })
  }
  const link = <a href={src} target="_blank" rel="noreferrer" title="Open image" onClick={event => { if (!event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) { event.preventDefault(); setOpen(true) } }}><img ref={picture} src={src} alt={alt} loading="lazy" /></a>
  return <>{path
    ? <span className="annotatable">{link}<button type="button" className="annotate-badge" onClick={annotate} disabled={busy} title="Draw on this picture" aria-label="Annotate this picture">✎</button>{error && <small className="annotate-error" role="alert">{error}</small>}</span>
    : link}{open && <ImagePreview url={src} title={alt || 'Image'} onClose={() => setOpen(false)} plain={plain} />}</>
}
