import { createPortal } from 'react-dom'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Excalidraw, exportToBlob, getSceneVersion, restore, serializeAsJSON } from '@excalidraw/excalidraw'
import type { BinaryFiles, ExcalidrawImperativeAPI, ExcalidrawInitialDataState } from '@excalidraw/excalidraw/types'
import '@excalidraw/excalidraw/index.css'
import { readDrawing, saveDrawing } from '../lib/cards'
import type { SavedDrawing } from '../lib/cards'
import { backgroundUrl } from '../lib/annotate'
import './cards.css'
import type { EditableCard } from './ReportViewer'

// Imported only through lazy(): Excalidraw's own stylesheet is global, so it must not reach the
// Library's first load.

declare global {
  interface Window { EXCALIDRAW_ASSET_PATH?: string }
}

/** Embedded images stay out of scenes (they are capped at 2 MB); the canvas offers no way to load or export files. */
const UI_OPTIONS = {
  tools: { image: false },
  canvasActions: { loadScene: false, saveToActiveFile: false, export: false, saveAsImage: false },
} as const

const EMPTY_SCENE = { type: 'excalidraw', version: 2, source: 'bunnyufo-workspace', elements: [], appState: {}, files: {} }

interface Current { text: string; etag: string | null }

/**
 * Where a drawing comes from and goes to when it is not a card's tab (the Hub's Sketch and Ask
 * answers): load the scene, save it with its picture, and fetch a background picture by name.
 */
export interface DrawingIo {
  load(): Promise<{ text: string; etag: string | null }>
  save(scene: string, pngBase64: string, base: string | null): Promise<{ etag: string | null }>
  background(name: string): Promise<Blob>
}

const message = (problem: unknown) => problem instanceof Error ? problem.message : String(problem)

/** The scene text as the editor's starting point. `restore` fills in what an agent-written scene leaves out. */
function initialOf(text: string): ExcalidrawInitialDataState {
  let parsed: unknown = EMPTY_SCENE
  if (text.trim()) {
    try { parsed = JSON.parse(text) } catch { throw new Error('This drawing is not valid JSON.') }
  }
  const restored = restore(parsed as Parameters<typeof restore>[0], null, null)
  return { elements: restored.elements, appState: { ...restored.appState, collaborators: new Map() }, files: restored.files, scrollToContent: true } as ExcalidrawInitialDataState
}

const MIME_OF: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml' }

const dataUrl = (blob: Blob) => new Promise<string>((resolve, reject) => {
  const reader = new FileReader()
  reader.onload = () => resolve(String(reader.result))
  reader.onerror = () => reject(new Error('The picture could not be read.'))
  reader.readAsDataURL(blob)
})

/**
 * The pictures an annotation sits on. The scene names them (`customData.buwSrc`, a file beside the
 * drawing) and does not hold them, so they are fetched from the card each time; they come from
 * the same origin, which keeps the canvas from being tainted for the PNG export. Returns the
 * pictures it could not get.
 */
async function backgrounds(initial: ExcalidrawInitialDataState, sceneUrl: string, signal: AbortSignal, io?: DrawingIo): Promise<string[]> {
  const files: BinaryFiles = {}
  const missing: string[] = []
  const base = new URL(sceneUrl, window.location.href)
  for (const element of (initial.elements ?? []) as readonly { fileId?: string | null; customData?: { buwSrc?: string } }[]) {
    const name = element.customData?.buwSrc
    if (!name || !element.fileId || files[element.fileId]) continue
    try {
      let blob: Blob
      if (io) {
        blob = await io.background(name)
      } else {
        const response = await fetch(backgroundUrl(name, base), { signal })
        if (!response.ok) throw new Error(`${response.status}`)
        blob = await response.blob()
      }
      const type = blob.type.startsWith('image/') ? blob.type : MIME_OF[name.split('.').pop()?.toLowerCase() ?? ''] ?? 'image/png'
      files[element.fileId] = { id: element.fileId as never, dataURL: (await dataUrl(blob.slice(0, blob.size, type))) as never, mimeType: type as never, created: Date.now() }
    } catch (problem) {
      if (signal.aborted) throw problem
      missing.push(name)
    }
  }
  initial.files = { ...(initial.files ?? {}), ...files }
  return missing
}

