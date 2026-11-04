// The owner's edits of a chat persona (ws-im1.4.1): the role line, the prompt and the chat's default model of Researcher, Market
// researcher, Teardown and Planner. A persona is a prompt on Hermes `main` that the Hub sends as the first line of each turn; nothing
// here touches the Hermes host.
//
// Storage is the avatar pattern: create-only `team/<agent>/persona-<stamp>-<rand4>.json`, written by the Hub only (owner-only in the
// card API, and a file with a `writer` mark is ignored here as a second guard). Newest valid name wins. A version is a whole
// snapshot, never a delta: `{ v: 1, role, prompt, model, at, by, note?, revertOf?, fromAsk? }`, or `{ v: 1, default: true, at, by, revertOf? }`
// ("follow the app's text again"). The synthetic version `default` is always in the list. Nothing is ever deleted.
//
// A persona the owner made from a template (ws-im1.4.3) is the same files in a folder `team/<id>/` that is no agent of the app: every version
// also carries `name` and `template`, the first one `created: true`, and a retired persona's newest version is `{ v: 1, retired: true, name, at, by }`.
// Bringing it back is a Revert to an earlier version. A made persona has no app text, so it has no `default` row. A folder with an avatar and no
// readable named version is no persona.
import { CHAT_MODELS } from './chat-models.mjs';
import { CHAT_PERSONAS, PERSONA_TEMPLATES } from './chat-personas.mjs';
import { redactSecrets } from './hub-agent-config.mjs';
import { markStamp, randomId } from './hub-model.mjs';
import { AGENTS } from './hub-team.mjs';

