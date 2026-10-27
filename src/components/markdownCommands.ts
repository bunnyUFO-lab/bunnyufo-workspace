import { EditorSelection, type ChangeSpec, type EditorState } from '@codemirror/state'
import type { Command, EditorView } from '@codemirror/view'
import { snippetCompletion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete'

/**
 * Formatting for the Markdown editor: the toolbar buttons, their shortcuts, `/` commands that
 * insert larger blocks (tables, code, task lists), and Enter in a table row starting the next one.
 */

/** `**bold**`, `*italic*`, `` `code` ``: wraps the selection, or unwraps it when it already is. */
export const wrap = (mark: string): Command => view => {
  const { state } = view
  view.dispatch(state.changeByRange(range => {
    const before = state.sliceDoc(range.from - mark.length, range.from)
    const after = state.sliceDoc(range.to, range.to + mark.length)
    if (before === mark && after === mark) {
      return {
        changes: [{ from: range.from - mark.length, to: range.from }, { from: range.to, to: range.to + mark.length }],
        range: EditorSelection.range(range.from - mark.length, range.to - mark.length),
      }
    }
    const text = state.sliceDoc(range.from, range.to)
    if (text.length > mark.length * 2 && text.startsWith(mark) && text.endsWith(mark)) {
      return { changes: { from: range.from, to: range.to, insert: text.slice(mark.length, -mark.length) }, range: EditorSelection.range(range.from, range.to - mark.length * 2) }
    }
    return {
      changes: [{ from: range.from, insert: mark }, { from: range.to, insert: mark }],
      range: EditorSelection.range(range.from + mark.length, range.to + mark.length),
    }
  }), { userEvent: 'input.format', scrollIntoView: true })
  view.focus()
  return true
}

/** The lines the selection touches, each once. */
function selectedLines(state: EditorState) {
  const seen = new Set<number>()
  const lines = []
  for (const range of state.selection.ranges) {
    for (let n = state.doc.lineAt(range.from).number; n <= state.doc.lineAt(range.to).number; n++) {
      if (!seen.has(n)) { seen.add(n); lines.push(state.doc.line(n)) }
    }
  }
  return lines
}

const LIST_MARK = /^(\s*)(?:[-*+] \[[ xX]\] |[-*+] |\d+[.)] |> |#{1,6} )/

/**
 * Starts every selected line with `prefix` (a list, quote or heading), replacing another such
 * marker; when every line already has it, takes it off. `numbered` counts 1., 2., 3. instead.
 */
export const linePrefix = (prefix: string, numbered = false): Command => view => {
  const { state } = view
  const lines = selectedLines(state)
  const marker = (index: number) => (numbered ? `${index + 1}. ` : prefix)
  const has = (text: string, index: number) => text.replace(/^\s*/, '').startsWith(marker(index)) || (numbered && /^\s*\d+[.)] /.test(text))
  const remove = lines.every((line, index) => has(line.text, index))
  const changes: ChangeSpec[] = lines.map((line, index) => {
    const found = LIST_MARK.exec(line.text)
    const indent = /^\s*/.exec(line.text)![0].length
    const from = line.from + indent
    const to = found ? line.from + found[0].length : from
    return { from, to, insert: remove ? '' : marker(index) }
  })
  view.dispatch({ changes, userEvent: 'input.format', scrollIntoView: true })
  view.focus()
  return true
}

/** `[text](url)` with the url selected to type over, or `[link text](url)` with the text selected. */
export const link: Command = view => {
  const { state } = view
  view.dispatch(state.changeByRange(range => {
    const text = state.sliceDoc(range.from, range.to)
    if (!text) {
      const insert = '[link text](https://)'
      return { changes: { from: range.from, insert }, range: EditorSelection.range(range.from + 1, range.from + 10) }
    }
    const insert = `[${text}](https://)`
    const start = range.from + text.length + 3
    return { changes: { from: range.from, to: range.to, insert }, range: EditorSelection.range(start, start + 8) }
  }), { userEvent: 'input.format', scrollIntoView: true })
  view.focus()
  return true
}

