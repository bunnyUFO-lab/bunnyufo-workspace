// Workspace pages carry Just the Docs front matter (title, parent, nav_order).
// The reader shows only the body; the editor and saved file keep the front matter.
const FRONT_MATTER = /^---\r?\n(?:[\s\S]*?\r?\n)?---[ \t]*(?:\r?\n|$)/
const BYTE_ORDER_MARK = 0xfeff

export function stripFrontMatter(text: string): string {
  const start = text.charCodeAt(0) === BYTE_ORDER_MARK ? 1 : 0
  const match = FRONT_MATTER.exec(text.slice(start))
  return match ? text.slice(start + match[0].length) : text
}
