// Requests in the Hub: the schema of `request.json`, the files that sit beside it, the state they add up
// to, the detail of one request, and Decline and Mark done. hub.mjs creates this module and delegates the
// `/hub/requests*` routes to it; the pure parts (the state table, the list row) live in hub-model.mjs so
// that Work and the tests can use them without a bucket.
//
// A request is a folder `requests/<id>/` of create-only files. Its state is never stored: it is derived
// from which files exist (docs/workspaces.md, "Requests"). Every file the server writes for itself is
// written with `ifNoneMatch: '*'`; a 412 means someone wrote it first and is answered with a 409.
import { checkDrawing } from './card-writes.mjs';
import { chatModelOf, chatModelsForClient } from './chat-models.mjs';
import { RULES, SUBJECT_RE, minutesOf, presetOf, presetsForClient, renderBrief, route, runBlock } from './presets.mjs';
import { createHash, createPublicKey, randomBytes } from 'node:crypto';
import { AGENTS } from './hub-team.mjs';
import { newNonce, sha256Hex, sign, verify } from './signing.mjs';
import { WHEN, newRequestId, requestItem, requestState, runFileTime, staleSince, validId, validProject } from './hub-model.mjs';

/** The needs a request may name. */
export const NEEDS = ['unity', 'gpu', 'comfyui', 'sprite-studio', 'lan', 'local-files'];
/** How long a request waits for the PC before the cloud is offered. */
export const MOVE_AFTER_MS = 6 * 3600 * 1000;
/** Where a request may run: the proposal in `request.json`, and the final target in `approved.json` (never `at-pc`). */
export const TARGETS = ['pc', 'cloud', 'hermes', 'at-pc'];
export const ORIGIN_KINDS = ['owner', 'agent', 'run'];
export const REQUEST_LIMITS = { subject: 200, text: 4000, title: 120, doneWhen: 400, reason: 400, summary: 500, question: 600, answer: 2000, followSummary: 500, name: 80, reply: 2000, replies: 5, maxReplies: 10 };
/** `owner/name` as GitHub spells them: an owner of letters, digits and single dashes, a name of letters, digits, dots, dashes and underscores. */
const REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}\/(?!\.{1,2}$)[\w.-]{1,100}$/;
export const validRepo = value => typeof value === 'string' && REPO_RE.test(value);
/** The presets that are for one agent. */
const AVATAR_PRESETS = ['agent-avatar', 'agent-avatar-sheet'];
const PRESET_RE = /^[a-z][a-z0-9-]{0,39}$/;
/** How many run and fire files the detail lists. */
const LIST_CAP = 20;

const text = (value, max, what, { required = false } = {}) => {
  const clean = typeof value === 'string' ? value.trim() : '';
  if (!clean) {
    if (required) throw Object.assign(new Error(`${what} is 1 to ${max} characters.`), { status: 400 });
    return undefined;
  }
  if (clean.length > max) throw Object.assign(new Error(`${what} is 1 to ${max} characters.`), { status: 400 });
  return clean;
};

/**
 * Check what a request is made from and return the clean fields. Throws a 400 in plain English. `raw` holds
 * `project`, `text` and either `when` (a legacy request) or `preset`; the optional fields are `title`, `repo`,
 * `needs`, `target`, `model`, `doneWhen`, `replaces`, `origin`, `followUp` and `continues`. Unknown fields are dropped. The id, the
 * time and the author are the server's to add.
 *
 * `fromOwner` is true only for the site API acting for a signed-in person: it alone may set `origin.kind`
 * `owner`, a `followUp` or `continues`. A request an agent makes (the card API, `cards request create`) never is.
 */
export function checkRequest(raw, { fromOwner = false } = {}) {
  const fail = message => Object.assign(new Error(message), { status: 400 });
  const data = raw && typeof raw === 'object' ? raw : {};
  if (!validProject(data.project)) throw fail('Name the project (lower-case letters, digits and dashes).');
  const body = text(data.text, REQUEST_LIMITS.text, 'A request', { required: true });
  const out = { project: data.project, text: body };
  if (data.preset !== undefined && data.preset !== null) {
    if (typeof data.preset !== 'string' || !PRESET_RE.test(data.preset)) throw fail('That preset is not a name.');
    out.preset = data.preset;
  } else {
    if (!WHEN.includes(data.when)) throw fail('Say when: next-sprint, nightly or record.');
    out.when = data.when;
  }
  // The agent an avatar job is for: required and known for the avatar presets, dropped for every other request.
  if (AVATAR_PRESETS.includes(out.preset)) {
    if (typeof data.agent !== 'string' || !AGENTS.some(agent => agent.id === data.agent)) throw fail('An avatar job is for one of the agents on the Team screen. Open it from an agent\'s Custom tab.');
  }
  const title = text(data.title, REQUEST_LIMITS.title, 'A title');
  if (title) out.title = title;
  if (data.repo !== undefined && data.repo !== null && data.repo !== '') {
    if (typeof data.repo !== 'string' || !REPO_RE.test(data.repo)) throw fail('The repo is owner/name.');
    out.repo = data.repo;
  }
  if (data.needs !== undefined && data.needs !== null) {
    if (!Array.isArray(data.needs) || data.needs.some(need => !NEEDS.includes(need))) throw fail(`Needs are any of: ${NEEDS.join(', ')}.`);
    out.needs = [...new Set(data.needs)];
  }
  if (data.target !== undefined && data.target !== null && data.target !== '') {
    if (!TARGETS.includes(data.target)) throw fail('The target is pc, cloud, hermes or at-pc.');
    out.target = data.target;
  }
  // The model of a Hermes job: an id from chat-models.mjs, 400 on any other. Auto is the default and is not stored, so a request
  // without a choice keeps the bytes it always had.
  if (data.model !== undefined && data.model !== null && data.model !== '') {
    const picked = chatModelOf(data.model);
    if (picked.provider) {
      if (!out.preset) throw fail('A model can be chosen for a preset job only.');
      out.model = picked.id;
    }
  }
  const doneWhen = text(data.doneWhen, REQUEST_LIMITS.doneWhen, '"Done when"');
  if (doneWhen) out.doneWhen = doneWhen;
  if (AVATAR_PRESETS.includes(out.preset)) out.agent = data.agent;
  if (data.replaces !== undefined && data.replaces !== null && data.replaces !== '') {
    if (!validId(data.replaces)) throw fail('"Replaces" is a request id.');
    out.replaces = data.replaces;
  }
  if (data.origin !== undefined && data.origin !== null) {
    const origin = data.origin;
    if (typeof origin !== 'object' || Array.isArray(origin) || !ORIGIN_KINDS.includes(origin.kind)) throw fail('The origin is { kind: owner, agent or run, name }.');
    if (origin.kind === 'owner' && !fromOwner) throw fail('Only the site can mark a request as the owner\'s.');
    const name = text(origin.name, REQUEST_LIMITS.name, 'The origin name');
    out.origin = { kind: origin.kind, ...(name ? { name } : {}) };
  }
  if (data.textOrigin !== undefined && data.textOrigin !== null) {
    if (!fromOwner) throw fail('Only the site can say who wrote the job text.');
    const written = data.textOrigin;
    if (typeof written !== 'object' || Array.isArray(written) || !ORIGIN_KINDS.includes(written.kind)) throw fail('The text origin is { kind: owner, agent or run, name }.');
    const writtenName = text(written.name, REQUEST_LIMITS.name, 'The text origin name');
    out.textOrigin = { kind: written.kind, ...(writtenName ? { name: writtenName } : {}) };
  }
  if (data.doneWhenOrigin !== undefined && data.doneWhenOrigin !== null) {
    if (!fromOwner) throw fail('Only the site can say who wrote the "done when".');
    const doneBy = data.doneWhenOrigin;
    if (typeof doneBy !== 'object' || Array.isArray(doneBy) || !ORIGIN_KINDS.includes(doneBy.kind)) throw fail('The "done when" origin is { kind: owner, agent or run, name }.');
    const doneByName = text(doneBy.name, REQUEST_LIMITS.name, 'The "done when" origin name');
    out.doneWhenOrigin = { kind: doneBy.kind, ...(doneByName ? { name: doneByName } : {}) };
  }
  // The avatar sheet request (the site API makes it after the owner picks a variant): the Ask, the pick and the subject it names.
  if (data.fromAsk !== undefined && data.fromAsk !== null) {
    if (!fromOwner) throw fail('Only the site can say which Ask a request came from.');
    if (!validId(data.fromAsk)) throw fail('The Ask is an Ask id.');
    out.fromAsk = data.fromAsk;
  }
  if (data.choice !== undefined && data.choice !== null) {
    if (!fromOwner) throw fail('Only the site can record a pick.');
    if (typeof data.choice !== 'string' || !/^[a-d]$/.test(data.choice)) throw fail('The pick is a to d.');
    out.choice = data.choice;
  }
  if (data.subject !== undefined && data.subject !== null) {
    if (!fromOwner) throw fail('Only the site can record a subject.');
    if (typeof data.subject !== 'string' || !SUBJECT_RE.test(data.subject)) throw fail('The subject is a path of up to 200 letters, digits, spaces and . _ / : -.');
    out.subject = data.subject;
  }
  if (data.followUp !== undefined && data.followUp !== null) {
    if (!fromOwner) throw fail('Only the site can add a follow-up.');
    const follow = data.followUp;
    if (typeof follow !== 'object' || Array.isArray(follow) || !validId(follow.from)) throw fail('A follow-up names the request it follows.');
    out.followUp = {
      from: follow.from,
      question: text(follow.question, REQUEST_LIMITS.question, 'The follow-up question', { required: true }),
      answer: text(follow.answer, REQUEST_LIMITS.answer, 'The follow-up answer', { required: true }),
      summary: text(follow.summary, REQUEST_LIMITS.followSummary, 'The follow-up summary') ?? '',
    };
  }
  // A continuation: the owner's reply to a Hermes job that ended. The earlier report is read at approval, never stored here.
  if (data.continues !== undefined && data.continues !== null) {
    if (!fromOwner) throw fail('Only the site can continue a request.');
    if (out.followUp) throw fail('A request is a follow-up or a continuation, not both.');
    const next = data.continues;
    if (typeof next !== 'object' || Array.isArray(next) || !validId(next.from)) throw fail('A continuation names the request it continues.');
    if (!Array.isArray(next.replies) || next.replies.length < 1 || next.replies.length > REQUEST_LIMITS.replies) throw fail(`A continuation carries 1 to ${REQUEST_LIMITS.replies} replies.`);
    out.continues = { from: next.from, replies: next.replies.map(reply => text(reply, REQUEST_LIMITS.reply, 'A reply', { required: true })) };
  }
  return out;
}

