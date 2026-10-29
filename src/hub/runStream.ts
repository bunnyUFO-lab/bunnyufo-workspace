import { HubError } from '../lib/hub'
import { authHeaders } from '../local/client'

/** One event of a request's Hermes run, as `GET /hub/requests/:id/events` sends it (names are Hermes's own, then our `state`). */
export interface RunEvent { event: string; data: Record<string, unknown> }

/**
 * Follow a request's run. EventSource cannot send our auth header, so this reads the response body and parses the `event:`
 * and `data:` blocks, like the chat stream does. Resolves when the server ends the stream; throws a HubError when it
 * refuses (409: the request has no Hermes run).
 */
export async function streamRun(id: string, onEvent: (event: RunEvent) => void, signal: AbortSignal): Promise<void> {
  const response = await fetch(`/api/hub/requests/${encodeURIComponent(id)}/events`, { headers: { ...authHeaders(), Accept: 'text/event-stream' }, cache: 'no-store', signal })
  if (!response.ok || !response.body) {
    const answer = await response.json().catch(() => null) as { error?: string } | null
    throw new HubError(answer?.error ?? `The Hub answered ${response.status}.`, response.status, answer as Record<string, unknown> | null)
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const handle = (block: string) => {
    let event = 'message'
    const data: string[] = []
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('event:')) event = line.slice(6).trim()
      else if (line.startsWith('data:')) data.push(line.slice(5).trim())
    }
    if (!data.length) return
    try { onEvent({ event, data: JSON.parse(data.join('\n')) as Record<string, unknown> }) } catch { /* a broken block is skipped */ }
  }
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let cut: number
    while ((cut = buffer.search(/\r?\n\r?\n/)) >= 0) {
      handle(buffer.slice(0, cut))
      buffer = buffer.slice(cut).replace(/^\r?\n\r?\n/, '')
    }
  }
}

/** What the drawer shows of a live run: the answer text so far, tool lines, and approvals Hermes asked for. */
export type LiveLine =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; id: string; tool: string; preview: string; state: 'running' | 'done' | 'failed' }
  | { kind: 'approval'; id: string; command: string; description: string; settled: boolean }

const str = (value: unknown) => (typeof value === 'string' ? value : '')

/** Fold one event into the list. Pure, so the order of lines is the order of the events. */
export function applyRunEvent(lines: LiveLine[], { event, data }: RunEvent): LiveLine[] {
  if (event === 'message.delta') {
    const delta = str(data.delta)
    if (!delta) return lines
    const last = lines[lines.length - 1]
    return last?.kind === 'text' ? [...lines.slice(0, -1), { kind: 'text', text: last.text + delta }] : [...lines, { kind: 'text', text: delta }]
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
