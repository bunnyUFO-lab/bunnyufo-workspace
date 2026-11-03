// "Not useful": the owner marks a Needs you item as noise and says why. The Hub keeps one record per item, which a
// session later files as a bug in the project that raised the item. Pure helpers; the route is in hub.mjs.
import { createHash } from 'node:crypto';
import { maskSecrets } from './hub-mask.mjs';

/** The project a record lands in when its row has none: the Hub's own, where Needs you is built. */
export const FEEDBACK_HOME = 'workspace-app';
/** The kinds of Needs you item that carry the button. Approvals and run questions keep Decline or an answer. */
export const FEEDBACK_KINDS = ['ask', 'checklist', 'review', 'blocked'];
/** Ask ids, checklist ids and event file names. */
export const FEEDBACK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
export const REASON_MAX = 200;
export const PRESETS = {
  'nothing-to-decide': 'Nothing to decide',
  'too-long': 'Too long',
  unclear: 'Unclear what to do',
  'already-done': 'Already done',
};
/** The most JSON bytes a record may hold; over it, `copy.raw` goes first. */
export const RECORD_MAX = 16 * 1024;
const STRING_MAX = 2000;
const ARRAY_MAX = 20;
const KEYS_MAX = 60;
const DEPTH_MAX = 5;

const clip = (value, length) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, length);

/** The body of the press: an optional preset id and an optional one-line note. Throws with a message for the owner. */
export function checkNotUseful(raw) {
  const body = raw === undefined || raw === null ? {} : raw;
  if (typeof body !== 'object' || Array.isArray(body)) throw new Error('Send { preset, note }.');
  let preset;
  if (body.preset !== undefined && body.preset !== null && body.preset !== '') {
    if (typeof body.preset !== 'string' || !Object.prototype.hasOwnProperty.call(PRESETS, body.preset)) throw new Error(`The reason is one of: ${Object.keys(PRESETS).join(', ')}.`);
    preset = body.preset;
  }
  let note;
  if (body.note !== undefined && body.note !== null) {
    if (typeof body.note !== 'string') throw new Error('The note is text.');
    const folded = body.note.replace(/\s+/g, ' ').trim();
    if (folded.length > REASON_MAX) throw new Error(`The note is at most ${REASON_MAX} characters.`);
    if (folded) note = folded;
  }
  return { ...(preset ? { preset } : {}), ...(note ? { note } : {}) };
}

/** The short handle of one item in one project: 8 hex of sha256("<project>/<kind>/<id>"). */
export const feedbackKey = (project, kind, id) => createHash('sha256').update(`${project}/${kind}/${id}`).digest('hex').slice(0, 8);

/** The chip label, then " · note" when both. */
export const reasonTextOf = ({ preset, note } = {}) => [preset ? PRESETS[preset] : '', note ?? ''].filter(Boolean).join(' · ');

/** The id the record is filed under: a blocked row is closed by its event file, the others by their own id. */
export const feedbackIdOf = row => String(row.kind === 'blocked' ? row.file ?? row.id : row.id);

/** The path of a record, relative to the inbox. */
export const recordPath = (project, kind, id) => `feedback/${project}/${kind}/${id}/not-useful.json`;

/** An Ask the session hook wrote for a question Claude asked (hub-hooks' remote question), as opposed to one an agent made with `cards ask create`. */
export function isRemoteQuestion(ask) {
  if (!ask || typeof ask !== 'object') return false;
  const head = typeof ask.context === 'string' ? ask.context.split('\n')[0] : '';
  return ask.from?.tool === 'claude-code' && typeof ask.from?.session === 'string' && ask.from.session !== ''
    && ask.kind === 'decision' && / asked by .+ in .+ on .+/.test(head);
}

const HOOK_SOURCES = new Set(['dev-sprint', 'hub-hooks', 'hub-events']);