/**
 * The id of the copy a rerun makes: one per original request (sha256 tail, like `sheetRequestId`), so a second Ask, a second
 * answer, a retry or a restarted server all meet the same id. Anyone can work the id out, so a request found at it counts
 * only when the site wrote it for this original.
 */
export function rerunRequestId(requestId) {
  const tail = createHash('sha256').update(`rerun:${requestId}`).digest('hex').slice(0, 4);
  return `${String(requestId).slice(0, 115)}-${tail}`;
}

/**
 * @param bucket        the s3.mjs bucket
 * @param key           `inboxKey` bound to this hub's prefix and inbox
 * @param cached        reads a create-only JSON file through the cache (null when missing)
 * @param putCreateOnly writes a file with `ifNoneMatch: '*'`, throwing the given error on a 412
 * @param listFolders   `(root, at) → Map<id, Set<file name>>` for this month and the one before
 * @param pool          bounded parallel map
 * @param projectRepo  `(project) → 'owner/name' | undefined`: the repo the project's section tracks
 * @param cloudRepos   `() → string[]`: repos with a cloud routine
 * @param hasCloud     `(repo) → boolean`: whether a repo has a cloud routine (default: `cloudRepos()` holds it)
 * @param signingKey   the Ed25519 private key (signing.mjs `loadSigningKey`), or null: Approve and Stop then answer 503
 * @param approveReason  what the page says when there is no key
 * @param hooks         `{ hermesLive(id) → boolean, pcBusy(session) → boolean }`; the Hermes follower and the PC report
 *                      plug in here (both default to false)
 */
