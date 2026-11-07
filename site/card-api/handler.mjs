// The card API: read and write workspace cards in the cards bucket from anywhere, with a token.
//
// It runs in AWS Lambda behind an API Gateway HTTP API (template.yaml), so a session on any machine
// can fetch or publish a card without AWS credentials and without a way into the home server. The
// function's role reaches `sections/*` in the cards bucket and nothing else: not state.json, not
// another bucket. Callers send `Authorization: Bearer <passphrase>`: the one password the site's owner
// set at deploy (BUW_CARD_PASSPHRASE). Optional extra tokens, each limited to some sections or to some
// verbs on them, are held as SHA-256 hashes (BUW_CARD_TOKENS; see parseTokens for the grammar).
//
//   GET    /sections                                 the sections this token may use
//   GET    /sections/{section}                       its name and card list
//   GET    /sections/{section}/cards/{card}          the card's entry and files, each with a short-lived download URL
//   PUT    /sections/{section}/cards/{card}          add or update the card's entry in workspace.json (body: the entity)
//   GET    /sections/{section}/files?prefix=<p>      the files under a prefix (path, size, etag, lastModified), 1000 at most
//   GET    /sections/{section}/files/{folder}/{path} one file, up to 4 MB
//   PUT    /sections/{section}/files/{folder}/{path} upload one file, up to 4 MB (the body is the file);
//                                                    If-None-Match: * creates only, If-Match: "<etag>" replaces only that version
//   DELETE /sections/{section}/files/{folder}/{path} remove one file
//   POST   /sections/{section}/uploads               upload URLs for bigger files (body: { files: [{ path }] })
//   GET    /resolve?ref=<site link | section/card | name>   which card a link or a name means
//   GET    /cards.mjs                                the client (cards.mjs beside this file), with no token:
//                                                    it is code and holds nothing, and a session needs it first
//
// Files go up first and the entry last, so a card is never listed before its files are there. The
// entry is written with If-Match on the ETag it read, so two writers never drop each other's card.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { contentTypeOf, createBucket, typeOf } from '../api/s3.mjs';
import { validateChanges } from '../api/ask-changes.mjs';
import { validateAgentEdit } from '../api/agent-edit.mjs';
import { RESERVED } from '../api/card-purge.mjs';
import { PURPOSES } from '../api/card-liveness.mjs';

const CLIENT = new URL('./cards.mjs', import.meta.url);

export const MAX_INLINE = 4 * 1024 * 1024; // a Lambda payload is 6 MB, and base64 adds a third
export const MAX_FILE = 50 * 1024 * 1024; // the same limit `npm run publish` keeps
const SECRET = /(^|\/)(\.env(\..*)?|.*\.(pem|key|p12|pfx)|id_(rsa|ed25519)(\.pub)?|.*(secret|credential|password|token).*\.(json|txt|ya?ml))$/i;
/** The hidden inbox sections: the real one, and the development copy's. Same rules for both. */
const INBOXES = new Set(['inbox', 'inbox-dev']);
const SECTION_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const URL_TTL = 900;
const SETTING_TTL = 30_000;

// What a Library right may write. Project sections come down to the owner's Windows PC, so a path is checked for that too.
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,119}$/;
const FOLDER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
const DEVICE_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const segmentOk = segment => SEGMENT.test(segment) && !/[. ]$/.test(segment) && !DEVICE_NAME.test(segment.split('.')[0]);
/** A card folder: one segment, the stricter set a `CARD:` line accepts. */
export const libraryFolderOk = folder => typeof folder === 'string' && FOLDER.test(folder) && segmentOk(folder);
/** A file path inside a Library section: `<folder>/<file>`, every segment safe on Windows. */
export const libraryPathOk = file => typeof file === 'string' && file.split('/').length >= 2 && libraryFolderOk(file.split('/')[0]) && file.split('/').every(segmentOk);
/** A first path segment the site keeps for itself, in any case: Windows treats `Card-Responses` and `card-responses` as one folder. */
const reservedName = name => RESERVED.has(String(name).toLowerCase());
/**
 * The names the publish and pull walk skips (SKIP_DIRS and SKIP_ROOT in scripts/shared/s3-sync.mjs; library-writes.test.mjs keeps the
 * two equal), lower-cased. A card folder with one of them is never walked, so a pull would write over the owner's file of that name
 * and the next publish would delete the agent's.
 */
export const SYNC_SKIPPED = new Set(['.git', '_site', '.jekyll-cache', 'node_modules', '.buw', 'gemfile', 'gemfile.lock', '_config.yml', 'docker-compose.yml', 'index.md', '.gitignore', 'readme.md', '_sass', 'categories']);
const skippedName = name => SYNC_SKIPPED.has(String(name).toLowerCase());
/** Script files an agent may add but not edit: an owner's page may load them, and they would run with the page's reach. */
const SCRIPT_FILE = /\.(js|mjs|cjs|wasm)$/i;
const lower = value => String(value).toLowerCase();
const stepPathOk = value => typeof value === 'string' && value.split('/').every(segmentOk);
const ENTRY_FIELDS = new Set(['id', 'title', 'description', 'type', 'category', 'created', 'updated', 'folder', 'steps', 'defaultStep', 'status', 'purpose']);
const AGENT = /^[A-Za-z0-9][\w .-]{0,39}$/;
const CONTEXT = /^(chat|job)(:[A-Za-z0-9._-]{1,120})?$/;
const BATCH = /^[a-z0-9]{8,32}$/;
const MAX_LISTED = 1000;

class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

const sha256 = text => createHash('sha256').update(text).digest('hex');

const VERBS = ['read', 'write', 'delete'];

/**
 * A token's scope, the part after the colon:
 *   (none)                         every verb on every section
 *   `a|b`                          every verb, on those sections only
 *   `read=*;write=inbox|assistant` the listed verbs only, each on `*` (every section) or some sections
 *   `write=inbox|assistant|@library` also adds cards and tabs to any Library section the owner has not turned off (write only)
 * Returns { read, write, delete }, each `null` (every section) or a Set of section ids (empty: none).
 */
export function parseScope(scope) {
  const text = String(scope ?? '');
  if (!text) return { read: null, write: null, delete: null };
  if (!text.includes('=')) {
    if (!/^[\w-]+(\|[\w-]+)*$/.test(text)) throw new Error('not a section list');
    return Object.fromEntries(VERBS.map(verb => [verb, new Set(text.split('|'))]));
  }
  const rights = Object.fromEntries(VERBS.map(verb => [verb, new Set()]));
  const seen = new Set();
  for (const part of text.split(';')) {
    // `@library` is one more member of the write set: "any Library section" (a section with cards the owner has not hidden or archived). No section id can hold `@`.
    const match = (part.startsWith('write=') ? /^(write)=(\*|(?:[a-z0-9-]+|@library)(?:\|(?:[a-z0-9-]+|@library))*)$/ : /^(read|write|delete)=(\*|[a-z0-9-]+(?:\|[a-z0-9-]+)*)$/).exec(part);
    if (!match) throw new Error(`not a right: ${part}`);
    if (seen.has(match[1])) throw new Error(`${match[1]} is listed twice`);
    seen.add(match[1]);
    rights[match[1]] = match[2] === '*' ? null : new Set(match[2].split('|'));
  }
  return rights;
}

/**
 * "laptop=<sha256>, cloud=<sha256>:magic-loops|bunnylink, hermes=<sha256>:read=*;write=inbox"
 * → [{ name, hash, rights: { read, write, delete } }]. Without a scope a token may do everything.
 * A bad entry throws with its name only, never its hash.
 */
export function parseTokens(value) {
  return String(value ?? '').split(',').map(item => item.trim()).filter(Boolean).map(item => {
    const match = /^([\w.-]+)=([0-9a-f]{64})(?::([\w|*=;@-]+))?$/i.exec(item);
    let rights;
    try {
      if (!match) throw new Error('form');
      rights = parseScope(match[3]);
    } catch {
      throw new Error(`BUW_CARD_TOKENS has an entry that is not name=<sha256>[:section|section | :read=*;write=a|b]: ${item.split('=')[0]}`);
    }
    return { name: match[1], hash: match[2].toLowerCase(), rights };
  });
}

const EVERYTHING = Object.freeze({ read: null, write: null, delete: null });

