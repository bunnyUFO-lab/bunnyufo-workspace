// The Hub's chat: a relay to Hermes's OpenAI-compatible API server, the conversations it keeps in
// the inbox (`chat/<id>.jsonl`, one line per message).
//
// Env (all optional; chat is off without the first two):
//   HERMES_URL      base URL of Hermes's API server, without /v1
//   HERMES_API_KEY  its bearer key
//   HERMES_MODEL    the `model` field, default hermes-agent (completions only)
//   HUB_CHAT_RUNS   `0` turns the run path off: every turn then goes to /v1/chat/completions
//
// A text turn runs as a Hermes run (`/v1/runs`): the answer streams, tool lines show, and an approval Hermes asks for
// is copied into the inbox and answered from Chat. A turn with a picture stays on /v1/chat/completions (pictures on runs
// were never tested). The run is started with `{ input, conversation_history }` and never names a provider or a model,
// so Hermes's own default and fallback chain apply. The completions path sends no system message (Hermes owns its prompt)
// and sends the history as `messages`.
// Keys are never logged, stored or echoed.
import { Readable } from 'node:stream';
import { randomId, day8 } from './hub-model.mjs';
import { IMAGE_FILE, checkChatImages, toDataUrl, typeOfFile } from './chat-images.mjs';

const MB = 1024 * 1024;
const CHAT_ID = /^\d{8}-[a-z0-9]{6}$/;
const MAX_FILE = 1024 * 1024;
const HISTORY_IMAGE_BUDGET = 6 * MB;
const NO_PICTURE = '[An earlier picture is not included.]';
const TOTAL_MS = 120_000;
const IDLE_MS = 60_000;
const KEEPALIVE_MS = 15_000;

const clip = (value, length) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, length);

export const isChatRoute = route => route === '/hub/chat' || route.startsWith('/hub/chat/');

