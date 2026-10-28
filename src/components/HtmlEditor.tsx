import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../local/client'
import type { Preview } from '../local/types'
import { useWorkspaceTheme } from '../lib/workspace-theme'
import { reportThemeCSS } from '../../server/report-theme.mjs'

/**
 * Edit an HTML page's text in place: every word on the page is editable, with a small toolbar
 * for bold, italic, underline, font, size and colour.
 *
 * It edits the file's own source, not the page as it ran. The source is loaded into a frame
 * with scripts switched off and the document in design mode, and what is saved is that
 * document serialised back. Editing the running page instead would save whatever its scripts
 * had drawn into the file, baking a chart or a generated list in as static markup. The price is
 * that text a script writes at run time is not on screen while editing.
 *
 * What the editor adds to the frame (a <base> so styles and images resolve, the report theme,
 * the editing outlines) is marked `data-buw-edit` and stripped before saving.
 *
 * The frame is loaded from /html-editor-frame and the page is swapped into it, rather than set
 * as srcDoc: a srcdoc document inherits the app's own CSP, whose base-uri, style-src and
 * font-src refuse the page's relative stylesheets, fonts and the <base> itself. The frame's
 * response carries a policy written for editing. The page is parsed by the frame's own
 * DOMParser (a parser from this window would hand the app's policy to the parsed document) and
 * its root replaces the frame's; document.open()/write() is not used because it takes the URL
 * and policy of the document that calls it, which is the app.
 */
const MARK = 'data-buw-edit'

const EDIT_CSS = `
  [contenteditable], html { caret-color: #f0a0b0; }
  body *:hover { outline: 1px dashed rgb(240 160 176 / 0.45); outline-offset: 2px; }
  body *:focus { outline: none; }
`

const FONTS: [string, string][] = [
  ['', 'Font'],
  ['system-ui, sans-serif', 'Sans'],
  ['Georgia, serif', 'Serif'],
  ['ui-monospace, monospace', 'Mono'],
]
// execCommand's 1–7 scale in pixels; with styleWithCSS it writes font-size: x-small … xxx-large.
// The size buttons step through it relative to the text under the selection, because an absolute
// keyword on a heading that is already that big changes nothing.
const SIZE_STEPS = [10, 13, 16, 18, 24, 32, 48]

/** The colour a browser reports as rgb(r, g, b), as the #rrggbb a colour input takes. */
function toHex(value: string) {
  const match = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(value)
  if (!match) return /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : '#000000'
  return '#' + match.slice(1, 4).map(part => Number(part).toString(16).padStart(2, '0')).join('')
}

/** What the toolbar shows about the selection. */
interface Marks { bold: boolean; italic: boolean; underline: boolean; colour: string; size: number }
const PLAIN: Marks = { bold: false, italic: false, underline: false, colour: '#000000', size: 16 }

function prepare(parser: DOMParser, source: string, baseUrl: string, theme: string) {
  const doc = parser.parseFromString(source, 'text/html')
  const base = doc.createElement('base')
  base.setAttribute('href', baseUrl)
  base.setAttribute(MARK, '')
  const style = doc.createElement('style')
  style.setAttribute(MARK, '')
  style.textContent = reportThemeCSS + EDIT_CSS
  doc.head.prepend(base)
  doc.head.append(style)
  const hadTheme = doc.documentElement.getAttribute('data-buw-theme')
  doc.documentElement.setAttribute('data-buw-theme', theme)
  return { root: doc.documentElement, hadTheme }
}

function serialise(doc: Document, source: string, hadTheme: string | null) {
  const root = doc.documentElement.cloneNode(true) as HTMLElement
  root.querySelectorAll(`[${MARK}]`).forEach(node => node.remove())
  if (hadTheme === null) root.removeAttribute('data-buw-theme')
  else root.setAttribute('data-buw-theme', hadTheme)
  // Keep the file's own doctype line, or none if it had none.
  const doctype = /^\s*(<!doctype[^>]*>)/i.exec(source)?.[1]
  return (doctype ? doctype + '\n' : '') + root.outerHTML + '\n'
}