/** A path inside a section: forward slashes, a card folder and at least one file below it. */
export function cardPath(value) {
  const parts = String(value ?? '').split('/').filter(Boolean);
  if (parts.length < 2 || parts.some(part => part === '.' || part === '..' || part.startsWith('.'))) return null;
  if (parts[0].startsWith('_')) return null; // _shared and the like belong to the whole section
  return parts.join('/');
}

/**
 * What a reference names: a site link (https://…/<section>#/<card>, or a /w/<section>/<folder>/
 * file link), "section/card", or a bare card id or title.
 */
export function parseRef(ref) {
  const text = String(ref ?? '').trim();
  if (/^https?:\/\//i.test(text)) {
    const url = new URL(text);
    const segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    if (segments[0] === 'w' && segments[1]) return { section: segments[1], folder: segments[2] ?? null, card: null };
    const card = decodeURIComponent(url.hash.replace(/^#\/?/, '').split('/')[0] || '') || null;
    return { section: segments[0] ?? null, card, folder: null };
  }
  const slash = text.indexOf('/');
  if (slash > 0) return { section: text.slice(0, slash), card: text.slice(slash + 1), folder: null };
  return { section: null, card: text || null, folder: null };
}

const summary = entity => ({
  id: entity.id,
  title: entity.title,
  description: entity.description,
  category: entity.category,
  folder: entity.folder,
  status: entity.status,
  purpose: entity.purpose,
  updated: entity.updated ?? entity.created,
});

/**
 * @param bucket an s3.mjs bucket
 * @param tokens parseTokens() output
 * @param prefix where the sections are in the bucket
 */
export function createCardApi({ bucket, tokens, prefix = 'sections', urlTtl = URL_TTL, today = () => new Date().toISOString().slice(0, 10), now = () => Date.now() }) {
  const keyOf = (section, rest) => `${prefix}/${section}/${rest}`;

  /**
   * The hidden inbox that holds a section's records and its Library setting: `inbox-dev` for the development copy's
   * `dev-*` sections, so QA there never touches real data, else `inbox`.
   */
  const inboxFor = section => (String(section).startsWith('dev-') ? 'inbox-dev' : 'inbox');
  /** A Library section: a card list that is not hidden, not archived, and not an inbox. */
  const isLibrary = (id, registry) => !/^inbox(-|$)/.test(id) && registry?.hidden !== true && registry?.archived !== true;

  /**
   * The owner's off-list for agent cards, `library-writes.json` at the root of an inbox, read at most every 30 s per inbox.
   * No file: everything is on. A file with a writer mark (not the Hub's own), one that does not parse or a bad shape: everything
   * is off, and logged. A storage error is a 503 and is not cached: never fail open.
   */
  const settingCache = new Map();
  async function libraryState(inbox) {
    const hit = settingCache.get(inbox);
    if (hit && now() - hit.at < SETTING_TTL) return hit.state;
    let state;
    try {
      const got = await bucket.getText(keyOf(inbox, 'library-writes.json'));
      if (!got) {
        state = { off: new Set() };
      } else if (got.metadata?.writer) {
        console.error(`[library-writes] ${inbox}/library-writes.json carries a writer mark; treating every section as off`);
        state = { all: true };
      } else {
        const value = JSON.parse(got.text);
        if (!value || typeof value !== 'object' || value.v !== 1 || !Array.isArray(value.off) || !value.off.every(item => typeof item === 'string')) throw new SyntaxError('bad shape');
        state = { off: new Set(value.off) };
      }
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw new HttpError(503, 'Could not check the section setting just now; try again.');
      console.error(`[library-writes] ${inbox}/library-writes.json is not valid; treating every section as off`);
      state = { all: true };
    }
    settingCache.set(inbox, { at: now(), state });
    return state;
  }
  const libraryOn = async id => {
    const state = await libraryState(inboxFor(id));
    return !state.all && !state.off.has(id);
  };

  function authenticate(headers) {
    const match = /^Bearer\s+(\S.*?)\s*$/i.exec(headers.authorization ?? ''); // a passphrase may have spaces
    if (!match) throw new HttpError(401, 'Send Authorization: Bearer <token>.');
    const hash = Buffer.from(sha256(match[1]), 'hex');
    const found = tokens.find(token => timingSafeEqual(Buffer.from(token.hash, 'hex'), hash));
    if (!found) throw new HttpError(401, 'That token is not known here.');
    return found;
  }

  const can = (caller, verb, section) => caller.rights[verb] === null || caller.rights[verb].has(section);

  /**
   * The one read the token named `hermes-config` has (ws-im1.4.2), without a `read` right on the token: in the `inbox` section only
   * (never `inbox-dev`), the signed approvals and the results of profile changes, `agent-config/changes/<id>/approved.json` and `result.json`.
   * Callers pass `hostChange` only for a listing under `agent-config/changes/` or a GET of a file that matches HOST_CHANGE_FILE; every
   * other call keeps `can()`. The token's scope is not widened: it still reads no export, no ask and no request.
   */
  const HOST_CHANGE_FILE = /^agent-config\/changes\/[^/]+\/(approved|result)\.json$/;
  const hostChangeReader = (caller, id) => caller.name === 'hermes-config' && caller.rights.write !== null && id === 'inbox';

  async function section(caller, id, verb, { hostChange = false } = {}) {
    if (!SECTION_ID.test(id ?? '')) throw new HttpError(400, 'A section id is lower-case letters, digits and dashes.');
    // A `@library` right is not a section: it adds a write to any Library section. A literal right wins, and a token with no right at all is refused before the list is read.
    const viaLibrary = verb === 'write' && !can(caller, 'write', id) && Boolean(caller.rights.write?.has('@library'));
    if (!can(caller, verb, id) && !viaLibrary && !(hostChange && verb === 'read' && hostChangeReader(caller, id))) throw new HttpError(403, `This token may not ${verb} section "${id}".`);
    const got = await bucket.getJson(keyOf(id, 'workspace.json'));
    if (!Array.isArray(got?.value?.entities)) throw new HttpError(404, `No section "${id}".`);
    if (viaLibrary) {
      if (!isLibrary(id, got.value)) throw new HttpError(403, `This token may not write section "${id}".`);
      if (!await libraryOn(id)) throw new HttpError(403, `The owner has turned agent cards off for section "${id}". Write to assistant.`);
    }
    return { id, registry: got.value, etag: got.etag, library: viaLibrary };
  }

  /** Where this caller may write a section, so an agent can see it without trying: `direct`, `library` or `read`. */
  async function accessOf(caller, id, registry) {
    if (can(caller, 'write', id)) return 'direct';
    if (!caller.rights.write?.has('@library') || !isLibrary(id, registry)) return 'read';
    try { return (await libraryOn(id)) ? 'library' : 'read'; } catch { return 'read'; }
  }

  /**
   * Who and why, from the `x-card-*` headers. For a Library right they are required (422); for a literal right they are optional and a
   * value that does not fit reads as absent. `agent` and `context` are self-reported: personas share one token. The token is proven.
   */
  function writeInfo(headers = {}, { strict = false, needContext = false } = {}) {
    const agent = headers['x-card-agent'];
    let why = null;
    if (headers['x-card-why'] !== undefined) {
      try { why = decodeURIComponent(headers['x-card-why']).replace(/\s+/g, ' ').trim(); } catch { why = null; }
      if (why !== null && (why.length < 1 || why.length > 300)) why = null;
    }
    const context = headers['x-card-context'];
    const batch = headers['x-card-batch'];
    const info = {
      agent: typeof agent === 'string' && AGENT.test(agent) ? agent : null,
      why,
      context: typeof context === 'string' && CONTEXT.test(context) ? context : null,
      batch: typeof batch === 'string' && BATCH.test(batch) ? batch : null,
    };
    if (strict) {
      if (!info.agent) throw new HttpError(422, 'A write to a project section says who made it: send x-card-agent (letters, digits, spaces, dots and dashes, 40 at most).');
      if (!info.why) throw new HttpError(422, 'A write to a project section says why: send x-card-why (URI-encoded, 1 to 300 characters).');
      if (headers['x-card-context'] !== undefined && !info.context) throw new HttpError(422, 'x-card-context is "chat" or "job:<id>".');
      if (headers['x-card-batch'] !== undefined && !info.batch) throw new HttpError(422, 'x-card-batch is 8 to 32 lower-case letters and digits.');
      if (needContext && !info.context) throw new HttpError(422, 'An edit says which chat or job asked for it.');
    }
    return info;
  }

  /** `<stamp>-<rand4>`: one id per write, sortable by time. */
  const writeId = () => `${new Date(now()).toISOString().replace(/[-:.]/g, '')}-${randomBytes(2).toString('hex')}`;

  /**
   * One create-only file per write in the section's inbox (never in the project section, which comes down to a PC): who, why and
   * which version, for the Hub's rows and Revert. The file is already in place and cannot be pulled back without a delete, so a
   * failed record is tried once more, then logged for the function log, and the write still answers 200 (`recorded: false`).
   */
  async function record(sectionId, folder, id, fields) {
    const row = { v: 1, id, section: sectionId, folder, ...fields, at: new Date(now()).toISOString() };
    const key = keyOf(inboxFor(sectionId), `card-writes/${sectionId}/${folder}/${id}.json`);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await bucket.putJson(key, row, { ifNoneMatch: '*', metadata: { writer: 'card-api' } });
        return true;
      } catch { /* once more */ }
    }
    console.error('[card-writes] not recorded', JSON.stringify(row));
    return false;
  }

  async function sectionIds(caller) {
    const { prefixes } = await bucket.list(`${prefix}/`, { delimiter: '/' });
    return prefixes.map(item => item.slice(prefix.length + 1).replace(/\/$/, '')).filter(id => SECTION_ID.test(id) && can(caller, 'read', id));
  }

  /** In the inbox, anything nested below a checklist's folder (checklists/<id>/x/…), answers, snoozes, declines, checklist ticks, submissions and pictures, a sketch's deleted.json, an agent's avatar choice and persona edits (team/<agent>/avatar-*.json, persona-*.json), a request's approval, stop, Hermes run, retry, fire records and answers (requests/<id>/approved|stop|hermes-run|hermes-retry|allow-grant.json, fire-*.json, answer-*.json), a job's reference picture (requests/<id>/reference.jpg|png) everything under hermes-approvals/ and the owner's Roadmap marks (bead-marks/<project>/<bead>/<stamp>-done|not-needed|unblock|undo-<rand>.json) the owner's Not useful records (feedback/<project>/<kind>/<id>/not-useful.json) and the Away switch (presence.json at the root) are the Hub's: only an unrestricted writer (the passphrase) may put them. */
  const OWNER_FILES = /^(asks\/[^/]+\/(answer\.[^/]+|snooze\.json)|requests\/[^/]+\/declined\.json|checklists\/[^/]+\/((tick|untick)-[^/]+\.json|submit(-\d+)?\.json|reopen-\d+\.json|(evidence|shot)-[^/]+)|checklists\/[^/]+\/[^/]+\/.*|drawings\/[^/]+\/deleted\.json|team\/[^/]+\/(avatar|persona)-[^/]+\.json|requests\/[^/]+\/(approved|stop|hermes-run|hermes-retry|allow-grant|continued|sprint|sprint-end)\.json|requests\/[^/]+\/(fire|answer|reply)-[^/]+\.json|requests\/[^/]+\/reference\.(jpg|png)|hermes-approvals\/.*|bead-marks\/[^/]+\/[^/]+\/[^/]+-(done|not-needed|unblock|undo)-[^/]+\.json|feedback\/[^/]+\/[^/]+\/[^/]+\/not-useful\.json|presence\.json|library-writes\.json|chat\/.*)$/i;
  const ASK_FILE = /^(?:asks\/(?:[^/]+\/)*ask|(?:asks|checklists)\/[^/]+\/(?:delivered|watch-[^/]+)|checklists\/[^/]+\/checklist|requests\/[^/]+\/request)\.json$/i;
  /** The files a run writes: taken, progress, result and report. */
  const RUNNER_FILES = /^requests\/([^/]+)\/(taken\.json|run-[^/]+\.json|result\.json|report\.md)$/i;
  /** An agent's only file under bead-marks/: the note that it closed the issue the owner marked (create-only). */
  const APPLIED_FILE = /^bead-marks\/[^/]+\/[^/]+\/[^/]+-applied-[^/]+\.json$/i;
  const markFiles = (caller, sectionId, file, { ifNoneMatch, upload = false } = {}) => {
    if (INBOXES.has(sectionId) && caller.rights.write !== null && /^bead-marks\//i.test(file) && (!APPLIED_FILE.test(file) || upload || ifNoneMatch !== '*')) {
      throw new HttpError(403, 'Agents write only applied marks, once.');
    }
  };
  /** An agent's only file under feedback/: the note that it filed the owner's Not useful item as a bug (create-only). */
  const FEEDBACK_FILED = /^feedback\/[^/]+\/[^/]+\/[^/]+\/filed-\d{8}T\d{9}Z-[a-z0-9]{4}\.json$/i;
  const feedbackFiles = (caller, sectionId, file, { ifNoneMatch, upload = false } = {}) => {
    if (INBOXES.has(sectionId) && caller.rights.write !== null && /^feedback\//i.test(file) && (!FEEDBACK_FILED.test(file) || upload || ifNoneMatch !== '*')) {
      throw new HttpError(403, 'Agents write only filed notes under feedback/, once.');
    }
  };
  /** The Hermes host's redacted settings export: create-only, one file per publish. */
  const AGENT_CONFIG_EXPORT = /^agent-config\/export-\d{8}T\d{6,9}Z\.json$/i;
  /** The result of a profile change (ws-im1.4.2), written once by the Hermes host next to the Hub's approved.json: agent-config/changes/<ask id>/result.json. */
  const AGENT_CONFIG_RESULT = /^agent-config\/changes\/\d{8}-[a-z0-9-]+-[a-z0-9]{4}\/result\.json$/;
  const AGENT_CONFIG_FILE = { test: file => AGENT_CONFIG_EXPORT.test(file) || AGENT_CONFIG_RESULT.test(file) };
  /**
   * In the inbox, `agent-config/` is for the token named `hermes-config` only (the exporter on the Hermes host), which may
   * create `export-<stamp>.json` and, for a profile change, `changes/<ask id>/result.json`, each once (If-None-Match: *, never an upload URL), and
   * nothing else in the inbox. The Hub's `changes/<id>/approved.json` is never writable here. The passphrase is not limited.
   */
  const agentConfigOnly = (caller, sectionId, file, { ifNoneMatch, upload = false } = {}) => {
    if (!INBOXES.has(sectionId) || caller.rights.write === null) return;
    const inFolder = /^agent-config\//i.test(file);
    if (caller.name === 'hermes-config') {
      if (!inFolder) throw new HttpError(403, 'This token only publishes agent-config exports and change results.');
    } else if (inFolder) {
      throw new HttpError(403, 'Only the Hermes config exporter writes agent-config/.');
    }
    if (inFolder && (!AGENT_CONFIG_FILE.test(file) || upload || ifNoneMatch !== '*')) {
      throw new HttpError(403, 'agent-config/export-<stamp>.json and changes/<id>/result.json are create-only (If-None-Match: *), never by upload URL.');
    }
  };
  /**
   * `asks/<id>/applied.json`: the ids a change list's creates made (ws-ch8). Only the apply job's token, named `apply-action`, may write it,
   * once (If-None-Match: *, never an upload URL), and the handler marks it `writer: apply-action`, which is what the Hub trusts. The passphrase can
   * write it too, with no mark, and the Hub ignores that copy.
   */
  const APPLIED_RECORD = /^asks\/[^/]+\/applied\.json$/i;
  const APPLY_TOKEN = 'apply-action';
  const appliedOnly = (caller, sectionId, file, { ifNoneMatch, upload = false } = {}) => {
    if (!INBOXES.has(sectionId) || caller.rights.write === null || !APPLIED_RECORD.test(file)) return;
    if (caller.name !== APPLY_TOKEN) throw new HttpError(403, 'Only the apply job writes applied.json.');
    if (upload || ifNoneMatch !== '*') throw new HttpError(403, 'applied.json is create-only (If-None-Match: *), never by upload URL.');
  };
  const ownerOnly = (caller, sectionId, file) => {
    if (INBOXES.has(sectionId) && caller.rights.write !== null && OWNER_FILES.test(file)) {
      throw new HttpError(403, 'Only the Hub writes answers.');
    }
  };
  /**
   * A limited writer may put a run's files (taken, run-*, result, report) in the inbox only as the token named
   * `pc-runner`, or as `cloud-<project>` for a request of that project (one GET of its request.json). Everyone else,
   * `hermes-main` and the old `cloud` token included, is refused. An unrestricted writer is not limited.
   */
  const runnerOnly = async (caller, sectionId, file) => {
    const match = INBOXES.has(sectionId) && caller.rights.write !== null ? RUNNER_FILES.exec(file) : null;
    if (!match) return;
    if (caller.name === 'pc-runner') {
      // A run's progress and result files only follow its take: `taken.json` (written by the runner when it claims the request) must be there first.
      // taken.json and report.md themselves are not gated (taken is the claim; the report is read with the result, after the take).
      if (/^(run-[^/]+|result)\.json$/i.test(match[2] ?? '')) {
        let taken = null;
        try {
          taken = await bucket.getJson(keyOf(sectionId, `requests/${match[1]}/taken.json`));   // null when there is no such file
        } catch (error) {
          // A file that does not parse is no take. A storage error is not an answer: 503, so the client retries or spools instead of dropping the write.
          if (!(error instanceof SyntaxError)) throw new HttpError(503, 'Could not check taken.json just now; try again.');
        }
        if (taken?.value?.runner !== 'pc') throw new HttpError(403, 'A run file follows the PC runner taking the request: taken.json is not there.');
      }
      return;
    }
    const project = /^cloud-([a-z0-9][a-z0-9-]*)$/.exec(caller.name ?? '')?.[1];
    if (project) {
      const got = await bucket.getJson(keyOf(sectionId, `requests/${match[1]}/request.json`)).catch(() => null);
      if (typeof got?.value?.project === 'string' && got.value.project === project) return;
    }
    throw new HttpError(403, 'Only a run writes run files.');
  };
  /**
   * Who wrote a request.json, kept as object metadata (`x-amz-meta-writer`), never in the body: `agent` for a token that
   * is an agent session (named `agent` or `agent-<name>`), nothing for anyone else (pc-runner, cloud-<project>,
   * hermes-main, the old shared tokens, the passphrase). Only this function sets it; a caller's own `x-amz-meta-*`
   * headers are never forwarded. The site API's policy approval signs only when the stored `origin` and this agree.
   * An `asks/<id>/ask.json` put by a limited token is tagged too, with the token's kind: `pc-runner` for the PC watcher's token
   * (the only one whose Ask the Hub lets carry a `rerun` pointer, see site/api/hub-rerun.mjs; PC runs hold this token too, so it excludes other tokens, not a run), `agent` for `agent`/`agent-<name>`, `other` for any
   * other limited token. The passphrase's own ask.json carries nothing.
   */
  const writerMetadata = (caller, sectionId, file) => {
    if (!INBOXES.has(sectionId)) return undefined;
    // Whatever goes into bead-marks/ through this API is tagged, so the Hub reads an owner verdict only from a file it wrote itself.
    if (/^bead-marks\//i.test(file)) return { writer: 'card-api' };
    // A persona edit is the prompt of every chat: whatever this API writes there carries a mark, and the Hub ignores a marked file. Only the Hub's own write has none.
    if (/^team\/[^/]+\/persona-/i.test(file)) return { writer: 'card-api' };
    // Same for the Not useful records: only a file with no mark is the Hub's.
    if (/^feedback\//i.test(file)) return { writer: 'card-api' };
    // The Away switch is the Hub's own file (it writes it with no mark): anything this API writes there carries one, and hub-hooks ignores it.
    if (file === 'presence.json') return { writer: 'card-api' };
    // The owner's off-list for agent cards is the Hub's own file (no mark); anything this API writes there carries one.
    if (file === 'library-writes.json') return { writer: 'card-api' };
    // An export the Hermes host published: the only provenance the Hub accepts for it.
    if (caller.rights.write !== null && caller.name === 'hermes-config' && AGENT_CONFIG_FILE.test(file)) return { writer: 'hermes-config' };
    // The apply job's record of the tasks a change list made: the Hub trusts it only with this mark.
    if (caller.rights.write !== null && caller.name === APPLY_TOKEN && APPLIED_RECORD.test(file)) return { writer: APPLY_TOKEN };
    if (caller.rights.write !== null && /^asks\/[^/]+\/ask\.json$/i.test(file)) {
      return { writer: caller.name === 'pc-runner' ? 'pc-runner' : /^agent(-[\w.-]+)?$/.test(caller.name ?? '') ? 'agent' : 'other' };
    }
    return caller.rights.write !== null && /^requests\/[^/]+\/request\.json$/i.test(file) && /^agent(-[\w.-]+)?$/.test(caller.name ?? '')
      ? { writer: 'agent' } : undefined;
  };
  /** A limited writer cannot claim a request as the owner's. */
  const noOwnerOrigin = (caller, sectionId, file, body) => {
    if (!INBOXES.has(sectionId) || caller.rights.write === null || !/^requests\/[^/]+\/request\.json$/i.test(file)) return;
    let parsed;
    // TextDecoder drops a leading BOM, as the site API's reader does; a file that does not parse is refused.
    try { parsed = JSON.parse(new TextDecoder('utf-8').decode(body)); } catch { throw new HttpError(403, 'request.json must be valid JSON.'); }
    if (parsed?.origin?.kind === 'owner') throw new HttpError(403, 'A request from the owner is written by the Hub only.');
  };
  /**
   * An Ask is written once. A limited writer may create ask.json (If-None-Match: *) and never replace it, so what the
   * owner was shown, and what the Discord buttons were built from, cannot be rewritten by an agent. A presigned upload
   * URL cannot enforce create-only, so it is refused for ask.json too.
   */
  const askCreateOnly = (caller, sectionId, file, { ifNoneMatch, upload = false } = {}) => {
    if (INBOXES.has(sectionId) && caller.rights.write !== null && ASK_FILE.test(file) && (upload || ifNoneMatch !== '*')) {
      throw new HttpError(403, 'ask.json, checklist.json, request.json, delivered.json and watch-*.json are create-only.');
    }
  };
  /**
   * A change-list Ask (ws-qdh.3) is refused with every problem named when its `changes` are not valid: the same check the site and the cards
   * client make (site/api/ask-changes.mjs). Only a limited writer's ask.json is looked at; one that does not parse, or has no `changes`, passes.
   */
  const changesValid = (caller, sectionId, file, body) => {
    if (!INBOXES.has(sectionId) || caller.rights.write === null || !/^asks\/[^/]+\/ask\.json$/i.test(file)) return;
    let parsed;
    try { parsed = JSON.parse(new TextDecoder('utf-8').decode(body)); } catch { return; }
    if (!parsed || typeof parsed !== 'object' || parsed.changes === undefined) return;
    const problems = validateChanges(parsed.changes);
    if (problems.length) throw new HttpError(422, `The change list is not valid: ${problems.slice(0, 6).join('; ')}.`);
  };
  /** An agent-edit Ask (ws-im1.4.1) is refused with its problems named when its `agentEdit` is not valid: the same check as the site's and the cards client's. */
  const agentEditValid = (caller, sectionId, file, body) => {
    if (!INBOXES.has(sectionId) || caller.rights.write === null || !/^asks\/[^/]+\/ask\.json$/i.test(file)) return;
    let parsed;
    try { parsed = JSON.parse(new TextDecoder('utf-8').decode(body)); } catch { return; }
    if (!parsed || typeof parsed !== 'object' || parsed.agentEdit === undefined) return;
    const problems = validateAgentEdit(parsed);
    if (problems.length) throw new HttpError(422, `The agent edit is not valid: ${problems.slice(0, 6).join('; ')}.`);
  };
  /**
   * A review the owner can do nothing with is not filed: a `ready-for-review` event (events/<day>/<name>.json, or deeper) needs a pull request
   * link (`url`, or `prs`) or an `ask` (the owner's action, one line). Every other event kind and every other file passes. A file that is
   * not JSON passes too: the Hub reads only what parses.
   */
  const reviewNeedsAction = (sectionId, file, body) => {
    // The Hub lists events/<day>/ without a delimiter, so a file in a subfolder is read as an event too.
    if (!INBOXES.has(sectionId) || !/^events\/[^/]+\/.+\.json$/i.test(file)) return;
    let parsed;
    try { parsed = JSON.parse(new TextDecoder('utf-8').decode(body)); } catch { return; }
    if (parsed?.kind !== 'ready-for-review') return;
    const pr = value => typeof value === 'string' && /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/.test(value);
    if (pr(parsed.url) || (Array.isArray(parsed.prs) && parsed.prs.some(pr)) || (typeof parsed.ask === 'string' && parsed.ask.trim())) return;
    throw new HttpError(422, 'A ready-for-review event needs a pull request link (url or prs) or an ask: the one line saying what the owner should decide or do. Add the PR or the decision.');
  };
  /** A limited deleter keeps its hands off the Hub's files: asks, answers, snoozes and declines. */
  const hubFilesStay = (caller, sectionId, file) => {
    if (INBOXES.has(sectionId) && caller.rights.delete !== null && (ASK_FILE.test(file) || OWNER_FILES.test(file) || RUNNER_FILES.test(file) || APPLIED_RECORD.test(file) || /^bead-marks\//i.test(file) || /^feedback\//i.test(file) || /^agent-config\//i.test(file))) {
      throw new HttpError(403, 'Only the Hub removes asks, answers, checklists, ticks, marks and request files.');
    }
  };

  const findEntity = (registry, ref) => registry.entities.find(item => item?.id === ref) ?? registry.entities.find(item => item?.folder === ref);

  /**
   * The site's record of a card that was moved to another workspace or put in the Trash, by id or
   * folder (`retired` in workspace.json, written only by the site). Null when the card is not retired.
   */
  const retiredBy = (registry, ref) => {
    const records = registry.retired && typeof registry.retired === 'object' ? registry.retired : {};
    const id = Object.keys(records).find(key => key === ref) ?? Object.keys(records).find(key => records[key]?.folder === ref || records[key]?.entity?.folder === ref);
    return id ? { id, ...records[id] } : null;
  };

  /**
   * The refusal for a retired card. The new workspace is named only to a token that may read it; any
   * other token is told the card moved, not where.
   */
  function retiredError(caller, sectionId, record, verb) {
    const status = verb === 'write' ? 409 : 404;
    if (record.kind === 'moved') {
      if (record.to && can(caller, 'read', record.to)) {
        return new HttpError(status, `Card "${record.id}" was moved to ${record.to}; ${verb === 'write' ? 'update it there' : 'read it there'}.`, { movedTo: { section: record.to, folder: record.folder ?? null } });
      }
      return new HttpError(status, `Card "${record.id}" was moved to another workspace.`);
    }
    return new HttpError(status, `Card "${record.id}" is in the Trash of ${sectionId}; ${verb === 'write' ? 'restore it first' : 'restore it to read it'}.`);
  }

  /** The retired record whose folder is `folder` in any case, or null. */
  const retiredFolded = (registry, folder) => {
    const records = registry.retired && typeof registry.retired === 'object' ? registry.retired : {};
    const id = Object.keys(records).find(key => [records[key]?.folder, records[key]?.entity?.folder].some(name => typeof name === 'string' && lower(name) === lower(folder)));
    return id ? { id, ...records[id] } : null;
  };

  /** The retired card a write would collide with: one with this id, or one that owns this folder. Null when a live card has the id. */
  function retiredClaim(registry, id, folder) {
    if (registry.entities.some(item => item?.id === id)) return null;
    return registry.retired?.[id] ? { id, ...registry.retired[id] } : retiredBy(registry, folder);
  }

  async function cardFiles(sectionId, folder) {
    const base = keyOf(sectionId, `${folder}/`);
    const { objects } = await bucket.list(base);
    return objects.map(object => ({ path: object.key.slice(keyOf(sectionId, '').length), size: object.size, etag: object.etag, lastModified: object.lastModified }));
  }

  /**
   * Marks the step that shows `path` in `folder`'s card as an agent's tab (`agentTab: true`), so the viewer attaches no card bridge to
   * it. Returns the path when it set the mark now, null when there was nothing to mark or it was already marked. The list write is
   * conditional and retried; a list that cannot be written refuses the file write (nothing has changed yet).
   */
  async function markAgentTab(caller, sectionId, folder, stepPath) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const { registry, etag } = await section(caller, sectionId, 'write');
      const index = registry.entities.findIndex(item => item?.folder === folder);
      const card = registry.entities[index];
      const at = (card?.steps ?? []).findIndex(step => (step?.path ?? step?.file) === stepPath);
      if (at < 0 || card.steps[at].agentTab === true) return null;
      const entity = { ...card, steps: card.steps.with(at, { ...card.steps[at], agentTab: true }) };
      try {
        await bucket.putJson(keyOf(sectionId, 'workspace.json'), { ...registry, entities: registry.entities.with(index, entity) }, { ifMatch: etag });
        return stepPath;
      } catch (error) {
        if (error.status !== 412 && error.status !== 409) throw error;
      }
    }
    throw new HttpError(409, 'The card list kept changing under this write; try again.');
  }

  const routes = {
    async listSections(caller) {
      const ids = await sectionIds(caller);
      const sections = await Promise.all(ids.map(async id => {
        const got = await bucket.getJson(keyOf(id, 'workspace.json')).catch(() => null);
        if (!Array.isArray(got?.value?.entities)) return null;
        return { id, name: got.value.name || id, cards: got.value.entities.length, access: await accessOf(caller, id, got.value) };
      }));
      return { sections: sections.filter(Boolean) };
    },

    async getSection(caller, id) {
      const { registry } = await section(caller, id, 'read');
      return { id, name: registry.name || id, cards: registry.entities.map(summary), access: await accessOf(caller, id, registry) };
    },

    async getCard(caller, sectionId, ref) {
      const { registry } = await section(caller, sectionId, 'read');
      const entity = findEntity(registry, ref);
      if (!entity) {
        const record = retiredBy(registry, ref);
        if (record) throw retiredError(caller, sectionId, record, 'read');
        throw new HttpError(404, `No card "${ref}" in ${sectionId}.`);
      }
      const files = await cardFiles(sectionId, entity.folder);
      const withUrls = await Promise.all(files.map(async file => ({ ...file, url: await bucket.presign('GET', keyOf(sectionId, file.path), { expires: urlTtl }) })));
      return { section: sectionId, entity, files: withUrls, urlsExpireIn: urlTtl };
    },

    async putCard(caller, sectionId, id, entity, headers = {}) {
      if (!entity || typeof entity !== 'object' || Array.isArray(entity)) throw new HttpError(400, 'Send the card entry as a JSON object.');
      if (entity.id !== id) throw new HttpError(400, `The entry's id must be "${id}", the id in the path.`);
      if (typeof entity.title !== 'string' || !entity.title.trim()) throw new HttpError(400, 'The entry needs a title.');
      if (!Array.isArray(entity.steps)) throw new HttpError(400, 'The entry needs a steps array.');
      if (entity.purpose !== undefined && !PURPOSES.includes(entity.purpose)) throw new HttpError(422, `purpose is "report" or "reference"; leave it out when unsure.`, { fields: ['purpose'] });
      if (typeof entity.folder !== 'string' || !cardPath(`${entity.folder}/x`) || entity.folder.includes('/')) {
        throw new HttpError(400, 'The entry needs a folder: one name, not starting with "_" or ".".');
      }
      if (INBOXES.has(sectionId) && caller.rights.write !== null) throw new HttpError(403, 'The inbox holds files, not cards.');
      const first = await section(caller, sectionId, 'write');
      const library = first.library;
      const limited = caller.rights.write !== null;
      const info = writeInfo(headers, { strict: library });
      if (limited && reservedName(entity.folder)) throw new HttpError(403, `"${entity.folder}" is not a card folder here.`);
      if (library && !first.registry.entities.some(item => item?.id === id) && skippedName(entity.folder)) throw new HttpError(403, `"${entity.folder}" is not a card folder here.`);
      const existingFirst = library ? first.registry.entities.find(item => item?.id === id) : null;
      const folder = existingFirst?.folder ?? entity.folder;
      /** A step an agent adds is { name, path, viewer? }: no url (it would frame any web address). A posted `agentTab` is dropped; the server sets it. */
      const checkStep = step => {
        if (!step || typeof step !== 'object' || Array.isArray(step)) throw new HttpError(422, 'Each step is { name, path, viewer? }.');
        const extra = Object.keys(step).filter(name => !['name', 'path', 'viewer', 'agentTab'].includes(name));
        if (extra.length) throw new HttpError(422, `A step is { name, path, viewer? }; not: ${extra.join(', ')}.`, { fields: extra });
        if (typeof step.name !== 'string' || !step.name.trim() || !stepPathOk(step.path) || (step.viewer !== undefined && typeof step.viewer !== 'string')) {
          throw new HttpError(422, 'Each step is { name, path, viewer? }, with a name and a path to a file in the folder.');
        }
        return { name: step.name, path: step.path, ...(step.viewer !== undefined ? { viewer: step.viewer } : {}) };
      };
      let posted = [];
      if (library && !existingFirst) {
        // The server builds the entry. A Library right adds a card or appends tabs; it never sets pinned, tags, removedTabs and the like.
        if (!libraryFolderOk(entity.folder)) throw new HttpError(422, 'The folder is letters, digits, dots, dashes and underscores, starting with a letter or digit, and is no Windows device name.');
        const extra = Object.keys(entity).filter(name => !ENTRY_FIELDS.has(name));
        if (extra.length) throw new HttpError(422, `A new card from an agent may not set: ${extra.join(', ')}.`, { fields: extra });
        if (entity.status !== undefined && entity.status !== 'active') throw new HttpError(422, 'A new card from an agent is active.');
        posted = entity.steps.map(checkStep);
      }
      const claimed = retiredClaim(first.registry, id, folder) ?? (library && !existingFirst ? retiredFolded(first.registry, folder) : null);
      if (claimed) throw retiredError(caller, sectionId, claimed, 'write');
      const files = await cardFiles(sectionId, folder);
      if (!files.length) throw new HttpError(409, `${folder}/ has no files yet: upload them first, then add the card.`);
      const refused = files.filter(file => SECRET.test(file.path) || file.size > MAX_FILE).map(file => file.path);
      if (refused.length) throw new HttpError(422, 'Some files look like secrets or are over 50 MB; delete them first.', { files: refused });
      const mustExist = steps => {
        const missing = steps.filter(step => !files.some(file => file.path === `${folder}/${step.path}`)).map(step => step.path);
        if (missing.length) throw new HttpError(422, `A step's path must be a file already in ${folder}/: ${missing.join(', ')}.`, { files: missing });
      };
      mustExist(posted);

      const stepKey = step => step?.path ?? step?.file ?? step?.name;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const { registry, etag } = await section(caller, sectionId, 'write');
        const clash = registry.entities.find(item => item?.folder === folder && item?.id !== id);
        if (clash) throw new HttpError(409, `Folder ${folder} already belongs to card "${clash.id}".`);
        if (library) {
          const lower = registry.entities.find(item => item?.id !== id && typeof item?.folder === 'string' && item.folder.toLowerCase() === folder.toLowerCase());
          if (lower) throw new HttpError(409, `Folder ${folder} is the same name as ${lower.folder} in another case; Windows would treat them as one.`);
        }
        const index = registry.entities.findIndex(item => item?.id === id);
        const taken = retiredClaim(registry, id, folder) ?? (library && index < 0 ? retiredFolded(registry, folder) : null);
        if (taken) throw retiredError(caller, sectionId, taken, 'write');
        const before = index >= 0 ? registry.entities[index] : null;
        let stored;
        const ignored = [];
        if (library && before) {
          // The stored entry stays, field by field; only steps with a new path are appended, marked as an agent's tab.
          const known = new Set((before.steps ?? []).map(stepKey));
          // A tab the owner took off (or Revert did) stays off: bringing it back would undo that.
          const removed = new Set((Array.isArray(before.removedTabs) ? before.removedTabs : []).map(item => (typeof item === 'string' ? item : item?.path ?? item?.file)).filter(Boolean));
          const added = [];
          for (const raw of entity.steps) {
            if (removed.has(raw?.path) && !known.has(raw?.path)) { if (!ignored.includes(`removed tab: ${raw.path}`)) ignored.push(`removed tab: ${raw.path}`); continue; }
            if (known.has(raw?.path) || added.some(item => item.path === raw?.path)) continue;
            added.push({ ...checkStep(raw), agentTab: true });
          }
          mustExist(added);
          for (const [name, value] of Object.entries(entity)) {
            if (['steps', 'updated', 'id'].includes(name)) continue;
            if (JSON.stringify(value) !== JSON.stringify(before[name])) ignored.push(name);
          }
          const same = (before.steps ?? []).every(step => {
            const match = entity.steps.find(item => item?.path === stepKey(step));
            return match && match.name === (step.name ?? step.title) && (match.viewer ?? null) === (step.viewer ?? null);
          });
          if (!same) ignored.push('steps');
          if (!added.length && before.updated === today()) return { section: sectionId, entity: before, created: false, unchanged: true, ignored };
          stored = { ...before, steps: [...(before.steps ?? []), ...added], updated: today() };
        } else {
          // A writer that rebuilds its entry without `purpose` keeps the stored one.
          stored = { ...entity, ...(library ? { steps: posted } : {}), ...(entity.purpose === undefined && before?.purpose !== undefined ? { purpose: before.purpose } : {}), updated: entity.updated ?? today() };
        }
        const entities = index >= 0 ? registry.entities.with(index, stored) : [...registry.entities, stored];
        let put;
        try {
          put = await bucket.putJson(keyOf(sectionId, 'workspace.json'), { ...registry, entities }, { ifMatch: etag });
        } catch (error) {
          // AWS can answer 409 as well as 412 for a write that raced another.
          if (error.status !== 412 && error.status !== 409) throw error;
          continue;
        }
        const answer = { section: sectionId, entity: stored, created: index < 0, ...(library ? { ignored } : {}) };
        if (limited) {
          const old = new Set((before?.steps ?? []).map(stepKey));
          const added = (stored.steps ?? []).map(stepKey).filter(key => !old.has(key));
          // A write that only moved `updated` has no row.
          if (index < 0 || added.length) {
            answer.recorded = await record(sectionId, folder, writeId(), {
              file: 'workspace.json', kind: index < 0 ? 'new-card' : 'new-tab', entry: true, cardId: id, steps: added,
              agent: info.agent ?? 'unknown', token: caller.name, versionId: put.versionId, previousVersionId: null,
              etag: put.etag, previousEtag: etag, context: info.context, why: info.why ?? '', batch: info.batch,
            });
          }
        }
        return answer;
      }
      throw new HttpError(409, 'The card list kept changing under this write; try again.');
    },

    async listFiles(caller, sectionId, prefixValue) {
      const wanted = String(prefixValue ?? '');
      if (/^[/_.]/.test(wanted) || wanted.split('/').some(part => part === '..' || part === '.') || /[\\\0]/.test(wanted)) {
        throw new HttpError(400, 'prefix is empty or a relative path: no "..", and not starting with "/", "_" or ".".');
      }
      const hostChange = wanted.startsWith('agent-config/changes/');
      await section(caller, sectionId, 'read', { hostChange });
      const base = keyOf(sectionId, '');
      const { objects } = await bucket.list(keyOf(sectionId, wanted));
      const files = objects
        .map(object => ({ path: object.key.slice(base.length), size: object.size, etag: object.etag, lastModified: object.lastModified }))
        .filter(file => cardPath(file.path) && !SECRET.test(file.path))
        // A caller with no read right of its own (the Hermes host) sees the change files and nothing else under that prefix.
        .filter(file => !hostChange || can(caller, 'read', sectionId) || HOST_CHANGE_FILE.test(file.path))
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      return { files: files.slice(0, MAX_LISTED), truncated: files.length > MAX_LISTED };
    },

    async getFile(caller, sectionId, file) {
      await section(caller, sectionId, 'read', { hostChange: HOST_CHANGE_FILE.test(file) });
      const key = keyOf(sectionId, file);
      let head;
      try {
        head = await bucket.head(key);
      } catch (error) {
        if (error.status === 404) throw new HttpError(404, `No file ${file} in ${sectionId}.`);
        throw error;
      }
      if (head.size > MAX_INLINE) {
        throw new HttpError(413, 'Too big to send through the API; download it from url.', { url: await bucket.presign('GET', key, { expires: urlTtl }) });
      }
      const got = await bucket.get(key);
      const body = Buffer.from(await new Response(got.body).arrayBuffer());
      // The stored writer mark, or `none` for an object with no mark (the Hub's own writes): hub-hooks reads it to tell the owner's presence.json from one put through this API. Only the inbox sections send it: no other section holds a presence file, so a mark-less object there must not look like the Hub's.
      return { raw: body, contentType: got.contentType || contentTypeOf(file), etag: got.etag, ...(INBOXES.has(sectionId) ? { writer: got.metadata?.writer || 'none' } : {}) };
    },

    async putFile(caller, sectionId, file, body, contentType, { ifNoneMatch, ifMatch, headers = {} } = {}) {
      if (SECRET.test(file)) throw new HttpError(422, `${file} looks like a secret; it is not uploaded.`);
      if (body.length > MAX_INLINE) throw new HttpError(413, 'Over 4 MB: ask POST /sections/{section}/uploads for an upload URL.');
      const first = await section(caller, sectionId, 'write');
      const limited = caller.rights.write !== null;
      // The records of who wrote what are the card API's own: no token, the passphrase included, writes them through a route.
      if (INBOXES.has(sectionId) && /^card-writes\//i.test(file)) throw new HttpError(403, 'card-writes/ is written by the card API itself.');
      if (limited && !INBOXES.has(sectionId) && reservedName(file.split('/')[0])) throw new HttpError(403, `"${file.split('/')[0]}" is not a card folder here.`);
      ownerOnly(caller, sectionId, file);
      appliedOnly(caller, sectionId, file, { ifNoneMatch });
      agentConfigOnly(caller, sectionId, file, { ifNoneMatch });
      markFiles(caller, sectionId, file, { ifNoneMatch });
      feedbackFiles(caller, sectionId, file, { ifNoneMatch });
      await runnerOnly(caller, sectionId, file);
      askCreateOnly(caller, sectionId, file, { ifNoneMatch });
      noOwnerOrigin(caller, sectionId, file, body);
      changesValid(caller, sectionId, file, body);
      agentEditValid(caller, sectionId, file, body);
      reviewNeedsAction(sectionId, file, body);
      const key = keyOf(sectionId, file);
      // A limited writer in a project section (not an inbox) leaves a record; a Library right also has to say who and why, and write conditionally.
      const recorded = limited && !INBOXES.has(sectionId);
      const folder = file.split('/')[0];
      let info = null;
      let id = null;
      let previous = null;
      if (first.library) {
        if (!libraryPathOk(file)) throw new HttpError(422, `${file} is not a safe path: letters, digits, space, dot, dash, underscore and brackets in each part, no Windows device names, no trailing dot or space.`);
        if (!ifNoneMatch && !ifMatch) throw new HttpError(428, 'Writes to a project section are conditional. Fetch the cards client again.');
        info = writeInfo(headers, { strict: true, needContext: Boolean(ifMatch) });
        const claimed = retiredBy(first.registry, folder);
        if (claimed) throw retiredError(caller, sectionId, claimed, 'write');
        if (reservedName(folder) || skippedName(folder)) throw new HttpError(403, `"${folder}" is not a card folder here.`);
        if (ifMatch && SCRIPT_FILE.test(file)) throw new HttpError(403, 'A script file is not edited by an agent: add a new tab with a new file name instead.');
        const retiredVariant = retiredFolded(first.registry, folder);
        if (retiredVariant) throw retiredError(caller, sectionId, retiredVariant, 'write');
        const liveVariant = first.registry.entities.find(item => typeof item?.folder === 'string' && item.folder !== folder && lower(item.folder) === lower(folder));
        if (liveVariant) throw new HttpError(409, `${folder} is the same name as the folder ${liveVariant.folder} in another case, and Windows would treat them as one.`);
        // S3 allows a key below another key, and a folder spelled two ways; Windows allows neither: one such file would stop every publish and
        // pull of the section, or land in the other spelling's folder. Every path part is compared without case.
        const lowFile = lower(file);
        const prefixesOf = value => value.split('/').map((_, index, parts) => parts.slice(0, index + 1).join('/'));
        const mine = prefixesOf(file);
        const clash = (await cardFiles(sectionId, folder)).find(item => {
          if (item.path === file) return false;
          const other = lower(item.path);
          if (other === lowFile || lowFile.startsWith(`${other}/`) || other.startsWith(`${lowFile}/`)) return true;
          const spelled = new Map(prefixesOf(item.path).map(prefix => [lower(prefix), prefix]));
          return mine.some(prefix => spelled.has(lower(prefix)) && spelled.get(lower(prefix)) !== prefix);
        });
        if (clash) throw new HttpError(409, `${clash.path} is already there; ${file} would sit below it, on it, or have the same name in another case, and Windows cannot hold both.`);
      } else if (recorded) {
        info = writeInfo(headers);
      }
      if (recorded) id = writeId();
      if (recorded && ifMatch) {
        let head;
        try { head = await bucket.head(key); } catch (error) { if (error.status !== 404) throw error; }
        if (!head || head.etag !== ifMatch) throw new HttpError(412, 'That file changed since you read it.');
        previous = head;
      }
      // An agent's edit of an owner's HTML page could keep calling the card bridge with the owner's sign-in: the step loses the bridge until Revert clears the mark.
      const marked = first.library && ifMatch && /\.html?$/i.test(file) ? await markAgentTab(caller, sectionId, folder, file.slice(folder.length + 1)) : null;
      let put;
      try {
        put = await bucket.put(key, body, {
          contentType: first.library ? contentTypeOf(file) : typeOf(contentType, file),
          ifNoneMatch, ifMatch,
          metadata: first.library ? { writer: caller.name, agent: info.agent, 'write-id': id } : writerMetadata(caller, sectionId, file),
        });
      } catch (error) {
        // AWS can answer 409 as well as 412 for a write that raced another.
        if (error.status === 412 || error.status === 409) throw new HttpError(412, ifNoneMatch ? 'That file already exists.' : 'That file changed since you read it.');
        throw error;
      }
      const answer = { path: file, size: body.length, etag: put.etag, ...(put.versionId ? { versionId: put.versionId } : {}) };
      if (recorded) {
        const owned = first.registry.entities.some(item => item?.folder === folder);
        answer.recorded = await record(sectionId, folder, id, {
          file, kind: ifMatch ? 'edit' : owned ? 'new-tab' : 'new-card', entry: false,
          agent: info.agent ?? 'unknown', token: caller.name,
          versionId: put.versionId, previousVersionId: previous?.versionId ?? null, etag: put.etag, previousEtag: previous?.etag ?? null,
          context: info.context, why: info.why ?? '', batch: info.batch,
          ...(marked ? { markedAgentTab: marked } : {}),
        });
      }
      return answer;
    },

    async deleteFile(caller, sectionId, file) {
      await section(caller, sectionId, 'delete');
      if (INBOXES.has(sectionId) && /^card-writes\//i.test(file)) throw new HttpError(403, 'card-writes/ is written by the card API itself.');
      hubFilesStay(caller, sectionId, file);
      await bucket.del(keyOf(sectionId, file));
      return { path: file, deleted: true };
    },

    async uploads(caller, sectionId, request) {
      const files = Array.isArray(request?.files) ? request.files : null;
      if (!files?.length || files.length > 50) throw new HttpError(400, 'Send { files: [{ path }] }, 1 to 50 of them.');
      const first = await section(caller, sectionId, 'write');
      // A presigned URL carries no condition, no metadata and no record.
      if (first.library) throw new HttpError(403, 'A project section takes files through the API, at most 4 MB each.');
      const uploads = await Promise.all(files.map(async item => {
        const file = cardPath(item?.path);
        if (!file) throw new HttpError(400, `Not a card path: ${item?.path}`);
        if (SECRET.test(file)) throw new HttpError(422, `${file} looks like a secret; it is not uploaded.`);
        if (INBOXES.has(sectionId) && /^card-writes\//i.test(file)) throw new HttpError(403, 'card-writes/ is written by the card API itself.');
        if (caller.rights.write !== null && !INBOXES.has(sectionId) && reservedName(file.split('/')[0])) throw new HttpError(403, `"${file.split('/')[0]}" is not a card folder here.`);
        ownerOnly(caller, sectionId, file);
        appliedOnly(caller, sectionId, file, { upload: true });
        // A presigned URL carries no metadata, so an upload there would land unmarked and count: refused for every caller, the passphrase too.
        if (INBOXES.has(sectionId) && /^team\/[^/]+\/persona-/i.test(file)) throw new HttpError(403, 'Persona files are written by the Hub only, never by upload URL.');
        agentConfigOnly(caller, sectionId, file, { upload: true });
        markFiles(caller, sectionId, file, { upload: true });
        feedbackFiles(caller, sectionId, file, { upload: true });
        await runnerOnly(caller, sectionId, file);
        askCreateOnly(caller, sectionId, file, { upload: true });
        return { path: file, method: 'PUT', url: await bucket.presign('PUT', keyOf(sectionId, file), { expires: urlTtl }) };
      }));
      return { uploads, urlsExpireIn: urlTtl, maxBytes: MAX_FILE };
    },

    async resolve(caller, ref) {
      const wanted = parseRef(ref);
      if (!wanted.card && !wanted.folder) throw new HttpError(400, 'Send ?ref= a site link, section/card, or a card id or title.');
      const ids = wanted.section ? [wanted.section] : await sectionIds(caller);
      const needle = (wanted.card ?? '').toLowerCase();
      const matches = [];
      const moved = [];
      let trashed = null;
      for (const id of ids) {
        const { registry } = await section(caller, id, 'read').catch(error => {
          if (wanted.section) throw error;
          return { registry: { entities: [] } };
        });
        for (const entity of registry.entities) {
          if (!entity) continue;
          const hit = wanted.folder
            ? entity.folder === wanted.folder || entity.id === wanted.folder
            : entity.id === wanted.card || entity.folder === wanted.card || entity.title?.toLowerCase() === needle;
          if (hit) matches.push({ section: id, ...summary(entity) });
        }
        // A card the site moved: follow it into its new workspace. One in the Trash is only named.
        if (!matches.some(match => match.section === id)) {
          const record = retiredBy(registry, wanted.folder ?? wanted.card);
          if (record?.kind === 'moved' && record.to) moved.push({ from: id, id: record.id, to: record.to });
          else if (record) trashed ??= { section: id, id: record.id };
        }
      }
      for (const hop of moved) {
        const target = await section(caller, hop.to, 'read').catch(() => null);
        const entity = target?.registry.entities.find(item => item?.id === hop.id);
        if (!entity) continue;
        const known = matches.find(match => match.section === hop.to && match.id === hop.id);
        if (known) known.movedFrom ??= hop.from;
        else matches.push({ section: hop.to, ...summary(entity), movedFrom: hop.from });
      }
      if (!matches.length && trashed) throw new HttpError(404, `Card "${trashed.id}" is in the Trash of ${trashed.section}; restore it first.`);
      if (!matches.length) throw new HttpError(404, `Nothing matches "${ref}".`);
      return { matches };
    },
  };

  return async function handle(event) {
    const method = event.requestContext?.http?.method ?? 'GET';
    const segments = (event.rawPath ?? '/').split('/').filter(Boolean).map(decodeURIComponent);
    const headers = Object.fromEntries(Object.entries(event.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]));
    const raw = () => (event.body == null ? Buffer.alloc(0) : Buffer.from(event.body, event.isBase64Encoded ? 'base64' : 'utf8'));
    const json = () => {
      try {
        return JSON.parse(raw().toString('utf8') || '{}');
      } catch {
        throw new HttpError(400, 'Expected a JSON body.');
      }
    };
    try {
      // A browser's CORS preflight carries no credentials. The catch-all route sends it here, so answer
      // it before authenticating; API Gateway adds the CORS headers from the template.
      if (method === 'OPTIONS') return { statusCode: 204, headers: { 'cache-control': 'no-store' }, body: '' };
      if (event.rawPath === '/cards.mjs' && ['GET', 'HEAD'].includes(method)) {
        // The client learns its own address from the host that served it, so a session that fetches it
        // from the API needs no setup. With no host to go by, it is served unchanged.
        let body = await readFile(CLIENT, 'utf8');
        const domain = event.requestContext?.domainName || headers.host;
        if (domain && /^[a-z0-9.:-]+$/i.test(domain)) body = body.replace("const SERVED_API = '';", () => `const SERVED_API = ${JSON.stringify(`https://${domain}`)};`);
        return { statusCode: 200, headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache' }, body };
      }
      const caller = authenticate(headers);
      const [root, sectionId, kind, ...rest] = segments;
      let result;
      if (root === 'resolve' && segments.length === 1 && method === 'GET') {
        result = await routes.resolve(caller, event.queryStringParameters?.ref);
      } else if (root === 'sections' && !sectionId && method === 'GET') {
        result = await routes.listSections(caller);
      } else if (root === 'sections' && sectionId && !kind && method === 'GET') {
        result = await routes.getSection(caller, sectionId);
      } else if (root === 'sections' && kind === 'cards' && rest.length === 1 && method === 'GET') {
        result = await routes.getCard(caller, sectionId, rest[0]);
      } else if (root === 'sections' && kind === 'cards' && rest.length === 1 && method === 'PUT') {
        result = await routes.putCard(caller, sectionId, rest[0], json(), headers);
      } else if (root === 'sections' && kind === 'uploads' && !rest.length && method === 'POST') {
        result = await routes.uploads(caller, sectionId, json());
      } else if (root === 'sections' && kind === 'files' && !rest.length && method === 'GET') {
        result = await routes.listFiles(caller, sectionId, event.queryStringParameters?.prefix);
      } else if (root === 'sections' && kind === 'files' && ['GET', 'PUT', 'DELETE'].includes(method)) {
        // One file lives at the root of the inbox, outside any card folder: the Away switch. Limited tokens may read it and never write it (OWNER_FILES).
        const file = INBOXES.has(sectionId) && rest.join('/') === 'presence.json' ? 'presence.json' : cardPath(rest.join('/'));
        if (!file) throw new HttpError(400, 'A file path is <card folder>/<file>, not starting with "_" or ".".');
        if (method === 'GET') result = await routes.getFile(caller, sectionId, file);
        if (method === 'PUT') result = await routes.putFile(caller, sectionId, file, raw(), headers['content-type'], {
          ifNoneMatch: headers['if-none-match'] === '*' ? '*' : undefined,
          ifMatch: headers['if-match']?.replace(/^W\//, '').replace(/^"|"$/g, '') || undefined,
          headers,
        });
        if (method === 'DELETE') result = await routes.deleteFile(caller, sectionId, file);
      } else {
        throw new HttpError(404, `No route ${method} ${event.rawPath}.`);
      }
      if (result?.raw) {
        return {
          statusCode: 200,
          headers: { 'content-type': result.contentType, etag: `"${result.etag}"`, 'cache-control': 'no-store', ...(result.writer ? { 'x-card-writer': result.writer } : {}) },
          body: result.raw.toString('base64'),
          isBase64Encoded: true,
        };
      }
      return { statusCode: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: JSON.stringify(result) };
    } catch (error) {
      const status = error instanceof HttpError ? error.status : error.status === 404 ? 404 : 500;
      if (status === 500) console.error(error);
      const message = status === 500 ? 'Something went wrong; see the function log.' : error.message;
      return { statusCode: status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: JSON.stringify({ error: message, ...(error.extra ?? {}) }) };
    }
  };
}

let ready;
/** Lambda's entry point: configuration from the environment the template sets. */
export async function handler(event) {
  ready ??= createCardApi({
    bucket: createBucket({ bucket: process.env.BUW_S3_BUCKET, region: process.env.BUW_S3_REGION, endpoint: process.env.BUW_S3_ENDPOINT || undefined }),
    tokens: [
      ...(process.env.BUW_CARD_PASSPHRASE ? [{ name: 'passphrase', hash: sha256(process.env.BUW_CARD_PASSPHRASE), rights: EVERYTHING }] : []),
      ...parseTokens(process.env.BUW_CARD_TOKENS),
    ],
    prefix: process.env.BUW_S3_PREFIX || 'sections',
  });
  return ready(event);
}
