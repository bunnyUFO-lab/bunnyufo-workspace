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