export default function HtmlEditor({ path, url, title, onClose, onSaved }: {
  /** The file on disk. */
  path: string
  /** Where the page is served, so its relative styles and images resolve while editing. */
  url: string
  title: string
  onClose: () => void
  onSaved: () => void
}) {
  const { resolved } = useWorkspaceTheme()
  const frame = useRef<HTMLIFrameElement>(null)
  const [file, setFile] = useState<Preview | null>(null)
  const hadTheme = useRef<string | null>(null)
  const [marks, setMarks] = useState<Marks>(PLAIN)
  const colourInput = useRef<HTMLInputElement>(null)
  const [ready, setReady] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')

  useEffect(() => {
    let live = true
    api<Preview>(`/files/source?path=${encodeURIComponent(path)}`)
      .then(value => {
        if (!live) return
        setFile(value)
      })
      .catch(error => { if (live) setStatus(error instanceof Error ? error.message : String(error)) })
    return () => { live = false }
  }, [path])

  const doc = () => frame.current?.contentDocument ?? null

  const save = useCallback(async () => {
    const d = frame.current?.contentDocument
    if (!d || !file || !ready || busy) return
    setBusy(true); setStatus('Saving…')
    try {
      const text = serialise(d, file.text || '', hadTheme.current)
      const result = await api<Preview>('/files/markdown', { path: file.path, text, revision: file.revision })
      setFile(result); setDirty(false); setStatus('Saved')
      onSaved()
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }, [file, ready, busy, onSaved])

  const close = useCallback(() => {
    if (dirty && !window.confirm('Leave edit mode and throw away the unsaved changes?')) return
    onClose()
  }, [dirty, onClose])

  // Ctrl+S, Ctrl+E and Esc, from the toolbar or from inside the page being edited (the frame is
  // its own document, so its keys never reach the window on their own).
  const keys = useRef({ save, close })
  useEffect(() => { keys.current = { save, close } })
  const onKey = useCallback((event: KeyboardEvent) => {
    const ctrl = event.ctrlKey || event.metaKey
    const key = event.key.toLowerCase()
    if (ctrl && !event.shiftKey && !event.altKey && key === 's') { event.preventDefault(); void keys.current.save() }
    else if (ctrl && !event.shiftKey && !event.altKey && key === 'e') { event.preventDefault(); event.stopPropagation(); keys.current.close() }
    // An open palette takes Esc first: it closes itself, and the editor stays.
    else if (event.key === 'Escape' && !ctrl && !document.querySelector('dialog.pal[open]')) { event.preventDefault(); event.stopPropagation(); keys.current.close() }
  }, [])
  useEffect(() => {
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onKey])

  // Only the first load sets the page up; a second one must not wipe the edits.
  const written = useRef(false)
  const onLoad = () => {
    const d = doc()
    const win = frame.current?.contentWindow as (Window & { DOMParser: typeof DOMParser }) | null
    if (!d || !win || !file || written.current) return
    written.current = true
    const prepared = prepare(new win.DOMParser(), file.text || '', new URL(url, location.href).href, resolved)
    hadTheme.current = prepared.hadTheme
    d.documentElement.replaceWith(d.importNode(prepared.root, true))
    setReady(true)
    d.designMode = 'on'
    d.execCommand('styleWithCSS', false, 'true')
    d.addEventListener('input', () => { setDirty(true); setStatus('') })
    d.addEventListener('keydown', onKey)
    d.addEventListener('selectionchange', () => setMarks(readMarks()))
  }

  // Bold, italic, underline, colour and size under the selection start, read from the page.
  const readMarks = useCallback((): Marks => {
    const d = frame.current?.contentDocument
    const win = frame.current?.contentWindow
    if (!d || !win) return PLAIN
    const selection = d.getSelection()
    const node = selection && selection.rangeCount ? selection.getRangeAt(0).startContainer : null
    const element = node ? (node.nodeType === 1 ? node as Element : node.parentElement) : null
    return {
      bold: d.queryCommandState('bold'),
      italic: d.queryCommandState('italic'),
      underline: d.queryCommandState('underline'),
      colour: toHex(d.queryCommandValue('foreColor')),
      size: element ? parseFloat(win.getComputedStyle(element).fontSize) || PLAIN.size : PLAIN.size,
    }
  }, [])

  const run = (command: string, value?: string) => {
    const d = doc()
    if (!d) return
    frame.current?.contentWindow?.focus()
    d.execCommand(command, false, value)
    setDirty(true); setStatus('')
    setMarks(readMarks())
  }
  // One step up or down the size scale from the text as it is now.
  const step = (direction: 1 | -1) => {
    const size = readMarks().size
    const next = direction > 0
      ? SIZE_STEPS.find(px => px > size + 0.5)
      : [...SIZE_STEPS].reverse().find(px => px < size - 0.5)
    if (!next) { setStatus(direction > 0 ? 'Already the largest size' : 'Already the smallest size'); return }
    run('fontSize', String(SIZE_STEPS.indexOf(next) + 1))
  }
  // A colour is applied when the picker is committed (the native change event), not on every
  // movement inside it: run() focuses the page, which would pull the keyboard out of the picker
  // while it is still open. React's onChange is the input event, so this one is attached by hand.
  useEffect(() => {
    const input = colourInput.current
    if (!input) return
    const commit = () => run('foreColor', input.value)
    input.addEventListener('change', commit)
    return () => input.removeEventListener('change', commit)
  })
  // Buttons act on the page's selection, so they must not take focus away from it.
  const hold = (event: React.MouseEvent) => event.preventDefault()

  return (
    <div className="html-editor" data-buw-editing="">
      <div className="document-toolbar html-editor-bar" role="toolbar" aria-label={`Edit ${title}`}>
        <button type="button" onMouseDown={hold} onClick={() => run('bold')} aria-pressed={marks.bold} title="Bold ( Ctrl+B )"><b>B</b></button>
        <button type="button" onMouseDown={hold} onClick={() => run('italic')} aria-pressed={marks.italic} title="Italic ( Ctrl+I )"><i>I</i></button>
        <button type="button" onMouseDown={hold} onClick={() => run('underline')} aria-pressed={marks.underline} title="Underline ( Ctrl+U )"><u>U</u></button>
        <select aria-label="Font" value="" onChange={event => { if (event.target.value) run('fontName', event.target.value) }}>
          {FONTS.map(([value, label]) => <option key={label} value={value}>{label}</option>)}
        </select>
        <button type="button" onMouseDown={hold} onClick={() => step(-1)} aria-label="Smaller text" title="Smaller text">A−</button>
        <button type="button" onMouseDown={hold} onClick={() => step(1)} aria-label="Larger text" title="Larger text">A+</button>
        <label className="html-editor-color" title="Text colour">
          <span aria-hidden="true">A</span>
          <input ref={colourInput} type="color" aria-label="Text colour" value={marks.colour} onChange={event => setMarks(current => ({ ...current, colour: event.target.value }))} />
        </label>
        <button type="button" onMouseDown={hold} onClick={() => run('removeFormat')} title="Clear formatting">Clear</button>
        <button type="button" onMouseDown={hold} onClick={() => run('undo')} title="Undo ( Ctrl+Z )">↶</button>
        <button type="button" onMouseDown={hold} onClick={() => run('redo')} title="Redo ( Ctrl+Y )">↷</button>
        <span className="document-status" role="status">
          {status || (dirty ? 'Unsaved changes' : 'Editing — click any text')}
        </span>
        <button type="button" onClick={close} title="Leave edit mode ( Ctrl+E or Esc )">Done</button>
        <button type="button" className="document-save" disabled={!dirty || busy} onClick={() => void save()} title="Save ( Ctrl+S )">Save</button>
      </div>
      {file
        ? <iframe ref={frame} className="report-frame loaded" title={`Editing ${title}`} sandbox="allow-same-origin" src="/html-editor-frame" onLoad={onLoad} />
        : <div className="report-loading" role="status">{status || 'Opening for editing…'}</div>}
    </div>
  )
}
