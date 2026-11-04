// The owner's edits of a chat persona (ws-im1.4.1): the role line, the prompt and the chat's default model of Researcher, Market
// researcher, Teardown and Planner. A persona is a prompt on Hermes `main` that the Hub sends as the first line of each turn; nothing
// here touches the Hermes host.
//
// Storage is the avatar pattern: create-only `team/<agent>/persona-<stamp>-<rand4>.json`, written by the Hub only (owner-only in the
// card API, and a file with a `writer` mark is ignored here as a second guard). Newest valid name wins. A version is a whole
// snapshot, never a delta: `{ v: 1, role, prompt, model, at, by, note?, revertOf?, fromAsk? }`, or `{ v: 1, default: true, at, by, revertOf? }`
// ("follow the app's text again"). The synthetic version `default` is always in the list. Nothing is ever deleted.
import { CHAT_MODELS } from './chat-models.mjs';
import { CHAT_PERSONAS } from './chat-personas.mjs';
import { redactSecrets } from './hub-agent-config.mjs';
import { markStamp, randomId } from './hub-model.mjs';

export const PERSONA_FILE_RE = /^persona-\d{8}T\d{6,9}Z-[A-Za-z0-9]{4}\.json$/;
/** The id of a stored version: its file name without `.json`. `default` is the app's own text. */
export const VERSION_ID_RE = /^persona-\d{8}T\d{6,9}Z-[A-Za-z0-9]{4}$/;
export const PERSONA_LIMITS = { role: 200, prompt: 8000, note: 200 };
export const VERSIONS_SHOWN = 50;
const TABLE_TTL_MS = 30000;
const KEYS = ['role', 'prompt', 'model', 'note', 'base'];
/** Named in a body, these are refused with a 403: they are the owner's decision to keep view-only. */
export const VIEW_ONLY = ['toolsets', 'platformToolsets', 'skills', 'soul', 'cron', 'jobs', 'terminal', 'fallbacks', 'provider'];
export const VIEW_ONLY_MESSAGE = 'Toolsets, skills, SOUL.md and scheduled jobs are view-only.';

const problem = (message, status = 400) => Object.assign(new Error(message), { status });
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
// Tab and newline are allowed in a prompt; no other control character, and no line or paragraph separator.
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\p{Zl}\p{Zp}]/u;
const LINE_CONTROL = /[\x00-\x1f\x7f\p{Zl}\p{Zp}]/u;
const SECRET_MESSAGE = 'That text looks like a secret (a key or a long unbroken string). Reword it so the prompt holds none.';

/** Names a view-only key in a body, or ''. */
export function viewOnlyKey(raw) {
  return isObject(raw) ? VIEW_ONLY.find(name => Object.hasOwn(raw, name)) ?? '' : '';
}

/**
 * A clean edit from a request body: `{ role, prompt, model, note?, base }`. Throws an error with `status`: 403 for a view-only key,
 * 400 for anything else wrong (every unknown key, a length, a control character, an unlisted model, a text that looks like a secret).
 */
export function checkPersonaEdit(raw) {
  if (!isObject(raw)) throw problem('Send the role, prompt and model as a JSON object.');
  if (viewOnlyKey(raw)) throw problem(VIEW_ONLY_MESSAGE, 403);
  const extra = Object.keys(raw).filter(name => !KEYS.includes(name));
  if (extra.length) throw problem(`A persona has no field ${extra.slice(0, 3).join(', ')}.`);
  const text = (name, label, max, { required = true, multiline = false } = {}) => {
    const value = raw[name];
    if (value === undefined && !required) return undefined;
    if (typeof value !== 'string') throw problem(`${label} is text.`);
    const clean = value.replace(/\r\n?/g, '\n').trim();
    if (required && !clean) throw problem(`${label} cannot be empty.`);
    if (clean.length > max) throw problem(`${label} is at most ${max} characters.`);
    if ((multiline ? CONTROL : LINE_CONTROL).test(clean)) throw problem(`${label} has a control character.`);
    if (redactSecrets(clean).count > 0) throw problem(SECRET_MESSAGE);
    return clean;
  };
  const role = text('role', 'The role line', PERSONA_LIMITS.role);
  const prompt = text('prompt', 'The prompt', PERSONA_LIMITS.prompt, { multiline: true });
  if (typeof raw.model !== 'string' || !CHAT_MODELS.some(entry => entry.id === raw.model)) throw problem('That chat model is not in the list.');
  const note = text('note', 'The note', PERSONA_LIMITS.note, { required: false });
  if (typeof raw.base !== 'string' || !(raw.base === 'default' || VERSION_ID_RE.test(raw.base))) throw problem('Say which version you were looking at (base).');
  return { role, prompt, model: raw.model, ...(note ? { note } : {}), base: raw.base };
}

