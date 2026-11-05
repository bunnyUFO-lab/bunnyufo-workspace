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
import { stripInlineImages } from './inline-images.mjs';
import { IMAGE_FILE, MAX_IMAGES, MAX_TOTAL_BYTES, checkChatImages, toDataUrl, typeOfFile } from './chat-images.mjs';
import { CHAT_CHAIN, CHAT_MODELS, chatModelOf, chatModelsForClient, currentModelId } from './chat-models.mjs';
import { DEFAULT_PROVIDER, pausesForClient } from './plan-pauses.mjs';
import { CHAT_PERSONAS, chatPersonaOf, chatPersonasForClient, storedPersona } from './chat-personas.mjs';
import { HELP_KINDS, buildHelpContext, helpExcerpt } from './hub-help.mjs';
import { foldDelegates, hasRunningDelegate, settleDelegates } from './chat-delegates.mjs';
import { QUEUE_LIMITS, STALE_MS_DEFAULT, addItem, cancelItem, createQueueStore, holdFor, holdQueue, readQueue, restoreItems, takeItems, tooOld, viewOf } from './chat-queue.mjs';

const MB = 1024 * 1024;
export const CHAT_ID = /^\d{8}-[a-z0-9]{6}$/;
const MAX_FILE = 1024 * 1024;
const HISTORY_IMAGE_BUDGET = 6 * MB;
const NO_PICTURE = '[An earlier picture is not included.]';
// A completions stream (a picture turn) sends nothing while Hermes runs a tool, and tool calls of 60-120 s are normal, so allow 5 min of
// silence and 10 min in all. The site's own 15 s keepalive keeps the browser and the proxy side open meanwhile.
export const TOTAL_MS_DEFAULT = 600_000;
export const IDLE_MS_DEFAULT = 300_000;
const MAX_TOOLS = 20;
const KEEPALIVE_MS = 15_000;
const DELEGATE_LOOK_MS = 4_000;   // how long reading a conversation waits for Hermes's delegate results

const clip = (value, length) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, length);

export const isChatRoute = route => route === '/hub/chat' || route.startsWith('/hub/chat/');