/** At most 2048 px on the long side and at most 2x, so a small drawing is not blown up. */
const dimensions = (width: number, height: number) => {
  const scale = Math.min(2, 2048 / Math.max(width, height, 1))
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), scale }
}

const toBase64 = (blob: Blob) => new Promise<string>((resolve, reject) => {
  const reader = new FileReader()
  reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''))
  reader.onerror = () => reject(new Error('The picture could not be read.'))
  reader.readAsDataURL(blob)
})

/**
 * The drawing canvas. Without `card` it only shows the scene (a drawing that has no picture yet);
 * with one it is a full-screen editor that saves the scene and its PNG through the card routes.
 */
export default function DrawingEditor({ url, title, card, io, onClose }: { url: string; title: string; card?: EditableCard; io?: DrawingIo; onClose?: (saved?: SavedDrawing) => void }) {
  const editing = !!card || !!io
  // The card prop is a new object on every render of the page; what it names is what matters.
  const workspace = card?.workspace, id = card?.id, file = card?.path
  const [initial, setInitial] = useState<ExcalidrawInitialDataState | null>(null)
  const [generation, setGeneration] = useState(0)
  const [error, setError] = useState('')
  const [warning, setWarning] = useState('')
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [conflict, setConflict] = useState<Current | null>(null)
  const api = useRef<ExcalidrawImperativeAPI | null>(null)
  const etag = useRef<string | null>(null)
  const baseline = useRef<number | null>(null)
  const busy = useRef(false)
  // The picture saved most recently, handed back on closing so the section shows it, not the old one.
  const lastSaved = useRef<SavedDrawing | undefined>(undefined)

  useEffect(() => {
    const controller = new AbortController()
    const load = io
      ? io.load()
      : workspace && id && file
      ? readDrawing(workspace, id, file)
      : fetch(url, { signal: controller.signal }).then(async response => {
        if (!response.ok) throw new Error(`Drawing unavailable (${response.status}).`)
        return { text: await response.text(), etag: null } as Current
      })
    load.then(async value => {
      const start = initialOf(value.text)
      const missing = await backgrounds(start, url, controller.signal, io)
      if (controller.signal.aborted) return
      etag.current = value.etag
      setWarning(missing.length ? 'The original image is missing' : '')
      setInitial(start)
    }).catch(problem => { if (!controller.signal.aborted) setError(message(problem)) })
    return () => controller.abort()
  }, [url, workspace, id, file, io])

  const save = useCallback(async (base?: string | null): Promise<SavedDrawing | null> => {
    const canvas = api.current
    if (!canvas || (!io && (!workspace || !id || !file)) || busy.current) return null
    busy.current = true
    setSaving(true); setError('')
    try {
      const elements = canvas.getSceneElements()
      const appState = canvas.getAppState()
      const files = canvas.getFiles()
      // A background picture is fetched from the card each time it opens, so it never goes into the scene.
      const scene = JSON.parse(serializeAsJSON(elements, appState, files, 'local')) as { elements: { fileId?: string; customData?: { buwSrc?: string } }[]; files: Record<string, unknown> }
      for (const element of scene.elements) if (element.customData?.buwSrc && element.fileId) delete scene.files[element.fileId]
      const blob = await exportToBlob({
        elements, files, mimeType: 'image/png',
        appState: { ...appState, exportBackground: true, exportWithDarkMode: false },
        getDimensions: dimensions,
      })
      const body = await toBase64(blob)
      const baseTag = base === undefined ? etag.current : base
      const saved = io
        ? { ...(await io.save(JSON.stringify(scene), body, baseTag)), png: '' } as SavedDrawing
        : await saveDrawing(workspace as string, id as string, file as string, JSON.stringify(scene), body, baseTag)
      etag.current = saved.etag
      lastSaved.current = saved
      baseline.current = getSceneVersion(elements)
      setDirty(false); setConflict(null)
      return saved
    } catch (problem) {
      const failure = problem as { status?: number; answer?: { current?: Current | null } }
      if (failure.status === 409 && failure.answer && 'current' in failure.answer) setConflict(failure.answer.current ?? { text: '', etag: null })
      else setError(message(problem))
      return null
    } finally { busy.current = false; setSaving(false) }
  }, [workspace, id, file, io])

  const done = async () => {
    if (!dirty) { onClose?.(lastSaved.current); return }
    const saved = await save()
    if (saved) onClose?.(saved)
  }
  const cancel = () => {
    if (dirty && !window.confirm('Discard the changes you have not saved?')) return
    onClose?.(lastSaved.current)
  }
  const loadTheirs = () => {
    if (!conflict) return
    try {
      etag.current = conflict.etag
      baseline.current = null
      setInitial(initialOf(conflict.text))
      setGeneration(value => value + 1)
      setConflict(null); setDirty(false)
    } catch (problem) { setError(message(problem)) }
  }

  const latest = useRef({ save, done })
  useEffect(() => { latest.current = { save, done } })
  useEffect(() => {
    if (!editing) return
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 's') {
        event.preventDefault(); event.stopPropagation()
        void latest.current.save()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [editing])
  useEffect(() => {
    if (!editing || !dirty) return
    const guard = (event: BeforeUnloadEvent) => { event.preventDefault() }
    window.addEventListener('beforeunload', guard)
    return () => window.removeEventListener('beforeunload', guard)
  }, [editing, dirty])

  const canvas = useMemo(() => initial && (
    <Excalidraw
      key={generation}
      theme="dark"
      viewModeEnabled={!editing}
      initialData={initial}
      UIOptions={UI_OPTIONS}
      excalidrawAPI={value => { api.current = value }}
      onChange={elements => {
        const version = getSceneVersion(elements)
        // The first change is the editor settling the scene it was given, not an edit.
        if (baseline.current === null) { baseline.current = version; return }
        setDirty(version !== baseline.current)
      }}
    />
  ), [initial, generation, editing])

  const state = saving ? 'Saving…' : dirty ? 'Unsaved changes' : 'Saved'
  const body = <div className={editing ? 'drawing-editor' : 'drawing-viewer'} data-buw-editing={editing ? '' : undefined}>
    {editing && <header className="drawing-bar">
      <strong title={title}>{title}</strong>
      <span className={`drawing-state${dirty ? ' dirty' : ''}`} role="status">{state}</span>
      <span className="drawing-bar-actions">
        <button type="button" onClick={() => void save()} disabled={saving || !initial} title="Save ( Ctrl+S )">Save</button>
        <button type="button" className="primary" onClick={() => void done()} disabled={saving || !initial} title="Save and close">Done</button>
        <button type="button" onClick={cancel} disabled={saving}>Cancel</button>
      </span>
    </header>}
    {conflict && <div className="document-conflict drawing-notice" role="alert">
      <span>Changed elsewhere since you opened it.</span>
      <button type="button" onClick={loadTheirs}>Load theirs</button>
      <button type="button" onClick={() => void save(conflict.etag)}>Keep mine</button>
    </div>}
    {error && <p className="drawing-notice drawing-error" role="alert">{error}</p>}
    {warning && <p className="drawing-notice drawing-error" role="status">{warning}</p>}
    <div className="drawing-canvas">{canvas ?? (!error && <div className="report-loading" role="status">Opening drawing…</div>)}</div>
  </div>
  // The editor covers the whole window, so it leaves the page's own stacking (the file rail and the menus sit in it).
  return editing ? createPortal(body, document.body) : body
}
