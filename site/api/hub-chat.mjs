// The Hub's chat: a relay to Hermes's OpenAI-compatible API server, the conversations it keeps in
// the inbox (`chat/<id>.jsonl`, one line per message), and speech-to-text for push-to-talk.
//
// Env (all optional; chat is off without the first two):
//   HERMES_URL      base URL of Hermes's API server, without /v1
//   HERMES_API_KEY  its bearer key
//   HERMES_MODEL    the `model` field, default hermes-agent
//   STT_URL         a full OpenAI-compatible …/audio/transcriptions endpoint
//   STT_API_KEY     its bearer key
//   STT_MODEL       default whisper-large-v3-turbo
//
// The Hub sends no system message (Hermes owns its prompt) and sends the history as `messages`.
// Keys are never logged, stored or echoed.
import { randomId, day8 } from './hub-model.mjs';

const CHAT_ID = /^\d{8}-[a-z0-9]{6}$/;
const MAX_FILE = 1024 * 1024;
const TOTAL_MS = 120_000;
const IDLE_MS = 60_000;
const KEEPALIVE_MS = 15_000;
const AUDIO = /^audio\/(webm|ogg|mp4|mpeg)\s*(;.*)?$/i;
const EXTENSION = { webm: 'webm', ogg: 'ogg', mp4: 'mp4', mpeg: 'mp3' };

const clip = (value, length) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, length);

export const isChatRoute = route => route === '/hub/chat' || route.startsWith('/hub/chat/') || route === '/hub/transcribe';

export function createChat({ env, fetchImpl, key, fresh, bucket, loadAsks, loadRequests, readBody, readJson, json, fail, now }) {
  const hermesUrl = String(env.HERMES_URL ?? '').replace(/\/+$/, '');
  const chatConfigured = !!hermesUrl && !!env.HERMES_API_KEY;
  const sttConfigured = !!env.STT_URL && !!env.STT_API_KEY;
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
        info = { title: clip(lines.find(line => line.role === 'user')?.text, 60) || 'New chat', count: lines.length };
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

  async function relay(request, response, user) {
    const data = await readJson(request, 64 * 1024);
    const text = typeof data.text === 'string' ? data.text.trim() : '';
    if (!text || text.length > 8000) throw fail('A message is 1 to 8000 characters.');
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
    const messages = [...history.slice(-20).map(line => ({ role: line.role, content: line.text })), { role: 'user', content: text }];
    const started = Date.now();

    const abort = new AbortController();
    let idle;
    const touch = () => { clearTimeout(idle); idle = setTimeout(() => abort.abort(), IDLE_MS); };
    const total = setTimeout(() => abort.abort(), TOTAL_MS);
    const finish = () => { clearTimeout(idle); clearTimeout(total); };
    response.on('close', () => { if (!response.writableFinished) abort.abort(); });
    touch();

    let upstream;
    try {
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
    if (!upstream.ok || !upstream.body) {
      finish();
      await upstream.body?.cancel?.().catch(() => {});
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
    try {
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
    const assistant = { role: 'assistant', text: failure ? `${reply} [interrupted]`.trim() : reply, at, ...(created.length ? { created } : {}) };
    try {
      await append(id, [{ role: 'user', text, at: new Date(started).toISOString(), ...(user ? { by: user } : {}) }, ...(failure && !reply ? [] : [assistant])]);
    } catch (error) {
      failure ??= 'The reply could not be saved.';
    }
    if (failure) emit('error', { error: failure });
    else emit('done', { conversation: id });
    response.end();
  }

  async function transcribe(request) {
    const type = String(request.headers['content-type'] ?? '');
    if (!AUDIO.test(type)) throw fail('Send audio/webm, audio/ogg, audio/mp4 or audio/mpeg.', 415);
    const buffer = await readBody(request, 2 * 1024 * 1024);
    if (!buffer.length) throw fail('That recording is empty.');
    const form = new FormData();
    form.append('file', new Blob([buffer], { type: type.split(';')[0].trim() }), `speech.${EXTENSION[type.split(';')[0].split('/')[1].trim().toLowerCase()]}`);
    form.append('model', env.STT_MODEL || 'whisper-large-v3-turbo');
    let answer;
    try {
      answer = await fetchImpl(env.STT_URL, { method: 'POST', headers: { authorization: `Bearer ${env.STT_API_KEY}` }, body: form, signal: AbortSignal.timeout(60_000) });
    } catch {
      throw fail('The transcription service did not answer.', 502);
    }
    if (!answer.ok) throw fail(`The transcription service did not answer (${answer.status}).`, 502);
    const result = await answer.json().catch(() => null);
    if (typeof result?.text !== 'string') throw fail('The transcription service sent no text.', 502);
    return { text: result.text.trim() };
  }

  return {
    capabilities({ enabled, signedIn, requireRemoteUser }) {
      const allowed = enabled && (!requireRemoteUser || signedIn);
      return { chat: allowed && chatConfigured, transcribe: allowed && sttConfigured };
    },
    /** Answers the chat and transcribe routes; the caller has checked that the route is one of them. */
    async handle({ request, response, method, route, user, requireRemoteUser }) {
      if (requireRemoteUser && !user) throw fail('Chat needs a signed-in user.', 401);
      const speech = route === '/hub/transcribe';
      if (speech ? !sttConfigured : !chatConfigured) throw fail(speech ? 'Speech to text is not set up on this host.' : 'Chat is not set up on this host.', 503);
      if (method === 'GET' && route === '/hub/chat') return json(response, 200, { conversations: await list() });
      let match;
      if (method === 'GET' && (match = /^\/hub\/chat\/([^/]+)$/.exec(route))) {
        if (!CHAT_ID.test(match[1])) throw fail('No such conversation.', 404);
        const got = await fresh(`chat/${match[1]}.jsonl`);
        if (!got) throw fail('No such conversation.', 404);
        return json(response, 200, { id: match[1], messages: parse(got.text) });
      }
      if (method === 'POST' && route === '/hub/chat') return relay(request, response, user);
      if (method === 'POST' && speech) return json(response, 200, await transcribe(request));
      throw fail('Not found', 404);
    },
  };
}
