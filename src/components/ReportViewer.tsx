import { useContext, useEffect, useMemo, useRef, useState } from 'react'
import { host } from '../lib/host'
import { api, serviceState } from '../local/client'
import type { Preview } from '../local/types'
import MarkdownDocument, { MarkdownView } from './MarkdownDocument'
import { ZoomImage } from './ImagePreview'
import { downloadImage } from '../lib/download'
import ReportFrame from './ReportFrame'
import HtmlEditor from './HtmlEditor'
import DrawingSection from './DrawingSection'
import { annotate as startAnnotation, openForEditing, readSection, saveSection, takeEditing } from '../lib/cards'
import { annotatable, AnnotateContext } from '../lib/annotate'
import type { Annotate } from '../lib/annotate'

/** The card a page belongs to, when it can be edited through the card routes. */
export interface EditableCard { workspace: string; id: string; path: string }

interface ViewerProps { url: string; title: string; relativePath: string; card?: EditableCard; stepIndex?: number; onStep?: (index: number) => void }

/** A card's page. On a card that can be written to, every picture on it can be drawn over (✎ Annotate). */
export default function ReportViewer(props: ViewerProps) {
  const { url, card, stepIndex = 0, onStep } = props
  const workspace = card?.workspace, id = card?.id, file = card?.path
  const steppable = !!onStep
  const open = useRef(onStep)
  useEffect(() => { open.current = onStep })
  const annotation = useMemo<Annotate | null>(() => {
    if (!workspace || !id || !file || !host.cards || !steppable) return null
    // The card folder is the page's address without the page's own path (which may sit in a sub-folder).
    const parts = new URL(url.split(/[?#]/)[0], window.location.href).href.split('/')
    const folderUrl = `${parts.slice(0, parts.length - file.split('/').length).join('/')}/`
    return {
      folderUrl,
      annotate: async (image, width, height) => {
        const made = await startAnnotation(workspace, id, image, stepIndex, width, height)
        openForEditing(workspace, id, made.path)
        open.current?.(made.step)
      },
    }
  }, [url, workspace, id, file, stepIndex, steppable])
  return <AnnotateContext.Provider value={annotation}><ReportPage {...props} /></AnnotateContext.Provider>
}

/**
 * A card page's address as a frame loads it. With a content host, a `/w/` page of this site is framed from there,
 * so the page runs on an origin of its own and cannot reach the app's storage or post to it as the app.
 */
function frameUrl(url: string): string {
  const content = host.contentOrigin
  if (!content) return url
  const target = new URL(url, window.location.href)
  if (target.origin !== window.location.origin || !target.pathname.startsWith('/w/')) return url
  return `${content}${target.pathname}${target.search}${target.hash}`
}

/** The picture's size, for a drawing made over it. */
const sizeOf = (src: string) => new Promise<{ width: number; height: number }>((resolve, reject) => {
  const picture = new Image()
  picture.onload = () => resolve({ width: picture.naturalWidth, height: picture.naturalHeight })
  picture.onerror = () => reject(new Error('This image could not be loaded.'))
  picture.src = src
})

function ReportPage({ url, title, relativePath, card }: ViewerProps) {
  const context = useContext(AnnotateContext)
  const annotateTarget = annotatable(context, url)
  const markdown = /\.md$/i.test(relativePath)
  const drawing = /\.excalidraw$/i.test(relativePath)
  const image = /\.(png|jpe?g|gif|webp|svg|bmp)$/i.test(relativePath)
  const [file, setFile] = useState<Preview | null>(null)
  const [error, setError] = useState('')
  const [available, setAvailable] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const paint = useRef(0)
  // HTML edit mode (local app only: it needs the service to write the file). `saves` counts saves,
  // so the page reloads from disk afterwards instead of from the browser's cache.
  const html = /\.html?$/i.test(relativePath)
  const [editing, setEditing] = useState(false)
  const [saves, setSaves] = useState(0)
  const canEdit = host.saves && html
  useEffect(() => {
    if (!canEdit || editing) return
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'e') {
        event.preventDefault(); setEditing(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [canEdit, editing])
  const reveal = () => {
    cancelAnimationFrame(paint.current)
    paint.current = requestAnimationFrame(() => { paint.current = requestAnimationFrame(() => setLoaded(true)) })
  }
  // A Markdown section of a card, on a host without the local file service: read and saved
  // through the card routes (the published site). The local app keeps its own file editor.
  const throughCards = markdown && !host.saves && host.cards && !!card
  const [startEditing] = useState(() => !!card && takeEditing(card.workspace, card.id, card.path))
  useEffect(() => {
    if (drawing) return // DrawingSection loads its own picture and scene
    const controller = new AbortController()
    if (throughCards && card) {
      readSection(card.workspace, card.id, card.path)
        .then(value => { if (!controller.signal.aborted) setFile({ name: title, path: relativePath, kind: 'text', size: 0, text: value.text, revision: value.etag ?? undefined, url }) })
        .catch(error => { if (!controller.signal.aborted) setError(String(error.message || error)) })
    } else if (markdown && host.saves) {
      // Card files arrive as absolute paths (the workspace may be its own repo); others are relative to the app repo.
      const full = /^(?:[a-zA-Z]:)?[\\/]/.test(relativePath) ? relativePath : `${serviceState().repo}/${relativePath}`
      api<Preview>(`/preview?path=${encodeURIComponent(full)}`).then(value => { if (!controller.signal.aborted) setFile(value) }).catch(error => { if (!controller.signal.aborted) setError(String(error.message || error)) })
    } else {
      fetch(url, { method: markdown ? 'GET' : 'HEAD', signal: controller.signal }).then(async response => {
        if (!response.ok) throw new Error(`Page unavailable (${response.status}).`)
        if (controller.signal.aborted) return
        setAvailable(true)
        if (markdown) setFile({ name: title, path: relativePath, kind: 'text', size: 0, text: await response.text(), url })
      }).catch(error => { if (!controller.signal.aborted) setError(String(error.message || error)) })
    }
    return () => { controller.abort(); cancelAnimationFrame(paint.current) }
  }, [url, title, relativePath, markdown, drawing]) // eslint-disable-line react-hooks/exhaustive-deps
  if (drawing) return <DrawingSection url={url} title={title} card={card} startEditing={startEditing} />
  if (error) return <div className="report-error"><strong>{title}</strong><p>{error}</p><a href={url} target="_blank" rel="noreferrer">Open source file</a></div>
  if (markdown && throughCards && card) return file
    ? <MarkdownDocument file={file} keys startEditing={startEditing}
      onSave={async (text, revision) => { const saved = await saveSection(card.workspace, card.id, card.path, text, revision ?? null); return { text: saved.text, revision: saved.etag ?? undefined } }} />
    : <div className="report-loading">Opening document…</div>
  if (markdown) return file ? host.saves ? <MarkdownDocument file={file} keys startEditing={startEditing} /> : <div className="markdown-reader"><MarkdownView text={file.text || ''} baseUrl={url} /></div> : <div className="report-loading">Opening document…</div>
  if (image) return <div className="report-image"><nav><span>{title}</span><a href={url} target="_blank" rel="noreferrer">Open original</a>{annotateTarget && context && <button type="button" className="report-annotate" onClick={() => void sizeOf(url).then(size => context.annotate(annotateTarget, size.width, size.height)).catch(problem => setError(problem.message))}>✎ Annotate</button>}<a href={url} onClick={event => { event.preventDefault(); void downloadImage(url).catch(error => setError(error.message)) }}>Download</a></nav><ZoomImage src={url} alt={title} plain /></div>
  const ready = available && loaded
  const fullPath = /^(?:[a-zA-Z]:)?[\\/]/.test(relativePath) ? relativePath : `${serviceState().repo}/${relativePath}`
  if (canEdit && editing) return <div className="report-document"><HtmlEditor path={fullPath} url={url} title={title} onClose={() => setEditing(false)} onSaved={() => setSaves(n => n + 1)} /></div>
  const framed = frameUrl(url)
  const shown = saves ? `${framed}${framed.includes('?') ? '&' : '?'}buw-saved=${saves}` : framed
  return <div className="report-document" aria-busy={!ready}>
    {canEdit && ready && <button type="button" className="report-edit" onClick={() => setEditing(true)} title="Edit the text on this page ( Ctrl+E )">✎ Edit</button>}
    <ReportFrame url={shown} title={title} bridge={card ? { workspace: card.workspace, id: card.id } : undefined} className={`report-frame${ready ? ' loaded' : ''}`} sandbox={new URL(framed, window.location.href).origin !== window.location.origin ? 'allow-scripts allow-same-origin allow-forms allow-popups allow-downloads' : undefined} onLoad={reveal} onError={() => setError('This page could not be loaded.')} />
    {!ready && <div className="report-loading" role="status">Opening report…</div>}
  </div>
}