export function createChat({ env, fetchImpl, key, fresh, bucket, loadAsks, loadRequests, loadHelpItem = null, readJson, json, fail, now, hermesRuns = null, planPauses = null, personas = null, autoFirst = null, copyApproval = null, readApproval = null, scrub = createScrub(env), log = () => {} }) {
  const IDLE_MS = Number(env.HUB_CHAT_IDLE_MS) > 0 ? Number(env.HUB_CHAT_IDLE_MS) : IDLE_MS_DEFAULT; // completions turns only; a test shortens it
  const TOTAL_MS = Number(env.HUB_CHAT_TOTAL_MS) > 0 ? Number(env.HUB_CHAT_TOTAL_MS) : TOTAL_MS_DEFAULT; // completions turns only; a test shortens it
  const hermesUrl = String(env.HERMES_URL ?? '').replace(/\/+$/, '');
  const chatConfigured = !!hermesUrl && !!env.HERMES_API_KEY;
  const runsOn = String(env.HUB_CHAT_RUNS ?? '') !== '0' && !!hermesRuns?.configured && !!copyApproval && !!readApproval;
  const titles = new Map();   // etag → { title, count }
  /** The persona table of this request: the app's, with the owner's edits (hub-personas.mjs) when the Hub gave a reader. */
  /** What Auto tries first: the label of the model the Hermes host says profile main uses (an export, ws-im1.4.2), else Codex, the app's own default. */
  const autoFirstLabel = async () => (autoFirst ? await autoFirst().catch(() => null) : null) || 'Codex';
  const tableNow = async () => (personas ? await personas() : CHAT_PERSONAS);   // persona:

  const parse = text => String(text ?? '').split(/\r?\n/).filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);

  /** The `about` of a stored context line, cut to what the page may show. */
  const helpAbout = about => (about && HELP_KINDS.includes(about.kind) && typeof about.id === 'string'
    ? { kind: about.kind, id: about.id, ...(typeof about.step === 'string' && /^\d{2}$/.test(about.step) ? { step: about.step } : {}), title: clip(about.title, 120) }
    : null);

  async function list() {
    const table = await tableNow();   // persona:
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
        const asked = lines.findLast(line => line.role === 'user' && typeof line.model === 'string' && chatModelsForClient().some(entry => entry.id === currentModelId(line.model)));   // model:
        const talking = lines.find(line => line.persona && storedPersona(line.persona, table))?.persona;   // persona:
        info = { title: about ? clip(`Help: ${about.title}`, 60) : clip(first?.text, 60) || (first ? 'Picture' : 'New chat'), count: lines.length, ...(about ? { about } : {}), ...(asked && currentModelId(asked.model) !== 'auto' ? { model: currentModelId(asked.model) } : {}), ...(talking ? { persona: talking } : {}) };
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
    const messages = lines.map(line => ({ role: line.role === 'context' ? 'user' : line.role, content: stripInlineImages(line.text) }));   // help: the context line goes as the first user message
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

  // The turns this process is relaying (a picture turn too, with no run): Stop may end these and no others.
  // Keyed by a turn key, `<conversation>-t-<rand>`: a turn the Hub starts from the queue has no run id until Hermes accepts it.
  // An entry is { key, user, conversation, run, stopAsked, log, listeners, asking: { text, at }, pumped }.
  const active = new Map();
  const queueStore = createQueueStore({ fresh, bucket, key });
  const SWEEP_MS = env.HUB_CHAT_QUEUE_SWEEP_MS === undefined || env.HUB_CHAT_QUEUE_SWEEP_MS === '' ? 60_000 : Math.max(0, Number(env.HUB_CHAT_QUEUE_SWEEP_MS) || 0);
  const MAX_PUMPED = 2;   // turns the Hub started itself (from the queue or after a restart) that may run at once, across chats
  const NUDGE_MS = 30_000;
  const STALE_MS = Number(env.HUB_CHAT_QUEUE_STALE_MS) > 0 ? Number(env.HUB_CHAT_QUEUE_STALE_MS) : STALE_MS_DEFAULT;   // an unheld message older than this is held, not delivered
  const pumping = new Set();   // conversations whose queue is being turned into a turn: a sweep must not take them too

  const turnKeyFor = (id, kind = 't') => `${id}-${kind}-${randomId(6)}`;
  const carriedOf = id => { for (const carried of active.values()) if (carried.conversation === id) return carried; return null; };
  const carriedByRun = run => { for (const carried of active.values()) if (run && carried.run === run) return carried; return null; };
  const pumpedCount = except => [...active.values()].filter(carried => carried.pumped && carried !== except).length;
  const makeCarried = ({ key: turnKey, user, conversation, run = null, text, at, pumped = false }) => ({ key: turnKey, user: user ?? null, conversation, run, stopAsked: false, log: [], listeners: new Set(), asking: { text, at }, pumped });

  /** The turn still answering in a conversation, as the page may see it: Stop names the run only for who started it. */
  const answering = (id, user) => {
    const carried = carriedOf(id);
    return carried ? { running: true, run: carried.run && carried.user === (user ?? null) ? carried.run : null, asking: carried.asking } : null;
  };

  /**
   * The one way a turn speaks: to its page (when it has one), into the turn's log (so a page that comes later can read it
   * through /live), and to whoever follows it. A delta merges into the one before it, so the log is about the reply's size.
   */
  function busFor(carried, response = null) {
    return (event, value) => {
      if (response && !response.destroyed) response.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`);
      const last = carried.log[carried.log.length - 1];
      if (event === 'delta' && last?.event === 'delta') last.data = { text: last.data.text + value.text };
      else carried.log.push({ event, data: value });
      for (const listener of [...carried.listeners]) listener(event, value);
    };
  }

  /**
   * The saved lines of a conversation, with delegates that have finished since (Hermes saves their results in the run's own session, and
   * nothing tells the Hub). Saved back when something changed; a lost race or a silent Hermes only means the next read looks again.
   */
  async function withDelegateResults(id, got) {
    const lines = parse(got.text);
    const waiting = lines.filter(line => line.role === 'assistant' && line.run && hasRunningDelegate(line)).slice(-3);
    if (!waiting.length || !hermesRuns?.sessionMessages) return lines;
    let changed = false;
    await Promise.all(waiting.map(async line => {
      let timer;
      const rows = await Promise.race([
        hermesRuns.sessionMessages(line.run).catch(() => null),
        new Promise(resolve => { timer = setTimeout(() => resolve(null), DELEGATE_LOOK_MS); timer.unref?.(); }),
      ]);
      clearTimeout(timer);
      const settled = settleDelegates(line.delegates, rows, now().getTime() - new Date(line.at).getTime());
      if (settled !== line.delegates) { line.delegates = settled; changed = true; }
    }));
    if (changed) await bucket.put(key(`chat/${id}.jsonl`), `${lines.map(line => JSON.stringify(line)).join('\n')}\n`, { contentType: 'application/x-ndjson', ifMatch: got.etag }).catch(() => {});
    return lines;
  }

  /** The lines as the page reads them (never written back): an id an earlier version listed gives its family's row, and an id no row has now loses its key, so the chat opens on Auto and can send. */
  function currentModels(lines) {
    const listed = new Set(CHAT_MODELS.map(entry => entry.id));
    return lines.map(line => {
      if (!line || typeof line !== 'object' || !('model' in line)) return line;
      const { model, ...rest } = line;
      const now = typeof model === 'string' ? currentModelId(model) : null;
      return now && listed.has(now) ? { ...rest, model: now } : rest;
    });
  }

  /** What goes to Hermes as the earlier turns: the persona and context text, then the last 20 lines (text only, a picture becomes a note). */
  function historyFor({ history, persona, context }) {
    // help: a help chat's context line is pinned at the front of the history, so a long chat never loses it.
    const recent = history[0]?.role === 'context' ? [history[0], ...history.slice(1).slice(-20)] : history.slice(-20);
    // Earlier pictures cannot ride in conversation_history (text only): they become the same note completions uses.
    const earlier = [...(persona ? [{ role: 'user', text: persona.text }] : []), ...(context ? [{ role: 'user', text: context.text }] : []), ...recent].map(line => ({ role: line.role === 'context' ? 'user' : line.role, content: stripInlineImages(line.text) || (line.images?.length ? NO_PICTURE : '') })).filter(line => line.content);
    return { recent, earlier };
  }

  /** Reads one run's events to its end, telling `emit` what it sees. Returns what the turn made; a failure is a sentence, never a throw. */
  async function carryRun({ carried, runId, choice, emit, signal, started, conversation }) {
    let reply = '';
    let failure = null;
    const tools = [];
    let delegates = [];
    const noteDelegates = (name, data) => {
      const next = foldDelegates(delegates, name, data);
      if (next !== delegates) { delegates = next; emit('delegates', { items: delegates }); }
    };
    let finishedByHermes = false;
    try {
      let ended = false;
      for await (const event of hermesRuns.events(runId, { signal })) {
        const data = event.data ?? {};
        if (event.event === 'message.delta' && typeof data.delta === 'string' && data.delta) { reply += data.delta; emit('delta', { text: data.delta }); }
        else if (event.event === 'tool.started') {
          const name = clip(data.tool, 80);
          if (name && !tools.includes(name) && tools.length < MAX_TOOLS) tools.push(name);
          emit('tool', { id: clip(data.tool_call_id, 80), name, summary: clip(data.preview, 160), state: 'running' });
        } else if (event.event === 'tool.completed') {
          emit('tool', { id: clip(data.tool_call_id, 80), name: clip(data.tool, 80), state: data.error ? 'failed' : 'done' });
          noteDelegates(event.event, data);
        } else if (event.event === 'subagent.start' || event.event === 'subagent.complete') noteDelegates(event.event, data);
        else if (event.event === 'approval.request') {
          // The card shows the stored record: its answers (once or deny), and an expiry counted from when Hermes asked.
          let stored = null;
          let copied = null;
          try {
            copied = await copyApproval({ runId, chat: conversation, prompt: data, startedAt: new Date(started) });
            if (copied) stored = await readApproval(copied);
          } catch { /* stored stays null */ }
          if (!stored) { failure = 'Hermes asked for approval, but the ask could not be saved.'; ended = true; }
          else if (stored.state === 'open') {
            const record = stored.approval;
            emit('approval', { id: copied, title: record.title, command: record.command, description: record.description, choices: (record.choices ?? []).filter(choice => choice === 'once' || choice === 'deny'), expiresAt: record.expiresAt });
          }
        } else if (event.event === 'approval.settled') emit('approval-settled', { prompt: data.prompt_id ?? null });
        else if (event.event === 'run.completed') {
          // The events Hermes keeps are the last ones only: a long reply is whole in its output, so a longer output wins over what was read.
          if (typeof data.output === 'string' && data.output.length > reply.length) { if (!reply) emit('delta', { text: data.output }); reply = data.output; }
          ended = true; finishedByHermes = true;
        } else if (event.event === 'run.failed') { failure = scrub(data.error, 200) || 'Hermes could not finish.'; ended = true; finishedByHermes = true; planPauses?.note(choice.provider ?? DEFAULT_PROVIDER, data.error); }   // pauses: a quota failure pauses the plan it ran on
        else if (event.event === 'run.cancelled' || event.event === 'run.interrupted') { failure = 'The run was stopped.'; ended = true; finishedByHermes = true; }
        if (ended) break;
      }
      if (!ended) failure = 'The connection to Hermes broke.';
    } catch (error) {
      failure = signal.aborted ? 'Hermes stopped answering.' : error?.code === 'idle' ? 'Hermes stopped answering.' : 'The connection to Hermes broke.';
    }
    return { reply, failure, tools, delegates, finishedByHermes };
  }

  /** Saves a finished turn's lines (the picture files first) and announces what it created. Returns the lines and a failure when they could not be saved. */
  async function saveTurn({ carried = null, id, user, text, started, pictures, context, choice, persona, runId, reply, failure, tools, delegates, emit, queued = [] }) {
    if (carried) carried.ending = true;   // the run is over: a Stop now has nothing to stop, and none is waited for below
    let created = [];
    try { created = await createdSince(started); } catch { /* the reply is still worth saving */ }
    if (created.length) emit('created', { items: created });
    const at = now().toISOString();
    const kept = stripInlineImages(reply);   // a picture Hermes made is megabytes of text: the line keeps a note
    const assistant = { role: 'assistant', text: failure ? `${kept} [interrupted]`.trim() : kept, at, ...(runId ? { run: runId, ...(tools.length ? { tools } : {}) } : {}), ...(delegates.length ? { delegates } : {}), ...(created.length ? { created } : {}), ...(choice.provider ? { model: choice.id } : {}), ...(persona ? { persona: persona.id } : {}) };   // model: persona:
    const userLine = { role: 'user', text, at: new Date(started).toISOString(), ...(user ? { by: user } : {}), ...(choice.provider ? { model: choice.id } : {}), ...(persona ? { persona: persona.id } : {}), ...(queued.length ? { queued } : {}) };   // model: persona: queued: the ids of the messages a queued turn joined
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
      await append(id, [...(contextLine ? [contextLine] : []), userLine, ...(failure && !reply && !delegates.length ? [] : [assistant])]);
    } catch (error) {
      failure ??= 'The reply could not be saved.';
    }
    return { failure, userLine, contextLine };
  }

  /** The messages waiting in `queue` as the next turn: written into the queue file as its `turn`, which the caller then starts. */
  const takeTurn = (queue, id) => {
    const taken = takeItems(queue);
    const turn = { key: turnKeyFor(id), run: null, text: taken.text, at: now().toISOString(), ...(taken.by ? { by: taken.by } : {}), ...(taken.model ? { model: taken.model } : {}), queued: taken.ids, taken: taken.taken, pumped: true, tries: 0 };
    return { queue: { ...taken.queue, turn }, out: turn };
  };

  /**
   * What a turn that has ended does to the queue, under the conversation's lock: its own `turn` goes. After a failure the waiting messages
   * are held (nothing goes out by itself); after a good reply, and when no hold is set and the host has room, they become the next turn.
   * Returns that turn, or null.
   */
  async function advanceQueue(id, carried, failure) {
    const { out } = await queueStore.update(id, queue => {
      const base = queue.turn?.key === carried.key ? { ...queue, turn: null } : queue;
      // A Stop that was accepted while the reply was ending counts as much as a failure: nothing goes out after a Stop.
      if (failure || carried.stopAsked) return { queue: queue.items.length ? holdQueue(base, holdFor(failure, carried.stopAsked), now().toISOString()) : base };
      if (!queue.items.length || queue.held || base.turn || pumpedCount(carried) >= MAX_PUMPED) return { queue: base };
      if (tooOld(queue.items, now().getTime(), STALE_MS)) return { queue: holdQueue(base, 'old', now().toISOString()) };
      return takeTurn(base, id);
    });
    return out ?? null;
  }

  /**
   * The end of a turn, in this order, because a page that reads `running: false` must find the reply saved and must see no gap before the next turn:
   * the lines are already saved; the queue moves on (and a next turn takes this one's place in `active` in the same tick); the page hears
   * `done` or `error`; and only then does the next run start.
   */
  async function endTurn({ carried, response = null, emit, id, failure, userLine = null, contextLine = null }) {
    let next = null;
    try { next = await advanceQueue(id, carried, failure); } catch (error) { log(`chat queue: could not move on after a turn: ${error.message}`); }   // the sweep finds it
    active.delete(carried.key);
    const following = next ? makeCarried({ key: next.key, user: next.by, conversation: id, text: next.text, at: next.at, pumped: true }) : null;
    if (following) active.set(following.key, following);
    if (failure) emit('error', { error: failure });
    else emit('done', { conversation: id, user: userLine, ...(contextLine ? { context: contextLine } : {}) });
    response?.end();
    if (following) work(following, () => startAndCarry({ id, carried: following, turn: next }));
  }

  /** Runs a turn the Hub carries on its own, without a page; whatever goes wrong ends the turn for anyone following it. */
  function work(carried, job) {
    job().catch(error => {
      log(`chat queue: a turn failed: ${error.message}`);
      busFor(carried)('error', { error: 'The reply could not be finished.' });
    }).finally(() => { if (active.get(carried.key) === carried) active.delete(carried.key); });
  }

  /** A start that did not happen: the messages go back to the front of the queue (a stored `taken` list, or the text as one message). */
  async function releaseTurn(id, carried, turn, reason) {
    try {
      await queueStore.update(id, queue => {
        if (queue.turn?.key !== turn.key) return null;
        const items = turn.taken?.length ? turn.taken : [{ id: `q${randomId(5)}`, text: turn.text, at: turn.at, ...(turn.by ? { by: turn.by } : {}), ...(turn.model ? { model: turn.model } : {}) }];
        const { tries: spent = 0, ...back } = restoreItems({ ...queue, turn: null }, items);
        const at = now().toISOString();
        if (reason === 'long' || reason === 'lost' || reason === 'old') return { queue: holdQueue(back, reason, at) };
        if (reason === 'failed') return { queue: holdQueue(back, 'failed', at) };
        if (reason === 'busy') return { queue: { ...back, ...(spent ? { tries: spent } : {}) } };
        return { queue: spent + 1 >= QUEUE_LIMITS.tries ? { ...back, held: { reason: 'failed', at } } : { ...back, tries: spent + 1 } };
      });
    } catch (error) { log(`chat queue: could not put the messages back: ${error.message}`); }
    active.delete(carried.key);
    busFor(carried)('error', { error: reason === 'long' ? 'This conversation is long; start a new one.' : 'Hermes did not take the message.' });
  }

  /** A start whose outcome is unknown (the answer never came): Hermes may have the run. The turn stays in the file and is started again under the same key; after three tries the words go back, held. */
  async function keepTurn(id, carried, turn) {
    let spent = turn.tries ?? 0;
    try {
      await queueStore.update(id, queue => {
        if (queue.turn?.key !== turn.key) return null;
        spent = (queue.turn.tries ?? 0) + 1;
        return spent >= QUEUE_LIMITS.tries ? null : { queue: { ...queue, turn: { ...queue.turn, tries: spent } } };
      });
    } catch (error) { log(`chat queue: could not note the try: ${error.message}`); }
    active.delete(carried.key);
    if (spent >= QUEUE_LIMITS.tries) { await releaseTurn(id, carried, turn, 'failed'); return; }
    busFor(carried)('error', { error: 'Hermes did not answer; the Hub will try again.' });
  }

  const modelOf = id => { try { return chatModelOf(id); } catch { return chatModelOf(null); } };   // a model that is no longer listed falls back to Auto

  /**
   * Starts the turn the queue made (or finishes the start of one a restart interrupted: the same key gives the same run), then carries it
   * to its end like a plain turn. Runs without a page, and never on the completions path.
   */
  async function startAndCarry({ id, carried, turn }) {
    const emit = busFor(carried);
    const started = Date.parse(turn.at) || Date.now();
    const choice = modelOf(turn.model);
    let runId;
    let persona = null;
    if (Date.now() - started > STALE_MS) { await releaseTurn(id, carried, turn, 'old'); return; }   // it waited too long (a long outage): the owner decides
    try {
      const got = await fresh(`chat/${id}.jsonl`);
      if (got && Buffer.byteLength(got.text) > MAX_FILE) { await releaseTurn(id, carried, turn, 'long'); return; }
      const history = got ? parse(got.text) : [];
      persona = storedPersona(history.find(line => line.persona)?.persona ?? turn.persona, await tableNow());
      const { earlier } = historyFor({ history, persona, context: null });
      ({ runId } = await hermesRuns.start({ input: turn.text, history: earlier, idempotencyKey: turn.key, ...(choice.provider ? { provider: choice.provider, model: choice.model } : {}) }));
    } catch (error) {
      log(`chat queue: Hermes did not take a queued turn (${error.status || error.code || 'unreachable'})`);
      // No status: Hermes may have accepted it (a timeout is "I do not know"), so the same key is tried again. A status is a refusal.
      if (!error.status) await keepTurn(id, carried, turn);
      else await releaseTurn(id, carried, turn, 'retry');
      return;
    }
    carried.run = runId;
    emit('started', { conversation: id, run: runId });
    await queueStore.update(id, queue => {
      if (queue.turn?.key !== turn.key) return null;
      const rest = { ...queue };
      delete rest.tries;   // a good start clears the count of bad ones
      return { queue: { ...rest, turn: { ...queue.turn, run: runId } } };
    }).catch(error => log(`chat queue: could not note the run: ${error.message}`));
    await carryOn({ id, carried, turn, runId, choice, persona, emit, started });
  }

  /** Reads a turn's run to its end, saves it and ends the turn; with `poll`, a run whose events are gone is followed by its status. */
  async function carryOn({ id, carried, turn, runId, choice, persona, emit, started, poll = false }) {
    const ran = await carryRun({ carried, runId, choice, emit, signal: new AbortController().signal, started, conversation: id });
    let { reply, failure } = ran;
    if (!ran.finishedByHermes) {
      let status = null;
      if (poll) {
        status = await pollRun(runId);
        if (status === null) { await releaseTurn(id, carried, turn, 'lost'); return; }
      }
      if (status) { ({ reply, failure } = settledBy(status, reply)); } else hermesRuns.stop(runId).catch(() => {});
    }
    const saved = await saveTurn({ carried, id, user: turn.by, text: turn.text, started, pictures: [], context: null, choice, persona, runId, reply, failure, tools: ran.tools, delegates: ran.delegates, emit, queued: turn.queued ?? [] });
    await endTurn({ carried, emit, id, ...saved });
  }

  const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
  /** What a finished run's status says: the reply and the failure sentence (null for a good end). */
  const settledBy = (status, partial = '') => ({
    reply: typeof status.output === 'string' && status.output.length >= partial.length ? status.output : partial,
    failure: status.status === 'completed' ? null : status.status === 'failed' ? (scrub(status.error, 200) || 'Hermes could not finish.') : 'The run was stopped.',
  });

  /** A run's status until it ends: the status object, null when Hermes has forgotten the run, undefined after two hours. */
  async function pollRun(runId) {
    const every = Number(env.HUB_CHAT_QUEUE_POLL_MS) > 0 ? Number(env.HUB_CHAT_QUEUE_POLL_MS) : 5000;
    for (let waited = 0; waited < 2 * 3600_000; waited += every) {
      let status;
      try { status = await hermesRuns.get(runId); } catch { status = undefined; }
      if (status === null) return null;
      if (status && TERMINAL.has(status.status)) return status;
      await new Promise(resolve => { const timer = setTimeout(resolve, every); timer.unref?.(); });
    }
    return undefined;
  }

  /**
   * The queue of one conversation, when nothing runs in it: the waiting messages become the next turn and it starts. Not while a reply is
   * held (the owner sends it), nor when the host already carries its limit of such turns. Returns the turn, or null.
   */
  async function pump(id, { force = false } = {}) {
    if (carriedOf(id) || pumping.has(id) || (pumpedCount() >= MAX_PUMPED)) return null;
    pumping.add(id);   // until the turn is in `active`: a sweep that reads the new `turn` in between must not recover it too
    try {
      // Messages with no saved chat behind them (a picture or help first turn that a restart lost) have nothing to be delivered into.
      const exists = !!await fresh(`chat/${id}.jsonl`);
      const { out } = await queueStore.update(id, queue => {
        if (queue.turn || !queue.items.length || (queue.held && !force)) return null;
        if (!exists) return { queue: holdQueue(queue, 'lost', now().toISOString()) };
        if (!force && tooOld(queue.items, now().getTime(), STALE_MS)) return { queue: holdQueue(queue, 'old', now().toISOString()) };
        return takeTurn(queue, id);
      });
      if (!out) return null;
      const carried = makeCarried({ key: out.key, user: out.by, conversation: id, text: out.text, at: out.at, pumped: true });
      if (carriedOf(id)) { await releaseTurn(id, carried, out, 'busy'); return null; }   // a plain turn began in the meantime
      active.set(carried.key, carried);
      work(carried, () => startAndCarry({ id, carried, turn: out }));
      return out;
    } finally { pumping.delete(id); }
  }

  /**
   * A conversation whose `turn` nothing here carries (the service restarted, or an end was cut short), in the queue file's own words:
   * no run yet, so start it (the same key gives the same run); a run that has ended, so save it unless it is saved; one still going, so read it on;
   * one Hermes forgot, so the words come back as a held message. Starts the work and returns.
   */
  function recoverTurn(id, turn) {
    if (carriedOf(id) || pumping.has(id)) return;
    const carried = makeCarried({ key: turn.key, user: turn.by, conversation: id, run: turn.run ?? null, text: turn.text, at: turn.at, pumped: !!turn.pumped });
    active.set(carried.key, carried);
    work(carried, async () => {
      const emit = busFor(carried);
      if (!turn.run) { await startAndCarry({ id, carried, turn }); return; }
      let status;
      try { status = await hermesRuns.get(turn.run); } catch { active.delete(carried.key); return; }   // Hermes is unreachable: the next sweep looks again
      if (status === null) { await releaseTurn(id, carried, turn, 'lost'); return; }
      const started = Date.parse(turn.at) || Date.now();
      const choice = modelOf(turn.model);
      const got = await fresh(`chat/${id}.jsonl`);
      const history = got ? parse(got.text) : [];
      const persona = storedPersona(history.find(line => line.persona)?.persona ?? turn.persona, await tableNow());
      if (!TERMINAL.has(status.status)) { await carryOn({ id, carried, turn, runId: turn.run, choice, persona, emit, started, poll: true }); return; }
      const { reply, failure } = settledBy(status);
      // Any user line, not only the last: the owner may have sent another turn since this one was saved.
      const savedAlready = history.some(line => line.role === 'user' && ((!!turn.queued?.length && JSON.stringify(line.queued ?? []) === JSON.stringify(turn.queued)) || (!turn.queued?.length && line.text === turn.text && line.at === turn.at)));
      if (savedAlready) { await endTurn({ carried, emit, id, failure }); return; }   // saved already: only the turn goes
      const saved = await saveTurn({ carried, id, user: turn.by, text: turn.text, started, pictures: [], context: null, choice, persona, runId: turn.run, reply, failure, tools: [], delegates: [], emit, queued: turn.queued ?? [] });
      await endTurn({ carried, emit, id, ...saved });
    });
  }

  /** Looks at one conversation's queue and moves it on when nothing carries it. Answers whether the file is idle (no turn, nothing deliverable). */
  async function sweepOne(id, queue = null) {
    if (carriedOf(id) || pumping.has(id)) return false;
    const current = queue ?? await queueStore.read(id);
    if (current.turn) { recoverTurn(id, current.turn); return false; }
    if (current.items.length && !current.held) { await pump(id); return false; }
    return true;
  }

  const idleFiles = new Set();   // etags of queue files seen idle: the sweep skips them until they change
  async function sweep() {
    if (!runsOn) return;
    const { objects } = await bucket.list(key('chat/queue/x.json').slice(0, -'x.json'.length));
    for (const object of objects) {
      const id = object.key.split('/').pop().replace(/\.json$/, '');
      if (!CHAT_ID.test(id) || idleFiles.has(object.etag)) continue;
      if (object.lastModified && now().getTime() - new Date(object.lastModified).getTime() > 7 * 86_400_000) continue;
      try {
        if (await sweepOne(id)) { idleFiles.add(object.etag); while (idleFiles.size > 500) idleFiles.delete(idleFiles.values().next().value); }
      } catch (error) { log(`chat queue: sweep of one chat failed: ${error.message}`); }
    }
  }

  const nudged = new Map();
  /** A page reading a conversation nudges its queue, at most every 30 s, so it does not wait for the sweep. */
  function nudge(id, queue) {
    if (!runsOn || carriedOf(id) || !(queue.turn || (queue.items.length && !queue.held))) return;
    const at = Date.now();
    if (at - (nudged.get(id) ?? 0) < NUDGE_MS) return;
    nudged.set(id, at);
    while (nudged.size > 200) nudged.delete(nudged.keys().next().value);
    sweepOne(id, queue).catch(() => {});
  }

  let sweepTimer = null;
  let firstSweep = null;
  if (runsOn && SWEEP_MS > 0) {
    firstSweep = setTimeout(() => sweep().catch(() => {}), Math.min(SWEEP_MS, 2000));
    sweepTimer = setInterval(() => sweep().catch(() => {}), SWEEP_MS);
    firstSweep.unref?.();
    sweepTimer.unref?.();
  }

  async function relay(request, response, user) {
    const data = await readJson(request, 7 * MB);
    const choice = chatModelOf(data.model);   // model: an id from the table, or a 400 before anything is written
    const table = await tableNow();
    const asked = chatPersonaOf(data.persona, table);   // persona: an id from the table, or a 400 before anything is written
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
      if (carriedOf(id)) throw fail('Hermes is still answering in this conversation; wait for the reply.', 409);
      const got = await fresh(`chat/${id}.jsonl`);
      if (!got) throw fail('No such conversation.', 404);
      if (Buffer.byteLength(got.text) > MAX_FILE) throw fail('This conversation is long; start a new one.', 409);
      history = parse(got.text);
      persona = storedPersona(history.find(line => line.persona)?.persona, table);   // persona: the one this conversation started with
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
    const { recent, earlier } = historyFor({ history, persona, context });
    // Runs carry text only: a turn that has to carry a picture (its own, or the pictures of a help chat's context) stays on completions.
    const runTurn = runsOn && !pictures.length && !contextPictures.length && !(recent[0]?.role === 'context' && recent[0].images?.length);
    const contextMessage = context && {   // help: a new help chat sends its context as the first user message
      role: 'user',
      content: contextPictures.length ? [{ type: 'text', text: context.text }, ...contextPictures.map(picture => ({ type: 'image_url', image_url: { url: toDataUrl(picture.type, picture.buffer) } }))] : context.text,
    };
    const messages = runTurn ? [] : [...(persona ? [{ role: 'user', content: persona.text }] : []), ...(contextMessage ? [contextMessage] : []), ...await historyMessages(id, recent, spent), { role: 'user', content: current }];
    const hasImages = messages.some(message => Array.isArray(message.content) && message.content.some(part => part.type === 'image_url'));
    const started = Date.now();
    const turnKey = turnKeyFor(id, runTurn ? 't' : 'p');
    // Busy from here, before Hermes is asked: a message queued while it takes this one waits, instead of starting a second run beside it, and a
    // second tab posting at once is told to wait. Every refusal below takes the entry out again.
    if (asking && carriedOf(id)) throw fail('Hermes is still answering in this conversation; wait for the reply.', 409);
    const carried = makeCarried({ key: turnKey, user, conversation: id, run: null, text, at: new Date(started).toISOString() });
    active.set(turnKey, carried);

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
      try {
        ({ runId } = await hermesRuns.start({ input: text, history: earlier, idempotencyKey: turnKey, ...(choice.provider ? { provider: choice.provider, model: choice.model } : {}) }));   // model:
        carried.run = runId;
      } catch (error) {
        finish();
        active.delete(turnKey);
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
      active.delete(turnKey);
      throw fail(`Hermes did not answer (${error.name === 'AbortError' ? 'timed out' : 'unreachable'}).`, 502);
    }
    if (!runTurn && (!upstream.ok || !upstream.body)) {
      finish();
      active.delete(turnKey);
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
    // A picture turn counts as busy too (it has no run to stop), so a message sent meanwhile is queued, not lost.
    const emit = busFor(carried, response);
    emit('started', { conversation: id, run: runTurn ? runId : null });   // run is null on a turn that has none to stop
    // A restart must be able to finish this turn: its user line is saved only when it ends. A failed write only logs; it never fails the chat.
    if (runTurn && !context) {
      await queueStore.update(id, queue => (queue.turn ? null : { queue: { ...queue, turn: { key: turnKey, run: runId, text, at: new Date(started).toISOString(), ...(user ? { by: user } : {}), ...(choice.provider ? { model: choice.id } : {}), ...(persona ? { persona: persona.id } : {}), queued: [], pumped: false, tries: 0 } } })).catch(error => log(`chat queue: could not note the turn: ${error.message}`));
    }
    const keepalive = setInterval(() => { if (!response.destroyed) response.write(': keepalive\n\n'); }, KEEPALIVE_MS);

    let reply = '';
    let failure = null;
    let tools = [];
    let delegates = [];
    let finishedByHermes = false;
    if (runTurn) {
      ({ reply, failure, tools, delegates, finishedByHermes } = await carryRun({ carried, runId, choice, emit, signal: abort.signal, started, conversation: id }));
      // Any exit that is not Hermes ending the run (idle, a dropped Hermes stream, an unsaved ask): stop it.
      if (!finishedByHermes) hermesRuns.stop(runId).catch(() => {});
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

    const saved = await saveTurn({ carried, id, user, text, started, pictures, context, choice, persona, runId, reply, failure, tools, delegates, emit });
    // Only now: a page that reads `running: false` finds the reply saved, and a new turn cannot overtake it.
    await endTurn({ carried, response, emit, id, ...saved });
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

  const queueId = id => { if (!CHAT_ID.test(id)) throw fail('No such conversation.', 404); if (!runsOn) throw fail('Sending while Hermes answers needs the run path, which is off on this host.', 503); return id; };

  /** What a page needs after a queue change: the waiting messages and why they are held. */
  const queueView = async id => viewOf(await queueStore.read(id));

  /** POST /queue: one more message for when the reply ends (at once when nothing runs and nothing is held). */
  async function queueMessage(id, data, user) {
    queueId(id);
    if (data.images !== undefined && data.images !== null && !(Array.isArray(data.images) && !data.images.length)) throw fail('Pictures cannot wait in the queue; send them when the reply is done.');
    const text = typeof data.text === 'string' ? data.text.trim() : '';
    if (!text || text.length > QUEUE_LIMITS.text) throw fail(`A message is 1 to ${QUEUE_LIMITS.text} characters.`);
    const choice = chatModelOf(data.model);   // model: an id from the table, or a 400
    if (!carriedOf(id) && !await fresh(`chat/${id}.jsonl`)) throw fail('No such conversation.', 404);
    const { out } = await queueStore.update(id, queue => {
      const added = addItem(queue, { id: `q${randomId(5)}`, text, at: now().toISOString(), by: user ?? undefined, model: choice.provider ? choice.id : undefined });
      return added.error ? { out: { error: added.error } } : { queue: added.queue, out: { ok: true } };
    });
    if (out.error === 'items') throw fail(`${QUEUE_LIMITS.items} messages are already waiting in this chat.`, 409);
    if (out.error) throw fail(`The waiting messages are at the ${QUEUE_LIMITS.chars} character limit; wait for the reply.`, 409);
    await pump(id);   // nothing running and nothing held: it goes now
    return queueView(id);
  }

  /** POST /queue/:qid/cancel: the message leaves the queue; a second call, or a message already delivered, is a 409. */
  async function cancelQueued(id, qid) {
    queueId(id);
    const { out } = await queueStore.update(id, queue => {
      const next = cancelItem(queue, qid);
      return next ? { queue: next, out: { ok: true } } : { out: { gone: true } };
    });
    if (out.gone) throw fail('That message has been sent.', 409);
    return queueView(id);
  }

  /** POST /queue/send: Send now. Clears the hold and delivers, unless a turn is running: then the messages stay queued. */
  async function sendQueued(id) {
    queueId(id);
    await queueStore.update(id, queue => (queue.held ? { queue: { ...queue, held: null } } : null));
    await pump(id, { force: true });
    return queueView(id);
  }

  /** GET /live: the running turn's events, replayed from its log and then followed; one `idle` event when nothing runs. */
  function live(response, id) {
    if (!CHAT_ID.test(id)) throw fail('No such conversation.', 404);
    response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no', Connection: 'keep-alive' });
    const send = (event, value) => { if (!response.destroyed) response.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`); };
    response.flushHeaders();
    const carried = carriedOf(id);
    if (!carried) { send('idle', {}); response.end(); return undefined; }
    let keepalive = null;
    const leave = () => { clearInterval(keepalive); carried.listeners.delete(follow); response.end(); };
    function follow(event, value) { send(event, value); if (event === 'done' || event === 'error') leave(); }
    for (const entry of [...carried.log]) { send(entry.event, entry.data); if (entry.event === 'done' || entry.event === 'error') { response.end(); return undefined; } }
    carried.listeners.add(follow);
    keepalive = setInterval(() => { if (!response.destroyed) response.write(': keepalive\n\n'); }, KEEPALIVE_MS);
    response.on('close', () => { clearInterval(keepalive); carried.listeners.delete(follow); });
    return undefined;
  }

  return {
    /** Stops the sweep (shutdown, tests). A turn in flight goes on until Hermes ends it. */
    close() { clearTimeout(firstSweep); clearInterval(sweepTimer); },
    /** One pass of the restart sweep, for the tests (the timer is off when HUB_CHAT_QUEUE_SWEEP_MS is 0). */
    sweep,
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
      if (method === 'GET' && route === '/hub/chat') return json(response, 200, { conversations: await list(), models: chatModelsForClient(), personas: chatPersonasForClient(await tableNow()), chain: CHAT_CHAIN, autoFirst: await autoFirstLabel(), pauses: pausesForClient(await planPauses?.read(now()).catch(() => []) ?? [], CHAT_MODELS) });   // model: persona: pauses:
      if (method === 'GET' && (match = /^\/hub\/chat\/([^/]+)$/.exec(route))) {
        if (!CHAT_ID.test(match[1])) throw fail('No such conversation.', 404);
        const got = await fresh(`chat/${match[1]}.jsonl`);
        const turn = answering(match[1], user);
        if (!got && !turn) throw fail('No such conversation.', 404);   // a new chat has no file until its first reply is saved
        const waiting = await queueStore.read(match[1]).catch(() => readQueue(null));
        nudge(match[1], waiting);
        return json(response, 200, { id: match[1], messages: got ? currentModels(await withDelegateResults(match[1], got)) : [], ...viewOf(waiting), ...(turn ?? {}) });
      }
      if (method === 'GET' && (match = /^\/hub\/chat\/([^/]+)\/live$/.exec(route))) return live(response, match[1]);
      if (method === 'POST' && (match = /^\/hub\/chat\/([^/]+)\/queue$/.exec(route))) return json(response, 201, await queueMessage(match[1], await readJson(request, 64 * 1024), user));
      if (method === 'POST' && (match = /^\/hub\/chat\/([^/]+)\/queue\/([^/]+)\/cancel$/.exec(route))) return json(response, 200, await cancelQueued(match[1], match[2]));
      if (method === 'POST' && (match = /^\/hub\/chat\/([^/]+)\/queue\/send$/.exec(route))) return json(response, 200, await sendQueued(match[1]));
      if (method === 'GET' && (match = /^\/hub\/chat\/([^/]+)\/images\/([^/]+)$/.exec(route))) return serveImage(response, match[1], match[2]);
      if (method === 'POST' && route === '/hub/chat') return relay(request, response, user);
      if (method === 'POST' && route === '/hub/chat/stop') {
        const data = await readJson(request, 4096);
        const run = typeof data.run === 'string' ? data.run : '';
        const carried = carriedByRun(run);
        if (!carried || carried.ending || carried.user !== (user ?? null)) throw fail('No such reply is running.', 404);   // a reply that has ended has nothing to stop
        carried.stopAsked = true;
        await hermesRuns.stop(run).catch(() => {});
        return json(response, 200, { stopped: true });
      }
      throw fail('Not found', 404);
    },
  };
}