/** Who raised the item: `hook`, `agent`, `session` or `unknown`, with the fields that say where. */
export function sourceOf(row, raw, writer) {
  const kind = row?.kind;
  const eventSource = typeof raw?.source === 'string' ? clip(raw.source, 40) : undefined;
  let by = 'unknown';
  if (kind === 'review') by = eventSource && (HOOK_SOURCES.has(eventSource) || eventSource.endsWith('-hooks')) ? 'hook' : 'agent';
  else if (kind === 'blocked') by = 'session';
  else if (kind === 'ask') by = isRemoteQuestion(raw) ? 'session' : 'agent';
  else if (kind === 'checklist') by = 'agent';
  const text = (value, length) => (typeof value === 'string' && value.trim() ? maskSecrets(clip(value, length)) : undefined);
  const fields = {
    host: text(row?.host, 80), session: text(row?.session, 80), tool: text(row?.tool, 40),
    eventSource: kind === 'review' || kind === 'blocked' ? text(eventSource, 40) : undefined,
    writer: text(writer, 40),
  };
  return { by, ...Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) };
}

// Keys that hold an answer, a tick, evidence or a picture, and values that are presigned or inline data: never copied.
const DROP_KEYS = new Set(['image', 'images', 'evidence', 'shots', 'screenshots', 'answer', 'answers', 'ticks', 'drawing', 'thumbnail', 'thumb']);
const SIGNED_RE = /X-Amz-|[?&](?:Signature|Expires|AWSAccessKeyId)=|^data:/i;

/** A copy of `value` that fits a record: strings masked then clipped at 2,000, arrays at 20 entries, objects at 60 keys, depth 5. */
export function capCopy(value, depth = 0) {
  if (typeof value === 'string') return SIGNED_RE.test(value) ? '[removed]' : maskSecrets(value).slice(0, STRING_MAX);
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (depth >= DEPTH_MAX) return '[cut]';
  if (Array.isArray(value)) return value.slice(0, ARRAY_MAX).map(entry => capCopy(entry, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [name, entry] of Object.entries(value).slice(0, KEYS_MAX)) {
      if (DROP_KEYS.has(name) || entry === undefined || typeof entry === 'function') continue;
      out[maskSecrets(name).slice(0, 80)] = capCopy(entry, depth + 1);
    }
    return out;
  }
  return undefined;
}

const bytes = value => Buffer.byteLength(JSON.stringify(value));

/**
 * The record the Hub stores when the owner presses Not useful. `row` is the Needs you row, `raw` the source object
 * (the cleaned Ask, the checklist, or the event), `writer` the stored writer mark of the source when the loader has it.
 */
export function notUsefulRecord({ row, raw, writer, project, preset, note, user, at }) {
  const kind = row.kind;
  const id = feedbackIdOf(row);
  const reasonText = reasonTextOf({ preset, note });
  const url = typeof row.url === 'string' && row.url ? row.url : Array.isArray(row.prs) && typeof row.prs[0] === 'string' ? row.prs[0] : undefined;
  const base = {
    v: 1, project, item: { kind, id }, key: feedbackKey(project, kind, id), at: at.toISOString(), by: user,
    reason: { ...(preset ? { preset } : {}), ...(note ? { note } : {}) },
    reasonText,
    title: maskSecrets(clip(row.title, 200)),
    ...(typeof row.bead === 'string' && row.bead ? { bead: clip(row.bead, 80) } : {}),
    ...(url ? { url: capCopy(url) } : {}),
    source: sourceOf(row, raw, writer),
  };
  const copyRow = capCopy(row);
  let record = { ...base, copy: { row: copyRow, raw: capCopy(raw) } };
  if (bytes(record) > RECORD_MAX) record = { ...base, copy: { row: copyRow }, truncated: true };
  if (bytes(record) > RECORD_MAX) record = { ...base, copy: { row: { kind, id, title: base.title } }, truncated: true };
  return record;
}
