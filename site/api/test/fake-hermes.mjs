// A stand-in for Hermes's OpenAI-compatible API server.
//   const hermes = await startFakeHermes({ key: 'k', onTurn: async body => { …make Hermes file a request… } })
//   hermes.url, hermes.requests (the chat bodies it saw), hermes.state.closedEarly, hermes.close()
// `refuseImages: true` answers 400 with an OpenAI-style error body when any message has an image_url part.
// `fail: true` answers 500 on both routes; `hold: true` stalls after the first chunk (for an abort test).
//
// The run API (`/v1/runs`) follows the S4 spike on Hermes 0.22.5 (see the notes at the bottom for what is guessed):
//   hermes.runs         one record per run: { id, body, key, status, output, error, servedBy, events, approvals, stopped }
//   hermes.approvals    every body posted to /approval; hermes.stops: the run ids stopped
//   hermes.release(id, output?)  ends a run held by a `{ hold: true }` step as completed
//   hermes.forget(id)   drops one run, as a Hermes restart would (status and events answer 404)
// Options for runs:
//   runScript      steps: 'text' (message.delta) | { tool, preview?, error?, ms? } (ms: how long the step runs before it completes) | { approval: { command?, description? } }
//                  | { wait: ms } | { hold: true } (waits for stop or release; use it for the 120-minute cap)
//                  | { end: 'output' } | { fail: 'error text' }. Default: the `chunks` as deltas.
//   askApproval    true adds a protected-file write that asks for approval after the first delta
//   endWith        the final output (default: the deltas joined); end it with a question mark for a run that asks
//   failWith       every run fails with this error text (the whole chain failed)
//   chain          the fallback chain, default Codex gpt-6-sol, Anthropic Sonnet, DeepSeek. A run is served by the first
//                  provider that is not in `providerFailures`; with `reportServed: true` the answer's `runtime` names it (live Hermes reported empty strings).
//   providerFailures  { 'openai-codex': '429 usage limit reached' }. A run whose body names `provider` uses only that one (no chain).
//   forgetRuns     every run route answers 404
//   dropBufferAfterMs  the events route answers 404 that long after a run ended while status still answers
//   approvalTimeoutMs  an unanswered approval auto-denies (default 300000)
//   busy           POST /v1/runs answers 429; maxConcurrent (default 10) answers 429 when that many runs are active
//   dropStreamAfter n  each events connection closes after n events (reconnect with Last-Event-ID)
//   approvalAgeMs  approval.request timestamp is that far in the past; approvalChoices overrides its choices
//   keepaliveMs    default 10000; reportServed fills runtime.provider and model
import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';

const DEFAULT_CHAIN = [
  { provider: 'openai-codex', model: 'gpt-6-sol' },
  { provider: 'anthropic', model: 'claude-sonnet-5-5' },
  { provider: 'deepseek', model: 'deepseek-chat' },
];
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
const openaiError = (message, type, code) => ({ error: { message, type, param: null, code } });
const json = (response, status, body, headers = {}) => {
  response.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  response.end(JSON.stringify(body));
};
const notFound = response => json(response, 404, openaiError('Run not found', 'invalid_request_error', 'run_not_found'));