export function createRequests({ bucket, key, cached, putCreateOnly, listFolders, pool, fail, hooks = {}, projectRepo = async () => undefined, bunnylinkRepo = async () => null, repoProjects = [], extraRepos = [], cloudRepos = () => [], hasCloud = repo => cloudRepos().includes(repo), signingKey = null, approveReason = '', cloudNever = [], neverRepos = [], log = () => {}, scrub = text => String(text ?? '').replace(/https?:\/\/\S+/gi, '').slice(0, 80) }) {
  // handOff[target](id) starts an approved request (Hermes: 1.10, cloud: M3c) and may answer `{ waiting: '<reason>' }`;
  // stopRun(id) stops a Hermes run. Both are plugged in later and default to doing nothing.
  const live = { wakeOnApprove: async () => false, hermesLive: () => false, pcBusy: () => false, stopRun: async () => {}, steer: async () => ({ delivery: 'queued', reason: 'Hermes is not set up on this host.' }), retryFire: async () => { throw fail('Not found', 404); }, cloudStatus: async () => null, ...hooks, handOff: { hermes: async () => null, cloud: async () => null, ...(hooks.handOff ?? {}) } };
  const clash = message => fail(message, 409);
  /** Bunnylink work (the homelab) is never signed for the PC or the cloud: the owner starts it at the PC. */
  const BUNNYLINK_AT_PC = 'Bunnylink work is started by you at the PC.';
  const NEVER_REPO = 'That repo is never run for you by the PC or the cloud; start work on it yourself at the PC.';
  const NOT_HERMES = 'Replies go to Hermes jobs. A PC or cloud run can\'t take a message yet.';
  const MODEL_ON_HERMES = 'A model can be chosen for a job that runs on Hermes.';

  /**
   * Whether a request that waits for the PC can be moved to the cloud, and if not, why. It must be approved for the PC and
   * not taken, for 6 hours or more; its preset must allow the cloud; neither the preset nor the request may need anything
   * only the PC has; it needs a repo that has a routine; and its project may not be Bunnylink or in `HUB_CLOUD_NEVER`.
   */
  const publicKey = signingKey ? createPublicKey(signingKey) : null;
  /** One spelling of a repo for comparing: lower case, no trailing `.git` (REPO_RE allows `owner/name.git`). */
  const normRepo = repo => String(repo).trim().toLowerCase().replace(/\.git$/, '');
  // HUB_NEVER_REPOS: entries that are not `owner/name` are logged and dropped.
  const configuredNever = neverRepos.filter(repo => {
    if (validRepo(repo)) return true;
    log(`[hub] HUB_NEVER_REPOS: dropped an entry that is not owner/name (${String(repo).replace(/[^\x20-\x7e]/g, '?').slice(0, 60)})`);
    return false;
  }).map(normRepo);
  /**
   * The repos no request may be signed for, whatever its project: the Bunnylink project's own repo (the homelab) and `HUB_NEVER_REPOS`. The project
   * guard alone is not enough: another project that names that repo would otherwise be signed for the PC or the cloud. It fails closed: when the
   * Bunnylink repo cannot be read (a storage error) or the Bunnylink section has no tracked repo, `unknown` says so and every request that names a
   * repo is refused for the PC and the cloud, because it could be that repo. No Bunnylink section at all means nothing to protect.
   * → `{ set: Set of normalised repos, unknown: { status, message } | null }`.
   */
  async function neverRepoSet() {
    const set = new Set(configuredNever);
    let home;
    try {
      home = await bunnylinkRepo();
    } catch (error) {
      log(`[hub] could not read the Bunnylink project's repo, so PC and cloud approvals for a repo are refused: ${error.message}`);
      return { set, unknown: { status: 503, message: 'Could not check which repos are off limits just now; try again.' } };
    }
    if (home === '') {
      log('[hub] the bunnylink section has no tracked repo, so PC and cloud approvals for a repo are refused until it has one');
      return { set, unknown: { status: 400, message: 'The Bunnylink project has no tracked repo, so the Hub cannot tell which repos are off limits; set it in the Bunnylink workspace.json.' } };
    }
    if (home) set.add(normRepo(home));
    return { set, unknown: null };
  }
  /** Why a request naming `repo` may not be signed for the PC or the cloud: `{ status, message }`, or null. */
  const neverProblem = (never, repo) => (!repo ? null : never.set.has(normRepo(repo)) ? { status: 400, message: NEVER_REPO } : never.unknown);
  function moveEligibility(request, state, approved, at, stored = null, never = { set: new Set(), unknown: null }) {
    const preset = presetOf(request.preset);
    if (!preset) return 'Only a request made from a preset can move.';
    if (state !== 'approved') return `That request is ${state}; it cannot move to the cloud.`;
    if (approved?.target !== 'pc') return `That request is approved for ${approved?.target ?? 'nothing'}, not the PC.`;
    // The old approval is checked as the queue checks a cloud one: this host's signature, this request, the PC, not expired and, when
    // the stored bytes are at hand (the route), the hash of the request. An approval signed by another key is never offered or re-signed.
    if (!publicKey || !verify(approved, publicKey)) return 'The approval on that request failed the server\'s check.';
    if (approved.request !== request.id || !(Date.parse(approved.expires) > at.getTime())) return 'The approval on that request failed the server\'s check.';
    if (stored && approved.requestSha256 !== sha256Hex(stored.buffer)) return 'The approval on that request failed the server\'s check.';
    if (at.getTime() - Date.parse(approved.at) < MOVE_AFTER_MS) return 'It has not waited 6 hours yet.';
    if (!preset.targets.includes('cloud')) return `${preset.label} cannot run in the cloud.`;
    if (preset.needs.length || (request.needs ?? []).length) return 'It needs something only the PC has.';
    if (!request.repo) return 'A cloud run needs a repo.';
    if (!hasCloud(request.repo)) return 'There is no cloud routine for that repo.';
    if (request.project === 'bunnylink' || cloudNever.includes(request.project)) return 'That project does not run in the cloud.';
    const never_ = neverProblem(never, request.repo);
    if (never_) return never_.message === NEVER_REPO ? 'That repo does not run in the cloud.' : never_.message;
    return null;
  }
  const moving = new Set();

  /** The newest run file's time, ignoring any later than `at` plus the skew (see `runFileTime`). */
  const newestRun = (names, at) => {
    let newest = null;
    for (const name of names) {
      const time = runFileTime(name, at);
      if (time !== null && (newest === null || time > newest)) newest = time;
    }
    return newest;
  };

  /** The state-bearing files of one request, read only when they exist. */
  async function readParts(id, names, request) {
    const read = file => (names.has(file) ? cached(`requests/${id}/${file}`) : null);
    const legacy = !request.preset;
    const [taken, approved, result] = await Promise.all([read('taken.json'), legacy ? null : read('approved.json'), !legacy || names.has('taken.json') ? read('result.json') : null]);
    return { taken, approved, result };
  }

  const stateOf = (id, names, request, parts, at) => requestState({
    names, request, ...parts, newestRunAt: newestRun(names, at), hermesLive: live.hermesLive(id) === true, pcBusy: live.pcBusy, now: at,
  });

  /** Every request of this month and the one before, as list rows. */
  async function loadRequests(at) {
    const folders = await listFolders('requests', at);
    const never = await neverRepoSet();
    const rows = await pool(16, [...folders], async ([id, names]) => {
      if (!names.has('request.json') || !validId(id)) return null;
      const request = await cached(`requests/${id}/request.json`);
      if (!request || typeof request.text !== 'string') return null;
      const full = { ...request, id };
      const parts = await readParts(id, names, full);
      const state = stateOf(id, names, full, parts, at);
      // Where a cloud request stands (queued, fired, waiting, fire-failed, not-started); null for everything else.
      const cloud = parts.approved?.target === 'cloud' ? await live.cloudStatus(id, { names, state, approved: parts.approved }, at).catch(() => null) : null;
      const offer = moveEligibility(full, state, parts.approved, at, null, never) === null ? 'move-to-cloud' : null;
      // (The list pass skips the request hash; the route checks it.)
      return requestItem(full, state, parts.taken, { ...parts, cloud, offer, lastRunAt: newestRun(names, at), now: at });
    });
    return rows.filter(Boolean);
  }

  /** The names directly inside `requests/<id>/`, or null when the folder has no request.json. */
  async function folderNames(id) {
    if (!validId(id)) throw fail('No such request.', 404);
    const base = key(`requests/${id}/request.json`).slice(0, -'request.json'.length);
    const { objects } = await bucket.list(base);
    const names = new Set(objects.map(object => object.key.slice(base.length)).filter(name => name && !name.includes('/')));
    if (!names.has('request.json')) throw fail('No such request.', 404);
    return names;
  }

  /** One request, its file names and the state-bearing files. 404 when it does not exist. */
  async function loadOne(id, at) {
    const names = await folderNames(id);
    const stored = await cached(`requests/${id}/request.json`);
    if (!stored || typeof stored.text !== 'string') throw fail('No such request.', 404);
    const request = { ...stored, id };
    const parts = await readParts(id, names, request);
    return { names, request, parts, state: stateOf(id, names, request, parts, at) };
  }

  /** The newest `limit` files of a family (`run-*`, `fire-*`), parsed, newest first; the stamp in the name sorts by time. */
  async function newestFiles(id, names, prefix, limit = LIST_CAP, at = null) {
    // A run file stamped in the future (past the skew) is not shown in the timeline either.
    const picked = [...names].filter(name => name.startsWith(prefix) && name.endsWith('.json') && (prefix !== 'run-' || at === null || runFileTime(name, at) !== null)).sort().reverse().slice(0, limit);
    const bodies = await pool(8, picked, name => cached(`requests/${id}/${name}`));
    return bodies.filter(Boolean);
  }

  /** A fire record as the page may see it: without `routine`, the repo key it was fired through. */
  const publicFire = ({ routine: _routine, ...fire }) => fire;

  /** `GET /hub/requests/:id`. `approved` comes without its signed brief (`run.brief`): it is long and the run view does not show it. */
  async function requestDetail(id, at) {
    const { names, request, parts, state } = await loadOne(id, at);
    const read = file => (names.has(file) ? cached(`requests/${id}/${file}`) : null);
    const [stop, declined, hermesRun, retry, claim, runs, fires] = await Promise.all([
      read('stop.json'), read('declined.json'), read('hermes-run.json'), read('hermes-retry.json'), read('continued.json'),
      newestFiles(id, names, 'run-', LIST_CAP, at), newestFiles(id, names, 'fire-'),
    ]);
    const { approved } = parts;
    const cloudFull = approved?.target === 'cloud' ? await live.cloudStatus(id, { names, state, approved }, at, { withFires: true }).catch(() => null) : null;
    const cloud = cloudFull?.fires ? { ...cloudFull, fires: cloudFull.fires.map(publicFire) } : cloudFull;
    const shown = approved && approved.run ? { ...approved, run: Object.fromEntries(Object.entries(approved.run).filter(([name]) => name !== 'brief')) } : approved;
    const stale = staleSince(requestItem(request, state, parts.taken, { ...parts, lastRunAt: newestRun(names, at) }), at);
    // The signed claim of a continuation (`continued.json`); one that does not verify for this request is not shown.
    const continued = claim && publicKey && verify(claim, publicKey) && claim.request === id && validId(claim.to) ? { to: claim.to, at: claim.at } : null;
    const replyList = await replyDetails(id, names, continued ? claim : null);
    return {
      request,
      state,
      ...(stale ? { stale } : {}),
      ...(replyList.length ? { replies: replyList } : {}),
      ...(shown ? { approved: shown } : {}),
      ...(parts.taken ? { taken: parts.taken } : {}),
      runs,
      ...(parts.result ? { result: parts.result } : {}),
      ...(hermesRun ? { hermesRun } : {}),
      ...(cloud ? { cloud } : {}),
      ...(retry ? { retry } : {}),
      ...(continued ? { continued } : {}),
      fires: fires.map(publicFire),
      ...(stop ? { stop } : {}),
      ...(declined ? { declined } : {}),
      files: [...names].sort(),
      report: names.has('report.md'),
    };
  }

  /**
   * `POST /hub/requests`. The legacy body is `{ project, text, when, drawing? }`. With a `preset` it is
   * `{ project, text, title?, preset, repo?, needs?, target?, doneWhen?, replaces?, drawing? }`: the request is
   * the owner's (`origin.kind: owner`, set here and never taken from the body) and carries the proposed target.
   */
  async function createRequest(data, user, at) {
    const { origin: _origin, followUp: _followUp, continues: _continues, textOrigin: _textOrigin, doneWhenOrigin: _doneWhenOrigin, ...body } = data ?? {};
    const clean = checkRequest(body, { fromOwner: true });
    const preset = clean.preset ? presetOf(clean.preset) : null;
    if (clean.preset && !preset) throw fail('There is no such preset.', 400);
    if (preset?.hidden) throw fail('That preset is started by the Hub, not by a request.', 400);
    if (preset && !user) throw fail('Sign in to send a job.', 401);
    let proposal = {};
    if (preset) {
      const repo = clean.repo ?? (preset.fields.includes('repo') ? await projectRepo(clean.project) : undefined);
      const needs = clean.needs ?? (preset.needs.length ? preset.needs : undefined);
      if (clean.project === 'bunnylink' && clean.target && clean.target !== 'at-pc') throw fail(BUNNYLINK_AT_PC, 400);
      const neverWhy = neverProblem(await neverRepoSet(), repo);
      const neverRepo = !!neverWhy;
      if (neverWhy && clean.target && clean.target !== 'at-pc' && clean.target !== 'hermes') throw fail(neverWhy.message, neverWhy.status);
      if (clean.target && clean.target !== 'at-pc' && !preset.targets.includes(clean.target)) throw fail(`${preset.label} runs on ${preset.targets.join(' or ')}.`, 400);
      const routed = route({ preset, project: clean.project, needs: needs ?? [], repo, cloudRepos: hasCloud });
      proposal = {
        ...(clean.title ? { title: clean.title } : {}), preset: preset.id, ...(repo ? { repo } : {}), ...(needs ? { needs } : {}),
        target: clean.project === 'bunnylink' || (neverRepo && (clean.target ?? routed.target) !== 'hermes') ? 'at-pc' : clean.target ?? routed.target, ...(clean.doneWhen ? { doneWhen: clean.doneWhen } : {}), ...(clean.agent ? { agent: clean.agent } : {}),
        origin: { kind: 'owner', name: user }, ...(clean.replaces ? { replaces: clean.replaces } : {}),
      };
      proposal.why = clean.target ? 'you chose it' : routed.why;
      if (clean.model && proposal.target !== 'hermes') throw fail(MODEL_ON_HERMES, 400);
      if (clean.model) proposal.model = clean.model;
    }
    const checked = data.drawing ? checkDrawing({ scene: data.drawing.scene, png: data.drawing.png }) : null;
    const { why, ...stored } = proposal;
    const made = await writeNew(clean.project, clean.text, at, id => ({ id, project: clean.project, createdAt: at.toISOString(), by: user || 'local', text: clean.text, ...(preset ? stored : { when: clean.when }) }), checked);
    return { status: 201, body: { id: made.id, ...(preset ? { target: made.request.target, why } : {}) } };
  }

  /** Write a new request folder under a free id: `build(id)` gives its request.json body; a drawing is stored beside it. */
  async function writeNew(project, text, at, build, checked = null, fixedId = null) {
    for (let attempt = 0; attempt < (fixedId ? 1 : 3); attempt += 1) {
      const id = fixedId ?? newRequestId(project, text, at);
      const conflict = fail('Could not find a free id; try again.', 409);
      try {
        const request = build(id);
        if (checked) {
          await putCreateOnly(`requests/${id}/request.excalidraw`, checked.sceneText, 'application/json', conflict);
          await putCreateOnly(`requests/${id}/request.png`, checked.pngBuffer, 'image/png', conflict);
          request.drawing = { excalidraw: 'request.excalidraw', png: 'request.png' };
        }
        // Who wrote the file is recorded as metadata: every request made here is the site's. Policy approval trusts this, not a field in the body.
        await putCreateOnly(`requests/${id}/request.json`, `${JSON.stringify(request, null, 2)}\n`, 'application/json', conflict, { writer: 'site' });
        return { id, request };
      } catch (error) {
        if (error !== conflict || attempt === 2) throw error;
      }
    }
    throw fail('Could not find a free id; try again.', 409);
  }

  /** `GET /hub/presets`, `/hub/presets/route?preset=&project=&repo=` and `/hub/presets/brief?request=<id>`. */
  async function presetRoutes(path, query, at) {
    if (path === '/hub/presets') return { presets: presetsForClient(), rules: RULES, models: chatModelsForClient().filter(entry => entry.id !== 'codex') };   // Spawn's menu is for pinning a paid model; Auto already tries Codex first, so Codex is a chat choice only
    if (path === '/hub/presets/repos') {
      // The repos Spawn offers: each project's own (its section's tracked repo, in the project table's order), then the ones the host lists.
      const seen = new Set();
      const repos = [];
      for (const project of repoProjects) {
        const repo = await projectRepo(project);
        if (repo && validRepo(repo) && !seen.has(repo)) { seen.add(repo); repos.push({ repo, project }); }
      }
      for (const repo of extraRepos) if (validRepo(repo) && !seen.has(repo)) { seen.add(repo); repos.push({ repo }); }
      return { repos };
    }
    if (path === '/hub/presets/route') {
      const preset = presetOf(query.get('preset'));
      if (!preset) throw fail('There is no such preset.', 400);
      const project = query.get('project') ?? '';
      if (!validProject(project)) throw fail('Name the project.', 400);
      const repo = query.get('repo') || (preset.fields.includes('repo') ? await projectRepo(project) : undefined);
      return route({ preset, project, repo: repo || undefined, cloudRepos: hasCloud });
    }
    if (path === '/hub/presets/brief') {
      const { request } = await loadOne(query.get('request') ?? '', at);
      const preset = presetOf(request.preset);
      if (!preset || request.target !== 'at-pc') throw fail('Only a request you start at the PC has a brief to copy.', 400);
      return { brief: renderBrief({ preset, request }) };
    }
    throw fail('Not found', 404);
  }

  /** `POST /hub/requests/:id/decline { reason? }`: only a request nobody has acted on (open, proposed or expired). */
  async function declineRequest(id, raw, user, at) {
    const { state } = await loadOne(id, at);
    if (state === 'declined') throw fail('That request is already declined.', 409);
    if (!['open', 'proposed', 'expired'].includes(state)) {
      throw fail(state === 'approved' ? 'That request is approved: stop it instead.' : `That request is ${state}; it can no longer be declined.`, 409);
    }
    const reason = text(raw?.reason, REQUEST_LIMITS.reason, 'A reason');
    const body = { at: at.toISOString(), by: user, ...(reason ? { reason } : {}) };
    await putCreateOnly(`requests/${id}/declined.json`, `${JSON.stringify(body, null, 2)}\n`, 'application/json', clash('That request is already declined.'));
    return { status: 201, body: { state: 'declined' } };
  }

  /** `POST /hub/requests/:id/done { summary? }`: Mark done on a request the owner runs at the PC. Not signed. */
  async function doneRequest(id, raw, user, at) {
    const { request, state } = await loadOne(id, at);
    if (request.preset === undefined || request.target !== 'at-pc') throw fail('Only a request for the PC (at-pc) is marked done by hand.', 400);
    if (state !== 'proposed') throw fail(`That request is ${state}.`, 409);
    const summary = text(raw?.summary, REQUEST_LIMITS.summary, 'The summary');
    const body = { v: 1, outcome: 'manual', ...(summary ? { summary } : {}), by: 'hub', at: at.toISOString() };
    await putCreateOnly(`requests/${id}/result.json`, `${JSON.stringify(body, null, 2)}\n`, 'application/json', clash('That request already has a result.'));
    return { status: 201, body: { state: 'done' } };
  }

  /** Who wrote this request's "done when", for a copy the owner approves: the author it already names, else the request's own (an agent's or a run's), else nobody. */
  function doneWhenAuthor(request, origin) {
    if (!request.doneWhen) return null;
    if (request.doneWhenOrigin) return request.doneWhenOrigin.kind === 'owner' ? null : request.doneWhenOrigin;
    return (origin ?? {}).kind === 'owner' ? null : (origin ?? { kind: 'agent' });
  }

  const needKey = () => { if (!signingKey) throw fail(approveReason, 503); };
  const writeSigned = (id, file, doc, message) => putCreateOnly(`requests/${id}/${file}`, `${JSON.stringify(doc, null, 2)}\n`, 'application/json', clash(message));
  const withoutBrief = approved => (approved?.run ? { ...approved, run: Object.fromEntries(Object.entries(approved.run).filter(([name]) => name !== 'brief')) } : approved);

  /**
   * The body of a stored request.json as the signer reads it: parsed after any BOM, then checked again with `checkRequest`.
   * Whether the request counts as the site's is decided by its own `origin.kind`: only `owner` (which the card API refuses
   * from an agent, and the site API sets itself) may carry a `followUp`. An agent's follow-up is refused, never signed
   * into a brief as "The owner answered". Returns the clean fields plus `id`.
   */
  function checkedRequest(id, buffer) {
    let stored;
    try { stored = JSON.parse(buffer.toString('utf8').replace(/^﻿/, '')); } catch { throw fail('That request is not valid JSON.', 400); }
    if (!stored || typeof stored !== 'object') throw fail('That request is not valid JSON.', 400);
    const fromOwner = stored.origin?.kind === 'owner';
    return { ...checkRequest(stored, { fromOwner }), id };
  }

  /**
   * Every rule that makes a request unapprovable whatever its state: a Bunnylink request is never signed (second wall behind createRequest, also for
   * Approve again and a follow-up), a request you start at the PC is never signed, the target must suit the preset, a model is for Hermes, a cloud run
   * needs a repo with a routine. `approveRequest` runs it, and so does `copyFor` BEFORE it writes the copy, so a refused Approve again leaves nothing behind.
   */
  async function refuseUnapprovable(request, preset, chosen) {
    if (request.project === 'bunnylink') throw fail(BUNNYLINK_AT_PC, 400);
    // The repo guard: another project that names the Bunnylink repo (or a repo in HUB_NEVER_REPOS) is never signed for the PC or the cloud either.
    if (chosen === 'pc' || chosen === 'cloud') {
      const why = neverProblem(await neverRepoSet(), request.repo);
      if (why) throw fail(why.message, why.status);
    }
    if (chosen === 'at-pc') throw fail('A request you start at the PC is never signed. Mark it done when you have done it.', 400);
    if (!preset.targets.includes(chosen)) throw fail(`${preset.label} runs on ${preset.targets.join(' or ')}.`, 400);
    if (request.model && chosen !== 'hermes') throw fail(MODEL_ON_HERMES, 400);
    if (chosen === 'cloud' && !request.repo) throw fail('A cloud run needs a repo.', 400);
    if (chosen === 'cloud' && !hasCloud(request.repo)) throw fail(`No cloud routine for ${request.repo}.`, 400);
  }

  /** What the earlier run left: its report (or, with none, its summary) and its card. These are the run's words; the brief quotes them as such. */
  async function readEarlier(from) {
    const [report, result] = await Promise.all([bucket.getBytes(key(`requests/${from}/report.md`)).catch(() => null), cached(`requests/${from}/result.json`).catch(() => null)]);
    return { report: report ? report.buffer.toString('utf8').replace(/^\ufeff/, '') : String(result?.summary ?? ''), card: typeof result?.card === 'string' ? result.card : null };
  }

  /**
   * Sign and store `approved.json` for a proposed request, then hand it to its target. The one path that signs
   * an approval: the Approve route, Approve again, a follow-up and policy approval (`by: 'policy'`) all use it.
   * There is no cap check: a full target makes the request wait in `approved`, and `waiting` says why.
   */
  async function approveRequest(id, { target, by, at }) {
    needKey();
    const { state, names } = await loadOne(id, at);
    if (!names.has('request.json')) throw fail('No such request.', 404);
    // Read request.json once, as bytes: the hash covers exactly these bytes, and the checks and the brief are made from the same body.
    const stored = await bucket.getBytes(key(`requests/${id}/request.json`));
    if (!stored) throw fail('No such request.', 404);
    const request = checkedRequest(id, stored.buffer);
    const preset = presetOf(request.preset);
    if (!preset) throw fail('Only a request made from a preset can be approved.', 400);
    if (state !== 'proposed') throw fail(`That request is ${state}; only a proposed one can be approved.`, 409);
    // A hidden preset is the Hub's own: only a request the site wrote (owner origin, from an Ask) can be signed, never one an agent wrote at that id.
    if (preset.hidden && !(request.origin?.kind === 'owner' && request.fromAsk && await siteWrote(id))) throw fail('That request was not made by the Hub, so it cannot be approved.', 400);
    const chosen = target ?? request.target;
    await refuseUnapprovable(request, preset, chosen);
    // A continuation quotes the earlier run's report (read here, not stored in request.json). Only a request the site wrote can carry one.
    let earlier;
    if (request.continues) {
      if (!await siteWrote(id)) throw fail('That request was not made by the Hub, so it cannot be approved.', 400);
      earlier = await readEarlier(request.continues.from);
    }
    const body = {
      v: 1, request: id, project: request.project, repo: request.repo ?? null, target: chosen,
      requestSha256: sha256Hex(stored.buffer), limits: { minutes: minutesOf(preset) },
      expires: new Date(at.getTime() + 72 * 3600 * 1000).toISOString(), nonce: newNonce(), at: at.toISOString(), by,
      run: runBlock({ preset, request, earlier }),
    };
    const approved = sign(body, signingKey);
    await writeSigned(id, 'approved.json', approved, 'That request is already approved.');
    // The approval is signed and stored. A target that cannot start it now makes the request wait; it never fails the approval.
    let waiting;
    let cloud;
    let woke = false;
    try {
      if (chosen === 'pc') woke = (await live.wakeOnApprove({ by, at })) === true;
      const handed = chosen === 'pc' ? null : await live.handOff[chosen](id, { at });
      if (handed?.waiting) waiting = handed.waiting;
      if (chosen === 'cloud' && handed) cloud = { fired: handed.fired === true, ...(handed.reason ? { reason: handed.reason } : {}), ...(handed.next ? { next: handed.next } : {}) };
    } catch (error) {
      log(`[hub] hand-off to ${chosen} failed for ${id}: ${scrub(error.message, 120)}`);
      waiting = `Could not start yet: ${scrub(error.message, 80)}`;
    }
    const after = await loadOne(id, at).catch(() => null);
    return { state: after?.state ?? 'approved', approved: withoutBrief(approved), ...(waiting ? { waiting } : {}), ...(cloud ? { cloud } : {}), ...(woke ? { wake: 'sent' } : {}) };
  }

  /** The signed stop of a request, allowed only in the given states. */
  async function writeStop(id, reason, by, at, states) {
    const { state } = await loadOne(id, at);
    if (!states.includes(state)) throw fail(`That request is ${state}; it cannot be stopped.`, 409);
    const body = sign({ v: 1, request: id, reason: reason ?? 'stopped by the owner', at: at.toISOString(), by, nonce: newNonce() }, signingKey);
    await writeSigned(id, 'stop.json', body, 'That request is already stopped.');
    return state;
  }

  /**
   * The signed allow grant of a rerun copy (`requests/<copy>/allow-grant.json`): the owner tapped Allow on these rules, for this Ask.
   * It is written before the copy's approval and is not an approval or a stop: `kind: 'pc-allow'`, `grantFor` instead of `request`.
   * The PC applies it only when the rules and the Ask are its own. Create-only: a second call accepts an identical grant of ours.
   */
  async function writeAllowGrant(copyId, { original, ask, project, rules, user, at }) {
    needKey();
    const body = sign({
      v: 1, kind: 'pc-allow', grantFor: copyId, original, ask, project, rules, at: at.toISOString(),
      expires: new Date(at.getTime() + 72 * 3600 * 1000).toISOString(), nonce: newNonce(), by: user,
    }, signingKey);
    try {
      await writeSigned(copyId, 'allow-grant.json', body, 'That request already has an allow grant.');
    } catch (error) {
      if (error.status !== 409) throw error;
      const existing = (await bucket.getJson(key(`requests/${copyId}/allow-grant.json`)).catch(() => null))?.value;
      const same = existing && verify(existing, publicKey) && existing.kind === 'pc-allow' && existing.grantFor === copyId && existing.ask === ask
        && Array.isArray(existing.rules) && JSON.stringify(existing.rules) === JSON.stringify(rules);
      if (!same) throw fail('That request id is taken; nothing started.', 409);
    }
  }

  const STOPPABLE = ['approved', 'expired', 'taken', 'running', 'lost', 'asking'];

  /** `POST /hub/requests/:id/approve { target? }` */
  async function approveRoute(id, raw, user, at) {
    if (raw?.target !== undefined && !TARGETS.includes(raw.target)) throw fail('The target is pc, cloud or hermes.', 400);
    return { status: 201, body: await approveRequest(id, { target: raw?.target, by: user, at }) };
  }

  /** `POST /hub/requests/:id/stop { reason? }`: a signed stop; for a Hermes run it also stops the run. */
  async function stopRoute(id, raw, user, at) {
    needKey();
    const reason = text(raw?.reason, REQUEST_LIMITS.reason, 'A reason');
    const was = await writeStop(id, reason, user, at, STOPPABLE);
    const after = await loadOne(id, at);
    if (after.parts.approved?.target === 'hermes') { try { await live.stopRun(id); } catch { /* the stop is written; the follower sees it */ } }
    return { status: 201, body: { state: after.state, was } };
  }

  /**
   * The copy of a request that `replaces` it, written as the owner's: the one place that builds it (Approve again, the cloud move
   * and a rerun). The old request must be in one of `states`. `raw` is the owner's edit (text, title, model, doneWhen);
   * `target` overrides the target; `followUp` and `fromAsk` replace the old ones; `fixedId` is a create-only id.
   * → `{ made, target, state }`; nothing is approved or retired here.
   */
  async function copyFor(id, { states, raw = {}, target: forced, user, at, followUp: newFollow, fromAsk, fixedId = null }) {
    const { parts, state } = await loadOne(id, at);
    if (!states.includes(state)) throw fail(`That request is ${state}; it cannot be approved again.`, 409);
    const stored = await bucket.getBytes(key(`requests/${id}/request.json`));
    if (!stored) throw fail('No such request.', 404);
    // The copy is the owner's, so it keeps only what passes the check the signer makes: no agent-written follow-up.
    const { id: _id, ...request } = checkedRequest(id, stored.buffer);
    const preset = presetOf(request.preset);
    if (!preset) throw fail('Only a request made from a preset can be approved again.', 400);
    const target = forced ?? raw?.target ?? parts.approved?.target ?? request.target;
    if (!preset.targets.includes(target)) throw fail(`${preset.label} runs on ${preset.targets.join(' or ')}.`, 400);
    const { origin: oldOrigin, followUp: oldFollow, continues: oldContinues, ...kept } = request;
    const followUp = newFollow ?? oldFollow;
    // A copy of a continuation is still one, unless it now carries a follow-up (a request is one or the other).
    const continues = followUp ? undefined : oldContinues;
    // "Done when" may be rewritten (an empty one removes it); the length check is the one a new request gets.
    if (raw?.doneWhen !== undefined && typeof raw.doneWhen !== 'string') throw fail('"Done when" is text.', 400);
    const { doneWhen: _oldDone, ...withoutDone } = kept;
    const copy = raw?.doneWhen === undefined ? kept : raw.doneWhen.trim() ? { ...withoutDone, doneWhen: raw.doneWhen } : withoutDone;
    // The copy is the owner's. Unless the owner rewrote the text, it still says who wrote it.
    const wroteText = raw?.text !== undefined || (oldOrigin ?? {}).kind === 'owner' ? null : (request.textOrigin ?? oldOrigin ?? { kind: 'agent' });
    // The "done when" has its own author: rewriting the text does not make an agent's "done when" the owner's.
    // Only a "done when" the owner changed (or removed) is the owner's; one sent back as it was keeps its author.
    const ownerChangedDone = raw?.doneWhen !== undefined && raw.doneWhen.trim() !== String(request.doneWhen ?? '').trim();
    const doneBy = ownerChangedDone ? null : doneWhenAuthor(request, oldOrigin);
    const clean = checkRequest({ ...copy, ...(continues ? { continues } : {}), ...(fromAsk ? { fromAsk } : {}), ...(raw?.text !== undefined ? { text: raw.text, textOrigin: undefined } : {}), ...(raw?.title !== undefined ? { title: raw.title } : {}), ...(raw?.model !== undefined ? { model: raw.model } : {}), ...(wroteText ? { textOrigin: wroteText } : {}), doneWhenOrigin: doneBy ?? undefined, target, replaces: id }, { fromOwner: true });
    // Refuse what the approval would refuse before anything is written: a copy that cannot be approved is never made.
    if (preset.hidden && !clean.fromAsk) throw fail('That request was not made by the Hub, so it cannot be approved.', 400);
    await refuseUnapprovable(clean, preset, target);
    const made = await writeNew(clean.project, clean.text, at, newId => ({
      id: newId, ...clean, createdAt: at.toISOString(), by: user, origin: { kind: 'owner', name: user }, ...(followUp ? { followUp } : {}),
    }), null, fixedId);
    return { made, target, state };
  }

  /**
   * `POST /hub/requests/:id/again { target?, text?, title?, doneWhen? }`: for an expired, failed, lost or proposed request. Makes a
   * new request copied from it (`replaces` the old id), approves that with the target, and retires the old one: a
   * proposal is declined, the others get a signed stop naming the new id. The old approved.json stays as it is.
   * `moved` is the cloud move (`move-to-cloud`): the id the copy must take. The old request was stopped first, naming that id, so the
   * copy is made under it and the old request is not stopped again.
   */
  async function againRoute(id, raw, user, at, { moved = null } = {}) {
    needKey();
    // A rerun made from the watcher's Ask is the one run of this request: a second copy from here could make two runs.
    if (!moved) {
      const copyId = rerunRequestId(id);
      const loaded = await loadOne(copyId, at).catch(() => null);
      if (loaded && loaded.request.replaces === id && loaded.request.origin?.kind === 'owner' && ['proposed', 'approved', 'taken', 'running', 'asking', 'stopping'].includes(loaded.state) && await siteWrote(copyId)) throw fail(`That request was already run again as ${copyId}; approve or stop that one.`, 409);
    }
    const { made, target, state } = await copyFor(id, { states: moved ? ['stopped'] : ['expired', 'failed', 'lost', 'proposed'], raw, user, at, fixedId: moved });
    let approval;
    try {
      approval = await approveRequest(made.id, { target, by: user, at });
    } catch (error) {
      // Decline the copy only when nothing was signed. Once approved.json exists the approval stands and the old request is retired.
      const signed = (await loadOne(made.id, at).catch(() => null))?.names.has('approved.json');
      if (!signed) {
        await writeSigned(made.id, 'declined.json', { at: at.toISOString(), by: user, reason: `approval failed: ${error.message}`.slice(0, 400) }, 'declined').catch(() => {});
        throw error;
      }
      approval = { state: 'approved', waiting: 'Could not finish the hand-off; it will start when it can.' };
    }
    const reason = `replaced by ${made.id}`;
    if (moved) return { status: 201, body: { id: made.id, ...approval } };
    if (state === 'proposed') await writeSigned(id, 'declined.json', { at: at.toISOString(), by: user, reason }, 'That request is already declined.');
    else await writeStop(id, reason, user, at, ['expired', 'failed', 'lost']);
    return { status: 201, body: { id: made.id, ...approval } };
  }

  /**
   * `POST /hub/requests/:id/answer-run { text }` (1 to 2000 characters), for a run that ended by asking a question
   * (state `asking`). Makes a new request copied from this one that `replaces` it and carries `followUp`
   * `{ from, question, answer, summary }` (the site wrote it, so it is signed into the brief as the owner's answer),
   * approves that for Hermes, then retires this one with a signed stop `answered by <new id>`. Without a signing key
   * the new request stays a proposal with the answer kept in it, and this one stays as it is.
   */
  async function answerRunRoute(id, raw, user, at) {
    const answer = text(raw?.text, REQUEST_LIMITS.answer, 'An answer', { required: true });
    const { parts, state } = await loadOne(id, at);
    if (state !== 'asking') throw fail(`That request is ${state}; only a run that asked a question can be answered.`, 409);
    const stored = await bucket.getBytes(key(`requests/${id}/request.json`));
    if (!stored) throw fail('No such request.', 404);
    const { id: _id, ...request } = checkedRequest(id, stored.buffer);
    const preset = presetOf(request.preset);
    if (!preset?.targets.includes('hermes')) throw fail('Only a Hermes run can be answered this way.', 400);
    const question = String(parts.result?.question ?? '').slice(0, REQUEST_LIMITS.question);
    if (!question) throw fail('That run left no question.', 409);
    const { origin: oldOrigin, followUp: _older, continues: _continues, ...copy } = request;
    // The job text keeps its author: an answer does not make the owner the writer of text an agent or a run wrote.
    const wroteText = request.textOrigin ?? ((oldOrigin ?? {}).kind === 'owner' ? null : (oldOrigin ?? { kind: 'agent' }));
    const clean = checkRequest({
      ...copy, target: 'hermes', replaces: id, origin: { kind: 'owner', name: user }, ...(wroteText ? { textOrigin: wroteText } : {}), doneWhenOrigin: doneWhenAuthor(request, oldOrigin) ?? undefined,
      followUp: { from: id, question, answer, summary: String(parts.result?.summary ?? '').slice(0, REQUEST_LIMITS.followSummary) },
    }, { fromOwner: true });
    const newId = newRequestId(clean.project, clean.text, at);
    const build = made => ({ id: made, ...clean, createdAt: at.toISOString(), by: user });
    if (!signingKey) {
      const proposal = await writeNew(clean.project, clean.text, at, build, null, newId);
      return { status: 201, body: { id: proposal.id, state: 'proposed' } };
    }
    // Claim this request before anything else is written: the signed stop is create-only, so of two answers at once only one
    // gets past it (the other is a 409) and only one follow-up run starts.
    await writeStop(id, `answered by ${newId}`, user, at, ['asking']);
    const made = await writeNew(clean.project, clean.text, at, build, null, newId);
    try {
      const approval = await approveRequest(made.id, { target: 'hermes', by: user, at });
      return { status: 201, body: { id: made.id, ...approval } };
    } catch (error) {
      // The answer is kept in the new proposal; a tap on it signs and starts the run.
      return { status: 201, body: { id: made.id, state: 'proposed', waiting: `Could not start yet: ${scrub(error.message, 80)}` } };
    }
  }

  /**
   * A reply to a Hermes job that has ended: a new request that `continues` this one, approved for Hermes through the one signing
   * path. The original stays as it is. The signed, create-only `continued.json` (`{ v, request, to, at, by, nonce }`) is the claim
   * and is written before the copy, so of two replies at once only one gets past it (the other is a 409 naming the first).
   * When the approval fails the copy stays a proposal with the reply kept in it.
   * -> `{ id, state, waiting? }`
   */
  async function continueRequest(id, { replies, user, at, carried = [] }) {
    needKey();
    const { names, parts, state } = await loadOne(id, at);
    if (parts.approved && parts.approved.target !== 'hermes') throw fail(NOT_HERMES, 400);
    if (state === 'asking') throw clash('That run asked a question; answer it.');
    if (!['done', 'failed', 'stopped'].includes(state) || parts.approved?.target !== 'hermes' || !names.has('hermes-run.json')) throw clash(`That request is ${state}; only a Hermes job that has ended can be continued.`);
    if (names.has('continued.json')) throw clash(`Already continued as ${await claimedTo(id)}; reply there.`);
    if (names.has('stop.json')) {
      const stop = await cached(`requests/${id}/stop.json`).catch(() => null);
      const by = /^(?:answered|replaced) by (\S+)$/.exec(String(stop?.reason ?? ''));
      if (by) throw clash(`That request was already carried on as ${by[1]}; reply there.`);
    }
    const stored = await bucket.getBytes(key(`requests/${id}/request.json`));
    if (!stored) throw fail('No such request.', 404);
    const { id: _id, ...request } = checkedRequest(id, stored.buffer);
    const preset = presetOf(request.preset);
    if (!preset?.targets.includes('hermes')) throw fail('Only a Hermes run can be continued.', 400);
    const { origin: oldOrigin, followUp: _followUp, continues: _continues, replaces: _replaces, ...copy } = request;
    // The job text keeps its author: a reply does not make the owner the writer of text an agent or a run wrote.
    const wroteText = request.textOrigin ?? ((oldOrigin ?? {}).kind === 'owner' ? null : (oldOrigin ?? { kind: 'agent' }));
    const clean = checkRequest({
      ...copy, target: 'hermes', origin: { kind: 'owner', name: user }, ...(wroteText ? { textOrigin: wroteText } : {}), doneWhenOrigin: doneWhenAuthor(request, oldOrigin) ?? undefined,
      continues: { from: id, replies },
    }, { fromOwner: true });
    // What the approval would refuse is refused before anything is written.
    await refuseUnapprovable(clean, preset, 'hermes');
    const newId = newRequestId(clean.project, clean.text, at);
    // Render the brief now, with the report cut as designed: one that cannot fit 16 KB even with no report would lock the original for good.
    try { renderBrief({ preset, request: { ...clean, id: newId }, earlier: await readEarlier(id) }); } catch (error) {
      if (error.status === 400) throw fail('That reply is too long to send with the job text; shorten the reply.', 400);
      throw error;
    }
    // `carried` names the reply files this continuation took over (the automatic send), so the page can mark each one, even a collapsed or a repeated one.
    const claim = sign({ v: 1, request: id, to: newId, at: at.toISOString(), by: user, ...(carried.length ? { carried } : {}), nonce: newNonce() }, signingKey);
    try {
      await putCreateOnly(`requests/${id}/continued.json`, `${JSON.stringify(claim, null, 2)}\n`, 'application/json', clash('claimed'));
    } catch (error) {
      if (error.status === 409) throw clash(`Already continued as ${await claimedTo(id)}; reply there.`);
      throw error;
    }
    const made = await writeNew(clean.project, clean.text, at, madeId => ({ id: madeId, ...clean, createdAt: at.toISOString(), by: user }), null, newId);
    try {
      const approval = await approveRequest(made.id, { target: 'hermes', by: user, at });
      return { id: made.id, state: approval.state, ...(approval.waiting ? { waiting: approval.waiting } : {}) };
    } catch (error) {
      // The reply is kept in the new proposal; a tap on it signs and starts the run.
      return { id: made.id, state: 'proposed', waiting: `Could not start yet: ${scrub(error.message, 80)}` };
    }
  }

  /** The id a verified `continued.json` names (for the 409), or 'another request'. */
  async function claimedTo(id) {
    const claim = await bucket.getJson(key(`requests/${id}/continued.json`)).then(found => found?.value).catch(() => null);
    return claim && publicKey && verify(claim, publicKey) && claim.request === id && validId(claim.to) ? claim.to : 'another request';
  }

  /**
   * `POST /hub/requests/:id/reply { text }`: the owner's reply to a Hermes job. A run that asked a question is answered
   * (`answer-run`); a job that has ended is continued; one still going is a 409 for now.
   */
  async function replyRoute(id, raw, user, at) {
    const reply = text(raw?.text, REQUEST_LIMITS.reply, 'A reply', { required: true });
    const { parts, state } = await loadOne(id, at);
    if (parts.approved && parts.approved.target !== 'hermes') throw fail(NOT_HERMES, 400);
    if (state === 'asking') return answerRunRoute(id, { text: reply }, user, at);
    if (state === 'running') return { status: 201, body: await steerReply(id, reply, user, at) };
    return { status: 201, body: await continueRequest(id, { replies: [reply], user, at }) };
  }

  const REPLY_FILE = /^reply-(\d{8}T\d{6,9}Z-[0-9a-f]{4})\.json$/;
  /** What Hermes is told when the owner replies while it works. */
  const STEER_PREFIX = 'Message from the owner while you work: ';
  const validTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value));

  /**
   * The owner's replies to a request, verified: `reply-<stamp>-<hex>.json` files that carry the server's signature, `kind: owner-reply`
   * and this request's id. A file that does not verify is ignored (an agent cannot write one: the card API keeps them owner-only, and
   * a forged one fails here). `sentAt` is the time Hermes accepted it (`reply-<stamp>-<hex>.sent.json`); newest first.
   */
  async function verifiedReplies(id, names) {
    if (!publicKey) return [];
    const files = [...names].filter(name => REPLY_FILE.test(name)).sort().reverse().slice(0, REQUEST_LIMITS.maxReplies * 3);
    const rows = await pool(8, files, async file => {
      const body = await cached(`requests/${id}/${file}`).catch(() => null);
      if (!body || !verify(body, publicKey) || body.kind !== 'owner-reply' || body.request !== id || typeof body.text !== 'string' || !validTime(body.at)) return null;
      const sentName = file.replace(/\.json$/, '.sent.json');
      const sent = names.has(sentName) ? await cached(`requests/${id}/${sentName}`).catch(() => null) : null;
      return { file, text: body.text, at: body.at, by: body.by, sentAt: sent?.accepted === true && validTime(sent.at) ? sent.at : null };
    });
    return rows.filter(Boolean);
  }

  /**
   * Whether Hermes never read a reply it may have taken: it was not accepted, it was in the run's `pending_steer` at the end
   * (`unreadIds`, kept in `result.json`), or it was sent to the run that died before the quota retry started (`retryAt`).
   */
  const isUnread = (row, unreadIds, retryAt) => !row.sentAt || unreadIds.includes(row.file) || (retryAt && Date.parse(row.sentAt) < Date.parse(retryAt));

  /** What a request's files say about its replies: the unread ids of the result and the time the quota retry started. */
  async function replyContext(id, names) {
    const [result, retry] = await Promise.all([
      names.has('result.json') ? cached(`requests/${id}/result.json`).catch(() => null) : null,
      names.has('hermes-retry.json') ? cached(`requests/${id}/hermes-retry.json`).catch(() => null) : null,
    ]);
    return { unreadIds: Array.isArray(result?.unreadReplies) ? result.unreadReplies : [], retryAt: validTime(retry?.at) ? retry.at : null };
  }

  /**
   * The `replies` of the detail: `{ id, text, at, by, delivery: sent | queued | continued, to? }`, newest first. A reply is `continued`
   * when the continuation's signed claim lists its file (`carried`), when it was sent by hand (the text is one the continuation
   * carries), or when the run ended asking and the Hub answered it with the reply still unread (the stop says `answered by <id>`).
   */
  async function replyDetails(id, names, claim) {
    const rows = await verifiedReplies(id, names);
    if (!rows.length) return [];
    const { unreadIds, retryAt } = await replyContext(id, names);
    const to = claim?.to ?? null;
    const carriedIds = Array.isArray(claim?.carried) ? claim.carried : [];
    const carriedTexts = to ? (await cached(`requests/${to}/request.json`).catch(() => null))?.continues?.replies ?? [] : [];
    let answeredBy = null;
    if (names.has('stop.json') && publicKey) {
      const stop = await cached(`requests/${id}/stop.json`).catch(() => null);
      if (stop && verify(stop, publicKey) && stop.request === id) answeredBy = /^answered by (\S+)$/.exec(String(stop.reason ?? ''))?.[1] ?? null;
      if (answeredBy && !validId(answeredBy)) answeredBy = null;
    }
    return rows.slice(0, LIST_CAP).map(row => {
      const unread = isUnread(row, unreadIds, retryAt);
      const carriedTo = to && (carriedIds.includes(row.file) || (!claim.carried && carriedTexts.includes(row.text))) ? to : answeredBy && unread ? answeredBy : null;
      return { id: row.file, text: row.text, at: row.at, by: row.by, delivery: carriedTo ? 'continued' : unread ? 'queued' : 'sent', ...(carriedTo ? { to: carriedTo } : {}) };
    });
  }

  /** The reply files Hermes accepted whose text is in the run's unread text at its end (`pendingText`, Hermes's newline-joined `pending_steer`). */
  async function unreadSentIds(id, pendingText, at) {
    const { names } = await loadOne(id, at);
    return (await verifiedReplies(id, names)).filter(row => row.sentAt && String(pendingText).includes(row.text)).map(row => row.file);
  }

  /** The signed owner's reply, create-only; written before anything is sent so the words survive a crash. */
  async function writeReply(id, { text: words, user, at }) {
    const stamp = at.toISOString().replace(/[-:.]/g, '');
    const file = `reply-${stamp}-${randomBytes(2).toString('hex')}.json`;
    const body = sign({ v: 1, kind: 'owner-reply', request: id, text: words, at: at.toISOString(), by: user, nonce: newNonce() }, signingKey);
    await writeSigned(id, file, body, 'That reply is already written.');
    return file;
  }

  /**
   * A reply to a run that is going: write the signed reply file, send it into the run (`steer`), and record that Hermes took it.
   * Hermes refusing or being unreachable never loses it: the file stays and the reply is `queued` (it goes out as the next run when
   * this one ends, or the owner sends it by hand). -> `{ id, delivery: 'sent' | 'queued', reason? }`
   */
  async function steerReply(id, words, user, at) {
    needKey();
    const { names, parts } = await loadOne(id, at);
    if (!names.has('hermes-run.json')) throw clash('Hermes has not started that run yet.');
    if (parts.approved?.target !== 'hermes') throw fail(NOT_HERMES, 400);
    if ([...names].filter(name => REPLY_FILE.test(name)).length >= REQUEST_LIMITS.maxReplies) throw clash(`That job has ${REQUEST_LIMITS.maxReplies} replies already; wait for it to end.`);
    const file = await writeReply(id, { text: words, user, at });
    let outcome;
    try { outcome = await live.steer(id, { text: `${STEER_PREFIX}${words}`, reply: words, at }); } catch (error) {
      log(`[hub] steer for ${id} failed: ${scrub(error.message, 120)}`);
      outcome = { delivery: 'queued', reason: 'Hermes could not be reached.' };
    }
    if (outcome.delivery === 'sent') {
      await putCreateOnly(`requests/${id}/${file.replace(/\.json$/, '.sent.json')}`, `${JSON.stringify({ at: at.toISOString(), accepted: true }, null, 2)}\n`, 'application/json', clash('sent'))
        .catch(error => { if (error.status !== 409) log(`[hub] could not record a delivered reply for ${id}: ${scrub(error.message, 120)}`); });
    }
    return { id: file, delivery: outcome.delivery === 'sent' ? 'sent' : 'queued', ...(outcome.reason ? { reason: outcome.reason } : {}) };
  }

  /**
   * At the end of a Hermes run: send what the owner said and Hermes did not read. Only for a run that completed (state `done` or
   * `asking`), with no stop and no time-out: after Stop, a time-out or a failure the replies wait for the owner's "Send it now".
   * The authority is the owner's own signed reply file (verified here, for this request); the approval is signed through the
   * ordinary path, as the owner who wrote the first reply. `pendingSteer` is the text Hermes never read; `retryAt` makes replies
   * sent to the run before the quota retry count as unread. Errors are the caller's to log. -> the answer, or null.
   */
  async function sendQueuedReplies(id, { at, completed, timedOut = false, pendingSteer = '', retryAt = null }) {
    if (!completed || timedOut || !signingKey) return null;
    const { names, state } = await loadOne(id, at);
    if (names.has('stop.json') || names.has('continued.json') || !['done', 'asking'].includes(state)) return null;
    const pending = Array.isArray(pendingSteer) ? pendingSteer.join('\n') : String(pendingSteer ?? '');
    const unread = (await verifiedReplies(id, names)).filter(row => isUnread(row, [], retryAt) || (pending && pending.includes(row.text)));
    if (!unread.length) return null;
    unread.reverse(); // oldest first
    const user = unread[0].by;
    if (typeof user !== 'string' || !user) return null;
    let texts = [...new Set(unread.map(row => row.text))];
    if (state === 'asking') return answerRunRoute(id, { text: texts.join('\n').slice(0, REQUEST_LIMITS.answer) }, user, at);
    if (texts.length > REQUEST_LIMITS.replies) texts = [...texts.slice(0, REQUEST_LIMITS.replies - 1), texts.slice(REQUEST_LIMITS.replies - 1).join(' / ').slice(0, REQUEST_LIMITS.reply)];
    return continueRequest(id, { replies: texts, user, at, carried: unread.map(row => row.file) });
  }

  /**
   * `POST /hub/requests/:id/move-to-cloud`: the owner's tap on the offer. Approve again with the cloud as the target, in this order:
   * (1) check the old approval and the rules; (2) choose the new id and write the old request's signed, create-only `stop.json`
   * naming it, which is the lock: a PC take before it makes this a 409 with nothing made, a take after it meets the stop, and a
   * second move from any process meets the create-only write; (3) only then make the cloud copy under that id, sign it and hand it to
   * the fire queue (the daily cap and a pause apply). If step 3 fails, the old request stays stopped (the copy is declined when
   * nothing was signed), and the owner approves the work again by hand. The chosen id is random, so a clash is not retried.
   */
  async function moveRoute(id, _raw, user, at) {
    needKey();
    if (moving.has(id)) throw clash('It is being moved.');
    moving.add(id);
    try {
      const { request, parts, state } = await loadOne(id, at);
      const stored = await bucket.getBytes(key(`requests/${id}/request.json`));
      if (!stored) throw fail('No such request.', 404);
      const why = moveEligibility(request, state, parts.approved, at, stored, await neverRepoSet());
      if (why) throw clash(why);
      const newId = newRequestId(request.project, request.text, at);
      await writeStop(id, `moved to the cloud: ${newId}`, user, at, ['approved']);
      return await againRoute(id, { target: 'cloud' }, user, at, { moved: newId });
    } finally { moving.delete(id); }
  }

  /** `POST /hub/requests/:id/fire`: Retry for an approved cloud request. The routines module does the work. */
  const fireRoute = (id, _raw, user, at) => live.retryFire(id, user, at);

  /** The POST routes under `/hub/requests/:id/`. Each needs a signed-in user, even where REQUIRE_REMOTE_USER is off. */
  const actions = { decline: declineRequest, done: doneRequest, approve: approveRoute, stop: stopRoute, again: againRoute, 'move-to-cloud': moveRoute, 'answer-run': answerRunRoute, reply: replyRoute, fire: fireRoute };

  async function post(id, action, raw, user, at) {
    if (!Object.hasOwn(actions, action)) throw fail('Not found', 404);
    if (!user) throw fail('Sign in to do that.', 401);
    return actions[action](id, raw, user, at);
  }

  /**
   * A request the site makes itself, under an id it chooses (create-only: a second call is a 409). Used for the avatar sheet
   * run, which a request body cannot ask for. `data` is checked like an owner's request; `origin` is the owner's.
   */
  async function createFixed(data, { id, user, at }) {
    if (!validId(id)) throw fail('That is not a request id.', 400);
    const clean = checkRequest(data, { fromOwner: true });
    const preset = presetOf(clean.preset);
    if (!preset) throw fail('There is no such preset.', 400);
    const needs = preset.needs.length ? preset.needs : undefined;
    const routed = route({ preset, project: clean.project, needs: needs ?? [], repo: clean.repo, cloudRepos: hasCloud });
    return writeNew(clean.project, clean.text, at, newId => ({
      id: newId, ...clean, ...(needs ? { needs } : {}), target: clean.target ?? routed.target,
      createdAt: at.toISOString(), by: user || 'local', origin: { kind: 'owner', name: user || 'local' },
    }), null, id);
  }

  /** True when the site API wrote this request.json (its metadata says so; a body cannot). */
  async function siteWrote(id) {
    return (await bucket.head(key(`requests/${id}/request.json`)).catch(() => null))?.metadata?.writer === 'site';
  }

  /**
   * The request and its approval, when the approval is the server's own: `approved.json` verifies with the public half of the
   * signing key, names this request, covers the bytes of `request.json` as they are now, and carries the expected preset.
   * Throws a 409 with the reason otherwise. Never reads an approval it did not sign.
   */
  async function verifiedRun(id, { preset: expected, at }) {
    needKey();
    const { names, request, state } = await loadOne(id, at);
    if (!names.has('approved.json')) throw fail('That request was never approved.', 409);
    if (names.has('stop.json') || names.has('declined.json') || ['stopped', 'stopping', 'declined', 'lost'].includes(state)) throw fail('That request was stopped or declined, so it cannot start a sheet run.', 409);
    const [stored, signed] = await Promise.all([bucket.getBytes(key(`requests/${id}/request.json`)), bucket.getJson(key(`requests/${id}/approved.json`))]);
    const approved = signed?.value;
    if (!stored || !approved) throw fail('That request cannot be read.', 409);
    if (!verify(approved, createPublicKey(signingKey))) throw fail('The approval of that request does not verify.', 409);
    if (approved.request !== id || approved.requestSha256 !== sha256Hex(stored.buffer)) throw fail('The approval does not match that request.', 409);
    if (approved.run?.preset !== expected || request.preset !== expected) throw fail(`That request is not a ${expected} request.`, 409);
    return { request: checkedRequest(id, stored.buffer), approved };
  }

  /**
   * The request and its approval for a rerun: like `verifiedRun`, but any preset, only a `pc` approval, only a request that ran
   * and ended (state `failed`, `lost` or `expired`), and never the Bunnylink project. The one stop it accepts is this module's own,
   * `run again as <copy>`, signed with the server key, so a second Ask can find the copy that already exists.
   * Throws a 409 with the reason; never reads an approval it did not sign.
   */
  async function verifiedPcRun(id, at) {
    needKey();
    const { names, request, state } = await loadOne(id, at);
    if (!names.has('approved.json')) throw fail('That request was never approved.', 409);
    const pub = createPublicKey(signingKey);
    const [stored, signed, stop] = await Promise.all([
      bucket.getBytes(key(`requests/${id}/request.json`)), bucket.getJson(key(`requests/${id}/approved.json`)),
      names.has('stop.json') ? bucket.getJson(key(`requests/${id}/stop.json`)) : null,
    ]);
    const approved = signed?.value;
    if (!stored || !approved) throw fail('That request cannot be read.', 409);
    if (!verify(approved, pub)) throw fail('The approval of that request does not verify.', 409);
    if (approved.request !== id || approved.requestSha256 !== sha256Hex(stored.buffer)) throw fail('The approval does not match that request.', 409);
    if (approved.target !== 'pc') throw fail('That request was not approved for the Gaming PC.', 409);
    if (request.project === 'bunnylink') throw fail(BUNNYLINK_AT_PC, 409);
    if (names.has('declined.json')) throw fail('That request was declined.', 409);
    if (names.has('stop.json')) {
      const own = stop?.value && verify(stop.value, pub) && stop.value.request === id && stop.value.reason === `run again as ${rerunRequestId(id)}`;
      if (!own) throw fail('That request was stopped, so it cannot run again.', 409);
      return { request: checkedRequest(id, stored.buffer), approved, state, ranAgain: true };
    }
    if (!['failed', 'lost', 'expired'].includes(state)) throw fail(`That request is ${state}; only a failed, lost or expired one can run again.`, 409);
    return { request: checkedRequest(id, stored.buffer), approved, state, ranAgain: false };
  }

  return { createFixed, verifiedRun, verifiedPcRun, copyFor, writeStop, writeAllowGrant, siteWrote, loadRequests, detail: requestDetail, create: createRequest, presets: presetRoutes, post, approveRequest, loadOne, stateOf, continueRequest, sendQueuedReplies, unreadSentIds, hooks: live };
}
