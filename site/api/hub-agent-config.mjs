// The Hermes host's redacted settings export, turned into what the agent details page shows.
// Pure: no S3, no clock of its own. `hub.mjs` finds the newest export and calls in.
//
// The export (v1) is published by an exporter on the Hermes host as create-only files,
// `inbox/agent-config/export-<stamp>.json`, through a card API token that may write nothing else. The card API
// stamps such a file with the object metadata `writer: hermes-config`; `hub.mjs` reads an export only when it
// carries that mark. The file is still not trusted: `validExport` applies the allow-list again, field by field,
// and cleans secret-looking text again. Anything not listed here is dropped, never passed through.
import { CHAT_MODELS } from './chat-models.mjs';

export const EXPORT_MAX_BYTES = 256 * 1024;
/** An export older than this means the exporter has stopped (it publishes at least every 6 h). */
export const STALE_SECONDS = 7 * 3600;
/** How far ahead of the site's clock an export (its name or its exportedAt) may be stamped before it is distrusted. */
export const FUTURE_SKEW_SECONDS = 5 * 60;
/** The card API token name, and the value of the `writer` mark on its files. */
export const WRITER = 'hermes-config';

export const PROFILES = ['main', 'briefs'];
export const SOUL_MAX_BYTES = 32 * 1024;
export const CRON_PROMPT_MAX_BYTES = 4 * 1024;
const MAX_FALLBACKS = 10;
const MAX_MODEL_OPTIONS = 20;
const MAX_TOOLSETS = 50;
const MAX_AUTOLOAD = 50;
const MAX_INSTALLED = 100;
const MAX_CRON = 20;
const MAX_PLATFORMS = 20;
const MAX_OWNER_SKILLS = 100;
const MAX_PLUGINS = 100;
const PLUGIN_STATUSES = ['enabled', 'disabled', 'not enabled'];
const PLUGIN_SOURCES = ['bundled', 'user', 'git', 'entrypoint'];

/** An ID string: a model, provider, toolset or skill name. Anything else is dropped, not cut. */
export const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,99}$/;

export const REDACTED = '[redacted]';

/**
 * The secret patterns, in order. The same list (a copy of `secret-vectors.json` in the homelab repo's
 * `scripts/assistant/config-export`) runs on the host and here; site/api/test/hub-agent-config.test.mjs checks it
 * against that file's patterns and test cases.
 */
export const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]{16,}/g,
  /sk-ant-[A-Za-z0-9_-]{16,}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /xox[abprs]-[A-Za-z0-9-]{10,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /[MNO][A-Za-z0-9_-]{23,27}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,40}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi,
  /(?:(?<![A-Za-z0-9])(?:api[_-]?key|token|secret|password)|[_-]key)\s*[:=]\s*(?!\[redacted\])\S{8,}/gi,
  /[A-Za-z0-9+/_-]{40,}/g,
];

/** Replace every secret-looking match with `[redacted]`. Keeps newlines (unlike scrub.mjs, which flattens). */
export function redactSecrets(text) {
  let count = 0;
  let out = typeof text === 'string' ? text : '';
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, () => { count += 1; return REDACTED; });
  }
  return { text: out, count };
}

/** At most `max` UTF-8 bytes of `text`, never ending in half a character. */
function cutBytes(text, max) {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= max) return { text, cut: false };
  let end = max;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return { text: bytes.subarray(0, end).toString('utf8'), cut: true };
}

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
/** An ID string is also refused when it holds a URL (`://`, as in `user:pass@host`) or when redaction would change it (an `sk-` model name). */
export const cleanId = value => (typeof value === 'string' && ID_RE.test(value) && !value.includes('://') && redactSecrets(value).count === 0 ? value : '');
const id = cleanId;
const ids = (value, max) => (Array.isArray(value) ? value.map(id).filter(Boolean).slice(0, max) : []);
const count = value => (Number.isInteger(value) && value >= 0 && value <= 1e9 ? value : 0);