/**
 * A role change on a prompt that was not edited by hand: the old role line, as it stands in the prompt's first line, becomes the new one,
 * once. A prompt that does not hold the old role in its first line is returned as it is.
 */
export function syncRole(prompt, oldRole, newRole) {
  if (!oldRole || oldRole === newRole) return prompt;
  const end = prompt.indexOf('\n');
  const first = end === -1 ? prompt : prompt.slice(0, end);
  const at = first.indexOf(oldRole);
  if (at === -1) return prompt;
  return `${first.slice(0, at)}${newRole}${first.slice(at + oldRole.length)}${end === -1 ? '' : prompt.slice(end)}`;
}

/** A stored object as a version, or null: the shape, the limits and a listed model are checked. `at` and `by` are text. */
function readVersion(value) {
  if (!isObject(value) || value.v !== 1) return null;
  const common = {
    at: typeof value.at === 'string' ? value.at : '', by: typeof value.by === 'string' ? value.by.slice(0, 80) : '',
    ...(typeof value.revertOf === 'string' && (value.revertOf === 'default' || VERSION_ID_RE.test(value.revertOf)) ? { revertOf: value.revertOf } : {}),
  };
  if (value.default === true) return { ...common, default: true };
  const { role, prompt, model } = value;
  if (typeof role !== 'string' || !role.trim() || role.length > PERSONA_LIMITS.role) return null;
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > PERSONA_LIMITS.prompt) return null;
  if (!CHAT_MODELS.some(entry => entry.id === model)) return null;
  return {
    ...common, role, prompt, model,
    ...(typeof value.note === 'string' && value.note ? { note: value.note.slice(0, PERSONA_LIMITS.note) } : {}),
    ...(typeof value.fromAsk === 'string' && value.fromAsk ? { fromAsk: value.fromAsk.slice(0, 120) } : {}),
  };
}

/**
 * The persona a chat uses: the app's entry, or the newest version's role, prompt and model on top of it. `version` is a `readVersion`
 * result with its `id`, or null; a `default` version means the app's own text. An edited one carries `edited: { id, at, by, note? }`.
 */
export function effectivePersona(defaultEntry, version) {
  if (!version || version.default) return defaultEntry;
  return {
    ...defaultEntry, role: version.role, model: version.model, text: version.prompt,
    edited: { id: version.id, at: version.at, by: version.by, ...(version.note ? { note: version.note } : {}) },
  };
}

/**
 * @param bucket       the Hub's S3 bucket (`list`, `head`, `getText`)
 * @param key          `rel → bucket key` of the inbox; `folder` the same for a folder with no file name
 * @param putCreateOnly  `(rel, body, contentType, conflict, metadata?)`; throws `conflict` when the name is taken
 * @param defaults     the app's persona table (CHAT_PERSONAS)
 */
