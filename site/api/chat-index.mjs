// The message search index, in memory in the Hub process (ws-cl0.6.7). No file, no timer, nothing at chat open.
//
// It holds, per chat, `{ listed, etag, at, title, persona, lines: [{ i, at, text, lower }] }`. A search does one LIST of
// `chat/`, compares etags and reads only the transcripts that changed, through one load in flight that a second search joins.
// The first search after a restart reads every transcript once: it waits `warmMs` (8 s), then answers with what it has and
// `warming: true` while the load goes on. Only user and assistant text is held (no context lines, no tool output), pictures are
// stripped, each message is cut at 4000 characters, and the whole is capped at `maxBytes` (32 MB): past that the oldest chats are
// left out and the answer says `partial: true`. Drop the index and it rebuilds; nothing is lost with it.
//
// `readState` is the seam for the chat's own state (ws-cl0.6.6, `chat/state.json`): an async function returning `{ chats: { <id>:
// { title?, archived?, trashed? } } }`. A trashed chat is left out, an archived one is marked, a rename wins over the derived title.
// Without it every chat is plain.
import { stripInlineImages } from './inline-images.mjs';
import { HELP_KINDS } from './hub-help.mjs';

const ID = /^\d{8}-[a-z0-9]{6}$/;
export const MAX_MESSAGE = 4000;
export const MAX_BYTES = 32 * 1024 * 1024;
export const WARM_MS = 8000;
export const PER_CHAT = 3;
const SNIPPET = 80;

const clip = (value, length) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, length);

/** The words of a query, lower case. Every one must be in a message. */
export const searchWords = q => String(q ?? '').toLowerCase().split(/\s+/).filter(Boolean);

/** About 80 characters of `text` around the first occurrence of `word`, with an ellipsis where it was cut. */
export function snippetOf(text, word) {
  const at = Math.max(0, text.toLowerCase().indexOf(word));
  if (text.length <= SNIPPET) return text;
  const start = Math.max(0, Math.min(at - 25, text.length - SNIPPET));
  const end = Math.min(text.length, start + SNIPPET);
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}

const parse = text => String(text ?? '').split(/\r?\n/).filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);

/** The title the chat list derives (hub-chat.mjs `list`): a help chat's, else the first thing the owner said. */
function titleOf(lines) {
  const first = lines.find(line => line.role === 'user');
  const about = lines[0]?.role === 'context' && lines[0].about && HELP_KINDS.includes(lines[0].about.kind) && typeof lines[0].about.title === 'string' ? lines[0].about : null;
  return about ? clip(`Help: ${about.title}`, 60) : clip(first?.text, 60) || (first ? 'Picture' : 'New chat');
}

/** What is kept of one transcript. `i` is the index in the stored lines, which is the index the page gets from GET /hub/chat/<id>. */
function entryOf(text, got, listed, at) {
  const lines = parse(text);
  const kept = [];
  let bytes = 0;
  lines.forEach((line, i) => {
    if (!line || (line.role !== 'user' && line.role !== 'assistant') || typeof line.text !== 'string') return;
    const body = clip(stripInlineImages(line.text), MAX_MESSAGE);
    if (!body) return;
    const lower = body.toLowerCase();
    kept.push({ i, at: typeof line.at === 'string' ? line.at : null, text: body, lower });
    bytes += (body.length + lower.length) * 2;
  });
  const persona = lines.find(line => typeof line.persona === 'string' && line.persona)?.persona ?? null;
  const title = titleOf(lines);
  bytes += (title.length + 64) * 2;
  return { listed, etag: got, at, title, persona, lines: kept, bytes };
}