/** Puts `block` on lines of its own at the cursor; `select` is the part of it to select after. */
function insertBlock(view: EditorView, block: string, select?: string) {
  const { state } = view
  const range = state.selection.main
  const line = state.doc.lineAt(range.from)
  const lead = line.text.trim() ? (range.from === line.from ? '' : '\n\n') : ''
  const tail = state.doc.lineAt(range.to)
  const trail = tail.to === range.to && tail.number === state.doc.lines ? '\n' : '\n\n'
  const insert = `${lead}${block}${trail}`
  const at = select ? insert.indexOf(select) : -1
  view.dispatch({
    changes: { from: range.from, to: range.to, insert },
    selection: at >= 0 ? EditorSelection.range(range.from + at, range.from + at + select!.length) : EditorSelection.cursor(range.from + lead.length + block.length),
    userEvent: 'input.format', scrollIntoView: true,
  })
  view.focus()
  return true
}

export const TABLE = '| Column | Column |\n| --- | --- |\n| Cell | Cell |'

export const table: Command = view => insertBlock(view, TABLE, 'Column')

/** A fenced block around the selected lines, or an empty one. */
export const codeBlock: Command = view => {
  const { state } = view
  const range = state.selection.main
  if (range.empty) return insertBlock(view, '```\n\n```')
  const from = state.doc.lineAt(range.from).from, to = state.doc.lineAt(range.to).to
  view.dispatch({ changes: [{ from, insert: '```\n' }, { from: to, insert: '\n```' }], userEvent: 'input.format' })
  view.focus()
  return true
}

/** The shortcuts the toolbar names in its tooltips. */
export const formatKeys = [
  { key: 'Mod-b', run: wrap('**') },
  { key: 'Mod-i', run: wrap('*') },
  { key: 'Mod-k', run: link },
  { key: 'Mod-Shift-x', run: wrap('~~') },
]

/**
 * Enter at the end of a table row starts the next row with the same number of cells. An Enter
 * on the row right after the header's `| --- |` line works too; anywhere else in the line it is
 * an ordinary Enter.
 */
export const continueTable: Command = view => {
  const { state } = view
  const range = state.selection.main
  if (!range.empty) return false
  const line = state.doc.lineAt(range.from)
  if (range.from !== line.to || !/^\s*\|.*\|\s*$/.test(line.text)) return false
  const cells = line.text.trim().slice(1, -1).split('|').length
  const row = `\n|${'  |'.repeat(cells)}`
  view.dispatch({ changes: { from: line.to, insert: row }, selection: EditorSelection.cursor(line.to + 3), userEvent: 'input', scrollIntoView: true })
  return true
}

/** `/` at the start of a line (or after a space) offers blocks to insert; Tab moves between their fields. */
const SLASH = [
  // Numbered fields: fields with the same name are one field in CodeMirror, edited together.
  snippetCompletion('| ${1:Column} | ${2:Column} |\n| --- | --- |\n| ${3:Cell} | ${4:Cell} |\n${5}', { label: '/table', detail: 'Table, 2 columns', type: 'class' }),
  snippetCompletion('| ${1:Column} | ${2:Column} | ${3:Column} |\n| --- | --- | --- |\n| ${4:Cell} | ${5:Cell} | ${6:Cell} |\n${7}', { label: '/table3', detail: 'Table, 3 columns', type: 'class' }),
  snippetCompletion('- [ ] ${task}', { label: '/todo', detail: 'Task list', type: 'keyword' }),
  snippetCompletion('- ${item}', { label: '/list', detail: 'Bulleted list', type: 'keyword' }),
  snippetCompletion('1. ${item}', { label: '/numbered', detail: 'Numbered list', type: 'keyword' }),
  snippetCompletion('```${language}\n${}\n```', { label: '/code', detail: 'Code block', type: 'function' }),
  snippetCompletion('> ${quote}', { label: '/quote', detail: 'Quote', type: 'text' }),
  snippetCompletion('## ${Heading}', { label: '/h2', detail: 'Heading', type: 'text' }),
  snippetCompletion('### ${Heading}', { label: '/h3', detail: 'Subheading', type: 'text' }),
  snippetCompletion('[${text}](${https://})', { label: '/link', detail: 'Link', type: 'variable' }),
  snippetCompletion('![${description}](${image.png})', { label: '/image', detail: 'Image', type: 'variable' }),
  snippetCompletion('<details>\n<summary>${Summary}</summary>\n\n${}\n\n</details>', { label: '/details', detail: 'Collapsible section', type: 'text' }),
  snippetCompletion('---\n', { label: '/divider', detail: 'Horizontal rule', type: 'text' }),
]

export function slashCommands(context: CompletionContext): CompletionResult | null {
  const word = context.matchBefore(/(?:^|\s)\/\w*$/)
  if (!word) return null
  const from = word.text.startsWith('/') ? word.from : word.from + 1
  return { from, options: SLASH, validFor: /^\/\w*$/ }
}
