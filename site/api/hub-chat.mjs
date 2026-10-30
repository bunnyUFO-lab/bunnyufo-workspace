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
// were never tested). The run is started with `{ input, conversation_history }` and names a provider and a model only when the
// owner picked one from chat-models.mjs (the page sends an id); Auto names none, so Hermes's own default and fallback chain apply. The completions path sends no system message (Hermes owns its prompt)
// and sends the history as `messages`.
// Keys are never logged, stored or echoed.
import { Readable, pipeline } from 'node:stream';
import { randomId, day8 } from './hub-model.mjs';
import { createScrub } from './scrub.mjs';
import { IMAGE_FILE, MAX_IMAGES, MAX_TOTAL_BYTES, checkChatImages, toDataUrl, typeOfFile } from './chat-images.mjs';
import { chatModelOf, chatModelsForClient } from './chat-models.mjs';
import { chatPersonaOf, chatPersonasForClient, storedPersona } from './chat-personas.mjs';
import { HELP_KINDS, buildHelpContext, helpExcerpt } from './hub-help.mjs';

const MB = 1024 * 1024;
export const CHAT_ID = /^\d{8}-[a-z0-9]{6}$/;
const MAX_FILE = 1024 * 1024;
const HISTORY_IMAGE_BUDGET = 6 * MB;
const NO_PICTURE = '[An earlier picture is not included.]';
const TOTAL_MS = 120_000;
const IDLE_MS_DEFAULT = 60_000;
const MAX_TOOLS = 20;
const KEEPALIVE_MS = 15_000;

const clip = (value, length) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, length);

export const isChatRoute = route => route === '/hub/chat' || route.startsWith('/hub/chat/');