export function createChatIndex({ bucket, key, fresh, pool, readState = null, maxBytes = MAX_BYTES, warmMs = WARM_MS }) {
  /** id -> entry */
  const entries = new Map();
  /** id -> the list etag of a chat left out for size, so the next load does not read it again. */
  const left = new Map();
  let loading = null;
  let partial = false;
  let total = 0;
  const prefix = key('chat/x.jsonl').slice(0, -'x.jsonl'.length);

  /** One pass: list, read what changed, forget what is gone, then drop the oldest chats past the cap. */
  async function load() {
    const { objects } = await bucket.list(prefix);
    const chats = [];
    for (const object of objects) {
      if (!object.key.startsWith(prefix) || !object.key.endsWith('.jsonl')) continue;
      const id = object.key.slice(prefix.length, -'.jsonl'.length);
      if (ID.test(id)) chats.push({ id, etag: object.etag, at: Date.parse(object.lastModified) || 0 });
    }
    chats.sort((a, b) => (b.at - a.at) || (a.id < b.id ? 1 : -1));
    const alive = new Set(chats.map(chat => chat.id));
    for (const id of [...entries.keys()]) if (!alive.has(id)) { total -= entries.get(id).bytes; entries.delete(id); }
    for (const id of [...left.keys()]) if (!alive.has(id)) left.delete(id);

    const changed = [];
    let dropped = false;
    for (const chat of chats) {
      const had = entries.get(chat.id);
      if (had && (had.listed === chat.etag || had.etag === chat.etag)) continue;
      if (left.get(chat.id) === chat.etag) { dropped = true; continue; }
      changed.push(chat);
    }
    const sized = await pool(6, changed, async chat => {
      const got = await fresh(`chat/${chat.id}.jsonl`);
      return { chat, entry: got ? entryOf(got.text, got.etag, chat.etag, chat.at) : null };
    });
    for (const { chat, entry } of sized) {
      const old = entries.get(chat.id);
      if (old) { total -= old.bytes; entries.delete(chat.id); }
      if (entry) { entries.set(chat.id, entry); total += entry.bytes; }
    }
    // Over the cap: drop the oldest until it fits.
    const order = chats.filter(chat => entries.has(chat.id));
    while (total > maxBytes && order.length) {
      const oldest = order.pop();
      total -= entries.get(oldest.id).bytes;
      entries.delete(oldest.id);
      left.set(oldest.id, oldest.etag);
      dropped = true;
    }
    partial = dropped;
  }

  /** The load in flight, started if none is. A failure is not kept: the next search tries again. */
  const sync = () => {
    if (!loading) loading = load().finally(() => { loading = null; });
    return loading;
  };

  /** `{ hits, warming?, partial? }`. Needs `q`'s words already checked by the caller (2 to 200 characters). */
  async function search({ q, limit = 50 }) {
    const words = searchWords(q);
    const cap = Math.max(1, Math.min(Number(limit) || 50, 50));
    let warming = false;
    const started = sync();
    started.catch(() => {});
    let timer;
    const outcome = await Promise.race([started.then(() => 'done'), new Promise(resolve => { timer = setTimeout(() => resolve('slow'), warmMs); })]);
    clearTimeout(timer);
    if (outcome === 'slow') warming = true;
    const state = (await readState?.().catch(() => null))?.chats ?? {};
    const ranked = [...entries].sort((a, b) => (b[1].at - a[1].at) || (a[0] < b[0] ? 1 : -1));
    const hits = [];
    for (const [id, entry] of ranked) {
      const mark = state[id];
      if (mark?.trashed) continue;
      let found = 0;
      for (let n = entry.lines.length - 1; n >= 0 && found < PER_CHAT && hits.length < cap; n -= 1) {
        const line = entry.lines[n];
        if (!words.every(word => line.lower.includes(word))) continue;
        found += 1;
        hits.push({ chat: id, title: clip(mark?.title, 120) || entry.title, persona: entry.persona, line: line.i, at: line.at, snippet: snippetOf(line.text, words[0]), archived: !!mark?.archived });
      }
      if (hits.length >= cap) break;
    }
    return { hits, ...(warming ? { warming: true } : {}), ...(partial ? { partial: true } : {}) };
  }

  return { search, stats: () => ({ chats: entries.size, bytes: total }) };
}
