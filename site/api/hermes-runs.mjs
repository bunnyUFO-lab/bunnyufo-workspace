// Hermes's run API, and nothing else about Hermes: start a run, read its status, follow its events,
// answer an approval, stop it. `HERMES_URL` (no /v1) and `HERMES_API_KEY` are the same settings Chat uses.
// The shapes follow the S4 spike on Hermes 0.22.5; `site/api/test/fake-hermes.mjs` speaks the same API.
//
// A run's status stays readable long after it ends, but its event buffer is dropped a few minutes after the
// last reader leaves: `events()` then answers 404 while `get()` still answers. Only a 404 on `get()` means
// Hermes has forgotten the run.

export class HermesError extends Error {
  constructor(message, { status = 0, code = '' } = {}) {
    super(message);
    this.name = 'HermesError';
    this.status = status;
    this.code = code;
  }
}

const TIMEOUT_MS = 15_000;
const IDLE_MS = 60_000;

export function createHermesRuns({ env = {}, fetchImpl = fetch, timeoutMs = TIMEOUT_MS, idleMs = IDLE_MS } = {}) {
  const base = String(env.HERMES_URL ?? '').replace(/\/+$/, '');
  const key = String(env.HERMES_API_KEY ?? '');
  const configured = !!base && !!key;
  const headers = extra => ({ Authorization: `Bearer ${key}`, ...extra });

  const reason = async response => {
    const body = await response.json().catch(() => null);
    const error = body?.error;
    return { message: (typeof error === 'string' ? error : error?.message) || `Hermes answered ${response.status}`, code: typeof error === 'object' ? error?.code ?? '' : '' };
  };

  async function call(method, path, body, extraHeaders = {}) {
    if (!configured) throw new HermesError('Hermes is not set up on this host.', { code: 'not_configured' });
    try {
      return await fetchImpl(`${base}${path}`, {
        method, headers: headers(body === undefined ? extraHeaders : { 'Content-Type': 'application/json', ...extraHeaders }),
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new HermesError(error.name === 'TimeoutError' ? 'Hermes did not answer in time.' : 'Hermes is unreachable.', { code: 'unreachable' });
    }
  }

  return {
    configured,

    /**
     * Start a run. Sends `{ input }` only: no provider and no model, so Hermes's own default and fallback chain
     * apply. Only the quota retry names a `provider` and `model`. `history` (Chat) is `[{ role, content }]`, sent as `conversation_history`. `idempotencyKey` makes a repeat answer the same run.
     */
    async start({ input, history, idempotencyKey, provider, model }) {
      const response = await call('POST', '/v1/runs', { input, ...(Array.isArray(history) && history.length ? { conversation_history: history } : {}), ...(provider ? { provider } : {}), ...(provider && model ? { model } : {}) }, idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {});
      if (response.status !== 202 && response.status !== 200) {
        const { message, code } = await reason(response);
        throw new HermesError(response.status === 429 ? 'Hermes is busy (too many runs).' : message, { status: response.status, code });
      }
      const body = await response.json().catch(() => null);
      if (typeof body?.run_id !== 'string') throw new HermesError('Hermes did not return a run id.', { status: response.status });
      return { runId: body.run_id, replayed: body.replayed === true };
    },

    /** The run's status: `{ status, output, usage, runtime, pending_controls, error? }`, or null when Hermes does not know it. */
    async get(runId) {
      const response = await call('GET', `/v1/runs/${encodeURIComponent(runId)}`);
      if (response.status === 404) return null;
      if (!response.ok) throw new HermesError((await reason(response)).message, { status: response.status });
      return response.json();
    },

    /**
     * The run's events from after `since` (the last seq seen), as `{ seq, event, data }`. Ends when the stream does.
     * Throws a HermesError with status 404 when the buffer is gone, and with code `idle` after `idleMs` of silence
     * (keepalives count as sound). `signal` stops it.
     */
    async *events(runId, { since, signal } = {}) {
      const stop = new AbortController();
      const onAbort = () => stop.abort();
      signal?.addEventListener('abort', onAbort);
      let timer;
      const touch = () => { clearTimeout(timer); timer = setTimeout(() => stop.abort(new HermesError('Hermes stopped sending events.', { code: 'idle' })), idleMs); };
      try {
        if (!configured) throw new HermesError('Hermes is not set up on this host.', { code: 'not_configured' });
        touch();
        let response;
        try {
          response = await fetchImpl(`${base}/v1/runs/${encodeURIComponent(runId)}/events`, {
            headers: headers({ Accept: 'text/event-stream', ...(since === undefined || since === null ? {} : { 'Last-Event-ID': String(since) }) }), signal: stop.signal,
          });
        } catch (error) {
          throw stop.signal.reason instanceof HermesError ? stop.signal.reason : new HermesError('Hermes is unreachable.', { code: 'unreachable' });
        }
        if (response.status === 404) throw new HermesError('Hermes has dropped this run\'s events.', { status: 404, code: 'run_not_found' });
        if (!response.ok || !response.body) throw new HermesError((await reason(response)).message, { status: response.status });
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          let chunk;
          try { chunk = await reader.read(); } catch (error) {
            if (signal?.aborted) return;
            throw stop.signal.reason instanceof HermesError ? stop.signal.reason : new HermesError('The event stream broke.', { code: 'dropped' });
          }
          if (chunk.done) return;
          touch();
          buffer += decoder.decode(chunk.value, { stream: true });
          let cut;
          while ((cut = buffer.search(/\r?\n\r?\n/)) >= 0) {
            const block = buffer.slice(0, cut);
            buffer = buffer.slice(cut).replace(/^\r?\n\r?\n/, '');
            let seq = null;
            let name = '';
            const data = [];
            for (const line of block.split(/\r?\n/)) {
              if (line.startsWith('id:')) seq = Number(line.slice(3).trim());
              else if (line.startsWith('event:')) name = line.slice(6).trim();
              else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
            }
            if (!data.length) continue; // a comment or a keepalive
            let parsed;
            try { parsed = JSON.parse(data.join('\n')); } catch { continue; }
            yield { seq: Number.isInteger(seq) ? seq : parsed?.seq ?? null, event: name || parsed?.event || '', data: parsed };
          }
        }
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        stop.abort();
      }
    },

    /** Answer a pending approval: `choice` is `once` or `deny`. Throws a HermesError (409 when it is no longer pending). */
    async answer(runId, { requestId, executionGeneration = 1, choice }) {
      const response = await call('POST', `/v1/runs/${encodeURIComponent(runId)}/approval`, { request_id: requestId, execution_generation: executionGeneration, choice });
      if (!response.ok) {
        const { message, code } = await reason(response);
        throw new HermesError(message, { status: response.status, code });
      }
      return true;
    },

    /** Ask Hermes to stop the run. A run that already ended answers with its status, which is fine. */
    async stop(runId) {
      const response = await call('POST', `/v1/runs/${encodeURIComponent(runId)}/stop`, {});
      if (response.status === 404) return false;
      if (!response.ok) throw new HermesError((await reason(response)).message, { status: response.status });
      return true;
    },
  };
}