export function createChat({ env, fetchImpl, key, fresh, bucket, loadAsks, loadRequests, readJson, json, fail, now, hermesRuns = null, copyApproval = null }) {
  const hermesUrl = String(env.HERMES_URL ?? '').replace(/\/+$/, '');
  const chatConfigured = !!hermesUrl && !!env.HERMES_API_KEY;
  const runsOn = String(env.HUB_CHAT_RUNS ?? '') !== '0' && !!hermesRuns?.configured && !!copyApproval;
  const titles = new Map();   // etag → { title, count }

  const parse = text => String(text ?? '').split(/\r?\n/).filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);

  async function list() {
    const { objects } = await bucket.list(`${key('chat/x.jsonl').slice(0, -'x.jsonl'.length)}`);
    const newest = objects.filter(object => object.key.endsWith('.jsonl')).sort((a, b) => (new Date(b.lastModified) - new Date(a.lastModified)) || (a.key < b.key ? 1 : -1)).slice(0, 30);
    const conversations = [];
    for (const object of newest) {
      const id = object.key.split('/').pop().replace(/\.jsonl$/, '');
      if (!CHAT_ID.test(id)) continue;
      let info = titles.get(object.etag);
      if (!info) {
        const lines = parse((await fresh(`chat/${id}.jsonl`))?.text);
        const first = lines.find(line => line.role === 'user');
        info = { title: clip(first?.text, 60) || (first ? 'Picture' : 'New chat'), count: lines.length };
        titles.set(object.etag, info);
        while (titles.size > 200) titles.delete(titles.keys().next().value);
      }
      conversations.push({ id, title: info.title, updated: object.lastModified ? new Date(object.lastModified).toISOString() : null, count: info.count });
    }
    return conversations;
  }

  /** Append lines to a conversation, conditionally; read again and retry twice on a lost race. */
  async function append(id, lines) {
    const rel = `chat/${id}.jsonl`;
    for (let attempt = 0; ; attempt += 1) {
      const current = await fresh(rel);
      const body = `${current?.text ?? ''}${lines.map(line => JSON.stringify(line)).join('\n')}\n`;
      try {
        await bucket.put(key(rel), body, { contentType: 'application/x-ndjson', ...(current ? { ifMatch: current.etag } : { ifNoneMatch: '*' }) });
        return;
      } catch (error) {
        if (error.status !== 412 || attempt >= 2) throw error.status === 412 ? fail('The conversation changed while saving; try again.', 409) : error;
      }
    }
  }

  /** Items Hermes made during a turn: requests it filed and Asks it raised. */
  async function createdSince(since) {
    const floor = Math.floor(since / 1000) * 1000;
    const [requests, asks] = await Promise.all([loadRequests(now()), loadAsks(now())]);
    const items = [];
    for (const item of requests) if (new Date(item.at).getTime() >= floor && String(item.by ?? '').includes('hermes')) items.push(item);
    for (const row of asks) if (new Date(row.ask.createdAt).getTime() >= floor && row.ask.from?.tool === 'hermes') items.push(row.item);
    return items;
  }

  /** The bytes of a stored picture, or null when it is gone. */
  async function readImage(id, file) {
    try {
      const object = await bucket.get(key(`chat/${id}/${file}`));
      return Buffer.from(await new Response(object.body).arrayBuffer());
    } catch { return null; }
  }

  /**
   * The history as Hermes's messages. Pictures of earlier turns go back as data URLs, newest first,
   * until the budget is spent; the rest, and any that cannot be read, become a note.
   */
  async function historyMessages(id, lines, spent) {
    let left = HISTORY_IMAGE_BUDGET - spent;
    const messages = lines.map(line => ({ role: line.role, content: line.text }));
    for (let at = lines.length - 1; at >= 0; at -= 1) {
      const pictures = lines[at].role === 'user' && Array.isArray(lines[at].images) ? lines[at].images.filter(image => IMAGE_FILE.test(String(image?.file))) : [];
      if (!pictures.length) continue;
      const parts = lines[at].text ? [{ type: 'text', text: lines[at].text }] : [];
      for (const image of pictures) {
        const bytes = left > 0 ? await readImage(id, image.file) : null;
        if (bytes && bytes.length <= left) { left -= bytes.length; parts.push({ type: 'image_url', image_url: { url: toDataUrl(typeOfFile(image.file), bytes) } }); }
        else parts.push({ type: 'text', text: NO_PICTURE });
      }
      messages[at].content = parts;
    }
    return messages;
  }

  async function relay(request, response, user) {
    const data = await readJson(request, 7 * MB);
    const text = typeof data.text === 'string' ? data.text.trim() : '';
    const pictures = checkChatImages(data.images, fail);
    if ((!text && !pictures.length) || text.length > 8000) throw fail('A message is 1 to 8000 characters.');
    let id = data.conversation;
    let history = [];
    if (id !== undefined && id !== null && id !== '') {
      if (typeof id !== 'string' || !CHAT_ID.test(id)) throw fail('No such conversation.', 404);
      const got = await fresh(`chat/${id}.jsonl`);
      if (!got) throw fail('No such conversation.', 404);
      if (Buffer.byteLength(got.text) > MAX_FILE) throw fail('This conversation is long; start a new one.', 409);
      history = parse(got.text);
    } else {
      id = `${day8(now())}-${randomId(6)}`;
    }
    const current = pictures.length
      ? [...(text ? [{ type: 'text', text }] : []), ...pictures.map(picture => ({ type: 'image_url', image_url: { url: toDataUrl(picture.type, picture.buffer) } }))]
      : text;
    const spent = pictures.reduce((sum, picture) => sum + picture.buffer.length, 0);
    const runTurn = runsOn && !pictures.length;
    const messages = runTurn ? [] : [...await historyMessages(id, history.slice(-20), spent), { role: 'user', content: current }];
    const hasImages = messages.some(message => Array.isArray(message.content) && message.content.some(part => part.type === 'image_url'));
    const started = Date.now();

    const abort = new AbortController();
    let idle;
    const touch = () => { clearTimeout(idle); idle = setTimeout(() => abort.abort(), IDLE_MS); };
    const total = runTurn ? null : setTimeout(() => abort.abort(), TOTAL_MS); // a run turn lives as long as Hermes keeps sending
    const finish = () => { clearTimeout(idle); clearTimeout(total); };
    response.on('close', () => { if (!response.writableFinished) abort.abort(); });
    touch();

    let upstream;
    let runId = null;
    if (runTurn) {
      // Earlier pictures cannot ride in conversation_history (text only): they become the same note completions uses.
      const earlier = history.slice(-20).map(line => ({ role: line.role, content: line.text || (line.images?.length ? NO_PICTURE : '') })).filter(line => line.content);
      try {
        ({ runId } = await hermesRuns.start({ input: text, history: earlier, idempotencyKey: `${id}-${history.length}-${started.toString(36)}` }));
      } catch (error) {
        finish();
        throw fail(error.status === 429 ? 'Hermes is busy; try again in a moment.' : `Hermes did not answer (${error.status || error.code || 'unreachable'}).`, 502);
      }
    } else try {
      upstream = await fetchImpl(`${hermesUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${env.HERMES_API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: env.HERMES_MODEL || 'hermes-agent', messages, stream: true }),
        signal: abort.signal,
      });
    } catch (error) {
      finish();
      throw fail(`Hermes did not answer (${error.name === 'AbortError' ? 'timed out' : 'unreachable'}).`, 502);
    }
    if (!runTurn && (!upstream.ok || !upstream.body)) {
      finish();
      let refusal = null;
      if (hasImages && [400, 413, 415].includes(upstream.status)) {
        const answer = await upstream.json().catch(() => null);
        refusal = clip(answer?.error?.message ?? (typeof answer?.error === 'string' ? answer.error : ''), 200);
      }
      await upstream.body?.cancel?.().catch(() => {});
      if (hasImages && [400, 413, 415].includes(upstream.status)) throw fail(`Hermes could not take the picture: ${refusal || `it answered ${upstream.status}`}`, 422);
      throw fail(`Hermes did not answer (${upstream.status}).`, 502);
    }

    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
      Connection: 'keep-alive',
    });
    const emit = (event, value) => { if (!response.destroyed) response.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`); };
    const keepalive = setInterval(() => { if (!response.destroyed) response.write(': keepalive\n\n'); }, KEEPALIVE_MS);

    let reply = '';
    let failure = null;
    const tools = [];
    if (runTurn) {
      // The client leaving ends the run: nobody is reading it.
      response.on('close', () => { if (!response.writableFinished) hermesRuns.stop(runId).catch(() => {}); });
      try {
        let ended = false;
        for await (const event of hermesRuns.events(runId, { signal: abort.signal })) {
          const data = event.data ?? {};
          if (event.event === 'approval.request') clearTimeout(idle); // a waiting approval pauses the idle timer
          else touch();
          if (event.event === 'message.delta' && typeof data.delta === 'string' && data.delta) { reply += data.delta; emit('delta', { text: data.delta }); }
          else if (event.event === 'tool.started') {
            if (data.tool && !tools.includes(data.tool)) tools.push(String(data.tool));
            emit('tool', { id: String(data.tool_call_id ?? ''), name: clip(data.tool, 80), summary: clip(data.preview, 160), state: 'running' });
          } else if (event.event === 'tool.completed') emit('tool', { id: String(data.tool_call_id ?? ''), name: clip(data.tool, 80), state: data.error ? 'failed' : 'done' });
          else if (event.event === 'approval.request') {
            let approval = null;
            try { approval = await copyApproval({ runId, chat: id, prompt: data }); } catch { /* answered below */ }
            if (!approval) { failure = 'Hermes asked for approval, but the ask could not be saved.'; hermesRuns.stop(runId).catch(() => {}); ended = true; }
            else emit('approval', { id: approval, title: clip(data.description || data.command, 200), command: clip(data.command, 2000), description: clip(data.description, 2000), choices: data.choices ?? ['once', 'deny'], expiresAt: new Date(now().getTime() + 300_000).toISOString() });
          } else if (event.event === 'approval.settled') emit('approval-settled', { prompt: data.prompt_id ?? null });
          else if (event.event === 'run.completed') {
            if (!reply && typeof data.output === 'string' && data.output) { reply = data.output; emit('delta', { text: reply }); }
            ended = true;
          } else if (event.event === 'run.failed') { failure = clip(data.error, 200) || 'Hermes could not finish.'; ended = true; }
          else if (event.event === 'run.cancelled' || event.event === 'run.interrupted') { failure = 'The run was stopped.'; ended = true; }
          if (ended) break;
        }
        if (!ended) failure = 'The connection to Hermes broke.';
      } catch (error) {
        failure = abort.signal.aborted ? 'Hermes stopped answering.' : error?.code === 'idle' ? 'Hermes stopped answering.' : 'The connection to Hermes broke.';
      }
    } else try {
      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let finished = false;
      while (!finished) {
        const { done, value } = await reader.read();
        if (done) break;
        touch();
        buffer += decoder.decode(value, { stream: true });
        let cut;
        while ((cut = buffer.search(/\r?\n\r?\n/)) >= 0) {
          const block = buffer.slice(0, cut);
          buffer = buffer.slice(cut).replace(/^\r?\n\r?\n/, '');
          for (const line of block.split(/\r?\n/)) {
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (payload === '[DONE]') { finished = true; break; }
            let chunk;
            try { chunk = JSON.parse(payload); } catch { continue; }
            const piece = chunk?.choices?.[0]?.delta?.content;
            if (typeof piece === 'string' && piece) { reply += piece; emit('delta', { text: piece }); }
          }
          if (finished) break;
        }
      }
      if (finished) reader.cancel().catch(() => {});
    } catch (error) {
      failure = abort.signal.aborted ? 'Hermes stopped answering.' : 'The connection to Hermes broke.';
    }
    finish();
    clearInterval(keepalive);

    let created = [];
    try { created = await createdSince(started); } catch { /* the reply is still worth saving */ }
    if (created.length) emit('created', { items: created });
    const at = now().toISOString();
    const assistant = { role: 'assistant', text: failure ? `${reply} [interrupted]`.trim() : reply, at, ...(runId ? { run: runId, ...(tools.length ? { tools } : {}) } : {}), ...(created.length ? { created } : {}) };
    const userLine = { role: 'user', text, at: new Date(started).toISOString(), ...(user ? { by: user } : {}) };
    try {
      // The pictures first, so a line never points at a missing file.
      if (pictures.length) {
        userLine.images = [];
        for (const picture of pictures) {
          const file = `${randomId(10)}.${picture.ext}`;
          await bucket.put(key(`chat/${id}/${file}`), picture.buffer, { contentType: picture.type, ifNoneMatch: '*' });
          userLine.images.push({ file, type: picture.type, width: picture.width, height: picture.height });
        }
      }
      await append(id, [userLine, ...(failure && !reply ? [] : [assistant])]);
    } catch (error) {
      failure ??= 'The reply could not be saved.';
    }
    if (failure) emit('error', { error: failure });
    else emit('done', { conversation: id, user: userLine });
    response.end();
  }

  async function serveImage(response, id, file) {
    if (!CHAT_ID.test(id) || !IMAGE_FILE.test(file)) throw fail('Not found', 404);
    let object;
    try {
      object = await bucket.get(key(`chat/${id}/${file}`));
    } catch (error) {
      throw error.status === 404 ? fail('Not found', 404) : error;
    }
    response.writeHead(200, {
      'Content-Type': typeOfFile(file),
      'Cache-Control': 'private, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "sandbox; default-src 'none'",
      ...(object.etag ? { ETag: `"${object.etag}"` } : {}),
      ...(object.size ? { 'Content-Length': object.size } : {}),
    });
    if (!object.body) return response.end();
    Readable.fromWeb(object.body).pipe(response);
    return undefined;
  }

  return {
    capabilities({ enabled, signedIn, requireRemoteUser }) {
      const allowed = enabled && (!requireRemoteUser || signedIn);
      return { chat: allowed && chatConfigured };
    },
    /** Answers the chat routes; the caller has checked that the route is one of them. */
    async handle({ request, response, method, route, user, requireRemoteUser }) {
      if (requireRemoteUser && !user) throw fail('Chat needs a signed-in user.', 401);
      if (!chatConfigured) throw fail('Chat is not set up on this host.', 503);
      if (method === 'GET' && route === '/hub/chat') return json(response, 200, { conversations: await list() });
      let match;
      if (method === 'GET' && (match = /^\/hub\/chat\/([^/]+)$/.exec(route))) {
        if (!CHAT_ID.test(match[1])) throw fail('No such conversation.', 404);
        const got = await fresh(`chat/${match[1]}.jsonl`);
        if (!got) throw fail('No such conversation.', 404);
        return json(response, 200, { id: match[1], messages: parse(got.text) });
      }
      if (method === 'GET' && (match = /^\/hub\/chat\/([^/]+)\/images\/([^/]+)$/.exec(route))) return serveImage(response, match[1], match[2]);
      if (method === 'POST' && route === '/hub/chat') return relay(request, response, user);
      throw fail('Not found', 404);
    },
  };
}
