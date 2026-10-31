// How a chat shows text the way chat apps do. An owner's message is plain text, but a fenced block in it (pasted
// terminal output, a command) shows as code rather than with its backticks. A reply keeps its single line breaks:
// commands an agent wrote on their own lines without a fence stay on their own lines instead of running together.

export type Part = { kind: 'text'; text: string } | { kind: 'code'; lang: string; code: string }

/** A fenced block: ``` or ~~~ on its own line, an optional language, then the same fence closing it. */
const FENCE = /^(`{3,}|~{3,})[ \t]*([\w+-]*)[^\n]*\n([\s\S]*?)\n\1[ \t]*$/gm

/** An owner's message as text and fenced code, in order. Text without a closed fence stays one text part. */
export function splitFences(input: string): Part[] {
  const text = input.replace(/\r\n?/g, '\n')
  const parts: Part[] = []
  let at = 0
  for (const match of text.matchAll(FENCE)) {
    const before = text.slice(at, match.index).replace(/^\n/, '').replace(/\n$/, '')
    if (before.trim()) parts.push({ kind: 'text', text: before })
    parts.push({ kind: 'code', lang: match[2], code: match[3] })
    at = match.index + match[0].length
  }
  const rest = text.slice(at).replace(/^\n/, '')
  if (rest.trim() || !parts.length) parts.push({ kind: 'text', text: rest })
  return parts
}

type MdNode = { type: string; value?: string; children?: MdNode[] }

function breakLines(node: MdNode) {
  if (!node.children) return
  node.children = node.children.flatMap(child => {
    if (child.type !== 'text' || !child.value?.includes('\n')) { breakLines(child); return [child] }
    return child.value.split('\n').flatMap((value, index) => [...(index ? [{ type: 'break' }] : []), ...(value ? [{ type: 'text', value }] : [])])
  })
}

/** A remark plugin (remark-breaks without the dependency): a newline inside a paragraph becomes a line break. Code is its own node, so it is untouched. */
export function remarkBreaks() {
  return (tree: MdNode) => { breakLines(tree) }
}