export function createPersonaStore({ bucket, key, folder, putCreateOnly, fail = problem, now = () => new Date(), defaults = CHAT_PERSONAS }) {
  /** Create-only files never change: whether a name is a valid, unmarked version is remembered. */
  const seen = new Map();
  let cache = null;
  const forget = () => { cache = null; };

  async function names(agentId) {
    const base = folder(`team/${agentId}`);
    const { objects } = await bucket.list(base);
    return objects.map(object => object.key.slice(base.length)).filter(name => PERSONA_FILE_RE.test(name)).sort().reverse();
  }

  /** A version by file name, or null (missing, not JSON, malformed, or a file with a `writer` mark: not the Hub's own). */
  async function read(agentId, name) {
    const id = name.slice(0, -'.json'.length);
    const marker = `${agentId}/${name}`;
    if (seen.has(marker)) return seen.get(marker);
    let version = null;
    try {
      const head = await bucket.head(key(`team/${agentId}/${name}`));
      if (!head?.metadata?.writer) {
        const got = await bucket.getText(key(`team/${agentId}/${name}`));
        const parsed = got ? readVersion(JSON.parse(got.text)) : null;
        if (parsed) version = { id, ...parsed };
      }
    } catch (error) {
      if (error.status === 404 || error instanceof SyntaxError) version = null;
      else throw error;
    }
    seen.set(marker, version);
    return version;
  }

  /** The newest valid versions of an agent, newest first, at most `limit`. */
  async function valid(agentId, limit) {
    const found = [];
    for (const name of await names(agentId)) {
      const version = await read(agentId, name);
      if (version) found.push(version);
      if (found.length >= limit) break;
    }
    return found;
  }

  const entryOf = id => defaults.find(entry => entry.id === id);
  const need = id => {
    const entry = entryOf(id);
    if (!entry) throw fail('No such persona.', 404);
    return entry;
  };

  /** The effective table: the app's entries with the newest valid version applied. Cached for 30 seconds in the process, cleared on a write. */
  async function table() {
    const at = now().getTime();
    if (cache && at - cache.at < TABLE_TTL_MS) return cache.table;
    const out = await Promise.all(defaults.map(async entry => effectivePersona(entry, (await valid(entry.id, 1))[0] ?? null)));
    cache = { at, table: out };
    return out;
  }

  const rowOf = (entry, version) => ({
    id: version.id, at: version.at, by: version.by,
    ...(version.default ? { default: true } : { role: version.role, prompt: version.prompt, model: version.model }),
    ...(version.note ? { note: version.note } : {}), ...(version.revertOf ? { revertOf: version.revertOf } : {}), ...(version.fromAsk ? { fromAsk: version.fromAsk } : {}),
    ...(version.default ? { role: entry.role, prompt: entry.text, model: entry.model } : {}),
  });

  /** What the Edit page shows: the current text, the app's text, the versions (newest 50, with the app's own text last) and the models. */
  async function versions(agentId) {
    const entry = need(agentId);
    const list = await valid(agentId, VERSIONS_SHOWN);
    const rows = [...list.map(version => rowOf(entry, version)), { id: 'default', default: true, role: entry.role, prompt: entry.text, model: entry.model, at: '', by: '' }];
    const newest = rows[0];
    return {
      current: { version: newest.id, role: newest.role, prompt: newest.prompt, model: newest.model },
      default: { role: entry.role, prompt: entry.text, model: entry.model },
      versions: rows,
      models: CHAT_MODELS.map(({ id, label, note }) => ({ id, label, note })),
    };
  }

  async function write(agentId, body, at) {
    const conflict = fail('Try again.', 409);
    for (let attempt = 0; ; attempt += 1) {
      const id = `persona-${markStamp(at)}-${randomId(4)}`;
      try {
        await putCreateOnly(`team/${agentId}/${id}.json`, `${JSON.stringify(body, null, 2)}\n`, 'application/json', conflict);
        forget();
        return id;
      } catch (error) {
        if (error !== conflict || attempt >= 2) throw error;
      }
    }
  }

  const STALE = 'This persona changed while you were looking.';
  async function current(agentId) {
    return (await valid(agentId, 1))[0] ?? null;
  }
  const idOf = version => version?.id ?? 'default';

  /** Saves an edit as a new version. `base` must be the version the page showed. `extra` may carry `fromAsk`. */
  async function save(agentId, raw, user, at, extra = {}) {
    const entry = need(agentId);
    const edit = checkPersonaEdit(raw);
    const newest = await current(agentId);
    if (edit.base !== idOf(newest)) throw fail(STALE, 409);
    const was = effectivePersona(entry, newest);
    let prompt = edit.prompt;
    // The role line is the one thing the prompt's first line repeats: a role change with the prompt left alone carries it into the prompt.
    if (prompt === was.text.trim() && edit.role !== was.role) prompt = syncRole(prompt, was.role, edit.role);
    if (prompt === was.text.trim() && edit.role === was.role && edit.model === was.model) throw fail('Nothing changed.', 400);
    const at$ = at.toISOString();
    const id = await write(agentId, {
      v: 1, role: edit.role, prompt, model: edit.model, at: at$, by: user || 'local',
      ...(edit.note ? { note: edit.note } : {}), ...(extra.fromAsk ? { fromAsk: extra.fromAsk } : {}),
    }, at);
    return { ok: true, version: id, ...(await versions(agentId)) };
  }

  /** Writes a new version that copies the chosen one (`to`: a version id or `default`), with `revertOf`. */
  async function revert(agentId, { to, base } = {}, user, at) {
    need(agentId);
    if (typeof to !== 'string' || !(to === 'default' || VERSION_ID_RE.test(to))) throw fail('Say which version to go back to.', 400);
    if (typeof base !== 'string' || !(base === 'default' || VERSION_ID_RE.test(base))) throw fail('Say which version you were looking at (base).', 400);
    const newest = await current(agentId);
    if (base !== idOf(newest)) throw fail(STALE, 409);
    if (to === idOf(newest)) throw fail('That version is the current one.', 400);
    const target = to === 'default' ? { default: true } : await read(agentId, `${to}.json`);
    if (!target) throw fail('No such version.', 404);
    const stamp = { at: at.toISOString(), by: user || 'local', revertOf: to };
    const body = target.default
      ? { v: 1, default: true, ...stamp }
      : { v: 1, role: target.role, prompt: target.prompt, model: target.model, ...stamp, ...(target.note ? { note: target.note } : {}) };
    const id = await write(agentId, body, at);
    return { ok: true, version: id, ...(await versions(agentId)) };
  }

  return { table, versions, save, revert, current: async agentId => idOf(await current(agentId)), forget };
}
