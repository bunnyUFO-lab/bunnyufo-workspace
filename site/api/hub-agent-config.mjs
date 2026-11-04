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
const MAX_TOOLSETS = 50;
const MAX_AUTOLOAD = 50;
const MAX_INSTALLED = 100;
const MAX_CRON = 20;
const MAX_PLATFORMS = 20;
const MAX_OWNER_SKILLS = 100;

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
const id = value => (typeof value === 'string' && ID_RE.test(value) && !value.includes('://') && redactSecrets(value).count === 0 ? value : '');
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

const KB = 1024;

/**
 * The details page's answer for one agent.
 * - `agent`: an AGENTS entry (hub-team.mjs); `exported`: `validExport(...)` or null; `at`: a Date.
 * - `persona`: the agent's CHAT_PERSONAS entry, `preset`: the Spawn preset it takes (presetOf(agent.presets[0])); both optional.
 */
export function agentDetails({ agent, exported = null, at, persona = null, preset = null }) {
  const profile = agent.profile ?? null;
  const block = profile && exported ? exported.profiles[profile] ?? null : null;
  const chatModel = persona ? CHAT_MODELS.find(entry => entry.id === persona.model)?.label : undefined;
  const who = { id: agent.id, name: agent.name, role: persona?.role ?? agent.role, room: agent.room, runtime: agent.runtime, profile, ...(persona ? { editable: { persona: true } } : {}), ...(chatModel ? { chatModel } : {}) };

  let freshness;
  if (!profile) freshness = { state: 'none' };
  else if (!exported || !block) freshness = { state: 'missing' };
  else {
    const raw = Math.floor((at.getTime() - new Date(exported.exportedAt).getTime()) / 1000);
    const ageSeconds = Math.max(0, raw);
    // An export stamped in the future (a clock that ran ahead, or a forged time) is not fresh: past the allowed skew it reads as stale.
    const ahead = raw < -FUTURE_SKEW_SECONDS;
    freshness = { state: ahead || ageSeconds >= STALE_SECONDS ? 'stale' : 'fresh', exportedAt: exported.exportedAt, ...(exported.changedAt ? { changedAt: exported.changedAt } : {}), ageSeconds };
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

  return { agent: who, freshness, settings, prompts, jobs: block?.cron ?? [] };
}