export const PERSONA_FILE_RE = /^persona-\d{8}T\d{6,9}Z-[A-Za-z0-9]{4}\.json$/;
/** The id of a stored version: its file name without `.json`. `default` is the app's own text. */
export const VERSION_ID_RE = /^persona-\d{8}T\d{6,9}Z-[A-Za-z0-9]{4}$/;
export const PERSONA_LIMITS = { role: 200, prompt: 8000, note: 200 };
export const VERSIONS_SHOWN = 50;
const TABLE_TTL_MS = 30000;
/** Ids a made persona may not take besides every AGENTS id: `new` and `templates` are routes under /hub/team/. One list for the route and its test. */
export const RESERVED_PERSONA_IDS = ['hermes', 'new', 'templates'];
export const MAX_MADE_PERSONAS = 20;
export const PERSONA_ID_RE = /^[a-z][a-z0-9-]{0,39}$/;
const NAME_RE = /^(?=.*[A-Za-z0-9])[A-Za-z0-9 ]{1,40}$/;
const NEW_KEYS = ['template', 'name', 'role'];
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
  const name = typeof value.name === 'string' && value.name === value.name.trim() && NAME_RE.test(value.name) ? value.name : '';
  const template = typeof value.template === 'string' && /^[a-z][a-z0-9-]{0,19}$/.test(value.template) ? value.template : '';
  if (value.retired === true) return name ? { ...common, retired: true, name } : null;
  if (value.default === true) return { ...common, default: true };
  const { role, prompt, model } = value;
  if (typeof role !== 'string' || !role.trim() || role.length > PERSONA_LIMITS.role) return null;
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > PERSONA_LIMITS.prompt) return null;
  if (!CHAT_MODELS.some(entry => entry.id === model)) return null;
  return {
    ...common, role, prompt, model,
    ...(name ? { name } : {}), ...(template ? { template } : {}), ...(value.created === true ? { created: true } : {}),
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

/** The name of a new persona from a body: 1 to 40 letters, digits and spaces, kept as typed (spaces trimmed and squeezed). */
export function checkPersonaName(value) {
  if (typeof value !== 'string') throw problem('The name is text.');
  const clean = value.replace(/\s+/g, ' ').trim();
  if (!clean) throw problem('Give the persona a name.');
  if (!NAME_RE.test(clean)) throw problem('A name is 1 to 40 letters, digits and spaces.');
  return clean;
}

/** The id a name makes: lower case, spaces as hyphens. Not yet checked against the id rules or the taken ones. */
export const personaIdOf = name => name.toLowerCase().replace(/ /g, '-');

/** The persona a made folder gives: the newest version that is not a retirement, with the newest one's name and state. `list` is newest first. */
function madeEntry(id, list) {
  const newest = list[0];
  const live = list.find(version => !version.retired);
  if (!newest?.name || !live) return null;
  return {
    id, name: newest.name, role: live.role, model: live.model, text: live.prompt, template: live.template ?? '', custom: true,
    ...(newest.retired ? { retired: true } : {}),
    ...(live.created ? {} : { edited: { id: live.id, at: live.at, by: live.by, ...(live.note ? { note: live.note } : {}) } }),
  };
}

/**
 * @param bucket       the Hub's S3 bucket (`list`, `head`, `getText`)
 * @param key          `rel → bucket key` of the inbox; `folder` the same for a folder with no file name
 * @param putCreateOnly  `(rel, body, contentType, conflict, metadata?)`; throws `conflict` when the name is taken
 * @param defaults     the app's persona table (CHAT_PERSONAS)
 * @param templates    the templates of a new persona (PERSONA_TEMPLATES)
 * @param reserved     ids a made persona may not take: every agent of the app, and RESERVED_PERSONA_IDS
 */
export function createPersonaStore({ bucket, key, folder, putCreateOnly, fail = problem, now = () => new Date(), defaults = CHAT_PERSONAS, templates = PERSONA_TEMPLATES, reserved = [...AGENTS.map(agent => agent.id), ...RESERVED_PERSONA_IDS] }) {
  /** Create-only files never change: whether a name is a valid, unmarked version is remembered. */
  const seen = new Map();
  let cache = null;
  const forget = () => { cache = null; };
  const taken = new Set([...reserved, ...defaults.map(entry => entry.id)]);

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
        // An agent of the app has no retirement and no name; a made persona's every version is named.
        if (parsed && defaults.some(entry => entry.id === agentId)) {
          if (!parsed.retired) {
            const { name: _name, template: _template, created: _created, ...plain } = parsed;
            version = { id, ...plain };
          }
        } else if (parsed && !taken.has(agentId) && parsed.name) version = { id, ...parsed };
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

  /** The ids of folders under `team/` that hold persona files and are no agent of the app. At most 60 are looked at. */
  async function madeIds() {
    const base = folder('team');
    const { objects } = await bucket.list(base);
    const ids = new Set();
    for (const object of objects) {
      const parts = object.key.slice(base.length).split('/');
      if (parts.length === 2 && PERSONA_ID_RE.test(parts[0]) && !taken.has(parts[0]) && PERSONA_FILE_RE.test(parts[1])) ids.add(parts[0]);
    }
    return [...ids].sort().slice(0, 60);
  }

  async function madeOf(id) {
    const first = (await valid(id, 1))[0];
    if (!first) return null;
    const list = first.retired ? await valid(id, VERSIONS_SHOWN) : [first];
    const entry = madeEntry(id, list);
    return entry ? { entry, list } : null;
  }

  const entryOf = id => defaults.find(entry => entry.id === id);
  /** Where an id's persona comes from: `{ made, entry (the app's, or the made one), newest, was (the effective persona now) }`. 404 for any other id. */
  async function resolve(id) {
    const base = entryOf(id);
    if (base) {
      const newest = (await valid(id, 1))[0] ?? null;
      return { made: false, entry: base, newest, was: effectivePersona(base, newest) };
    }
    if (typeof id !== 'string' || taken.has(id) || !PERSONA_ID_RE.test(id)) throw fail('No such persona.', 404);
    const made = await madeOf(id);
    if (!made) throw fail('No such persona.', 404);
    return { made: true, entry: made.entry, newest: made.list[0], was: made.entry };
  }

  /** The effective table: the app's entries with the newest valid version applied, then the made personas (retired ones too, marked). Cached for 30 seconds in the process, cleared on a write. */
  async function table() {
    const at = now().getTime();
    if (cache && at - cache.at < TABLE_TTL_MS) return cache.table;
    const out = await Promise.all(defaults.map(async entry => effectivePersona(entry, (await valid(entry.id, 1))[0] ?? null)));
    const made = (await Promise.all((await madeIds()).map(madeOf))).filter(Boolean).map(item => item.entry);
    const all = [...out, ...made];
    cache = { at, table: all };
    return all;
  }

  const rowOf = (entry, version) => ({
    id: version.id, at: version.at, by: version.by,
    ...(version.created ? { created: true } : {}),
    ...(version.retired ? { retired: true } : version.default ? { default: true } : { role: version.role, prompt: version.prompt, model: version.model }),
    ...(version.note ? { note: version.note } : {}), ...(version.revertOf ? { revertOf: version.revertOf } : {}), ...(version.fromAsk ? { fromAsk: version.fromAsk } : {}),
    ...(version.default ? { role: entry.role, prompt: entry.text, model: entry.model } : {}),
  });

  /** What the Edit page shows: the current text, the app's text, the versions (newest 50, with the app's own text last) and the models. A made persona has no app text. */
  async function versions(agentId) {
    const { made, entry } = await resolve(agentId);
    const models = CHAT_MODELS.map(({ id, label, note }) => ({ id, label, note }));
    const list = await valid(agentId, VERSIONS_SHOWN);
    if (made) {
      const rows = list.map(version => rowOf(entry, version));
      return {
        current: { version: rows[0].id, role: entry.role, prompt: entry.text, model: entry.model },
        default: null, custom: true, name: entry.name, ...(entry.retired ? { retired: true } : {}),
        versions: rows, models,
      };
    }
    const rows = [...list.map(version => rowOf(entry, version)), { id: 'default', default: true, role: entry.role, prompt: entry.text, model: entry.model, at: '', by: '' }];
    const newest = rows[0];
    return {
      current: { version: newest.id, role: newest.role, prompt: newest.prompt, model: newest.model },
      default: { role: entry.role, prompt: entry.text, model: entry.model },
      versions: rows,
      models,
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
  const RETIRED = 'This persona is retired. Bring it back first.';
  const idOf = version => version?.id ?? 'default';

  /** Saves an edit as a new version. `base` must be the version the page showed. `extra` may carry `fromAsk`. */
  async function save(agentId, raw, user, at, extra = {}) {
    const { made, newest, was } = await resolve(agentId);
    const edit = checkPersonaEdit(raw);
    if (made && newest.retired) throw fail(RETIRED, 409);
    if (edit.base !== idOf(newest)) throw fail(STALE, 409);
    let prompt = edit.prompt;
    // The role line is the one thing the prompt's first line repeats: a role change with the prompt left alone carries it into the prompt.
    if (prompt === was.text.trim() && edit.role !== was.role) prompt = syncRole(prompt, was.role, edit.role);
    if (prompt.length > PERSONA_LIMITS.prompt) throw fail(`The prompt is at most ${PERSONA_LIMITS.prompt} characters, and the new role line makes it longer. Shorten the role or the prompt.`, 400);
    if (prompt === was.text.trim() && edit.role === was.role && edit.model === was.model) throw fail('Nothing changed.', 400);
    const at$ = at.toISOString();
    const id = await write(agentId, {
      v: 1, role: edit.role, prompt, model: edit.model, ...(made ? { name: was.name, template: was.template } : {}), at: at$, by: user || 'local',
      ...(edit.note ? { note: edit.note } : {}), ...(extra.fromAsk ? { fromAsk: extra.fromAsk } : {}),
    }, at);
    return { ok: true, version: id, ...(await versions(agentId)) };
  }

  /** Writes a new version that copies the chosen one (`to`: a version id or `default`), with `revertOf`. */
  async function revert(agentId, { to, base } = {}, user, at) {
    const { made, newest, was } = await resolve(agentId);
    const stray = Object.keys(arguments[1] ?? {}).filter(name => name !== 'to' && name !== 'base');
    if (stray.length) throw fail(`A revert takes only to and base, not ${stray.slice(0, 3).join(', ')}.`, 400);
    if (typeof to !== 'string' || !(to === 'default' || VERSION_ID_RE.test(to))) throw fail('Say which version to go back to.', 400);
    if (typeof base !== 'string' || !(base === 'default' || VERSION_ID_RE.test(base))) throw fail('Say which version you were looking at (base).', 400);
    if (base !== idOf(newest)) throw fail(STALE, 409);
    if (to === idOf(newest)) throw fail('That version is the current one.', 400);
    if (made && to === 'default') throw fail('A persona you made has no app text to go back to.', 400);
    const target = to === 'default' ? { default: true } : await read(agentId, `${to}.json`);
    if (!target) throw fail('No such version.', 404);
    if (target.retired) throw fail('That version is the retirement. Pick an earlier one.', 400);
    const stamp = { at: at.toISOString(), by: user || 'local', revertOf: to };
    const body = target.default
      ? { v: 1, default: true, ...stamp }
      : { v: 1, role: target.role, prompt: target.prompt, model: target.model, ...(made ? { name: was.name, template: target.template ?? was.template } : {}), ...stamp, ...(target.note ? { note: target.note } : {}) };
    const id = await write(agentId, body, at);
    return { ok: true, version: id, ...(await versions(agentId)) };
  }

  /** A new persona from a template: `{ template, name, role }`. The first file holds the template's text as a whole snapshot. */
  async function create(raw, user, at) {
    if (!isObject(raw)) throw fail('Send the template, name and role as a JSON object.', 400);
    if (viewOnlyKey(raw)) throw fail(VIEW_ONLY_MESSAGE, 403);
    const extra = Object.keys(raw).filter(name => !NEW_KEYS.includes(name));
    if (extra.length) throw fail(`A new persona has no field ${extra.slice(0, 3).join(', ')}.`, 400);
    const template = typeof raw.template === 'string' ? templates.find(item => item.id === raw.template) : undefined;
    if (!template) throw fail('Pick one of the templates.', 400);
    const name = checkPersonaName(raw.name);
    const id = personaIdOf(name);
    if (!PERSONA_ID_RE.test(id)) throw fail('A name starts with a letter.', 400);
    if (taken.has(id)) throw fail('That name is taken by an agent of the app.', 400);
    // The role line goes into the prompt's first line without a closing full stop; the checks of an edit (length, control characters, secrets) run on both.
    const first = checkPersonaEdit({ role: raw.role, prompt: 'x', model: template.model, base: 'default' });
    const role = first.role.replace(/[.\s]+$/, '');
    if (!role) throw fail('The role line cannot be empty.', 400);
    const edit = checkPersonaEdit({ role, prompt: template.text(name, role), model: template.model, base: 'default' });
    const ids = await madeIds();
    if (ids.includes(id) || (await names(id)).length) throw fail('A persona with that name exists, or did once. Pick another name.', 409);
    if (ids.length >= MAX_MADE_PERSONAS) throw fail(`You can make at most ${MAX_MADE_PERSONAS} personas. Retired ones count.`, 400);
    const version = await write(id, { v: 1, role: edit.role, prompt: edit.prompt, model: edit.model, name, template: template.id, created: true, at: at.toISOString(), by: user || 'local' }, at);
    return { ok: true, id, name, version };
  }

  /** Retires a made persona: one more version. Nothing is deleted. */
  async function retire(agentId, user, at) {
    if (entryOf(agentId)) throw fail('An agent of the app cannot be retired.', 400);
    const { entry, newest } = await resolve(agentId);
    if (entry.retired) throw fail('That persona is retired already.', 409);
    const version = await write(agentId, { v: 1, retired: true, name: entry.name, at: at.toISOString(), by: user || 'local' }, at);
    return { ok: true, id: agentId, version, base: newest.id };
  }

  /** The retired personas with what Bring back needs: `to`, the newest version that is not the retirement, and `base`, the current one. */
  async function retiredList() {
    const out = [];
    for (const item of await table()) {
      if (!item.retired) continue;
      const list = await valid(item.id, VERSIONS_SHOWN);
      const live = list.find(version => !version.retired);
      if (live) out.push({ id: item.id, name: item.name, role: item.role, to: live.id, base: list[0].id });
    }
    return out;
  }

  return { table, versions, save, revert, create, retire, retiredList, current: async agentId => idOf((await valid(agentId, 1))[0]), forget };
}
