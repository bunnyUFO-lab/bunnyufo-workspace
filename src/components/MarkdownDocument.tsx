import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { api } from '../local/client'
import type { Preview } from '../local/types'
import './documents.css'
import { ZoomImage } from './ImagePreview'
import { stripFrontMatter } from './frontMatter'
import './cards.css'

// How much text a table cell holds. A phone gives a cell of prose more room than one holding a
// number or a name (documents.css), or the table squeezes every column to the same narrow width.
type Hast = { type: string; value?: string; children?: Hast[] }
const textLength = (node?: Hast): number =>
  !node ? 0 : node.type === 'text' ? node.value?.length ?? 0 : (node.children ?? []).reduce((n, c) => n + textLength(c), 0)
const LONG_CELL = 40

// CodeMirror is only fetched once someone edits: reading a card never loads it.
const MarkdownEditor = lazy(() => import('./MarkdownEditor'))

/** The editor and the preview side by side need this much room; below it, Split falls back to Edit. */
const SPLIT_WIDTH = 960
const SPLIT_KEY = 'buw.md-split'
const readSplit = () => { try { return localStorage.getItem(SPLIT_KEY) === '1' } catch { return false } }

const drafts = new Map<string, string>()
function restoreDraft(key: string, fallback: string) {
  if (drafts.has(key)) return drafts.get(key)!
  try { return sessionStorage.getItem(key) ?? fallback } catch { return fallback }
}

export function MarkdownView({ text, baseUrl }: { text: string; baseUrl?: string }) {
  // Browser preview supplies /workspace/...; URL's base must be absolute.
  const base = baseUrl ? new URL(baseUrl, window.location.href).href : undefined
  return <article className="buw-markdown"><Markdown remarkPlugins={[remarkGfm]} components={{
    a: ({ href, children }) => <a href={href?.startsWith('#') ? href : href && base ? new URL(href, base).href : href} target={href?.startsWith('#') ? undefined : '_blank'} rel="noreferrer">{children}</a>,
    td: ({ node, children, style }) => <td style={style} data-long={textLength(node as Hast) > LONG_CELL || undefined}>{children}</td>,
    img: ({ src, alt }) => <ZoomImage src={typeof src === 'string' ? base ? new URL(src, base).href : src : undefined} alt={alt} />,
  }}>{stripFrontMatter(text)}</Markdown></article>
}

/** What a save answers: the text now on disk or in the bucket, and the revision to name next time. */
export interface Saved { text: string; revision?: string }

/** A refused save: someone else wrote the file since this editor read it. */
interface Conflict { text: string; revision?: string }

/**
 * `keys` makes this the document Ctrl+E and Ctrl+S act on from anywhere on the page, not only
 * from inside the editor: the open card's note takes them, a preview in the files rail does not.
 *
 * `onSave` replaces the local service's file save: a card section on the published site saves
 * through the card routes instead. Either way a save names the revision it started from, and
 * one refused because the file changed since comes back as a conflict to resolve here.
 */