export async function startFakeHermes({
  key = 'test-key', chunks = ['Hel', 'lo ', 'there'], delayMs = 20, onTurn, fail = false, hold = false, refuseImages = false,
  runScript, askApproval = false, endWith, failWith, chain = DEFAULT_CHAIN, providerFailures = {}, forgetRuns = false,
  dropBufferAfterMs = 0, approvalTimeoutMs = 300_000, busy = false, maxConcurrent = 10, dropStreamAfter = 0, keepaliveMs = 10_000, reportServed = false, approvalAgeMs = 0, approvalChoices,
} = {}) {
  const requests = [];
  const state = { closedEarly: 0 };
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const runs = [];
  const approvals = [];
  const stops = [];
  const byId = new Map();
  const byKey = new Map();

  const emit = (run, event, fields = {}) => {
    if (TERMINAL.has(run.status)) return null; // a finished run emits nothing more (an interrupt ends it from outside)
    const entry = { event, run_id: run.id, timestamp: Date.now() / 1000, ...fields, seq: run.events.length };
    run.events.push(entry);
    for (const listener of [...run.listeners]) listener();
    return entry;
  };
  // Waits ms (or forever), or until the run is stopped or released. Returns whether it was stopped.
  const pause = (run, ms) => new Promise(resolve => {
    const timer = ms === Infinity ? null : setTimeout(done, ms);
    function done() { clearTimeout(timer); run.wakers.delete(done); resolve(run.stopped); }
    run.wakers.add(done);
    if (run.stopped) done();
  });
  const wakeAll = run => { for (const wake of [...run.wakers]) wake(); };
  // S4: provider and model read "" on every completed run. `reportServed: true` fills in the served pair for the fallback tests.
  // `requested` is there only when the body named a provider or model; route_source is raw_request, model_routes or global.
  const runtimeOf = run => ({
    provider: reportServed ? run.servedBy?.provider ?? '' : '', model: reportServed ? run.servedBy?.model ?? '' : '', route_source: run.routeSource,
    ...(run.requested.provider ? { requested: run.requested } : {}),
  });
  const finish = (run, status) => {
    if (TERMINAL.has(run.status)) return;
    run.status = status; run.endedAt = Date.now(); run.pending = [];
    run.runtime = runtimeOf(run);
    for (const listener of [...run.listeners]) listener();
  };
  const failRun = (run, error) => {
    run.error = error; run.usage = {};
    emit(run, 'error', { error });
    emit(run, 'run.failed', { error, completed: false, partial: false, interrupted: false });
    finish(run, 'failed');
  };
  const askAndWait = async (run, step) => {
    const prompt = {
      kind: 'approval', prompt_id: randomBytes(16).toString('hex'), execution_generation: 1, command: step.command ?? '<write to AGENTS.md>',
      description: step.description ?? 'Write to protected agent-instruction file(s): AGENTS.md. These files steer future agent behavior; approval is always required (not bypassed by auto-approve).',
      choices: approvalChoices ?? ['once', 'deny'],
    };
    const toolCall = `toolu_${randomBytes(8).toString('hex')}`;
    run.pending = [prompt]; run.status = 'waiting_for_approval';
    emit(run, 'tool.started', { tool: 'write_file', preview: '/tmp/work/AGENTS.md', tool_call_id: toolCall });
    emit(run, 'approval.request', { ...prompt, timestamp: (Date.now() - approvalAgeMs) / 1000 });
    const answer = await new Promise(resolve => {
      const timer = setTimeout(() => resolve('timeout'), approvalTimeoutMs);
      run.answer = choice => { clearTimeout(timer); resolve(choice); };
    });
    run.answer = null; run.pending = []; run.status = 'running';
    const toolDone = error => emit(run, 'tool.completed', { tool: 'write_file', duration: 0, error, tool_call_id: toolCall, preview: '' });
    const settled = () => emit(run, 'approval.settled', { prompt_id: prompt.prompt_id, execution_generation: 1 });
    // S4: after a stop or a timeout, tool.completed comes first; after an answer, approval.settled does.
    if (answer !== 'once' && answer !== 'deny') { toolDone(true); settled(); return answer; }
    settled();
    toolDone(answer !== 'once');
    return answer;
  };
  const execute = async run => {
    const steps = [...(runScript ?? chunks)];
    if (askApproval) steps.splice(Math.min(1, steps.length), 0, { approval: {} });
    const { requested } = run;
    // The named provider alone, or the first of the chain that works.
    const candidates = requested.provider ? [{ provider: requested.provider, model: requested.model ?? '' }] : chain;
    const served = candidates.find(entry => !providerFailures[entry.provider]);
    run.routeSource = requested.provider ? 'raw_request' : 'global';
    if (failWith || !served) return failRun(run, failWith ?? providerFailures[candidates.at(-1).provider]);
    run.servedBy = served;
    let text = '';
    let ended = false;
    for (const step of steps) {
      if (run.stopped || ended) break;
      await pause(run, delayMs);
      if (run.stopped) break;
      if (typeof step === 'string') { text += step; emit(run, 'message.delta', { delta: step }); continue; }
      if (step.wait !== undefined) { await pause(run, step.wait); continue; }
      if (step.hold) {
        await pause(run, Infinity);
        if (run.released) { if (run.released.output !== undefined) text = run.released.output; ended = true; }
        continue;
      }
      if (step.tool) {
        const id = `toolu_${randomBytes(8).toString('hex')}`;
        emit(run, 'tool.started', { tool: step.tool, preview: step.preview ?? '', tool_call_id: id });
        if (step.ms) await pause(run, step.ms); // a step that takes a while: Hermes says nothing in between
        if (run.stopped) break;
        emit(run, 'tool.completed', { tool: step.tool, duration: 0, error: Boolean(step.error), tool_call_id: id, preview: '' });
        continue;
      }
      if (step.approval) {
        const answer = await askAndWait(run, step.approval);
        if (answer === 'stopped') break;
        if (answer !== 'once') {
          const note = 'The write was blocked. The user has not consented.';
          text += note; emit(run, 'message.delta', { delta: note });
        }
        continue;
      }
      if (step.fail !== undefined) return failRun(run, step.fail);
      if (step.end !== undefined) { text = step.end; ended = true; }
    }
    run.output = endWith !== undefined && !run.stopped ? endWith : text;
    if (run.stopped) {
      run.usage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
      emit(run, 'run.cancelled', { completed: false, partial: false, interrupted: true, turn_exit_reason: run.stopReason });
      return finish(run, 'cancelled');
    }
    const out = Math.max(1, Math.ceil(run.output.length / 4));
    run.usage = { input_tokens: 21749, output_tokens: out, total_tokens: 21749 + out };
    run.runtime = runtimeOf(run);
    emit(run, 'run.completed', { output: run.output, usage: run.usage, runtime: run.runtime, completed: true, partial: false, interrupted: false });
    return finish(run, 'completed');
  };
  const view = run => {
    const done = TERMINAL.has(run.status);
    return {
      object: 'hermes.run', model: 'main', created_at: run.created, pending_controls: run.pending, run_id: run.id, status: run.status,
      session_id: run.id, admission_id: run.admission, execution_generation: 1,
      output: done ? run.output : '', usage: done ? run.usage : {}, ...(run.status === 'completed' ? { runtime: run.runtime } : {}), ...(run.error ? { error: run.error } : {}),
    };
  };
  const activeRuns = () => runs.filter(run => !TERMINAL.has(run.status)).length;

  function streamEvents(request, response, url, run) {
    if (dropBufferAfterMs && run.endedAt && Date.now() - run.endedAt >= dropBufferAfterMs) return notFound(response);
    const last = request.headers['last-event-id'] ?? url.searchParams.get('last_seq');
    let next = last === null || last === undefined || last === '' ? 0 : Number(last) + 1;
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    response.flushHeaders();
    response.write(': open\n\n');
    let sent = 0;
    let closed = false;
    const stop = () => { closed = true; clearInterval(keepalive); run.listeners.delete(pump); };
    const keepalive = setInterval(() => response.write(': keepalive\n\n'), keepaliveMs);
    function pump() {
      while (!closed && next < run.events.length) {
        const entry = run.events[next++];
        const frame = `id: ${entry.seq}\ndata: ${JSON.stringify(entry)}\n\n`;
        sent += 1;
        const terminal = ['run.completed', 'run.failed', 'run.cancelled', 'run.interrupted'].includes(entry.event);
        // Cut the connection a moment after the frame is flushed, or the client may never see it.
        if (dropStreamAfter && sent >= dropStreamAfter && !terminal) { stop(); return response.write(frame, () => setTimeout(() => response.destroy(), 15)); }
        response.write(frame);
      }
      if (!closed && TERMINAL.has(run.status) && next >= run.events.length) { stop(); response.write(': stream closed\n\n'); response.end(); }
      return undefined;
    }
    response.on('close', stop);
    run.listeners.add(pump);
    return pump();
  }

  async function handleRuns(request, response, url, raw) {
    const parts = url.pathname.split('/').filter(Boolean); // v1 runs [id [action]]
    if (parts.length === 2) {
      if (request.method !== 'POST') return json(response, 405, openaiError('Method not allowed', 'invalid_request_error', 'method_not_allowed'));
      let body;
      try { body = JSON.parse(raw.toString('utf8')); } catch { return json(response, 400, openaiError('invalid_json', 'invalid_request_error', 'invalid_json')); }
      if (typeof body?.input !== 'string' || !body.input) return json(response, 400, openaiError('invalid_params', 'invalid_request_error', 'invalid_params'));
      const idem = request.headers['idempotency-key'];
      if (idem && byKey.has(idem)) return json(response, 202, { run_id: byKey.get(idem).id, status: 'running', replayed: true });
      if (busy || activeRuns() >= maxConcurrent) {
        return json(response, 429, openaiError(`Too many concurrent runs (max ${maxConcurrent})`, 'rate_limit_error', 'rate_limit_exceeded'), { 'Retry-After': '1' });
      }
      const run = {
        id: `run_${randomUUID().replaceAll('-', '')}`, body, key: idem, status: 'running', output: '', usage: {}, error: undefined, events: [],
        listeners: new Set(), wakers: new Set(), pending: [], created: Date.now() / 1000, admission: randomBytes(16).toString('hex'),
        stopped: false, stopReason: '', released: null, answer: null, servedBy: null, routeSource: 'global', runtime: undefined, endedAt: 0, approvals: [],
        requested: body.provider ? { provider: body.provider, model: body.model ?? '' } : {},
      };
      runs.push(run); byId.set(run.id, run); if (idem) byKey.set(idem, run);
      execute(run).catch(error => { if (!TERMINAL.has(run.status)) failRun(run, `fake hermes crashed: ${error.message}`); });
      return json(response, 202, { run_id: run.id, status: 'started', replayed: false });
    }
    const run = byId.get(parts[2]);
    if (forgetRuns || !run) return notFound(response);
    const action = parts[3];
    if (!action && request.method === 'GET') return json(response, 200, view(run));
    if (action === 'events' && request.method === 'GET') return streamEvents(request, response, url, run);
    if (action === 'stop' && request.method === 'POST') {
      if (TERMINAL.has(run.status)) return json(response, 200, view(run)); // already done: its status, as Hermes answers
      run.stopped = true;
      run.stopReason = run.status === 'waiting_for_approval' ? 'interrupted_by_user' : 'interrupted_during_api_call';
      stops.push(run.id);
      wakeAll(run); run.answer?.('stopped');
      return json(response, 200, { run_id: run.id, status: 'stopping', admission_id: run.admission });
    }
    if (action === 'approval' && request.method === 'POST') {
      let body = null;
      try { body = JSON.parse(raw.toString('utf8')); } catch { /* answered below */ }
      approvals.push({ run_id: run.id, ...body });
      const exact = body && typeof body === 'object' && Object.keys(body).sort().join() === 'choice,execution_generation,request_id';
      if (!exact || typeof body.request_id !== 'string' || !Number.isInteger(body.execution_generation) || !['once', 'deny'].includes(body.choice)) {
        return json(response, 400, openaiError('invalid_params', 'invalid_request_error', 'invalid_params'));
      }
      const prompt = run.pending[0];
      if (!prompt || body.execution_generation !== prompt.execution_generation) return json(response, 409, openaiError('stale_generation', 'invalid_request_error', 'stale_generation'));
      if (prompt.prompt_id !== body.request_id) return json(response, 409, openaiError('approval_not_pending', 'invalid_request_error', 'approval_not_pending'));
      run.approvals.push(body.choice);
      run.answer(body.choice);
      return json(response, 200, { run_id: run.id, status: 'resolved', prompt_id: prompt.prompt_id });
    }
    return json(response, 404, openaiError('Not found', 'invalid_request_error', 'not_found'));
  }

  const server = createServer(async (request, response) => {
    const incoming = [];
    for await (const chunk of request) incoming.push(chunk);
    const raw = Buffer.concat(incoming);
    if (request.headers.authorization !== `Bearer ${key}`) { response.writeHead(401); return response.end('{"error":"bad key"}'); }
    if (fail) { response.writeHead(500); return response.end('{"error":"boom"}'); }
    const url = new URL(request.url, 'http://fake');
    if (url.pathname === '/v1/runs' || url.pathname.startsWith('/v1/runs/')) return handleRuns(request, response, url, raw);
    if (request.method === 'POST' && request.url === '/v1/chat/completions') {
      const body = JSON.parse(raw.toString('utf8'));
      if (body.stream !== true) { response.writeHead(400); return response.end('{"error":"stream must be true"}'); }
      requests.push(body);
      if (refuseImages && body.messages.some(message => Array.isArray(message.content) && message.content.some(part => part.type === 'image_url'))) {
        response.writeHead(400, { 'Content-Type': 'application/json' });
        return response.end(JSON.stringify({ error: { message: 'This model does not accept images.', code: 'unsupported_content_type' } }));
      }
      response.on('close', () => { if (!response.writableFinished) state.closedEarly += 1; });
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const send = data => response.write(`data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`);
      for (const [index, text] of chunks.entries()) {
        if (index === chunks.length - 1) await onTurn?.(body);
        if (response.destroyed) return undefined;
        send({ choices: [{ delta: { content: text } }] });
        await sleep(delayMs);
        if (hold && index === 0) await sleep(30_000);
      }
      send('[DONE]');
      return response.end();
    }
    response.writeHead(404);
    return response.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`, requests, state, runs, approvals, stops,
    release: (id, output) => { const run = byId.get(id); run.released = { output }; wakeAll(run); },
    forget: id => { byId.delete(id); },
    // A gateway shutdown: a live run ends `interrupted` (event run.interrupted), as Hermes does.
    interrupt: id => {
      const run = byId.get(id);
      if (!run || TERMINAL.has(run.status)) return;
      const error = 'Gateway shutdown interrupted the run.';
      emit(run, 'run.interrupted', { error, completed: false, partial: true, interrupted: true });
      run.error = error; run.output = ''; run.usage = {};
      finish(run, 'interrupted');
      run.stopped = true; wakeAll(run); run.answer?.('stopped');
    },
    close: () => new Promise(resolve => { for (const run of runs) { run.stopped = true; wakeAll(run); run.answer?.('stopped'); } server.closeAllConnections(); server.close(resolve); }),
  };
}

// Read from Hermes 0.22.5's source: stop on a finished run is 200 with its status; route_source is raw_request, model_routes or global; a prompt id
// that is not pending is 409 approval_not_pending; the approval body must be exactly request_id, execution_generation, choice; `interrupted` is a
// terminal status. Live Hermes sends only `run.failed` (no separate `error` event): do not end a run on `error`.
// Guessed: the 400 for a choice that is neither once nor deny, a filled-in `runtime.provider` after a fallback (`reportServed`; S4's runs showed empty
// strings), and a running run's status `output` (S4 saw "" while it waited). Hermes has no wall-clock cap, only an idle timeout (1800 s);
// the 120-minute limit belongs to the site API, so test it with a `{ hold: true }` step and a fake clock in the follower.
