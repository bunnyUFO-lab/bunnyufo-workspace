import { useEffect, useRef } from 'react'
import { EditorState, Prec } from '@codemirror/state'
import { EditorView, keymap, placeholder, type Command } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { autocompletion, completionKeymap } from '@codemirror/autocomplete'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { languages } from '@codemirror/language-data'
import { tags } from '@lezer/highlight'
import { codeBlock, continueTable, formatKeys, linePrefix, link, slashCommands, table, wrap } from './markdownCommands'

/**
 * The Markdown source editor (CodeMirror 6), loaded only when someone edits: the read-only site
 * never fetches it. Colours come from the theme tokens, so it follows the light and dark themes.
 * The Markdown package continues lists on Enter and makes a URL pasted over selected text a link.
 */

const highlight = HighlightStyle.define([
  { tag: tags.heading, color: 'var(--text-bright)', fontWeight: '600' },
  { tag: tags.heading1, fontSize: '1.2em' },
  { tag: tags.heading2, fontSize: '1.1em' },
  { tag: [tags.emphasis], fontStyle: 'italic' },
  { tag: [tags.strong], fontWeight: '700', color: 'var(--text-bright)' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { tag: [tags.link, tags.url], color: 'var(--pink)' },
  { tag: [tags.processingInstruction, tags.contentSeparator, tags.labelName], color: 'var(--text-muted)' },
  { tag: [tags.monospace], color: 'var(--amber)' },
  { tag: tags.quote, color: 'var(--text-dim)', fontStyle: 'italic' },
  { tag: [tags.keyword, tags.operator], color: 'var(--pink)' },
  { tag: [tags.string, tags.special(tags.string)], color: 'var(--amber)' },
  { tag: [tags.comment, tags.meta], color: 'var(--text-muted)' },
  { tag: [tags.number, tags.bool, tags.atom], color: 'var(--purple)' },
])

/** The toolbar: label, tooltip, the command, and an icon (SVG path data on a 16px grid) or a letter. */
const TOOLS: { label: string; title: string; run: Command; icon?: string; text?: string }[] = [
  { label: 'Bold', title: 'Bold (Ctrl+B)', run: wrap('**'), text: 'B' },
  { label: 'Italic', title: 'Italic (Ctrl+I)', run: wrap('*'), text: 'I' },
  { label: 'Strikethrough', title: 'Strikethrough (Ctrl+Shift+X)', run: wrap('~~'), text: 'S' },
  { label: 'Heading', title: 'Heading', run: linePrefix('## '), text: 'H' },
  { label: 'Link', title: 'Link (Ctrl+K), or paste a URL over selected text', run: link, icon: 'M6.5 9.5l3-3M7 4.5l1-1a2.8 2.8 0 0 1 4 4l-1 1M9 11.5l-1 1a2.8 2.8 0 0 1-4-4l1-1' },
  { label: 'Inline code', title: 'Inline code', run: wrap('`'), icon: 'M5.5 4.5L2 8l3.5 3.5M10.5 4.5L14 8l-3.5 3.5' },
  { label: 'Quote', title: 'Quote', run: linePrefix('> '), icon: 'M3 4v8M6 5h7M6 8h7M6 11h5' },
  { label: 'Bulleted list', title: 'Bulleted list', run: linePrefix('- '), icon: 'M6 4h8M6 8h8M6 12h8M2.5 4h.01M2.5 8h.01M2.5 12h.01' },
  { label: 'Numbered list', title: 'Numbered list', run: linePrefix('', true), icon: 'M7 4h7M7 8h7M7 12h7M2 3l1-.5V6M2 9.5c.3-.6 2-.6 2 .3 0 .7-2 1.4-2 2.2h2' },
  { label: 'Task list', title: 'Task list', run: linePrefix('- [ ] '), icon: 'M2 3.5h3v3H2zM2 9.5h3v3H2zM7 5h7M7 11h7' },
  { label: 'Code block', title: 'Code block', run: codeBlock, icon: 'M2.5 2.5h11v11h-11zM6 6.5L4.5 8 6 9.5M10 6.5L11.5 8 10 9.5' },
  { label: 'Table', title: 'Table, or type /table', run: table, icon: 'M2 2.5h12v11H2zM2 6.5h12M2 10h12M6.5 2.5v11' },
]

export default function MarkdownEditor({ value, onChange, label, onSave, onScroll }: {
  value: string
  onChange: (text: string) => void
  label: string
  /** Ctrl+S inside the editor, when the page does not already take it. */
  onSave?: () => void
  /** How far down the editor is scrolled, 0 to 1, for a preview beside it to follow. */
  onScroll?: (fraction: number) => void
}) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  // The editor is made once; these keep its callbacks current without remaking it.
  const latest = useRef({ onChange, onSave, onScroll })
  useEffect(() => { latest.current = { onChange, onSave, onScroll } })

  useEffect(() => {
    const editor = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          history(),
          // Ahead of the Markdown keymap, so Enter at the end of a table row adds a row.
          Prec.highest(keymap.of([{ key: 'Enter', run: continueTable }])),
          keymap.of([
            { key: 'Mod-s', run: () => { if (!latest.current.onSave) return false; latest.current.onSave(); return true } },
            ...formatKeys, ...completionKeymap, indentWithTab, ...defaultKeymap, ...historyKeymap,
          ]),
          markdown({ base: markdownLanguage, codeLanguages: languages, completeHTMLTags: false }),
          autocompletion({ override: [slashCommands], icons: false }),
          syntaxHighlighting(highlight),
          EditorView.lineWrapping,
          placeholder('Write Markdown…'),
          EditorView.contentAttributes.of({ 'aria-label': label, spellcheck: 'false' }),
          EditorView.updateListener.of(update => { if (update.docChanged) latest.current.onChange(update.state.doc.toString()) }),
          EditorView.domEventHandlers({
            scroll: (_, editorView) => {
              const box = editorView.scrollDOM
              const room = box.scrollHeight - box.clientHeight
              latest.current.onScroll?.(room > 0 ? box.scrollTop / room : 0)
            },
          }),
        ],
      }),
    })
    view.current = editor
    editor.focus()
    return () => { editor.destroy(); view.current = null }
    // Made once per mount; `value` changes from outside are applied below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // A discard or "use their version" replaces the text from outside the editor.
  useEffect(() => {
    const editor = view.current
    if (editor && editor.state.doc.toString() !== value) editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: value } })
  }, [value])

  // mousedown, not click: the editor keeps its focus and selection while a button is pressed.
  return <div className="markdown-editor">
    <div className="markdown-format" role="toolbar" aria-label="Formatting">
      {TOOLS.map(tool => <button key={tool.label} type="button" aria-label={tool.label} title={tool.title}
        className={tool.text ? `markdown-format-${tool.label.toLowerCase()}` : undefined}
        onMouseDown={event => { event.preventDefault(); if (view.current) tool.run(view.current) }}
        onKeyDown={event => { if ((event.key === 'Enter' || event.key === ' ') && view.current) { event.preventDefault(); tool.run(view.current) } }}>
        {tool.text ?? <svg viewBox="0 0 16 16" aria-hidden="true"><path d={tool.icon} /></svg>}
      </button>)}
      <span className="markdown-format-hint">Type / for tables, lists, code…</span>
    </div>
    <div className="markdown-editor-body" ref={host} />
  </div>
}
