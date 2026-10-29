/** What the drawer shows of a live run: the answer text so far, tool lines, and approvals Hermes asked for. */
export type LiveLine =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; id: string; tool: string; preview: string; state: 'running' | 'done' | 'failed' }
  | { kind: 'approval'; id: string; command: string; description: string; settled: boolean }

/** The most live text kept, and the most lines: nothing upstream caps a run's output, so the page does. */
export const MAX_TEXT = 20_000
export const MAX_LINES = 300

const str = (value: unknown) => (typeof value === 'string' ? value : '')

/** Fold one event into the list. Pure, so the order of lines is the order of the events. */
export function applyRunEvent(lines: LiveLine[], { event, data }: { event: string; data: Record<string, unknown> }): LiveLine[] {
  return capLines(fold(lines, event, data))
}

const capText = (text: string) => (text.length > MAX_TEXT ? `…${text.slice(text.length - MAX_TEXT)}` : text)
const capLines = (lines: LiveLine[]) => (lines.length > MAX_LINES ? lines.slice(lines.length - MAX_LINES) : lines)

function fold(lines: LiveLine[], event: string, data: Record<string, unknown>): LiveLine[] {
  if (event === 'message.delta') {
    const delta = str(data.delta)
    if (!delta) return lines
    const last = lines[lines.length - 1]
    return last?.kind === 'text' ? [...lines.slice(0, -1), { kind: 'text', text: capText(last.text + delta) }] : [...lines, { kind: 'text', text: capText(delta) }]
  }
  if (event === 'tool.started') return [...lines, { kind: 'tool', id: str(data.tool_call_id) || `t${lines.length}`, tool: str(data.tool) || 'tool', preview: str(data.preview), state: 'running' }]
  if (event === 'tool.completed') {
    const id = str(data.tool_call_id)
    const failed = data.error === true
    let at = lines.findIndex(line => line.kind === 'tool' && line.state === 'running' && (!id || line.id === id))
    if (at < 0) at = -1
    return at < 0 ? lines : lines.map((line, index) => (index === at && line.kind === 'tool' ? { ...line, state: failed ? 'failed' : 'done' } : line))
  }
  if (event === 'approval.request') return [...lines, { kind: 'approval', id: str(data.prompt_id) || `a${lines.length}`, command: str(data.command), description: str(data.description), settled: false }]
  if (event === 'approval.settled') return lines.map(line => (line.kind === 'approval' && !line.settled ? { ...line, settled: true } : line))
  return lines
}