export function createChat({ env, fetchImpl, key, fresh, bucket, loadAsks, loadRequests, loadHelpItem = null, readJson, json, fail, now, hermesRuns = null, copyApproval = null, readApproval = null, scrub = createScrub(env) }) {
  const IDLE_MS = Number(env.HUB_CHAT_IDLE_MS) > 0 ? Number(env.HUB_CHAT_IDLE_MS) : IDLE_MS_DEFAULT; // completions turns only; a test shortens it
  const hermesUrl = String(env.HERMES_URL ?? '').replace(/\/+$/, '');
  const chatConfigured = !!hermesUrl && !!env.HERMES_API_KEY;
  const runsOn = String(env.HUB_CHAT_RUNS ?? '') !== '0' && !!hermesRuns?.configured && !!copyApproval && !!readApproval;
  const titles = new Map();   // etag → { title, count }

  const parse = text => String(text ?? '').split(/\r?\n/).filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);

  /** The `about` of a stored context line, cut to what the page may show. */
  const helpAbout = about => (about && HELP_KINDS.includes(about.kind) && typeof about.id === 'string'
    ? { kind: about.kind, id: about.id, ...(typeof about.step === 'string' && /^\d{2}$/.test(about.step) ? { step: about.step } : {}), title: clip(about.title, 120) }
    : null);

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
        const about = lines[0]?.role === 'context' ? helpAbout(lines[0].about) : null;   // help:
        const asked = lines.findLast(line => line.role === 'user' && typeof line.model === 'string' && chatModelsForClient().some(entry => entry.id === line.model));   // model:
        const talking = lines.find(line => line.persona && storedPersona(line.persona))?.persona;   // persona:
        info = { title: about ? clip(`Help: ${about.title}`, 60) : clip(first?.text, 60) || (first ? 'Picture' : 'New chat'), count: lines.length, ...(about ? { about } : {}), ...(asked && asked.model !== 'auto' ? { model: asked.model } : {}), ...(talking ? { persona: talking } : {}) };
        titles.set(object.etag, info);
        while (titles.size > 200) titles.delete(titles.keys().next().value);
      }
      conversations.push({ id, title: info.title, updated: object.lastModified ? new Date(object.lastModified).toISOString() : null, count: info.count, ...(info.about ? { about: info.about } : {}), ...(info.model ? { model: info.model } : {}), ...(info.persona ? { persona: info.persona } : {}) });
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
    const messages = lines.map(line => ({ role: line.role === 'context' ? 'user' : line.role, content: line.text }));   // help: the context line goes as the first user message
    for (let at = lines.length - 1; at >= 0; at -= 1) {
      const pictures = (lines[at].role === 'user' || lines[at].role === 'context') && Array.isArray(lines[at].images) ? lines[at].images.filter(image => IMAGE_FILE.test(String(image?.file))) : [];
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

  /** help: a file of the inbox, or null. */
  async function readInbox(rel) {
    try {
      const object = await bucket.get(key(rel));
      return Buffer.from(await new Response(object.body).arrayBuffer());
    } catch { return null; }
  }

  /** help: the server-built context for an `about` of `{ kind, id, step? }`: 400 for a bad shape, 404 for an item that is gone. */
  async function helpContext(about) {
    if (!about || typeof about !== 'object' || Array.isArray(about)) throw fail('about is { kind, id, step? }.');
    const { kind, id, step } = about;
    if (!HELP_KINDS.includes(kind)) throw fail('about.kind is ask, checklist, review or blocked.');
    if (typeof id !== 'string' || !id || id.length > 200) throw fail('about.id is the id of the item.');
    if (step !== undefined && step !== null && step !== '-' && step !== '' && !(typeof step === 'string' && /^\d{2}$/.test(step))) throw fail('about.step is a step number like "03".');
    if (!loadHelpItem) throw fail('Help is not available on this host.', 503);
    const detail = await loadHelpItem(kind, id, now());
    return buildHelpContext(kind, detail, { id, step: typeof step === 'string' && step !== '-' ? step : undefined, readFile: readInbox, fail });
  }

  /** help: a context picture as the Hub stores it, a create-only file of the new conversation. */
  async function putContextPictures(id, pictures) {
    const stored = [];
    for (const picture of pictures) {
      const file = `${randomId(10)}.${picture.ext}`;
      await bucket.put(key(`chat/${id}/${file}`), picture.buffer, { contentType: picture.type, ifNoneMatch: '*' });
      stored.push({ file, type: picture.type, width: picture.width, height: picture.height });
    }
    return stored;
  }

  /** help: the chat an answer attaches. 404 when it is gone, 400 when it is not about this item. */
  async function excerptOf(chatId, { kind, id }) {
    if (typeof chatId !== 'string' || !CHAT_ID.test(chatId)) throw fail('No such conversation.', 404);
    const got = await fresh(`chat/${chatId}.jsonl`);
    if (!got) throw fail('No such conversation.', 404);
    const lines = parse(got.text);
    const about = lines[0]?.role === 'context' ? helpAbout(lines[0].about) : null;
    if (!about || about.kind !== kind || about.id !== id) throw fail('That chat is not about this item.');
    return { chat: chatId, ...helpExcerpt(lines) };
  }

  // The runs this process started and is still relaying: Stop may end these and no others.
  // Each maps to who started it and which conversation it writes to.
  const active = new Map();

  async function relay(request, response, user) {
    const data = await readJson(request, 7 * MB);
    const choice = chatModelOf(data.model);   // model: an id from the table, or a 400 before anything is written
    const asked = chatPersonaOf(data.persona);   // persona: an id from the table, or a 400 before anything is written
    const text = typeof data.text === 'string' ? data.text.trim() : '';
    const pictures = checkChatImages(data.images, fail);
    if ((!text && !pictures.length) || text.length > 8000) throw fail('A message is 1 to 8000 characters.');
    let id = data.conversation;
    let history = [];
    let persona = asked;   // persona: null is Hermes itself
    const asking = id !== undefined && id !== null && id !== '';
    if (asked && asking) throw fail('persona opens a new conversation; a chat keeps the one it started with.');   // persona:
    if (asked && data.about !== undefined && data.about !== null) throw fail('Get help stays with Hermes; send about without persona.');   // persona:
    if (data.about !== undefined && data.about !== null && asking) throw fail('about opens a new conversation; send it without conversation.');   // help:
    const context = asking ? null : (data.about !== undefined && data.about !== null ? await helpContext(data.about) : null);   // help:
    if (asking) {
      if (typeof id !== 'string' || !CHAT_ID.test(id)) throw fail('No such conversation.', 404);
      // An earlier reply is still being written: a new turn now would miss it in the history and save out of order.
      if ([...active.values()].some(carried => carried.conversation === id)) throw fail('Hermes is still answering in this conversation; wait for the reply.', 409);
      const got = await fresh(`chat/${id}.jsonl`);
      if (!got) throw fail('No such conversation.', 404);
      if (Buffer.byteLength(got.text) > MAX_FILE) throw fail('This conversation is long; start a new one.', 409);
      history = parse(got.text);
      persona = storedPersona(history.find(line => line.persona)?.persona);   // persona: the one this conversation started with
    } else {
      id = `${day8(now())}-${randomId(6)}`;
    }
    const current = pictures.length
      ? [...(text ? [{ type: 'text', text }] : []), ...pictures.map(picture => ({ type: 'image_url', image_url: { url: toDataUrl(picture.type, picture.buffer) } }))]
      : text;
    if (context) {   // help: the context pictures yield to the owner's own, so one message stays within the usual limits
      let room = MAX_IMAGES - pictures.length;
      let bytes = MAX_TOTAL_BYTES - pictures.reduce((sum, picture) => sum + picture.buffer.length, 0);
      const kept = context.pictures.filter(picture => { if (room > 0 && picture.buffer.length <= bytes) { room -= 1; bytes -= picture.buffer.length; return true; } return false; });
      if (kept.length < context.pictures.length) {
        context.text += `
(${context.pictures.length - kept.length} of the item's pictures are not included in this turn.)`;
        context.pictures = kept;
      }
    }
    const contextPictures = context?.pictures ?? [];
    const spent = [...pictures, ...contextPictures].reduce((sum, picture) => sum + picture.buffer.length, 0);
    // help: a help chat's context line is pinned at the front of the history, so a long chat never loses it.
    const recent = history[0]?.role === 'context' ? [history[0], ...history.slice(1).slice(-20)] : history.slice(-20);
    // Runs carry text only: a turn that has to carry a picture (its own, or the pictures of a help chat's context) stays on completions.
    const runTurn = runsOn && !pictures.length && !contextPictures.length && !(recent[0]?.role === 'context' && recent[0].images?.length);
    const contextMessage = context && {   // help: a new help chat sends its context as the first user message
      role: 'user',
      content: contextPictures.length ? [{ type: 'text', text: context.text }, ...contextPictures.map(picture => ({ type: 'image_url', image_url: { url: toDataUrl(picture.type, picture.buffer) } }))] : context.text,
    };
    const messages = runTurn ? [] : [...(persona ? [{ role: 'user', content: persona.text }] : []), ...(contextMessage ? [contextMessage] : []), ...await historyMessages(id, recent, spent), { role: 'user', content: current }];
    const hasImages = messages.some(message => Array.isArray(message.content) && message.content.some(part => part.type === 'image_url'));
    const started = Date.now();

    const abort = new AbortController();
    let idle;
    // A run turn has no timer here: the event reader has its own 60 s idle limit, and Hermes's keepalives (which only it sees) reset it.
    const touch = () => { if (runTurn) return; clearTimeout(idle); idle = setTimeout(() => abort.abort(), IDLE_MS); };
    const total = runTurn ? null : setTimeout(() => abort.abort(), TOTAL_MS); // a run turn lives as long as Hermes keeps sending
    const finish = () => { clearTimeout(idle); clearTimeout(total); };
    // A run turn outlives its browser: Hermes finishes and the reply is saved, so a dropped page loses nothing. Only Stop ends it.
    if (!runTurn) response.on('close', () => { if (!response.writableFinished) abort.abort(); });
    touch();

    let upstream;
    let runId = null;
    if (runTurn) {
      // Earlier pictures cannot ride in conversation_history (text only): they become the same note completions uses.
      const earlier = [...(persona ? [{ role: 'user', text: persona.text }] : []), ...(context ? [{ role: 'user', text: context.text }] : []), ...recent].map(line => ({ role: line.role === 'context' ? 'user' : line.role, content: line.text || (line.images?.length ? NO_PICTURE : '') })).filter(line => line.content);
      try {
        ({ runId } = await hermesRuns.start({ input: text, history: earlier, idempotencyKey: `${id}-${history.length}-${started.toString(36)}`, ...(choice.provider ? { provider: choice.provider, model: choice.model } : {}) }));   // model:
      } catch (error) {
        finish();
        throw fail(error.status === 429 ? 'Hermes is busy; try again in a moment.' : `Hermes did not answer (${error.status || error.code || 'unreachable'}).`, 502);
      }
    } else try {
      upstream = await fetchImpl(`${hermesUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${env.HERMES_API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: choice.model ?? (env.HERMES_MODEL || 'hermes-agent'), ...(choice.provider ? { provider: choice.provider } : {}), messages, stream: true }),   // model:
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
    if (runTurn) active.set(runId, { user: user ?? null, conversation: id });
    emit('started', { conversation: id, run: runTurn ? runId : null });   // run is null on a turn that has none to stop
    const keepalive = setInterval(() => { if (!response.destroyed) response.write(': keepalive\n\n'); }, KEEPALIVE_MS);

    let reply = '';
    let failure = null;
    const tools = [];
    let finishedByHermes = false;
    if (runTurn) {
      try {
        let ended = false;
        for await (const event of hermesRuns.events(runId, { signal: abort.signal })) {
          const data = event.data ?? {};
          if (event.event === 'message.delta' && typeof data.delta === 'string' && data.delta) { reply += data.delta; emit('delta', { text: data.delta }); }
          else if (event.event === 'tool.started') {
            const name = clip(data.tool, 80);
            if (name && !tools.includes(name) && tools.length < MAX_TOOLS) tools.push(name);
            emit('tool', { id: clip(data.tool_call_id, 80), name, summary: clip(data.preview, 160), state: 'running' });
          } else if (event.event === 'tool.completed') emit('tool', { id: clip(data.tool_call_id, 80), name: clip(data.tool, 80), state: data.error ? 'failed' : 'done' });
          else if (event.event === 'approval.request') {
            // The card shows the stored record: its answers (once or deny), and an expiry counted from when Hermes asked.
            let stored = null;
            let copied = null;
            try {
              copied = await copyApproval({ runId, chat: id, prompt: data, startedAt: new Date(started) });
              if (copied) stored = await readApproval(copied);
            } catch { /* stored stays null */ }
            if (!stored) { failure = 'Hermes asked for approval, but the ask could not be saved.'; ended = true; }
            else if (stored.state === 'open') {
              const record = stored.approval;
              emit('approval', { id: copied, title: record.title, command: record.command, description: record.description, choices: (record.choices ?? []).filter(choice => choice === 'once' || choice === 'deny'), expiresAt: record.expiresAt });
            }
          } else if (event.event === 'approval.settled') emit('approval-settled', { prompt: data.prompt_id ?? null });
          else if (event.event === 'run.completed') {
            if (!reply && typeof data.output === 'string' && data.output) { reply = data.output; emit('delta', { text: reply }); }
            ended = true; finishedByHermes = true;
          } else if (event.event === 'run.failed') { failure = scrub(data.error, 200) || 'Hermes could not finish.'; ended = true; finishedByHermes = true; }
          else if (event.event === 'run.cancelled' || event.event === 'run.interrupted') { failure = 'The run was stopped.'; ended = true; finishedByHermes = true; }
          if (ended) break;
        }
        if (!ended) failure = 'The connection to Hermes broke.';
      } catch (error) {
        failure = abort.signal.aborted ? 'Hermes stopped answering.' : error?.code === 'idle' ? 'Hermes stopped answering.' : 'The connection to Hermes broke.';
      }
      // Any exit that is not Hermes ending the run (idle, a dropped Hermes stream, an unsaved ask): stop it.
      if (!finishedByHermes) hermesRuns.stop(runId).catch(() => {});
      active.delete(runId);
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
    const assistant = { role: 'assistant', text: failure ? `${reply} [interrupted]`.trim() : reply, at, ...(runId ? { run: runId, ...(tools.length ? { tools } : {}) } : {}), ...(created.length ? { created } : {}), ...(choice.provider ? { model: choice.id } : {}), ...(persona ? { persona: persona.id } : {}) };   // model: persona:
    const userLine = { role: 'user', text, at: new Date(started).toISOString(), ...(user ? { by: user } : {}), ...(choice.provider ? { model: choice.id } : {}), ...(persona ? { persona: persona.id } : {}) };   // model: persona:
    let contextLine = null;   // help:
    try {
      if (context) {
        contextLine = { role: 'context', about: context.about, text: context.text, at: new Date(started).toISOString() };
        if (context.pictures.length) contextLine.images = await putContextPictures(id, context.pictures);
      }
      // The pictures first, so a line never points at a missing file.
      if (pictures.length) {
        userLine.images = [];
        for (const picture of pictures) {
          const file = `${randomId(10)}.${picture.ext}`;
          await bucket.put(key(`chat/${id}/${file}`), picture.buffer, { contentType: picture.type, ifNoneMatch: '*' });
          userLine.images.push({ file, type: picture.type, width: picture.width, height: picture.height });
        }
      }
      await append(id, [...(contextLine ? [contextLine] : []), userLine, ...(failure && !reply ? [] : [assistant])]);
    } catch (error) {
      failure ??= 'The reply could not be saved.';
    }
    if (failure) emit('error', { error: failure });
    else emit('done', { conversation: id, user: userLine, ...(contextLine ? { context: contextLine } : {}) });
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
    // pipeline, not pipe: a body error or a client that leaves ends this one response and never throws on the process.
    pipeline(Readable.fromWeb(object.body), response, () => {});
    return undefined;
  }

  return {
    capabilities({ enabled, signedIn, requireRemoteUser }) {
      const allowed = enabled && (!requireRemoteUser || signedIn);
      return { chat: allowed && chatConfigured };
    },
    /** Answers the chat routes; the caller has checked that the route is one of them. */
    /** help: the excerpt an answer carries, `{ chat, lines, excerpt }`. */
    helpExcerpt: excerptOf,
    async handle({ request, response, method, route, user, requireRemoteUser }) {
      if (requireRemoteUser && !user) throw fail('Chat needs a signed-in user.', 401);
      if (!chatConfigured) throw fail('Chat is not set up on this host.', 503);
      let match;
      // help: the preview of what Hermes will be given for an item; the context is rebuilt on send.
      if (method === 'GET' && (match = /^\/hub\/chat\/about\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(route))) {
        const [kind, step, itemId] = match.slice(1).map(part => { try { return decodeURIComponent(part); } catch { throw fail('Bad address.'); } });
        const built = await helpContext({ kind, id: itemId, step });
        return json(response, 200, { about: built.about, title: built.title, text: built.text, pictures: built.pictures.map(picture => ({ path: picture.path, label: picture.label })) });
      }
      if (method === 'GET' && route === '/hub/chat') return json(response, 200, { conversations: await list(), models: chatModelsForClient(), personas: chatPersonasForClient() });   // model: persona:
      if (method === 'GET' && (match = /^\/hub\/chat\/([^/]+)$/.exec(route))) {
        if (!CHAT_ID.test(match[1])) throw fail('No such conversation.', 404);
        const got = await fresh(`chat/${match[1]}.jsonl`);
        if (!got) throw fail('No such conversation.', 404);
        return json(response, 200, { id: match[1], messages: parse(got.text) });
      }
      if (method === 'GET' && (match = /^\/hub\/chat\/([^/]+)\/images\/([^/]+)$/.exec(route))) return serveImage(response, match[1], match[2]);
      if (method === 'POST' && route === '/hub/chat') return relay(request, response, user);
      if (method === 'POST' && route === '/hub/chat/stop') {
        const data = await readJson(request, 4096);
        const run = typeof data.run === 'string' ? data.run : '';
        const carried = active.get(run);
        if (!carried || carried.user !== (user ?? null)) throw fail('No such reply is running.', 404);
        await hermesRuns.stop(run).catch(() => {});
        return json(response, 200, { stopped: true });
      }
      throw fail('Not found', 404);
    },
  };
}