export default function MarkdownDocument({ file, keys = false, onSave, startEditing = false }: {
  file: Preview
  keys?: boolean
  onSave?: (text: string, revision: string | undefined) => Promise<Saved>
  /** Open in the editor: a section just made has nothing to read yet. */
  startEditing?: boolean
}) {
  const draftKey = `buw.md-draft.${file.path}`
  const [saved, setSaved] = useState(file.text || '')
  const [draft, setDraft] = useState(() => restoreDraft(draftKey, file.text || ''))
  const [revision, setRevision] = useState(file.revision)
  const [editing, setEditing] = useState(startEditing)
  const [conflict, setConflict] = useState<Conflict | null>(null)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  // Split is a preference remembered in this browser; it shows only while there is room for it.
  const [split, setSplit] = useState(readSplit)
  const [wide, setWide] = useState(false)
  const reader = useRef<HTMLDivElement>(null)
  // A callback ref, so the width is watched from whenever the section is attached, not only at mount.
  const [root, setRoot] = useState<HTMLElement | null>(null)
  useEffect(() => {
    if (!root) return
    const measure = () => setWide(root.getBoundingClientRect().width >= SPLIT_WIDTH)
    const observer = new ResizeObserver(measure)
    observer.observe(root)
    measure()
    return () => observer.disconnect()
  }, [root])
  const chooseSplit = (value: boolean) => { setSplit(value); try { localStorage.setItem(SPLIT_KEY, value ? '1' : '0') } catch { /* only this session remembers it */ } }
  const sideBySide = editing && split && wide
  const dirty = draft !== saved
  useEffect(() => {
    if (dirty) drafts.set(draftKey, draft); else drafts.delete(draftKey)
    try { if (dirty) sessionStorage.setItem(draftKey, draft); else sessionStorage.removeItem(draftKey) } catch { /* In-memory drafts still survive file switching when browser storage is full. */ }
    const warn = (event: BeforeUnloadEvent) => { if (dirty) { event.preventDefault(); event.returnValue = '' } }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty, draft, draftKey])
  const save = async () => {
    if (busy || !dirty) return
    setBusy(true); setStatus('Saving…')
    try {
      const result: Saved = onSave
        ? await onSave(draft, revision)
        : await api<Preview>('/files/markdown', { path: file.path, text: draft, revision }).then(value => ({ text: value.text || '', revision: value.revision }))
      setSaved(result.text); setDraft(result.text); setRevision(result.revision); setConflict(null); setStatus('Saved')
    } catch (error) {
      const answer = (error as { status?: number; answer?: { current?: { text: string; etag: string | null } | null } })
      if (answer.status === 409 && answer.answer && 'current' in answer.answer) {
        const current = answer.answer.current
        setConflict({ text: current?.text ?? '', revision: current?.etag ?? undefined })
        setStatus('Not saved')
      } else setStatus(error instanceof Error ? error.message : String(error))
    }
    finally { setBusy(false) }
  }
  // Keep this draft over what is there now (the next save names their revision), or take theirs.
  const keepMine = () => { if (!conflict) return; setRevision(conflict.revision); setConflict(null); setStatus('Save again to replace their version') }
  const takeTheirs = () => { if (!conflict) return; setSaved(conflict.text); setDraft(conflict.text); setRevision(conflict.revision); setConflict(null); setStatus('Loaded their version') }
  const saveRef = useRef(save)
  useEffect(() => { saveRef.current = save })
  useEffect(() => {
    if (!keys) return
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return
      const key = event.key.toLowerCase()
      if (key === 'e') { event.preventDefault(); setEditing(v => !v) }
      else if (key === 's') { event.preventDefault(); void saveRef.current() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [keys])
  // The preview beside the editor follows its scroll, by the same share of the way down.
  const follow = (fraction: number) => {
    const box = reader.current
    if (box) box.scrollTop = fraction * (box.scrollHeight - box.clientHeight)
  }
  const editor = <Suspense fallback={<div className="markdown-editor markdown-editor-loading">Opening the editor…</div>}>
    <MarkdownEditor value={draft} label={`Edit ${file.name}`} onChange={text => { setDraft(text); setStatus('') }}
      onSave={keys ? undefined : () => void save()} onScroll={sideBySide ? follow : undefined} />
  </Suspense>
  return <section className="markdown-document" ref={setRoot}data-buw-editing={editing ? '' : undefined}>
    <div className="document-toolbar"><div className="document-modes" aria-label="Markdown mode">
      <button aria-pressed={!editing} onClick={() => setEditing(false)}>View</button>
      <button aria-pressed={editing && !sideBySide} onClick={() => { setEditing(true); if (wide) chooseSplit(false) }} title={keys ? 'Edit ( Ctrl+E )' : undefined}>Edit</button>
      {wide && <button aria-pressed={sideBySide} onClick={() => { setEditing(true); chooseSplit(true) }} title="Editor and preview side by side">Split</button>}
    </div>
      <span className="document-status" role="status">{status || (dirty ? 'Unsaved draft' : 'Markdown')}</span>
      {dirty && <button disabled={busy} onClick={() => { setDraft(saved); setStatus('Draft discarded') }}>Discard</button>}
      <button className="document-save" disabled={!dirty || busy} onClick={() => void save()}>Save</button>
    </div>
    {conflict && <div className="document-conflict" role="alert">
      <span>This section changed somewhere else since you opened it.</span>
      <button type="button" onClick={takeTheirs}>Use their version</button>
      <button type="button" onClick={keepMine}>Keep mine</button>
    </div>}
    {sideBySide
      ? <div className="markdown-split">{editor}<div className="markdown-reader" ref={reader}><MarkdownView text={draft} baseUrl={file.url} /></div></div>
      : editing ? editor : <div className="markdown-reader"><MarkdownView text={draft} baseUrl={file.url} /></div>}
  </section>
}