/** An ISO time (a string a Date reads) as a canonical ISO string; '' for anything else. */
function isoOf(value) {
  if (typeof value !== 'string' || value.length > 40) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

function cleanSoul(raw) {
  if (!isObject(raw) || typeof raw.text !== 'string') return null;
  const redacted = redactSecrets(raw.text);
  const cut = cutBytes(redacted.text, SOUL_MAX_BYTES);
  return {
    text: cut.text,
    sha256: typeof raw.sha256 === 'string' && /^[0-9a-f]{64}$/.test(raw.sha256) ? raw.sha256 : '',
    bytes: count(raw.bytes),
    truncated: raw.truncated === true || cut.cut,
    redacted: count(raw.redacted) + redacted.count,
  };
}

function cleanJob(raw) {
  if (!isObject(raw) || typeof raw.name !== 'string' || typeof raw.schedule !== 'string') return null;
  const name = redactSecrets(raw.name.trim().slice(0, 120));
  const schedule = redactSecrets(raw.schedule.trim().slice(0, 120));
  const prompt = redactSecrets(typeof raw.prompt === 'string' ? raw.prompt : '');
  if (!name.text) return null;
  return {
    name: name.text, schedule: schedule.text, enabled: raw.enabled === true,
    prompt: cutBytes(prompt.text, CRON_PROMPT_MAX_BYTES).text,
  };
}

/** A short free-text field (a plugin's name, version or description): redacted, then cut. */
const shortText = (value, max) => (typeof value === 'string' ? redactSecrets(value.trim().slice(0, max)).text : '');

/** One plugin of a profile (ws-cl0.6.10): name, status, version, source and a short description. Anything else is dropped. */
function cleanPlugin(raw) {
  if (!isObject(raw)) return null;
  const name = shortText(raw.name, 80);
  if (!name || name === REDACTED) return null;
  return {
    name,
    status: PLUGIN_STATUSES.includes(raw.status) ? raw.status : 'not enabled',
    version: shortText(raw.version, 20),
    source: PLUGIN_SOURCES.includes(raw.source) ? raw.source : 'user',
    description: shortText(raw.description, 160),
  };
}

/** One profile's block from the allow-list, or null when it is not an object. Absent parts are omitted. */
function cleanProfile(raw) {
  if (!isObject(raw)) return null;
  const out = {};
  if (isObject(raw.model)) {
    const model = {};
    if (id(raw.model.provider)) model.provider = raw.model.provider;
    if (id(raw.model.default)) model.default = raw.model.default;
    if (Object.keys(model).length) out.model = model;
  }
  out.fallbacks = Array.isArray(raw.fallbacks)
    ? raw.fallbacks.filter(isObject).map(item => ({ provider: id(item.provider), model: id(item.model) })).filter(item => item.provider && item.model).slice(0, MAX_FALLBACKS)
    : [];
  // The models the host would apply (ws-im1.4.2): kept only when the export has the list, so an older exporter's profile has the same keys as before.
  if (Array.isArray(raw.modelOptions)) out.modelOptions = raw.modelOptions.filter(isObject).map(item => ({ provider: id(item.provider), model: id(item.model) })).filter(item => item.provider && item.model).slice(0, MAX_MODEL_OPTIONS);
  if (Array.isArray(raw.toolsets)) out.toolsets = ids(raw.toolsets, MAX_TOOLSETS);
  if (isObject(raw.platformToolsets)) {
    const platforms = {};
    for (const [name, list] of Object.entries(raw.platformToolsets)) {
      if (Object.keys(platforms).length >= MAX_PLATFORMS) break;
      if (id(name) && Array.isArray(list)) platforms[name] = ids(list, MAX_TOOLSETS);
    }
    out.platformToolsets = platforms;
  }
  const skills = isObject(raw.skills) ? raw.skills : {};
  out.skills = { autoLoad: ids(skills.autoLoad, MAX_AUTOLOAD), installed: ids(skills.installed, MAX_INSTALLED) };
  // Plugins (ws-cl0.6.10): kept only when the export has the list, so an older exporter's profile reads as "not listed", not "none".
  if (Array.isArray(raw.plugins)) out.plugins = raw.plugins.map(cleanPlugin).filter(Boolean).slice(0, MAX_PLUGINS);
  if (isObject(raw.terminal)) {
    const terminal = {};
    if (id(raw.terminal.backend)) terminal.backend = raw.terminal.backend;
    const memory = raw.terminal.containerMemoryMb;
    if (Number.isInteger(memory) && memory >= 0 && memory <= 65536) terminal.containerMemoryMb = memory;
    if (Object.keys(terminal).length) out.terminal = terminal;
  }
  const soul = cleanSoul(raw.soul);
  if (soul) out.soul = soul;
  if (Array.isArray(raw.cron)) out.cron = raw.cron.map(cleanJob).filter(Boolean).slice(0, MAX_CRON);
  return out;
}

/**
 * A clean v1 export from parsed JSON, or null (not an object, wrong `v`, no readable `exportedAt`). Only the
 * profiles `main` and `briefs` survive. `changedAt` is kept when it reads, else omitted.
 */
export function validExport(raw) {
  if (!isObject(raw) || raw.v !== 1) return null;
  const exportedAt = isoOf(raw.exportedAt);
  if (!exportedAt) return null;
  const changedAt = isoOf(raw.changedAt);
  const profiles = {};
  if (isObject(raw.profiles)) {
    for (const name of PROFILES) {
      const block = Object.hasOwn(raw.profiles, name) ? cleanProfile(raw.profiles[name]) : null;
      if (block) profiles[name] = block;
    }
  }
  return { v: 1, exportedAt, ...(changedAt ? { changedAt } : {}), profiles, ownerSkills: ids(raw.ownerSkills, MAX_OWNER_SKILLS) };
}

// --- profile changes (ws-im1.4.2) ---
// The Hub signs an approved change into create-only `agent-config/changes/<ask id>/approved.json`; the Hermes host applies it and puts
// `result.json` beside it (card API, `writer: hermes-config`). The format is in docs/workspaces.md ("Profile changes").

/** The fixed list of reasons in a result.json; the host never sends free text. The words are for the owner. */
export const CHANGE_CODES = {
  ok: 'It worked.',
  'bad-signature': 'The host did not accept the Hub\'s signature. After a key rotation the host needs a deploy',
  'bad-shape': 'The host could not read the change',
  expired: 'The change was not applied in time',
  stale: 'The settings on the host changed after you asked',
  'unknown-model': 'The host does not offer one of the models',
  'missing-key': 'The host has no API key for one of the models',
  'no-codex-login': 'The profile is not signed in to Codex',
  'config-write': 'The host could not write the settings',
  'config-check': 'Hermes did not accept the new settings',
  restart: 'The gateway did not restart',
  health: 'The gateway did not stay up after the restart',
  interrupted: 'The host stopped in the middle of the change',
  'rollback-failed': 'The host could not put the old settings back',
};
export const CHANGE_WINDOW_MS = 24 * 3600 * 1000;
export const CHANGE_MAX_FALLBACKS = 4;
const CHANGE_KEYS = ['v', 'kind', 'change', 'profile', 'from', 'to', 'expires', 'nonce', 'at', 'by', 'ask', 'signature'];
const RESULT_KEYS = ['v', 'change', 'outcome', 'code', 'rolledBack', 'at'];

const modelRef = raw => (isObject(raw) && Object.keys(raw).length === 2 && id(raw.provider) && id(raw.model) ? { provider: raw.provider, model: raw.model } : null);
/** `{ provider, model, fallbacks }` or null. The primary and the fallbacks are different; at most four fallbacks. */
function modelSet(raw) {
  if (!isObject(raw) || Object.keys(raw).length !== 3 || !Array.isArray(raw.fallbacks) || raw.fallbacks.length > CHANGE_MAX_FALLBACKS) return null;
  const primary = modelRef({ provider: raw.provider, model: raw.model });
  const chain = raw.fallbacks.map(modelRef);
  if (!primary || chain.some(item => !item)) return null;
  const names = [primary, ...chain].map(item => `${item.provider}/${item.model}`);
  return new Set(names).size === names.length ? { ...primary, fallbacks: chain } : null;
}
const changeTime = value => (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(value) && !Number.isNaN(Date.parse(value)) ? value : '');

/**
 * A clean signed change from the parsed `approved.json`, or null. The shape only: this site wrote the file and the host checks the signature.
 * → { change, profile, from, to, expires, at, by, ask }
 */
export function validChange(raw) {
  if (!isObject(raw) || raw.v !== 1 || raw.kind !== 'profile-change') return null;
  if (Object.keys(raw).length !== CHANGE_KEYS.length || !CHANGE_KEYS.every(name => Object.hasOwn(raw, name))) return null;
  if (typeof raw.change !== 'string' || raw.change !== raw.ask || !PROFILES.includes(raw.profile) || typeof raw.by !== 'string' || typeof raw.nonce !== 'string' || typeof raw.signature !== 'string') return null;
  const from = modelSet(raw.from);
  const to = modelSet(raw.to);
  const expires = changeTime(raw.expires);
  const at = changeTime(raw.at);
  if (!from || !to || !expires || !at) return null;
  return { change: raw.change, profile: raw.profile, from, to, expires, at, by: raw.by.slice(0, 80), ask: raw.ask };
}

/** A clean result.json, or null. → { change, outcome, code, rolledBack, at } */
export function validResult(raw) {
  if (!isObject(raw) || raw.v !== 1) return null;
  if (Object.keys(raw).length !== RESULT_KEYS.length || !RESULT_KEYS.every(name => Object.hasOwn(raw, name))) return null;
  const at = changeTime(raw.at);
  if (typeof raw.change !== 'string' || !['applied', 'failed'].includes(raw.outcome) || !Object.hasOwn(CHANGE_CODES, raw.code) || typeof raw.rolledBack !== 'boolean' || !at) return null;
  if ((raw.outcome === 'applied') !== (raw.code === 'ok')) return null;
  return { change: raw.change, outcome: raw.outcome, code: raw.code, rolledBack: raw.rolledBack, at };
}

const sameModels = (block, set) => !!block?.model && block.model.provider === set.provider && block.model.default === set.model
  && block.fallbacks.length === set.fallbacks.length && block.fallbacks.every((item, index) => item.provider === set.fallbacks[index].provider && item.model === set.fallbacks[index].model);

/**
 * Where a signed change stands.
 * - waiting: signed, no result yet, not past `expires`
 * - late: past `expires` with no result ("The Hermes host did not pick this up")
 * - failed: the host says it failed (the old settings stay, unless `rolledBack` is false and the code is `rollback-failed`)
 * - applied: the host says it worked; the export does not show it yet
 * - live: an export made at or after the result shows the new settings
 * `change` is `validChange(...)`, `result` is `validResult(...)` or null (a result for another change is ignored), `exported` is `validExport(...)` or null.
 */
export function changeState({ change, result = null, exported = null, at }) {
  const mine = result && result.change === change.change ? result : null;
  if (mine?.outcome === 'failed') return 'failed';
  if (mine) {
    const made = exported ? Date.parse(exported.exportedAt) : NaN;
    return made >= Date.parse(mine.at) && sameModels(exported.profiles[change.profile], change.to) ? 'live' : 'applied';
  }
  return at.getTime() > Date.parse(change.expires) ? 'late' : 'waiting';
}

/**
 * One change as the page gets it. `landedAt` is when the host's result.json landed in the bucket (the listing's last-modified time, set by S3
 * after the health check): the page shows it as "running since", because `result.at` is the start of the host's tick, up to a minute earlier.
 */
export function changeView({ change, result = null, landedAt = '', exported = null, at }) {
  const state = changeState({ change, result, exported, at });
  const mine = result && result.change === change.change ? result : null;
  return {
    id: change.change, profile: change.profile, state, at: change.at, by: change.by, from: change.from, to: change.to,
    ...(mine ? { resultAt: mine.at } : {}),
    ...(mine?.outcome === 'applied' ? { runningAt: landedAt || mine.at } : {}),
    ...(state === 'failed' ? { code: mine.code, reason: CHANGE_CODES[mine.code], rolledBack: mine.rolledBack } : {}),
    ...(state === 'late' ? { reason: 'The Hermes host did not pick this up.' } : {}),
  };
}

const setOf = block => (block?.model?.provider && block.model.default
  ? { provider: block.model.provider, model: block.model.default, fallbacks: block.fallbacks.map(item => ({ provider: item.provider, model: item.model })) }
  : null);

/**
 * The order a profile runs on now, for the next change's `from` and for the form's "current". The export says what the host's file held when it
 * was made; a change the host confirmed (`ok` result) can be newer than that export. So: take the newest change of the profile with an `ok` result;
 * when the export does not show its `to` and was made before the result landed, the order is that `to`. Otherwise the export's: an export made
 * after the landing wins even when it differs (somebody changed the host), and a failed result changes nothing.
 * `changes` is `[{ change, result, landedAt? }]`; `landedAt` falls back to `result.at`. Null when the export has no readable order for the profile.
 * The host still checks `from`, so a wrong answer here costs a `stale` result and changes nothing.
 */
export function effectiveSet(exported, profile, changes = []) {
  const block = exported?.profiles?.[profile] ?? null;
  const fromExport = setOf(block);
  const win = changes
    .filter(item => item.change.profile === profile && item.result?.change === item.change.change && item.result.outcome === 'applied')
    .sort((a, b) => (a.change.at < b.change.at ? 1 : a.change.at > b.change.at ? -1 : 0))[0];
  if (!win) return fromExport;
  if (block && sameModels(block, win.change.to)) return fromExport;
  const landed = Date.parse(win.landedAt || win.result.at);
  const made = exported ? Date.parse(exported.exportedAt) : NaN;
  if (exported && made >= landed) return fromExport;
  return { provider: win.change.to.provider, model: win.change.to.model, fallbacks: win.change.to.fallbacks.map(item => ({ provider: item.provider, model: item.model })) };
}

/** 'fresh' for an export the host made lately, else 'stale' (the exporter stopped, or the export is stamped in the future). The same rule as the details page. */
export function exportFreshness(exported, at) {
  const raw = Math.floor((at.getTime() - new Date(exported.exportedAt).getTime()) / 1000);
  return raw < -FUTURE_SKEW_SECONDS || Math.max(0, raw) >= STALE_SECONDS ? 'stale' : 'fresh';
}

const KB = 1024;

/**
 * The details page's answer for one agent.
 * - `agent`: an AGENTS entry (hub-team.mjs); `exported`: `validExport(...)` or null; `at`: a Date.
 * - `persona`: the agent's CHAT_PERSONAS entry, `preset`: the Spawn preset it takes (presetOf(agent.presets[0])); both optional.
 * - `changes`: the signed changes of the agent's profile with their results, newest first (`[{ change, result, landedAt }]`, hub.mjs); the answer carries the recent ones as `changes` (waiting, or ended in the last 24 hours), and the newest as `change`.
 */
export function agentDetails({ agent, exported = null, at, persona = null, preset = null, changes = [] }) {
  const profile = agent.profile ?? null;
  const block = profile && exported ? exported.profiles[profile] ?? null : null;
  const chatModel = persona ? CHAT_MODELS.find(entry => entry.id === persona.model)?.label : undefined;
  const who = { id: agent.id, name: agent.name, role: persona?.role ?? agent.role, room: agent.room, runtime: agent.runtime, profile, ...(persona || profile ? { editable: { ...(persona ? { persona: true } : {}), ...(profile ? { profile: true } : {}) } } : {}), ...(chatModel ? { chatModel } : {}) };

  let freshness;
  if (!profile) freshness = { state: 'none' };
  else if (!exported || !block) freshness = { state: 'missing' };
  else {
    const ageSeconds = Math.max(0, Math.floor((at.getTime() - new Date(exported.exportedAt).getTime()) / 1000));
    // An export stamped in the future (a clock that ran ahead, or a forged time) is not fresh: past the allowed skew it reads as stale.
    freshness = { state: exportFreshness(exported, at), exportedAt: exported.exportedAt, ...(exported.changedAt ? { changedAt: exported.changedAt } : {}), ageSeconds };
  }

  let settings = null;
  const prompts = [];
  if (block) {
    const { soul, cron, ...rest } = block;
    settings = rest;
    if (soul) {
      const notes = [];
      if (soul.truncated) notes.push(`Cut at ${SOUL_MAX_BYTES / KB} KB.`);
      if (soul.redacted) notes.push(`${soul.redacted} secret-like ${soul.redacted === 1 ? 'text was' : 'texts were'} replaced with ${REDACTED}.`);
      prompts.push({ id: 'soul', title: `SOUL.md (profile ${profile})`, source: 'hermes-host', text: soul.text, ...(notes.length ? { note: notes.join(' ') } : {}) });
    }
  }
  if (persona) prompts.push({ id: 'persona', title: 'Chat persona', source: 'app', text: persona.text, ...(persona.edited ? { note: `Edited ${persona.edited.at.slice(0, 10)} by ${persona.edited.by}.` } : {}) });
  if (preset?.template) prompts.push({ id: 'job', title: `Job template (${preset.label})`, source: 'app', text: preset.template, note: 'Placeholders are filled in when a job starts.' });

  // A change is shown while it waits, and for 24 hours after it ended: after the host's result, or after it ran out with none (`late`).
  // Where the order stands now: the export, or a change the host confirmed after that export was made.
  const effective = settings && profile ? effectiveSet(exported, profile, changes) : null;
  // `applied` and `live` say the host confirmed a change, not that it still runs: after a way back or a host edit another order is in use, so that row is `replaced`.
  const inUse = view => !effective || (view.state !== 'applied' && view.state !== 'live') || sameModels({ model: { provider: effective.provider, default: effective.model }, fallbacks: effective.fallbacks }, view.to);
  const recent = profile ? changes.filter(item => at.getTime() - Date.parse(item.result?.at ?? item.change.expires) < CHANGE_WINDOW_MS).map(item => changeView({ ...item, exported, at })).map(view => (inUse(view) ? view : { ...view, replaced: true })) : [];
  if (settings && effective) settings = { ...settings, effective };
  return { agent: who, freshness, settings, prompts, jobs: block?.cron ?? [], ...(recent.length ? { change: recent[0], changes: recent } : {}) };
}
