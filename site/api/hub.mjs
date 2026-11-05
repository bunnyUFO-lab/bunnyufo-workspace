// The Hub: Asks, requests, events, Beads copies and drawings, read from and written to the
// `inbox` section of the cards bucket (`sections/inbox/…`). The published site and the local
// service mount the same code over their own bucket client, so a phone and the PC see one inbox.
//
// Every key this module touches is built by `inboxKey`, which is the whole write boundary: it
// refuses anything outside the seven folders the Hub owns, anything with `..` or a hidden segment,
// and anything that looks like a secret. The routes are documented in docs/workspaces.md.
//
// State is derived, never stored: an Ask's state is which files exist next to it, and Today and
// the Inbox are computed from a seven-day window of event files. Event files, ask.json and
// request.json are create-only and so never change; they are cached by key. The read routes in
// LIST_CACHED_ROUTES also see the bucket's listings through a short cache (list-cache.mjs), which every
// write through this process clears; everything else, writes and sweeps included, lists live.
import { createApplyPoke } from './hub-apply-poke.mjs';
import { createHash, timingSafeEqual } from 'node:crypto';
import { Readable, pipeline } from 'node:stream';
import { S3Error, contentTypeOf } from './s3.mjs';
import { checkDrawing } from './card-writes.mjs';
import {
  askRev, cleanAsk, deliveryOf, DELIVERY_WATCHERS, checkPlaytestSubmit, PLAYTEST_VERDICTS, CHECKLIST_LIMITS, checkChecklist, DAY, discordEligible, checklistItem, checklistEvidence, checklistProgress, EVIDENCE_PER_STEP, EVIDENCE_RE, SHOT_RE, SHOTS_PER_CHECKLIST, checklistState, markStamp, askItem, askState, buildInbox, fillProjects, inProject, projectCounts, buildToday, describeItem, inboxCounts, subCounts, inboxFilter, needsKindOf, askSubtype, stepsSubtype, canAnswer, checkAnswer, CARD_DIR_RE, fileLabel, findSprintCard, summaryFilePaths, trackedRepo, monthPrefixes, newDrawingId,
  ALERT_KEY_RE, ALERT_MARKS, dismissedAlerts, checkHelp, deriveEventItems, randomId, REVIEW_FILE_RE, reviewDetail, reviewDone, titleCase, validDrawingId, validId, validProject, windowDays, WINDOW_DAYS,
} from './hub-model.mjs';
import { FEEDBACK_HOME, FEEDBACK_ID_RE, FEEDBACK_KINDS, checkNotUseful, feedbackIdOf, notUsefulRecord, reasonTextOf, recordPath } from './hub-feedback.mjs';
import { buildMap, isWayfinderQuestion } from './hub-map.mjs';
import { SESSION_ITEMS, projectsToLoad, touchedBySession, withLinks } from './hub-links.mjs';
import { applyMarks, checkMarkRequest, isWaiting, markEntry, markKey, markState, NOT_YET, REASON_MAX } from './hub-marks.mjs';
import { createRequests } from './hub-requests.mjs';
import { createRoutines, loadRoutines, routineFor } from './routines.mjs';
import { createAvatar } from './hub-avatar.mjs';
import { createRerun } from './hub-rerun.mjs';
import { createPersonaStore, MAX_MADE_PERSONAS, VIEW_ONLY, VIEW_ONLY_MESSAGE, viewOnlyKey } from './hub-personas.mjs';
import { PERSONA_TEMPLATES } from './chat-personas.mjs';
import { AGENT_EDIT_OPTIONS, validateAgentEdit } from './agent-edit.mjs';
import { createAgentEdits } from './hub-agent-edit.mjs';
import { loadSigningKey, verify as verifySigned } from './signing.mjs';
import { createPublicKey } from 'node:crypto';
import { createHermesDispatch } from './hermes-dispatch.mjs';
import { createScrub } from './scrub.mjs';
import { createHermesApprovals } from './hub-hermes-approvals.mjs';
import { createNotify } from './notify.mjs';
import { createPolicy } from './policy.mjs';
import { createSprints } from './hub-sprints.mjs';
import { defaultsOf } from './project-defaults.mjs';
import { SEED_KINDS, beadSeed, createBeadsReader, searchRows } from './hub-beads.mjs';
import { createChat, isChatRoute } from './hub-chat.mjs';
import { createPlanPauses } from './plan-pauses.mjs';
import { buildWork, unaskedOf } from './hub-work.mjs';
import { AGENTS, agentOfPersona, agentStatuses, AVATAR_FILE_RE, buildTeam, checkAvatar } from './hub-team.mjs';
import { createSheets, SHEET_PNG_RE, sheetSprite } from './hub-sheets.mjs';
import { CHAT_MODELS } from './chat-models.mjs';
import { agentDetails, CHANGE_CODES, cleanId, exportFreshness, EXPORT_MAX_BYTES, FUTURE_SKEW_SECONDS, redactSecrets, validChange, validExport, validResult, WRITER as CONFIG_WRITER } from './hub-agent-config.mjs';
import { presetOf } from './presets.mjs';
import { jobRow, verifyJob } from './chat-jobs.mjs';
import { deliverablesOf, jobsList } from './job-deliverables.mjs';
import { isActive, pcSummary, STATUS_MAX_BYTES, validStatus, workingNow } from './hub-pc.mjs';
import { nothingToDo } from './nothing-to-do.mjs';
import { withRunEvents } from './hub-run-events.mjs';
import { createWake } from './pc-wake.mjs';
import { createPresence } from './hub-presence.mjs';
import { createCardWrites, isInbox, isLibrarySection, SETTING_FILE } from './hub-card-writes.mjs';
import { PROJECT_DEFAULTS } from './project-defaults.mjs';
import { checkOneImage } from './chat-images.mjs';
import { createListCache } from './list-cache.mjs';

const FOLDERS = ['asks', 'checklists', 'requests', 'events', 'beads', 'drawings', 'chat', 'pc', 'team', 'hermes-approvals', 'bead-marks', 'agent-config', 'feedback', 'card-writes'];
// Copied from site/card-api/handler.mjs (SECRET), applied to each segment on its own: the card API
// applies it to a whole path, where an Ask whose id mentions a token would be refused as a file.
const SECRET = /(^|\/)(\.env(\..*)?|.*\.(pem|key|p12|pfx)|id_(rsa|ed25519)(\.pub)?|.*(secret|credential|password|token).*\.(json|txt|ya?ml))$/i;

const MB = 1024 * 1024;
const LIMITS = { big: 8 * MB, chat: 64 * 1024, small: 256 * 1024 };
const CACHE_MAX = 5000;
const EVENT_CAP = 2000;
const POOL = 16;

/** The read routes that may see the listing cache. Anything else, writes included, lists live; add a route only after reading what it calls. */
const LIST_CACHED_ROUTES = /^\/hub\/(?:today|inbox|work|jobs|projects|team|events|search-text|unasked|map\/[^/]+)$/;
/** Rows of a Needs you answer that carry their detail (`detail=1`); the rest come without. */
const INBOX_DETAIL_CAP = 30;

const fail = (message, status = 400, extra) => Object.assign(new Error(message), { status, ...(extra ? { extra } : {}) });

/**
 * The only way this module names a key: `<prefix>/inbox/<rel>`. `rel` has no empty, `..`, dot or
 * underscore-led segment, starts in one of the Hub's folders, and names no secret-looking file.
 */
export function inboxKey(rel, prefix = 'sections', inbox = 'inbox') {
  if (!/^inbox(-[a-z0-9]+)?$/.test(inbox)) throw fail('That is not an inbox section.', 400);
  const text = String(rel ?? '');
  // The two files at the root of the inbox, each the owner's alone: the Away switch (hub-presence) and the agent-cards setting (hub-card-writes). Exactly these names.
  if (text === 'presence.json' || text === SETTING_FILE) return `${prefix}/${inbox}/${text}`;
  const segments = text.split('/');
  if (!text || segments.some(part => !part || part === '..' || part.startsWith('.') || part.startsWith('_') || /[\\\0]/.test(part))) {
    throw fail('That path is not in the inbox.', 400);
  }
  if (!FOLDERS.includes(segments[0]) || segments.length < 2) throw fail('That path is not in the inbox.', 400);
  if (segments.some(part => SECRET.test(part))) throw fail('That file looks like a secret.', 400);
  return `${prefix}/${inbox}/${text}`;
}

/** Run `fn` over `items`, at most `size` at a time, keeping the order of the results. */
export async function pool(size, items, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
  return results;
}

const json = (response, status, body) => {
  const text = JSON.stringify(body);
  response.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text), 'Cache-Control': 'no-store' });
  response.end(text);
};

async function readBody(request, limit) {
  if (Number(request.headers['content-length']) > limit) throw fail('That is too large.', 413);
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw fail('That is too large.', 413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(request, limit) {
  const buffer = await readBody(request, limit);
  if (!buffer.length) return {};
  try {
    const value = JSON.parse(buffer.toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
    return value;
  } catch {
    throw fail('Expected JSON.');
  }
}

const clip = (value, length) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, length);
const sendTime = value => (typeof value === 'string' && !Number.isNaN(new Date(value).getTime()) ? new Date(value) : null);

/**
 * @param bucket   an s3.mjs bucket (null: the Hub is off)
 * @param prefix   where the sections are in it
 * @param inbox    the inbox section's id: `inbox`, or `inbox-dev` on the development copy
 * @param enabled  `HUB=1` on the site, bucket-and-not-`HUB=0` on the local service
 * @param env      the merged environment (the chat routes and the Hermes request runs read HERMES_* from it)
 * @param hermesTiming  intervals of the Hermes followers and sweep, for tests (see hermes-dispatch.mjs)
 */
export function createHub({ bucket: store = null, prefix = 'sections', inbox = 'inbox', enabled = false, env = {}, fetchImpl = fetch, now = () => new Date(), log = console.log, hermesTiming = {}, listCacheMs = 0 } = {}) {
  const listCache = createListCache({ bucket: store, root: `${prefix}/${inbox}/`, ttlMs: listCacheMs, clock: () => now().getTime() });
  const bucket = listCache.bucket;
  const on = !!enabled && !!bucket;
  const key = rel => inboxKey(rel, prefix, inbox);
  const cache = new Map();
  const remember = (name, value) => {
    cache.set(name, value);
    while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  };

  /** A create-only JSON file, through the cache; null when it is missing or not JSON. */
  async function cached(rel) {
    const name = key(rel);
    if (cache.has(name)) return cache.get(name);
    const got = await bucket.getText(name);
    if (!got) return null;
    let value;
    try { value = JSON.parse(got.text); } catch { return null; }
    remember(name, value);
    return value;
  }

  /** A JSON file that can change, with its etag; null when missing. Never cached. */
  async function fresh(rel) {
    const got = await bucket.getText(key(rel));
    if (!got) return null;
    try { return { value: JSON.parse(got.text), etag: got.etag, text: got.text }; } catch { return { value: null, etag: got.etag, text: got.text }; }
  }

  const exists = async rel => {
    try { await bucket.head(key(rel)); return true; } catch (error) { if (error.status === 404) return false; throw error; }
  };

  /** The key of a folder of the Hub, with its trailing slash; `inboxKey` checks the name. */
  const folder = root => `${key(`${root}/x`).slice(0, -1)}`;

  const listFolders = async (root, at) => {
    const found = new Map();
    const lists = await Promise.all(monthPrefixes(at).map(month => bucket.list(key(`${root}/${month}`))));
    for (const { objects } of lists) {
      for (const object of objects) {
        const parts = object.key.slice(folder(root).length).split('/');
        // Exactly <id>/<file>: a deeper key (<id>/x/submit.json) is no file of the folder, whatever its last segment says.
        if (parts.length !== 2 || !parts[0] || !parts[1]) continue;
        const [id, file] = parts;
        if (!found.has(id)) found.set(id, new Set());
        found.get(id).add(file);
      }
    }
    return found;
  };

  /** An Ask as read: a malformed `decisions` or `image` is dropped so it shows as a plain Question, logged once per Ask. */
  const warned = new Set();
  const readAsk = (raw, id) => {
    const { ask, bad } = cleanAsk(raw);
    if (bad.length && !warned.has(id)) { warned.add(id); log(`[hub] Ask ${id} has a malformed ${bad.join(' and ')}; it shows as a plain question.`); }
    return { ...ask, id };
  };

  async function loadAsks(at) {
    const folders = await listFolders('asks', at);
    const rows = await pool(POOL, [...folders], async ([id, names]) => {
      if (!names.has('ask.json') || !validId(id)) return null;
      const ask = await cached(`asks/${id}/ask.json`);
      if (!ask || typeof ask.question !== 'string') return null;
      const snooze = names.has('snooze.json') ? (await fresh(`asks/${id}/snooze.json`))?.value : null;
      const state = askState(names, ask, at, snooze);
      const clean = readAsk(ask, id);
      return { ask: clean, names, state, item: askItem(clean, state) };
    });
    return rows.filter(Boolean);
  }

  /** The file names directly in `<root>/<id>/`: keys one level deeper do not count. */
  const directNames = (objects, base) => new Set(objects.map(object => object.key.slice(base.length)).filter(name => name && !name.includes('/')));

  /** A stored list must be valid, with its items numbered 01.. in order, or it is treated as missing: it is an agent's file. */
  const validChecklist = value => !!value && typeof value === 'object' && checkChecklist(value).length === 0
    && value.items.every((item, index) => item.id === String(index + 1).padStart(2, '0'));

  async function loadChecklists(at) {
    const folders = await listFolders('checklists', at);
    const rows = await pool(POOL, [...folders], async ([id, names]) => {
      if (!names.has('checklist.json') || !validId(id)) return null;
      const checklist = await cached(`checklists/${id}/checklist.json`);
      if (!validChecklist(checklist)) return null;
      return { checklist: { ...checklist, id }, names, item: checklistItem({ ...checklist, id }, names) };
    });
    return rows.filter(Boolean);
  }

  /** The last `days` UTC days of events, newest first, capped. */
  async function loadEvents(at, days = WINDOW_DAYS) {
    const names = [];
    const dayList = windowDays(at, days);
    const lists = await pool(POOL, dayList, day => bucket.list(key(`events/${day}`) + '/'));
    dayList.forEach((day, index) => {
      for (const object of lists[index].objects) {
        const file = object.key.split('/').pop();
        if (file.endsWith('.json')) names.push({ day, file });
      }
    });
    names.sort((a, b) => (a.day === b.day ? (a.file < b.file ? 1 : -1) : a.day < b.day ? 1 : -1));
    const truncated = names.length > EVENT_CAP;
    const kept = names.slice(0, EVENT_CAP);
    const events = (await pool(POOL, kept, async ({ day, file }) => {
      const event = await cached(`events/${day}/${file}`);
      if (!event || typeof event.ts !== 'string' || typeof event.kind !== 'string') return null;
      return { ...event, file };
    })).filter(Boolean);
    events.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : a.file < b.file ? 1 : -1));
    return { events, truncated };
  }

  const beadsReader = createBeadsReader({ bucket, key });

  /** The repo a project's section tracks (`workspace.json` `tracked.repo`), if any. */
  const projectRepo = async project => trackedRepo((await bucket.getJson(`${prefix}/${project}/workspace.json`).catch(() => null))?.value?.tracked?.repo);
  /** `{ 'owner/repo': project }` (repo lower case) from the project list's tracked repos, kept for a minute: a review's project follows its pull requests' repository. */
  let repoProjectsMemo = { at: 0, map: {} };
  const repoProjects = async () => {
    if (now().getTime() - repoProjectsMemo.at <= 60000) return repoProjectsMemo.map;
    const map = {};
    for (const row of PROJECT_DEFAULTS) {
      const repo = await projectRepo(row.id);
      if (repo && !(repo.toLowerCase() in map)) map[repo.toLowerCase()] = row.id;
    }
    repoProjectsMemo = { at: now().getTime(), map };
    return map;
  };
  // Approvals are signed with HUB_SIGNING_KEY. A key that does not parse turns Approve off (and says so) instead of stopping the API.
  let signingKey = null;
  let approveReason = 'Approvals are signed on the server; open mission control on the site.';
  try { signingKey = loadSigningKey(env); } catch (error) { approveReason = 'The signing key on the server is not valid.'; log(`[hub] ${error.message}`); }
  const scrub = createScrub(env);
  // Cloud routines (CLAUDE_ROUTINE_<REPO_KEY>_URL/_TOKEN): which repos can run in the cloud, known before the request module is made.
  const routineSet = loadRoutines(env);
  const dryRun = String(env.HUB_ROUTINE_DRY_RUN ?? '').trim() === '1';
  const hasCloud = repo => dryRun || (!!repo && !!routineFor(routineSet.routines, repo));
  const requestFiles = createRequests({ bucket, key, cached, putCreateOnly, listFolders, pool, fail, projectRepo, cardSectionOf, hasCloud, cloudRepos: () => [...routineSet.routines.keys()], signingKey, approveReason, log, scrub,
    cloudNever: String(env.HUB_CLOUD_NEVER ?? '').split(',').map(name => name.trim()).filter(Boolean),
    // The Bunnylink project's own repo, for the repo guard: null when there is no such section, '' when it tracks no repo, throws on a storage error.
    bunnylinkRepo: async () => { const got = await bucket.getJson(`${prefix}/bunnylink/workspace.json`); return got ? trackedRepo(got.value?.tracked?.repo) ?? '' : null; },
    neverRepos: String(env.HUB_NEVER_REPOS ?? '').split(',').map(name => name.trim()).filter(Boolean),
    repoProjects: PROJECT_DEFAULTS.map(row => row.id),
    // Repos beyond the projects' own, for Spawn's picker: `HUB_KNOWN_REPOS=owner/name,owner/other`. Bad entries are dropped.
    extraRepos: String(env.HUB_KNOWN_REPOS ?? '').split(',').map(item => item.trim()).filter(Boolean),
  });
  const routines = createRoutines({ env, fetchImpl, bucket, key, requests: requestFiles, listFolders, putCreateOnly, cached, fail, signingKey, now, log: line => log(scrub(line, 400)), scrub });
  // The sprite flow: an answer to an avatar Ask starts the sheet run or chooses the sheet (hub-avatar.mjs).
  const avatarFlow = createAvatar({ requests: requestFiles, chooseAvatar: (agentId, raw, user, at) => chooseAvatar(agentId, raw, user, at), agents: AGENTS.map(agent => agent.id), log });
  // A proposal that policy would sign carries a note once the day's limit is reached, so the list says why it waits for a tap.
  // The watcher's "run it again": an answer to a passkey Ask with a `rerun` field makes and approves one copy of the run (hub-rerun.mjs).
  // The owner's edits of a chat persona (hub-personas.mjs): create-only team/<agent>/persona-*.json, read through a 30 s table the chat uses.
  const personaStore = createPersonaStore({ bucket, key, folder, putCreateOnly, fail, now, live: fn => listCache.liveReads(fn) });
  // An agent's proposal to edit a persona: only the owner's Apply answer, over the web, writes a version (hub-agent-edit.mjs).
  const agentEditFlow = createAgentEdits({
    personas: personaStore, log,
    profiles: {
      signingKey,
      exported: at => loadAgentConfig(at),
      changes: (profile, at) => loadProfileChanges(profile, at),
      putApproval: (id, doc) => putCreateOnly(`agent-config/changes/${id}/approved.json`, `${JSON.stringify(doc, null, 2)}\n`, 'application/json', Object.assign(new Error('That change was already signed.'), { status: 409, conflict: true })),
    },
  });
  const rerunFlow = createRerun({ requests: requestFiles, readAsk: async id => (await askFolder(id)).ask, writerOf: async id => (await bucket.head(key(`asks/${id}/ask.json`)).catch(() => null))?.metadata?.writer ?? null, log });

  const loadRequests = async at => policy.annotate(await requestFiles.loadRequests(at));
  // /hub/map is polled and only needs the list for run state on the sheet: keep it ~30 s. Creating or posting to a request clears it.
  const MAP_REQUESTS_MS = Number(env.HUB_MAP_REQUESTS_MS ?? 30_000);   // 0 turns it off (tests that write the bucket directly)
  let mapRequests = null;   // { made, value }
  const loadMapRequests = async at => {
    if (mapRequests && Date.now() - mapRequests.made < MAP_REQUESTS_MS) return mapRequests.value;
    const made = Date.now();
    const value = await loadRequests(at);
    mapRequests = { made, value };
    return value;
  };
  // Hermes request runs: the hand-off, the followers and the re-attach after a restart. Idle without HERMES_URL and HERMES_API_KEY.
  const notify = createNotify({ env, fetchImpl, log: line => log(scrub(line, 400)) });
  const applyPoke = createApplyPoke({ env, fetchImpl, log: line => log(scrub(line, 200)) });
  /** What an approval needs to know about the request it belongs to: its project, and whether the run has ended. */
  const requestInfo = async id => {
    const { request, parts } = await requestFiles.loadOne(id, now());
    return { project: request.project, hasResult: !!parts.result };
  };
  const hermesApprovals = createHermesApprovals({ cached, putCreateOnly, listFolders, fail, now, runs: () => hermesDispatch.runs, notify, requestInfo, log: line => log(scrub(line, 400)), scrub });
  const hermesDispatch = createHermesDispatch({
    env, fetchImpl, requests: requestFiles, listFolders, putCreateOnly, cached, fail, allCards, now, log, timing: hermesTiming, scrub,
    onApproval: (context, prompt, runId, options) => hermesApprovals.copyApproval({ runId, request: context.id, prompt, startedAt: context.startedAt, polled: options?.polled === true }),
  });
  // Policy approval (off unless HUB_POLICY_APPROVE names kinds): signs eligible proposals through the same path as a tap.
  const policy = createPolicy({ env, requests: requestFiles, listFolders, cached, canSign: on && !!signingKey, now, log, writerOf: async id => (await bucket.head(key(`requests/${id}/request.json`)).catch(() => null))?.metadata?.writer ?? null });
  // Sprints on the PC (hub-sprints.mjs): the owner starts a chain of runs on a milestone; a sweep signs each next item when the one before it is done.
  const sprints = createSprints({
    requests: requestFiles, listFolders, cached, putCreateOnly, signingKey: on ? signingKey : null, fail, now, log, repoOf: project => projectRepo(project),
    writeEvent: (event, at) => putHubEvent(event, at), sweepMs: Number(env.HUB_SPRINT_SWEEP_MS ?? 60_000),
    // What eligibility is built from: the same data as the map, read fresh (a start is rare and must not judge from a 30-second-old list).
    loadInputs: async (project, at) => {
      const [{ meta, issues }, window, asks, checklists, marks, requests] = await Promise.all([loadBeads(project), loadEvents(at), loadAsks(at), loadChecklists(at), loadMarks(project), loadRequests(at)]);
      return { issues: issues.map(issue => ({ ...issue, project })), marks, events: window.events, asks: asks.map(askRow), checklists: checklists.map(checklistRow), requests: requests.filter(item => item.project === project), repo: meta?.repo };
    },
  });
  // The cloud fire queue: sweeps approved cloud requests at start and every 5 minutes. Idle without a routine (or the dry run) and a key.
  if (on) routines.start();
  if (on && hermesDispatch.runs.configured) hermesDispatch.reattach().catch(error => log(`[hub] could not re-attach Hermes runs: ${scrub(error.message)}`));

  /** Every copy of the project's Beads export, merged: the newest version of each issue wins. */
  async function loadBeads(project) {
    return beadsReader.load(project);
  }

  /**
   * The owner's Roadmap marks (`bead-marks/<project>/<bead>/<file>`) of one project, or of all, as a Map of
   * `<project>/<bead>` to entries. The files are create-only, so each is read once; the listing is live.
   */
  async function loadMarks(project) {
    const base = folder('bead-marks');
    const { objects } = await bucket.list(project ? `${base}${project}/` : base);
    const entries = await pool(POOL, objects, async object => {
      const rel = object.key.slice(base.length);
      if (!/^[^/]+\/[^/]+\/\d{8}T\d{9}Z-[a-z-]+-[a-z0-9]{4}\.json$/.test(rel)) return null;
      let hit = cache.get(object.key);
      if (!hit) {
        const got = await bucket.getText(object.key);
        if (!got) return null;
        let value = null;
        try { value = JSON.parse(got.text); } catch { /* not JSON: markEntry refuses it */ }
        hit = { value, writer: got.metadata?.writer ?? null };
        remember(object.key, hit);
      }
      return markEntry(rel, hit.value, hit.writer);
    });
    const marks = new Map();
    for (const entry of entries) {
      if (!entry) continue;
      const name = markKey(entry.project, entry.bead);
      if (!marks.has(name)) marks.set(name, []);
      marks.get(name).push(entry);
    }
    return marks;
  }

  /**
   * The newest valid PC status file, or null. The report script writes `pc/status-<stamp>.json`
   * every minute, so this hour and the one before hold the newest file (at most about 120 keys);
   * only when both are empty does it look at the day prefixes. The listing is never cached.
   */
  async function loadPcStatus(at) {
    const hour = date => markStamp(date).slice(0, 11);
    const day = date => markStamp(date).slice(0, 8);
    const names = async prefixes => {
      const found = [];
      for (const { objects } of await Promise.all(prefixes.map(prefix => bucket.list(key(`pc/status-${prefix}`))))) {
        for (const object of objects) {
          const name = object.key.slice(folder('pc').length);
          if (/^status-\d{8}T\d{6,9}Z\.json$/.test(name)) found.push(name);
        }
      }
      return found.sort();
    };
    const before = new Date(at.getTime() - 60 * 60 * 1000);
    let found = await names([hour(before), hour(at)]);
    if (!found.length) found = await names([day(new Date(at.getTime() - DAY)), day(at)]);
    // The newest file that reads: one the script wrote half-done or this version refuses must not hide the minute before it.
    for (const name of found.slice(-3).reverse()) {
      const got = await fresh(`pc/${name}`);
      const status = got && got.text.length <= STATUS_MAX_BYTES ? validStatus(got.value) : null;
      if (status) return status;
    }
    return null;
  }

  /**
   * The newest valid settings export of the Hermes host, or null. The files are create-only (`agent-config/export-<stamp>.json`),
   * so the newest three names of this month and the last are tried, newest first: one must carry the card API's mark
   * (`writer: hermes-config`, from a head, never from the body), fit the size cap and pass `validExport`. An unmarked file
   * (the passphrase's, or anyone else's) is never read. The winner is remembered by name; the listing is not.
   */
  async function loadAgentConfig(at) {
    const names = [];
    for (const month of monthPrefixes(at)) {
      const { objects } = await bucket.list(key(`agent-config/export-${month}`));
      for (const object of objects) {
        const name = object.key.slice(folder('agent-config').length);
        const stamp = /^export-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})\d{0,3}Z\.json$/.exec(name);
        if (!stamp) continue;
        // A name stamped more than the allowed skew ahead is skipped, so a future-stamped file cannot sit on top of the newest real one.
        const made = Date.UTC(+stamp[1], +stamp[2] - 1, +stamp[3], +stamp[4], +stamp[5], +stamp[6]);
        if (made > at.getTime() + FUTURE_SKEW_SECONDS * 1000) continue;
        names.push(name);
      }
    }
    for (const name of names.sort().slice(-3).reverse()) {
      const rel = `agent-config/${name}`;
      const hit = cache.get(key(rel));
      if (hit?.configExport) return hit.configExport;
      const head = await bucket.head(key(rel)).catch(error => { if (error.status === 404) return null; throw error; });
      if (head?.metadata?.writer !== CONFIG_WRITER) continue;
      // The size in bytes is checked before the download, and again on the text that came.
      if (head.size > EXPORT_MAX_BYTES) continue;
      const got = await fresh(rel);
      const exported = got && Buffer.byteLength(got.text) <= EXPORT_MAX_BYTES ? validExport(got.value) : null;
      if (!exported) continue;
      remember(key(rel), { configExport: exported });
      return exported;
    }
    return null;
  }

  /** The chat label of what Hermes `main` tries first, from a fresh export ("Codex", "Sonnet", ...), or null: then the chat says Codex. */
  let autoFirstMemo = { until: 0, value: null };   // the chat list is read often; the export changes every few hours
  async function autoFirstLabel() {
    const at = now();
    if (autoFirstMemo.until > at.getTime()) return autoFirstMemo.value;
    const exported = await loadAgentConfig(at);
    const model = exported && exportFreshness(exported, at) === 'fresh' ? exported.profiles.main?.model : null;
    const value = model?.provider && model?.default ? CHAT_MODELS.find(entry => entry.provider === model.provider && entry.model === model.default)?.label ?? model.default : null;
    autoFirstMemo = { until: at.getTime() + 30000, value };
    return value;
  }

  /**
   * The signed changes of one Hermes profile with the host's results, newest first (at most 20 are read). The Hub wrote each `approved.json`
   * (create-only, `agent-config/changes/<ask id>/`; no token but the Hermes host's writes under agent-config/, and only a result); a
   * `result.json` counts only with the card API's mark `writer: hermes-config`, from a head and never from the body, and only beside an approval.
   * `landedAt` is the listing's last-modified time of `result.json` (S3 sets it, after the host's health check), '' without a result.
   * @returns {Promise<{ change: object, result: object | null, landedAt: string }[]>}
   */
  async function loadProfileChanges(profile, at) {
    return (await loadAllChanges(at)).filter(item => item.change.profile === profile);
  }

  /** Every signed change of both profiles with its result, newest first (the work of loadProfileChanges, listed once). */
  async function loadAllChanges(at) {
    const found = new Map();
    for (const month of monthPrefixes(at)) {
      const { objects } = await bucket.list(key(`agent-config/changes/${month}`));
      for (const object of objects) {
        const parts = object.key.slice(folder('agent-config').length).split('/');
        // Exactly changes/<id>/<file>.
        if (parts.length !== 3 || parts[0] !== 'changes' || !validId(parts[1])) continue;
        if (!found.has(parts[1])) found.set(parts[1], new Map());
        found.get(parts[1]).set(parts[2], object.lastModified ? new Date(object.lastModified).toISOString() : '');
      }
    }
    const out = [];
    for (const [id, names] of [...found].sort((a, b) => (a[0] < b[0] ? 1 : -1)).slice(0, 20)) {
      if (!names.has('approved.json')) continue;
      // Only an approval this Hub signed counts: a file anyone else put there (the passphrase writes unmarked) verifies with no key.
      const doc = await cached(`agent-config/changes/${id}/approved.json`);
      if (!signingKey || !verifySigned(doc, createPublicKey(signingKey))) continue;
      const change = validChange(doc);
      if (!change || change.change !== id) continue;
      let result = null;
      let landedAt = '';
      if (names.has('result.json')) {
        const rel = `agent-config/changes/${id}/result.json`;
        const head = await bucket.head(key(rel)).catch(error => { if (error.status === 404) return null; throw error; });
        const read = head?.metadata?.writer === CONFIG_WRITER && head.size <= 4096 ? validResult(await cached(rel)) : null;
        if (read?.change === id) { result = read; landedAt = names.get('result.json'); }
      }
      out.push({ change, result, landedAt });
    }
    return out.sort((a, b) => (a.change.at < b.change.at ? 1 : a.change.at > b.change.at ? -1 : 0));
  }

  /**
   * One event for each profile change whose result is in (ws-ubo.6), so the owner hears of it with no page open: `profile-change` when the host
   * confirmed it, an `alert` when it failed. Run from the page loads that already sweep (Today, Inbox, Work) and from the details route, at most
   * every 30 s and never twice at once. A change that has an event is skipped (`change` names it). It never fails a request, and its words are
   * fixed: CHANGE_CODES, never text from the host. A race may write one event twice, which is harmless.
   */
  let noteChanges = { last: 0, running: false };
  async function noteChangeResults(at) {
    if (noteChanges.running || (at.getTime() >= noteChanges.last && at.getTime() - noteChanges.last < 30_000)) return;
    noteChanges = { last: at.getTime(), running: true };
    try {
      const rows = (await loadAllChanges(at))
        .filter(item => item.result && at.getTime() - Date.parse(item.landedAt || item.result.at) < 24 * 3600 * 1000);
      if (!rows.length) return;
      const { events } = await loadEvents(at);
      for (const { change, result, landedAt } of rows) {
        if (events.some(event => event.change === change.change && (event.kind === 'profile-change' || event.kind === 'alert'))) continue;
        const ts = landedAt || result.at;
        const model = change.to.model;
        let event;
        if (result.outcome === 'applied') {
          event = { ts, kind: 'profile-change', change: change.change, profile: change.profile, title: `Hermes ${change.profile} is running ${model}`, host: 'hub', source: 'hub', by: change.by };
        } else {
          const words = String(CHANGE_CODES[result.code]).replace(/\.$/, '');
          const tail = result.code === 'rollback-failed' ? 'Hermes may be down.' : 'The old settings stay.';
          event = { ts, kind: 'alert', change: change.change, profile: change.profile, title: `The change to ${model} failed: ${words}. ${tail}`, host: 'hub', source: 'hub', by: change.by };
        }
        await putHubEvent(event, new Date(ts));
      }
    } catch (error) {
      log(`[hub] profile change events were not written: ${String(error.message).slice(0, 120)}`);
    } finally {
      noteChanges.running = false;
    }
  }

  // "Wake the PC": HUB_WAKE_URL unset turns it off. Approve of a PC request wakes it too when HUB_WAKE_ON_APPROVE=1 (hub-pc, pc-wake).
  const wake = createWake({ env, fetchImpl, bucket, key, fail, log: line => log(scrub(line, 200)) });
  // The Away switch (presence.json): the owner's, read by hub-hooks on the PC.
  const presence = createPresence({ bucket, key, fail, log: line => log(scrub(line, 200)) });
  requestFiles.hooks.wakeOnApprove = async ({ by, at }) => wake.onApproval({ status: await loadPcStatus(at).catch(() => null), by, at });

  /** Hermes `/health` (no key, 1.5 s), cached for 60 s. `null` when HERMES_URL is not set. */
  let hermesHealth = { at: 0, value: null };
  async function hermesState() {
    const base = String(env.HERMES_URL ?? '').replace(/\/+$/, '');
    if (!base) return null;
    if (Date.now() - hermesHealth.at < 60000) return hermesHealth.value;
    let ok = false;
    try { ok = (await fetchImpl(`${base}/health`, { signal: AbortSignal.timeout(1500) })).ok; } catch { ok = false; }
    hermesHealth = { at: Date.now(), value: { ok } };
    return hermesHealth.value;
  }

  /** The ISO time of the newest chat file, or ''. */
  async function lastChatAt() {
    const { objects } = await bucket.list(folder('chat'));
    const times = objects.filter(object => object.key.endsWith('.jsonl') && object.lastModified).map(object => new Date(object.lastModified).getTime()).filter(Number.isFinite);
    return times.length ? new Date(Math.max(...times)).toISOString() : '';
  }

  /** The newest valid avatar choice file of each agent, or none. Names sort by their stamp, so the last is the newest. */
  async function avatarChoices() {
    const choices = {};
    await Promise.all((await allAgents()).map(async agent => {
      const base = folder(`team/${agent.id}`);
      const { objects } = await bucket.list(base);
      const names = objects.map(object => object.key.slice(base.length)).filter(name => AVATAR_FILE_RE.test(name)).sort().reverse().slice(0, 5);
      for (const name of names) {
        const choice = checkAvatar((await fresh(`team/${agent.id}/${name}`))?.value);
        if (choice?.kind === 'custom') {
          // Counts only while the sheet is still listed and is the very file the owner chose.
          const sheet = choice.sha256 ? await sheets.find(agent.id, choice.sheet).catch(() => null) : null;
          if (sheet && sheet.sha256 === choice.sha256) { choices[agent.id] = { ...choice, sprite: sheetSprite(agent.id, sheet) }; return; }
        } else if (choice) { choices[agent.id] = choice; return; }
      }
    }));
    return choices;
  }

  /** The agents of the app and the personas the owner made (not the retired ones). The sprite sheet jobs stay on AGENTS: they are for the built-in agents. */
  async function allAgents() {
    return [...AGENTS, ...(await personaStore.table()).filter(entry => entry.custom && !entry.retired).map(agentOfPersona)];
  }

  async function teamView(at) {
    const [window, status, hermes, lastChat, choices, personas, exported, agents] = await Promise.all([loadEvents(at), loadPcStatus(at), hermesState(), lastChatAt().catch(() => ''), avatarChoices(), personaStore.table(), loadAgentConfig(at).catch(() => null), allAgents()]);
    const working = workingNow({ status, events: window.events, at, defaults: PROJECT_DEFAULTS });
    const statuses = agentStatuses({ working, pc: status ? pcSummary(status, at) : null, hermes, lastChat, extra: agents.filter(agent => agent.custom).map(agent => agent.id), at });
    return { agents: buildTeam({ statuses, choices, personas, exported, agents, at }) };
  }

  /** The sheets reader; the keys come from `inboxKey` like every other. */
  const sheets = createSheets({ bucket, folderKey: agentId => folder(`team/${agentId}`), agents: AGENTS.map(agent => agent.id) });

  /** An agent's listed sheets, newest first, each marked `current` when it is the sprite now. */
  async function sheetList(agentId, at) {
    if (!AGENTS.some(agent => agent.id === agentId)) throw fail('No such agent.', 404);
    const [list, choices] = await Promise.all([sheets.listSheets(agentId), avatarChoices()]);
    const current = choices[agentId]?.kind === 'custom' ? choices[agentId].sheet : '';
    return { sheets: list.map(sheet => ({ sheet: sheet.sheet, at: sheet.at, rows: sheet.rows, url: sheetSprite(agentId, sheet).url, current: sheet.sheet === current })) };
  }

  /** The owner's avatar choice: a create-only file the Hub alone writes (owner-only in the card API). */
  async function chooseAvatar(agentId, raw, user, at) {
    if (!(await allAgents()).some(agent => agent.id === agentId)) throw fail('No such agent.', 404);
    let choice = checkAvatar(raw);
    if (!choice) throw fail('An avatar is a built-in key, a random one with a whole number from 0 to 9999, or a custom sheet.', 400);
    if (choice.kind === 'custom') {
      const sheet = await sheets.find(agentId, choice.sheet);
      if (!sheet) throw fail("That sheet isn't ready or failed its check.", 400);
      choice = { kind: 'custom', sheet: sheet.sheet, sha256: sheet.sha256 };
    }
    const body = `${JSON.stringify({ ...choice, at: at.toISOString(), by: user || 'local' }, null, 2)}
`;
    for (let attempt = 0; ; attempt += 1) {
      try {
        await bucket.put(key(`team/${agentId}/avatar-${markStamp(at)}-${randomId(4)}.json`), body, { contentType: 'application/json', ifNoneMatch: '*' });
        break;
      } catch (error) {
        if (error.status !== 412 || attempt >= 2) throw error;
      }
    }
    return { status: 200, body: { ok: true, ...choice } };
  }

  /** `https://host/path` -> `https://host`, or '' for something that is not an address. */
  const originOfAddress = value => { try { return new URL(String(value)).origin; } catch { return ''; } };

  /**
   * The signed-in owner's press on the Edit page (ws-ubo.4): "Change and restart Hermes <profile>". It signs at once and writes no Ask. Strict body, one of
   *   `{ primary, fallbacks, base }`   a new order, `base` being the order the page showed as current
   *   `{ undo: '<change id>', base }`  back to the order that change replaced
   * a view-only key is a 403 and any other unknown key a 400. Answers 201 `{ change, state: 'waiting', from, to }`.
   *
   * This route is the only caller of `applyDirect` and `undo`. Before it, server.mjs has already refused a write with no Remote-User (401), an Origin that is not
   * in the allowed list (403) and a body that is not JSON (415). Here the request must also not come from the content origin whatever the list says
   * (an agent's card page is served there and the session cookie reaches it), and `Sec-Fetch-Site`, when the browser sends it, must be same-origin. The user is
   * `Remote-User` only: `Authorization` is never read here.
   */
  async function requestProfileChange(agentId, raw, user, at, { headers = {}, contentOrigin = '' } = {}) {
    if (!user) throw fail('Sign in to change a model.', 401);
    const origin = String(headers.origin ?? '');
    const content = originOfAddress(contentOrigin || env.BUW_CONTENT_ORIGIN || '');
    if (content && originOfAddress(origin) === content) throw fail('A card page cannot change a model.', 403);
    const site = headers['sec-fetch-site'];
    if (site !== undefined && String(site).toLowerCase() !== 'same-origin') throw fail('A model is changed from this site\'s own page.', 403);
    const agent = (await allAgents()).find(item => item.id === agentId);
    if (!agent) throw fail('No such agent.', 404);
    if (!agent.profile) throw fail('This agent has no Hermes profile to change.', 404);
    if (Object.keys(raw).some(name => name !== 'fallbacks' && VIEW_ONLY.includes(name))) throw fail(VIEW_ONLY_MESSAGE, 403);
    const OUT_OF_DATE = 'This page is out of date. Reload it.';
    if (raw.base === undefined || raw.why !== undefined) throw fail(OUT_OF_DATE, 400);
    const undoing = raw.undo !== undefined;
    const allowed = undoing ? ['undo', 'base'] : ['primary', 'fallbacks', 'base'];
    if (undoing && (raw.primary !== undefined || raw.fallbacks !== undefined)) throw fail('Send a new order or an undo, not both.', 400);
    const extra = Object.keys(raw).filter(name => !allowed.includes(name));
    if (extra.length) throw fail(`A model change has no field ${extra.slice(0, 3).join(', ')}.`, 400);
    const base = raw.base;
    const refOk = item => item && typeof item === 'object' && !Array.isArray(item) && Object.keys(item).length === 2 && cleanId(item.provider) && cleanId(item.model);
    if (!base || typeof base !== 'object' || Array.isArray(base) || Object.keys(base).length !== 3 || !refOk({ provider: base.provider, model: base.model })
      || !Array.isArray(base.fallbacks) || base.fallbacks.length > 4 || !base.fallbacks.every(refOk)) throw fail(OUT_OF_DATE, 400);
    const baseSet = { provider: base.provider, model: base.model, fallbacks: base.fallbacks.map(item => ({ provider: item.provider, model: item.model })) };
    let made;
    if (undoing) {
      // Any change id: one the owner's Apply signed for an agent's Ask has that Ask's id. `undo` itself takes only the newest signed change of this profile.
      if (!validId(raw.undo)) throw fail('That is not a change id.', 400);
      made = await agentEditFlow.undo({ profile: agent.profile, changeId: raw.undo, base: baseSet, user, at });
    } else {
      const edit = { op: 'profile', profile: agent.profile, primary: raw.primary, fallbacks: raw.fallbacks };
      const problems = validateAgentEdit({ agentEdit: edit, requirePasskey: true, options: AGENT_EDIT_OPTIONS });
      if (problems.length) throw fail(`${problems.slice(0, 2).join('; ')}.`, 400);
      for (const item of [edit.primary, ...edit.fallbacks]) if (!cleanId(item.provider) || !cleanId(item.model)) throw fail('That is not a model id.', 400);
      made = await agentEditFlow.applyDirect({ edit, base: baseSet, user, at });
    }
    // The record of the press, beside the result event the sweep writes later. A failed write is logged and does not fail the press: the change is signed.
    try {
      await putHubEvent({
        ts: at.toISOString(), kind: 'profile-change-sent', change: made.change, profile: agent.profile, title: `Model change sent: Hermes ${agent.profile} to ${made.to.model}`,
        host: 'hub', source: 'hub', by: user, ...(made.undoOf ? { undoOf: made.undoOf } : {}),
      }, at);
    } catch (error) {
      log(`[hub] the event for ${made.change} was not written: ${String(error.message).slice(0, 120)}`);
    }
    return { status: 201, body: { change: made.change, state: 'waiting', from: made.from, to: made.to } };
  }

  const stale = what => fail(`This ${what} changed while you were looking; reload and try again.`, 409);

  async function askFolder(id) {
    if (!validId(id)) throw fail('No such Ask.', 404);
    const base = key(`asks/${id}`) + '/';
    const { objects } = await bucket.list(base);
    const names = directNames(objects, base);
    if (!names.has('ask.json')) throw fail('No such Ask.', 404);
    const ask = await cached(`asks/${id}/ask.json`);
    if (!ask) throw fail('No such Ask.', 404);
    return { ask: readAsk(ask, id), names };
  }

  /**
   * Where an answer (or a checklist's submission) went: agent-written `delivered.json` and up to 3 `watch-*.json` in the
   * item's folder, read fresh (another writer's token may have replaced them), checked by `deliveryOf`. Nothing when there is
   * no answer yet.
   */
  async function deliveryFor(folderPath, names, answer, at) {
    if (!answer) return undefined;
    const watchNames = [...names].filter(name => /^watch-[A-Za-z0-9_-]{1,40}\.json$/.test(name)).sort().slice(0, DELIVERY_WATCHERS);
    const readFresh = async name => (names.has(name) ? (await fresh(`${folderPath}/${name}`))?.value : undefined);
    const [delivered, ...watchers] = await Promise.all([readFresh('delivered.json'), ...watchNames.map(readFresh)]);
    return deliveryOf({ answer, delivered, watchers, at });
  }

  /** The title Beads has for the open Wayfinder question a decision Ask would decide, or ''. It comes from Beads, never from the Ask. */
  async function decidesTitle(ask) {
    if (ask.kind !== 'decision' || !ask.bead || !validProject(ask.project)) return '';
    try {
      const { issues } = await loadBeads(ask.project);
      return isWayfinderQuestion(issues, ask.bead) ? String(issues.find(item => item.id === ask.bead).title ?? ask.bead) : '';
    } catch {
      return '';
    }
  }

  async function askDetail(id, at) {
    const found = await askFolder(id);
    const { names } = found;
    let ask = found.ask;
    // An edit of an agent is shown from the file as it is now, not from the cache, with the rev of those same bytes: what the page shows is what Apply applies.
    let rev;
    if (ask.agentEdit !== undefined) {
      const got = await bucket.getText(key(`asks/${id}/ask.json`));
      let parsed = null;
      try { parsed = got ? JSON.parse(got.text) : null; } catch { /* shown as the cached file, with no rev: Apply is then refused */ }
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && typeof parsed.question === 'string') { ask = readAsk(parsed, id); rev = askRev(got.text); }
    }
    const snooze = names.has('snooze.json') ? (await fresh(`asks/${id}/snooze.json`))?.value : null;
    const state = askState(names, ask, at, snooze);
    const read = async name => (names.has(name) ? cached(`asks/${id}/${name}`) : undefined);
    const [answer, pickup, cancel] = await Promise.all([read('answer.json'), read('pickup.json'), read('cancel.json')]);
    const delivery = await deliveryFor(`asks/${id}`, names, answer, at);
    // A rerun pointer from a token other than the PC watcher's starts nothing; the page says so instead of offering it.
    const rerunBlocked = await rerunFlow.blockedReason(ask).catch(() => null);
    // Only an Ask that can still be answered can be blocked: once answered, its own change would read as "still waiting".
    const agentEditBlocked = canAnswer(state.state) ? await agentEditFlow.blockedReason(ask, at).catch(() => null) : null;
    const sub = askSubtype(ask);
    const beadTitle = await decidesTitle(ask);
    return {
      ...ask, ...state,
      ...(rev ? { rev } : {}),
      ...(beadTitle ? { beadTitle } : {}),
      subtype: sub.subtype, ...(sub.inferred ? { kindInferred: true } : {}),
      ...(rerunBlocked ? { rerunBlocked } : {}),
      ...(agentEditBlocked ? { agentEditBlocked } : {}),
      ...(answer ? { answer } : {}), ...(pickup ? { pickup } : {}), ...(cancel ? { cancel } : {}),
      ...(delivery ? { delivery } : {}),
      files: [...names].sort(),
    };
  }

  async function checklistFolder(id) {
    if (!validId(id)) throw fail('No such checklist.', 404);
    const base = key(`checklists/${id}`) + '/';
    const { objects } = await bucket.list(base);
    const names = directNames(objects, base);
    if (!names.has('checklist.json')) throw fail('No such checklist.', 404);
    const checklist = await cached(`checklists/${id}/checklist.json`);
    if (!validChecklist(checklist)) throw fail('No such checklist.', 404);
    return { checklist: { ...checklist, id }, names };
  }

  async function checklistDetail(id, at = now()) {
    const { checklist, names } = await checklistFolder(id);
    const state = checklistState(names);
    const { done, total, marks } = checklistProgress(checklist, names);
    const read = async name => (names.has(name) ? cached(`checklists/${id}/${name}`) : undefined);
    const [submit, pickup, cancel] = await Promise.all([read('submit.json'), read('pickup.json'), read('cancel.json')]);
    const pictures = checklistEvidence(names);
    const delivery = await deliveryFor(`checklists/${id}`, names, submit, at);
    const sub = stepsSubtype(checklist);
    return {
      ...checklist, state, done, total,
      ...(sub ? { subtype: sub.subtype, ...(sub.inferred ? { kindInferred: true } : {}) } : {}),
      evidence: Object.fromEntries([...pictures.evidence].map(([item, { file, at }]) => [item, { file, at }])),
      shots: pictures.shots,
      items: checklist.items.map(item => ({ ...item, done: !!marks.get(item.id)?.done, ...(marks.get(item.id) ? { at: marks.get(item.id).at } : {}) })),
      ...(submit ? { submit } : {}), ...(pickup ? { pickup } : {}), ...(cancel ? { cancel } : {}),
      ...(delivery ? { delivery } : {}),
      files: [...names].sort(),
    };
  }

  /** Tick or untick one item: one create-only mark file, and nothing at all when the item already is as asked. */
  async function markChecklistItem(id, item, data, user, at) {
    if (typeof data.done !== 'boolean') throw fail('Send { "done": true } or { "done": false }.');
    const { checklist, names } = await checklistFolder(id);
    const state = checklistState(names);
    if (state !== 'open') throw fail(`This checklist is ${state.replace('-', ' ')}, so it can no longer be changed.`, 409);
    if (!checklist.items.some(candidate => candidate.id === item)) throw fail('No such item.', 404);
    if (!!checklistProgress(checklist, names).marks.get(item)?.done !== data.done) {
      const body = `${JSON.stringify({ item, done: data.done, at: at.toISOString(), by: user || 'local' }, null, 2)}\n`;
      for (let attempt = 0; ; attempt += 1) {
        const clash = fail('Could not find a free name; try again.', 409);
        try {
          await putCreateOnly(`checklists/${id}/${data.done ? 'tick' : 'untick'}-${item}-${markStamp(at)}-${randomId(4)}.json`, body, 'application/json', clash);
          break;
        } catch (error) {
          if (error !== clash || attempt >= 2) throw error;
        }
      }
    }
    return { status: 200, body: await checklistDetail(id) };
  }

  /**
   * One picture for a step (`for: "03"`) or a playtest issue (`for: "issue"`), as `{ type, data }` in the chat shape. The picture is
   * checked and stripped of its metadata like a chat picture, then written create-only in the checklist's own folder and nowhere else.
   */
  async function putChecklistFile(id, data, at) {
    const target = data.for;
    if (target !== 'issue' && !(typeof target === 'string' && /^\d{2}$/.test(target))) throw fail('Send "for" as a step number like "03", or "issue".');
    const picture = checkOneImage(data.image, fail);
    const { checklist, names } = await checklistFolder(id);
    const state = checklistState(names);
    if (state !== 'open') throw fail(`This checklist is ${state.replace('-', ' ')}, so it can no longer be changed.`, 409);
    const pictures = checklistEvidence(names);
    let prefix;
    if (target === 'issue') {
      if (pictures.shots.length >= SHOTS_PER_CHECKLIST) throw fail(`A checklist has at most ${SHOTS_PER_CHECKLIST} screenshots.`, 409);
      prefix = 'shot';
    } else {
      if (!checklist.items.some(candidate => candidate.id === target)) throw fail('No such item.', 404);
      if ((pictures.evidence.get(target)?.count ?? 0) >= EVIDENCE_PER_STEP) throw fail(`A step has at most ${EVIDENCE_PER_STEP} pictures.`, 409);
      prefix = `evidence-${target}`;
    }
    for (let attempt = 0; ; attempt += 1) {
      const clash = fail('Could not find a free name; try again.', 409);
      const file = `${prefix}-${markStamp(at)}-${randomId(4)}.${picture.ext}`;
      try {
        await putCreateOnly(`checklists/${id}/${file}`, picture.buffer, picture.type, clash);
        return { status: 201, body: { file, at: at.toISOString() } };
      } catch (error) {
        if (error !== clash || attempt >= 2) throw error;
      }
    }
  }

  /** Send the list back: submit.json create-only, then the `checklist-submitted` event. A lost event is logged and does not undo the submit. */
  async function submitChecklist(id, data, user, at) {
    const { checklist, names } = await checklistFolder(id);
    const state = checklistState(names);
    const existing = async () => (await fresh(`checklists/${id}/submit.json`))?.value ?? null;
    if (state === 'cancelled') throw fail('The agent withdrew this checklist.', 409);
    if (state !== 'open') throw fail('This checklist is already submitted.', 409, { submit: await existing() });
    const note = data.note;
    if (note !== undefined && note !== null && (typeof note !== 'string' || note.length > CHECKLIST_LIMITS.note)) throw fail(`A note is text of at most ${CHECKLIST_LIMITS.note} characters.`);
    const { done: doneCount, total, marks } = checklistProgress(checklist, names);
    const ids = checklist.items.map(item => item.id);
    const playtest = checklist.kind === 'playtest';
    if (!playtest && ['rating', 'verdict', 'issues'].some(name => data[name] !== undefined)) throw fail('Only a playtest takes a rating.');
    const report = playtest ? checkPlaytestSubmit(checklist, data, names) : null;
    const help = await helpFor(data.help, 'checklist', id);
    const submit = {
      at: at.toISOString(), by: user || 'local',
      ...(typeof note === 'string' && note.trim() ? { note: note.trim() } : {}),
      done: ids.filter(item => marks.get(item)?.done), open: ids.filter(item => !marks.get(item)?.done),
      ...(report ?? {}),
      ...(help ? { help } : {}),
    };
    try {
      await bucket.put(key(`checklists/${id}/submit.json`), `${JSON.stringify(submit, null, 2)}\n`, { contentType: 'application/json', ifNoneMatch: '*' });
    } catch (error) {
      if (error.status !== 412) throw error;
      throw fail('This checklist is already submitted.', 409, { submit: await existing() });
    }
    cache.delete(key(`checklists/${id}/submit.json`));
    const event = {
      ts: at.toISOString(), kind: 'checklist-submitted', project: checklist.project, checklist: id, host: 'hub', source: 'hub', by: user || 'local',
      title: `Submitted: ${clip(checklist.title, 80)}`, summary: report ? `Rating ${report.rating}/5 · ${PLAYTEST_VERDICTS[report.verdict]} · ${report.issues.length} ${report.issues.length === 1 ? 'issue' : 'issues'}` : `${doneCount} of ${total} done`,
    };
    try {
      await putHubEvent(event, at);
    } catch (error) {
      log(`[hub] checklist ${id} was submitted but its event was not written: ${error.message}`);
    }
    return { status: 201, body: { state: 'submitted', submit } };
  }

  /** A create-only mark file `bead-marks/<project>/<bead>/<stamp>-<verdict>-<rand4>.json`, a new name on a clash, three tries. */
  async function putMark({ project, bead, verdict, body, at }) {
    const text = `${JSON.stringify(body, null, 2)}\n`;
    for (let attempt = 0; ; attempt += 1) {
      const clash = fail('Could not find a free name; try again.', 409);
      try {
        await putCreateOnly(`bead-marks/${project}/${bead}/${markStamp(at)}-${verdict}-${randomId(4)}.json`, text, 'application/json', clash);
        return;
      } catch (error) {
        if (error !== clash || attempt >= 2) throw error;
      }
    }
  }

  const askRow = row => ({ id: row.ask.id, bead: row.ask.bead, state: row.state.state });
  const checklistRow = row => ({ id: row.checklist.id, bead: row.item.bead, state: row.item.state });

  /** What Needs you is built from, loaded once: the Asks, lists, requests and events, and the rows themselves (`waiting`, with their projects filled). */
  async function loadNeeds(at) {
    const [requests, window, asks, checklists, hermesOpen] = await Promise.all([loadRequests(at), loadEvents(at), loadAsks(at), loadChecklists(at), hermesApprovals.loadOpen(at)]);
    const waiting = fillProjects(buildInbox({ filter: inboxFilter('needs-you'), asks: asks.map(row => row.item), checklists: checklists.map(row => row.item), requests, hermesApprovals: hermesOpen, events: window.events, now: at, repoProjects: await repoProjects() }), requests);
    return { requests, window, asks, checklists, hermesOpen, waiting };
  }

  /**
   * What the Work board and /hub/unasked are built from, for one project or (null) every project with Beads:
   * issues with the owner's marks applied, requests, events, Asks, checklists and every other Needs you item
   * that names a bead. One loader so the two routes never drift.
   */
  async function loadWorkInputs(only, at) {
    if (only && !validProject(only)) throw fail('No such project.', 404);
    const ids = only ? [only] : (await beadRows()).map(row => row.id);
    const [loaded, { requests, window, asks, checklists, waiting }, status, marks] = await Promise.all([
      pool(POOL, ids, async id => ({ id, ...(await loadBeads(id)) })), loadNeeds(at), loadPcStatus(at), loadMarks(only),
    ]);
    return {
      issues: applyMarks(loaded.flatMap(row => row.issues.map(issue => ({ ...issue, project: row.id }))), marks),
      requests: only ? requests.filter(item => item.project === only) : requests,
      events: window.events, asks: asks.map(askRow), checklists: checklists.map(checklistRow),
      needs: waiting.filter(item => item.bead).map(item => ({ bead: item.bead, kind: item.kind, id: item.id })),
      status, now: at,
    };
  }

  /**
   * The owner marks any open task done or no longer needed, and a task that waits on them also unblocked (or takes it back), even when
   * an Ask or a Needs you item names it: the PC (or a session) that applies the mark cancels those.
   * Only the Hub writes the verdict; the PC closes the issue in Beads (or drops the label) later and writes `applied`. Agents never write a verdict.
   */
  async function markBead(project, raw, user, at) {
    if (!validProject(project)) throw fail('No such project.', 404);
    let request;
    try { request = checkMarkRequest(raw); } catch (error) { throw fail(error.message, 400); }
    const { bead, verdict, reason } = request;
    const { meta, issues } = await loadBeads(project);
    const issue = issues.find(item => item.id === bead);
    if (!issue) throw fail('No such task in this project.', 404);
    const closed = issue.status === 'closed';
    // An open Wayfinder question may be decided or set aside by the owner although it does not wait on them (the Roadmap's "Answer here").
    const wayfinder = isWayfinderQuestion(issues, bead);
    const state = markState((await loadMarks(project)).get(markKey(project, bead)) ?? [], { closed, waiting: isWaiting(issue) });
    const answer = (status, body) => ({ status, body });
    if (verdict === 'undo') {
      if (state?.verdict === 'unblock' && state.applied) throw fail(`Already applied in Beads; add the label back with bd label add ${bead} needs-owner.`, 409);
      if (state && state.verdict !== 'undo' && state.verdict !== 'unblock' && (state.applied || closed)) throw fail('Already closed in Beads; reopen it there with bd reopen.', 409);
      if (!state?.active) return answer(200, { state: 'unmarked' });
    } else {
      if (state?.active && state.verdict === verdict) return answer(200, { state: 'marked', verdict, at: state.at });
      if (closed) throw fail('Already closed in Beads.', 409);
      // Unblock removes `needs-owner` or `blocked`; a task that waits only through an Ask or a checklist has neither, so it would change nothing.
      if (verdict === 'unblock' && !isWaiting(issue)) throw fail('Unblock changes nothing here: this task has no needs-owner label and is not blocked, it waits only through an Ask or a checklist. Answer or cancel that Ask, or use Mark done or Not needed.', 409);
      if (!(wayfinder && verdict !== 'unblock')) {
        // Done and not needed apply to any open task. Unblock is for a task that waits on the owner. A milestone or a feature is not a task and stays unmarked.
        const [asks, checklists, window] = await Promise.all([loadAsks(at), loadChecklists(at), loadEvents(at)]);
        const map = buildMap({ project, meta, issues, events: window.events, asks: asks.map(askRow), checklists: checklists.map(checklistRow), now: at });
        const task = map.milestones.flatMap(milestone => milestone.features.flatMap(feature => feature.tasks)).find(item => item.id === bead);
        if (verdict === 'unblock' ? task?.state !== 'you' : !task) throw fail(verdict === 'unblock' ? 'This is not waiting on you.' : 'Only a task can be marked here, not a milestone or a feature.', 409);
      }
    }
    const stamp = at.toISOString();
    await putMark({ project, bead, verdict, at, body: { v: 1, project, bead, verdict, at: stamp, by: user, ...(reason ? { reason } : {}) } });
    applyPoke.poke();
    return answer(201, verdict === 'undo' ? { state: 'unmarked' } : { state: 'marked', verdict, at: stamp });
  }

  /** A create-only event file written by the Hub: `events/<day>/<hhmmss>-hub-<rand4>.json`, a new name on a clash, three tries. */
  async function putHubEvent(event, at) {
    const body = `${JSON.stringify(event, null, 2)}\n`;
    const stamp = at.toISOString();
    for (let attempt = 0; ; attempt += 1) {
      const clash = fail('Could not find a free name; try again.', 409);
      const name = `${stamp.slice(11, 19).replace(/:/g, '')}-hub-${randomId(4)}.json`;
      try {
        await putCreateOnly(`events/${stamp.slice(0, 10)}/${name}`, body, 'application/json', clash);
        return;
      } catch (error) {
        if (error !== clash || attempt >= 2) throw error;
      }
    }
  }

  async function putCreateOnly(rel, body, contentType, conflict, metadata) {
    try {
      return await bucket.put(key(rel), body, { contentType, ifNoneMatch: '*', ...(metadata ? { metadata } : {}) });
    } catch (error) {
      if (error.status === 412) throw conflict;
      throw error;
    }
  }

  // A drawing file left behind by an answer that never got its answer.json is only meaningful once the
  // create-only answer.json names it, so it can be overwritten. If answer.json exists, the Ask is answered.
  async function putDrawingFile(id, name, body, contentType) {
    try {
      await bucket.put(key(`asks/${id}/${name}`), body, { contentType, ifNoneMatch: '*' });
    } catch (error) {
      if (error.status !== 412) throw error;
      if (await exists(`asks/${id}/answer.json`)) {
        const existing = await fresh(`asks/${id}/answer.json`);
        throw fail('This Ask was answered while you were drawing.', 409, { answer: existing?.value ?? null });
      }
      await bucket.put(key(`asks/${id}/${name}`), body, { contentType });
    }
  }

  /** The 409 for an Ask that already has its answer.json, carrying the answer that won. */
  async function alreadyAnswered(id) {
    const existing = await fresh(`asks/${id}/answer.json`);
    return fail('This Ask is already answered.', 409, { answer: existing?.value ?? null });
  }

  /** The one create-only write of answer.json, for the web and for Discord: the first writer wins, a later one gets 409. */
  async function writeAnswer(id, answer) {
    try {
      await bucket.put(key(`asks/${id}/answer.json`), `${JSON.stringify(answer, null, 2)}\n`, { contentType: 'application/json', ifNoneMatch: '*' });
    } catch (error) {
      if (error.status !== 412) throw error;
      throw await alreadyAnswered(id);
    }
    cache.delete(key(`asks/${id}/answer.json`));
  }

  /** help: the attached help chat's excerpt, read from the stored chat and checked to be about this item; null when none is attached. */
  async function helpFor(raw, kind, id) {
    const chatId = checkHelp(raw);
    if (!chatId) return null;
    const { chat: name, lines, excerpt } = await chat.helpExcerpt(chatId, { kind, id });
    return { chat: name, lines, excerpt };
  }

  /**
   * The owner's answer to a `kind: decision` Ask that names an open Wayfinder question of the Ask's own project decides that question:
   * a done mark with the picked option (and the note) as its reason, the same mark "Answer here" writes. The reserved option id `not-yet` ("not decided yet") writes none. Skipped answers, other kinds,
   * other projects and anything that is not an open Wayfinder question write nothing. A failed write is logged and never fails the answer.
   */
  async function markFromAnswer({ ask, answer, user, at }) {
    try {
      if (ask.kind !== 'decision' || !ask.bead || !validProject(ask.project) || typeof answer.choice !== 'string' || !answer.choice || answer.choice === NOT_YET) return;
      const option = Array.isArray(ask.options) ? ask.options.find(item => item.id === answer.choice) : null;
      if (!option) return;
      if (!isWayfinderQuestion((await loadBeads(ask.project)).issues, ask.bead)) return;
      const label = String(option.label ?? option.id).replace(/\s+/g, ' ').trim();
      const note = typeof answer.note === 'string' ? answer.note.replace(/\s+/g, ' ').trim() : '';
      const text = note ? `${label}: ${note}` : label;
      await markBead(ask.project, { bead: ask.bead, verdict: 'done', reason: text.length > REASON_MAX ? `${text.slice(0, REASON_MAX - 1).trimEnd()}…` : text }, user, at);
    } catch (error) {
      log(`[hub] ask ${ask.id} was answered but its question was not marked decided: ${scrub(String(error?.message ?? error), 200)}`);
    }
  }

  async function answerAsk(id, data, user, at, response) {
    if (await exists(`asks/${id}/answer.json`)) throw await alreadyAnswered(id);
    const { ask, names } = await askFolder(id);
    const snooze = names.has('snooze.json') ? (await fresh(`asks/${id}/snooze.json`))?.value : null;
    const { state } = askState(names, ask, at, snooze);
    if (!canAnswer(state)) {
      throw fail(state === 'expired' ? `This Ask is expired: it ran out at ${ask.expiresAt}.` : `This Ask is ${state.replace('-', ' ')}.`, 409);
    }
    checkAnswer(ask, data);
    // What an answer applies (an agent's model or persona) must be what the owner's page showed, not the file as it is now: read it fresh, not
    // from the cache, and refuse the answer, writing nothing, when its revision is not the one the page holds. The fresh parse is what is applied.
    let applied = ask;
    if (ask.agentEdit !== undefined) {
      const got = await bucket.getText(key(`asks/${id}/ask.json`));
      if (!got || typeof data.rev !== 'string' || data.rev !== askRev(got.text)) throw fail('This Ask changed while you were looking; reload and try again.', 409);
      let parsed = null;
      try { parsed = JSON.parse(got.text); } catch { /* refused below */ }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw fail('This Ask changed while you were looking; reload and try again.', 409);
      applied = readAsk(parsed, id);
    }
    const help = await helpFor(data.help, 'ask', id);
    const checked = data.drawing ? checkDrawing({ scene: data.drawing.scene, png: data.drawing.png }) : null;
    const answer = { at: at.toISOString(), by: user || 'local' };
    if (data.choice) answer.choice = data.choice;
    if (data.note) answer.note = data.note;
    if (data.decisions) {
      answer.decisions = Object.fromEntries(Object.entries(data.decisions).map(([decision, entry]) => [decision, {
        verdict: entry.verdict, ...(typeof entry.note === 'string' && entry.note.trim() ? { note: entry.note.trim() } : {}),
      }]));
    }
    if (checked) {
      // The drawing first, so an agent never sees an answer.json that points at a missing picture.
      await putDrawingFile(id, 'answer.excalidraw', checked.sceneText, 'application/json');
      await putDrawingFile(id, 'answer.png', checked.pngBuffer, 'image/png');
      answer.drawing = { excalidraw: 'answer.excalidraw', png: 'answer.png' };
    }
    if (help) answer.help = help;
    await writeAnswer(id, answer);
    if (ask.changes) applyPoke.poke();
    // The answer stands whatever happens next. An avatar Ask may start the sheet run or choose the sheet.
    const avatar = await avatarFlow.afterAnswer({ ask, answer, user, at });
    const rerun = await rerunFlow.afterAnswer({ ask, answer, user, at });
    const agentEdit = await agentEditFlow.afterAnswer({ ask: applied, answer, user, at });
    await markFromAnswer({ ask, answer, user: user || 'local', at });
    return { status: 201, body: { state: 'answered', answer, ...(avatar ? { avatar } : {}), ...(rerun ? { rerun } : {}), ...(agentEdit ? { agentEdit } : {}) } };
  }

  // --- Discord: the bot's two routes (see docs/workspaces.md, "Answers from Discord") ---

  const changedAsk = () => fail('This Ask changed since it was posted.', 409);

  /** An Ask read for Discord: ask.json straight from the bucket, never from the cache, with its rev. */
  async function askForDiscord(id, at) {
    if (!validId(id)) throw fail('No such Ask.', 404);
    const { objects } = await bucket.list(key(`asks/${id}`) + '/');
    const names = new Set(objects.map(object => object.key.split('/').pop()));
    if (!names.has('ask.json')) throw fail('No such Ask.', 404);
    const got = await bucket.getText(key(`asks/${id}/ask.json`));
    if (!got) throw fail('No such Ask.', 404);
    let ask = null;
    try { ask = JSON.parse(got.text); } catch { /* not JSON: refused below */ }
    if (!ask || typeof ask !== 'object' || Array.isArray(ask) || typeof ask.question !== 'string') throw fail('No such Ask.', 404);
    ask = { ...ask, id };
    const snooze = names.has('snooze.json') ? (await fresh(`asks/${id}/snooze.json`))?.value : null;
    return { ask, names, rev: askRev(got.text), state: askState(names, ask, at, snooze).state };
  }

  /** The open Asks that may have buttons, each with the rev of the ask.json it was read from. */
  async function discordList(at) {
    const folders = await listFolders('asks', at);
    const candidates = [...folders].filter(([id, names]) => validId(id) && names.has('ask.json')
      && !['cancel.json', 'pickup.json', 'answer.json'].some(name => names.has(name)));
    const rows = await pool(POOL, candidates, async ([id]) => {
      const row = await askForDiscord(id, at).catch(error => { if (error.status === 404) return null; throw error; });
      if (!row || row.state !== 'open' || !discordEligible(row.ask).ok) return null;
      const { ask } = row;
      return {
        id, project: typeof ask.project === 'string' ? ask.project : '', question: ask.question,
        options: ask.options.map(option => ({ id: option.id, label: option.label })),
        requirePasskey: ask.requirePasskey === true,
        createdAt: typeof ask.createdAt === 'string' ? ask.createdAt : '', expiresAt: typeof ask.expiresAt === 'string' ? ask.expiresAt : '',
        rev: row.rev,
      };
    });
    return { asks: rows.filter(Boolean).sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1)) };
  }

  const DISCORD_KEYS = ['ask', 'choice', 'interaction', 'message', 'rev', 'user'];
  const SNOWFLAKE = /^\d{17,20}$/;

  /** One click: the owner's choice on one Ask that still is the Ask the bot showed. */
  async function discordAnswer(raw, ownerId, at) {
    if (!raw || Object.keys(raw).sort().join() !== DISCORD_KEYS.join()) throw fail(`Send exactly these keys: ${DISCORD_KEYS.join(', ')}.`);
    const { ask: id, choice, rev, user, interaction, message } = raw;
    if ([id, choice, rev, user].some(value => typeof value !== 'string' || !value)) throw fail('ask, choice, rev and user are text.');
    if (!SNOWFLAKE.test(String(interaction)) || !SNOWFLAKE.test(String(message))) throw fail('interaction and message are Discord ids.');
    if (user !== ownerId) throw fail('Only the owner can answer.', 403);
    const row = await askForDiscord(id, at);
    if (row.rev !== rev) throw changedAsk();
    const eligible = discordEligible(row.ask);
    if (!eligible.ok) throw fail(`This Ask is answered in the Hub. ${eligible.reason}`, 403);
    if (row.names.has('answer.json')) throw await alreadyAnswered(id);
    if (!canAnswer(row.state)) {
      throw fail(row.state === 'expired' ? `This Ask is expired: it ran out at ${row.ask.expiresAt}.` : `This Ask is ${row.state.replace('-', ' ')}.`, 409);
    }
    checkAnswer(row.ask, { choice });
    const answer = { at: at.toISOString(), by: 'owner', via: 'discord', choice, rev, discord: { interaction, message } };
    await writeAnswer(id, answer);
    await markFromAnswer({ ask: row.ask, answer, user: 'owner', at });
    log(`[hub] discord answer ${id} ${choice} interaction=${interaction}`);
    return { status: 201, body: { state: 'answered', answer } };
  }

  const bearerMatches = (headers, hex) => {
    const match = /^Bearer\s+(\S+)\s*$/i.exec(String(headers.authorization ?? ''));
    if (!match) return false;
    return timingSafeEqual(createHash('sha256').update(match[1]).digest(), Buffer.from(hex, 'hex'));
  };

  async function snoozeAsk(id, data, user, at) {
    const { ask, names } = await askFolder(id);
    const current = names.has('snooze.json') ? (await fresh(`asks/${id}/snooze.json`))?.value : null;
    const { state } = askState(names, ask, at, current);
    if (!canAnswer(state)) throw fail(`This Ask is ${state.replace('-', ' ')}.`, 409);
    const hours = data.hours === undefined ? 1 : Number(data.hours);
    if (!Number.isInteger(hours) || hours < 1 || hours > 24) throw fail('Snooze for 1 to 24 whole hours.');
    const until = new Date(at.getTime() + hours * 3600_000).toISOString();
    const body = `${JSON.stringify({ at: at.toISOString(), by: user || 'local', until }, null, 2)}\n`;
    for (let attempt = 0; ; attempt += 1) {
      const existing = await fresh(`asks/${id}/snooze.json`);
      try {
        await bucket.put(key(`asks/${id}/snooze.json`), body, { contentType: 'application/json', ...(existing ? { ifMatch: existing.etag } : { ifNoneMatch: '*' }) });
        return { status: 200, body: { state: 'snoozed', snoozedUntil: until } };
      } catch (error) {
        if (error.status !== 412 || attempt >= 1) throw error.status === 412 ? stale('snooze') : error;
      }
    }
  }

  async function cancelAsk(id, user, at) {
    await askFolder(id);
    await putCreateOnly(`asks/${id}/cancel.json`, `${JSON.stringify({ at: at.toISOString(), by: user || 'local' }, null, 2)}\n`, 'application/json', fail('This Ask is already cancelled.', 409));
    return { status: 200, body: { state: 'cancelled' } };
  }

  /** Hide one review in Needs you by writing a `review-done` event that names it; a second call writes nothing. */
  async function markReviewDone(id, user, at, kind = 'ready-for-review') {
    const missing = () => fail(kind === 'blocked' ? 'No such blocked session.' : 'No such review.', 404);
    if (!REVIEW_FILE_RE.test(id)) throw missing();
    const { events } = await loadEvents(at);
    const review = events.find(event => event.kind === kind && event.file === id);
    if (!review) throw missing();
    if (events.some(event => event.kind === 'review-done' && event.review === id)) return { status: 200, body: { state: 'done' } };
    await putHubEvent(reviewDone({ review: id, event: review, user, at }), at);
    return { status: 201, body: { state: 'done' } };
  }

  /** The project folders under `feedback/`, as far as records go. */
  async function feedbackProjects() {
    const { prefixes } = await bucket.list(`${key('feedback/x').slice(0, -1)}`, { delimiter: '/' });
    return prefixes.map(item => item.split('/').filter(Boolean).pop()).filter(validProject);
  }

  /** The record already filed for this item, in whichever project it went to; null when there is none. */
  async function findNotUseful(kind, id) {
    for (const project of await feedbackProjects()) {
      const rel = recordPath(project, kind, id);
      const got = await fresh(rel);
      if (!got) continue;
      // Only the Hub writes this record with no writer mark; one put through the card API is not the owner's.
      const head = await bucket.head(key(rel));
      if (head.metadata?.writer) throw fail('A record from another writer is in the way.', 409);
      return got.value;
    }
    return null;
  }

  /** Take an item off Needs you the way its own close does; safe to repeat. */
  async function closeNeed(kind, id, { event, user, at }) {
    if (kind === 'ask') {
      try { await cancelAsk(id, user, at); } catch (error) { if (error.status !== 409 && error.status !== 404) throw error; }
    } else if (kind === 'checklist') {
      try {
        await putCreateOnly(`checklists/${id}/cancel.json`, `${JSON.stringify({ at: at.toISOString(), by: user || 'local', notUseful: true }, null, 2)}
`, 'application/json', fail('This list is already cancelled.', 409));
      } catch (error) { if (error.status !== 409) throw error; }
    } else if (event) {
      const { events } = await loadEvents(at);
      if (!events.some(other => other.kind === 'review-done' && other.review === id)) await putHubEvent(reviewDone({ review: id, event, user, at }), at);
    }
  }

  /**
   * The owner says a Needs you item is not useful. The Hub finds the item itself, writes one create-only record under
   * `feedback/<project>/<kind>/<id>/` for a session to file as a bug, closes the item the way its own close does, and
   * posts a pointer event. A second press writes nothing new.
   */
  async function notUseful(kind, id, raw, user, at) {
    if (!user) throw fail('Sign in to mark this.', 401);
    if (!FEEDBACK_KINDS.includes(kind)) throw fail('Not found', 404);
    if (!FEEDBACK_ID_RE.test(id)) throw fail('No such item.', 404);
    let reason;
    try { reason = checkNotUseful(raw); } catch (error) { throw fail(error.message, 400); }
    const eventKind = kind === 'blocked' ? 'blocked' : 'ready-for-review';
    const before = await findNotUseful(kind, id);
    if (before) {
      const { events } = kind === 'review' || kind === 'blocked' ? await loadEvents(at) : { events: [] };
      await closeNeed(kind, id, { event: events.find(event => event.kind === eventKind && event.file === id) ?? { title: before.title, project: before.project, bead: before.bead }, user, at });
      return { status: 200, body: { state: 'filed-before', key: before.key, project: before.project } };
    }
    const needs = await loadNeeds(at);
    const row = needs.waiting.find(item => item.kind === kind && feedbackIdOf(item) === id);
    if (!row) throw fail('This is no longer in Needs you.', 404);
    const project = validProject(row.project) ? row.project : FEEDBACK_HOME;
    let source;
    let writer = null;
    if (kind === 'ask') {
      source = needs.asks.find(entry => entry.ask.id === id)?.ask;
      writer = (await bucket.head(key(`asks/${id}/ask.json`)).catch(() => null))?.metadata?.writer ?? null;
    } else if (kind === 'checklist') {
      source = needs.checklists.find(entry => entry.checklist.id === id)?.checklist;
    } else {
      source = needs.window.events.find(event => event.kind === eventKind && event.file === id);
    }
    const record = notUsefulRecord({ row, raw: source, writer, project, ...reason, user, at });
    const path = recordPath(project, kind, id);
    try {
      await putCreateOnly(path, `${JSON.stringify(record, null, 2)}
`, 'application/json', fail('Already filed.', 409));
    } catch (error) {
      if (error.status !== 409) throw error;
      await closeNeed(kind, id, { event: source, user, at });
      return { status: 200, body: { state: 'filed-before', key: record.key, project } };
    }
    await closeNeed(kind, id, { event: source, user, at });
    try {
      await putHubEvent({
        ts: at.toISOString(), kind: 'not-useful', title: `Not useful: ${clip(row.title, 80)}`, project, item: { kind, id }, key: record.key, reason: reasonTextOf(reason),
        ...(row.bead ? { bead: row.bead } : {}), record: path, host: 'hub', source: 'hub', by: user,
      }, at);
    } catch (error) {
      log(`[hub] ${kind} ${id} was marked not useful but its event was not written: ${error.message}`);
    }
    return { status: 201, body: { state: 'filed', key: record.key, project } };
  }

  /**
   * Dismiss or restore alerts: one event per key (`alert-dismissed` / `alert-restored`, create-only), so the choice
   * is the owner's on every device. Keys the client got from Today's alerts; a repeat writes nothing.
   */
  async function markAlerts(kind, raw, user, at) {
    const keys = Array.isArray(raw?.keys) ? [...new Set(raw.keys)] : [];
    if (!keys.length || keys.length > 50 || keys.some(item => typeof item !== 'string' || !ALERT_KEY_RE.test(item))) throw fail('Send up to 50 alert keys.', 400);
    const { events } = await loadEvents(at);
    const current = dismissedAlerts(events);
    let written = 0;
    for (const alert of keys) {
      if (current.has(alert) === (kind === 'alert-dismissed')) continue;
      await putHubEvent({ ts: at.toISOString(), kind, alert, title: kind === 'alert-dismissed' ? 'Alert dismissed' : 'Alert restored', host: 'hub', source: 'hub', by: user || 'local' }, at);
      written += 1;
    }
    return { status: written ? 201 : 200, body: { state: kind === 'alert-dismissed' ? 'dismissed' : 'restored', count: written } };
  }

  /** One review's detail, from the ready-for-review event in the last seven days. */
  async function reviewDetailFor(id, at) {
    const missing = () => fail('This review is not in the last 7 days.', 404);
    if (!REVIEW_FILE_RE.test(id)) throw missing();
    const { events } = await loadEvents(at);
    const detail = reviewDetail(events, id, await repoProjects());
    if (!detail) throw missing();
    if (!detail.card) {
      const inferred = await inferCard(detail).catch(() => null);
      if (inferred) detail.inferred = inferred;
    }
    return detail;
  }

  /** Every card of every card section: `sections/<id>/workspace.json` entities, with the section's tracked repo. */
  let lastSections = new Set();
  // Each section's `hidden` and `archived` flags, from the same listing: a card list that is neither is a Library section (cardSectionOf).
  let lastSectionFlags = new Map();
  async function allCards() {
    const { prefixes } = await bucket.list(`${prefix}/`, { delimiter: '/' });
    const sections = prefixes.map(name => name.slice(prefix.length + 1).replace(/\/$/, '')).filter(id => /^[a-z0-9][a-z0-9-]{0,63}$/.test(id) && !/^inbox(-[a-z0-9]+)?$/.test(id));
    lastSections = new Set(sections);
    const flags = new Map();
    lastSectionFlags = flags;
    const lists = await pool(6, sections, async section => {
      const got = await bucket.getJson(`${prefix}/${section}/workspace.json`).catch(() => null);
      const entities = got?.value?.entities;
      if (!Array.isArray(entities)) return [];
      flags.set(section, { hidden: got.value.hidden === true, archived: got.value.archived === true, name: typeof got.value.name === 'string' ? got.value.name : '' });
      const repo = trackedRepo(got.value.tracked?.repo);
      return entities
        .filter(entity => entity && typeof entity.id === 'string' && typeof entity.title === 'string')
        .map(entity => ({
          section, id: entity.id, title: entity.title, folder: typeof entity.folder === 'string' ? entity.folder : entity.id, repo,
          ...(typeof entity.created === 'string' ? { created: entity.created } : {}), ...(typeof entity.updated === 'string' ? { updated: entity.updated } : {}),
        }));
    });
    return lists.flat();
  }

  // The cards by `section/folder` and `section#id`, kept for a minute: a run's card is linked by its id in its section, which the folder does not give.
  let cardIndex = { at: 0, byRef: new Map(), rows: [], sections: new Set(), flags: new Map() };
  const cardRow = row => ({ title: row.title, href: `/${encodeURIComponent(row.section)}#/${encodeURIComponent(row.id)}` });
  /** Make sure the index is no older than a minute (`maxAge` ms), listing the sections at most once per call. */
  async function refreshCardIndex(maxAge = 60000) {
    if (now().getTime() - cardIndex.at <= maxAge) return;
    // A failed listing also counts as a try, so an S3 outage does not list every section for every lookup.
    const at = now().getTime();
    try {
      const byRef = new Map();
      const rows = await allCards();
      for (const row of rows) {
        byRef.set(`${row.section}/${row.folder}`, cardRow(row));
        if (!byRef.has(`${row.section}#${row.id}`)) byRef.set(`${row.section}#${row.id}`, cardRow(row));
      }
      cardIndex = { at, byRef, rows, sections: lastSections, flags: lastSectionFlags };
    } catch { cardIndex = { ...cardIndex, at }; }
  }
  /** The site path of a card named `section/folder` (what a finished run's result holds): `/<section>#/<card id>`. Undefined when no such card is listed. */
  async function cardHrefOf(card) {
    if (typeof card !== 'string') return undefined;
    await refreshCardIndex();
    // A card a run has just written is not in an index built a moment ago: on a miss, look again once the index is 10 s old.
    if (!cardIndex.byRef.has(card)) await refreshCardIndex(10000);
    return cardIndex.byRef.get(card)?.href;
  }
  /** A project's Library cards: the section whose id is the project id, newest first, at most 20, from the one-minute index. `section` is null when there is no such section (`agent-plans` is never a project's). */
  async function projectCards(project) {
    await refreshCardIndex();
    if (project === 'agent-plans' || !cardIndex.sections.has(project)) return { section: null, cards: [], total: 0 };
    const when = row => row.updated ?? row.created ?? '';
    const mine = cardIndex.rows.filter(row => row.section === project).sort((a, b) => when(b).localeCompare(when(a)));
    return { section: project, cards: mine.slice(0, 20).map(row => ({ ...cardRow(row), ...(when(row) ? { updated: when(row) } : {}) })), total: mine.length };
  }
  /**
   * The section a job for `project` writes its card to, chosen when the Hub signs the brief and never from request text: the project's own
   * section when it is a Library section (a card list, not hidden, not archived, not an inbox, not `agent-plans`) that the owner has not
   * turned agent cards off for (`library-writes.json`), else `assistant`. On the development copy only a `dev-` section qualifies. A failed
   * listing or setting read gives `assistant`: it never fails an approval.
   */
  async function cardSectionOf(project) {
    try {
      if (typeof project !== 'string' || project === 'assistant' || project === 'agent-plans' || /^inbox(-|$)/.test(project)) return 'assistant';
      if (env.BUW_DEV === '1' && !project.startsWith('dev-')) return 'assistant';
      await refreshCardIndex();
      const flags = cardIndex.flags.get(project);
      if (!flags || flags.hidden || flags.archived) return 'assistant';
      // The same file the card API reads: `dev-` sections keep theirs in `inbox-dev`, so the two copies never see each other's.
      const got = await bucket.getText(`${prefix}/${project.startsWith('dev-') ? 'inbox-dev' : 'inbox'}/library-writes.json`);
      if (!got) return project;
      if (got.metadata?.writer) return 'assistant';
      const setting = JSON.parse(got.text);
      if (!setting || setting.v !== 1 || !Array.isArray(setting.off) || !setting.off.every(item => typeof item === 'string')) return 'assistant';
      return setting.off.includes(project) ? 'assistant' : project;
    } catch { return 'assistant'; }
  }
  /**
   * The Library sections this Hub may set agent cards for (the setting's panel and its POST): a card list that is not hidden, not archived and
   * not an inbox. The development copy lists only `dev-` sections and the real one leaves them out, so neither can reach the other's.
   */
  async function librarySections() {
    await refreshCardIndex(5000);
    const dev = env.BUW_DEV === '1';
    return [...cardIndex.flags].filter(([id, flags]) => id !== 'assistant' && isLibrarySection(id, flags) && !isInbox(id) && id.startsWith('dev-') === dev)
      .map(([id, flags]) => ({ id, name: flags.name || id })).sort((a, b) => a.name.localeCompare(b.name));
  }
  /** Card titles by folder for one section, from the one-minute index: what a row says the write was in. */
  async function cardTitlesOf(section) {
    await refreshCardIndex();
    const titles = {};
    for (const row of cardIndex.rows) if (row.section === section) titles[row.folder] = row.title;
    return titles;
  }
  const cardWrites = createCardWrites({ bucket, prefix, key, fail, pool, sections: librarySections, titleOf: cardTitlesOf, now, log: line => log(scrub(line, 400)) });
  /** The development copy writes only `dev-` sections: the route restriction QA relies on (`mayWrite` in server.mjs does not cover Hub routes). */
  const writableSection = id => {
    if (env.BUW_DEV === '1' && !String(id ?? '').startsWith('dev-')) throw fail('The development copy writes only dev-… sections.', 403);
  };
  /** A resolver for the map: `section/folder` or `section#id` to `{ title, href }`, from the one-minute index (no listing of its own per request). */
  async function cardResolver() {
    await refreshCardIndex();
    const index = cardIndex.byRef;
    return ref => index.get(ref) ?? null;
  }

  /** The event window with the run events in it: started and finished, from the requests' own files. */
  async function eventsWithRuns(events, requests, at) {
    const cards = new Map();
    for (const card of new Set(requests.map(item => item.finish?.card).filter(Boolean))) cards.set(card, await cardHrefOf(card));
    return withRunEvents(events, requests, { now: at, cardHref: card => cards.get(card) });
  }

  /** Working now rows with the Beads items and cards each is about (`links`): see hub-links.mjs. Never fails the page. */
  async function linkedWorking(working, events) {
    try {
      const touched = touchedBySession(events);
      const issues = new Map(await Promise.all(projectsToLoad(working, touched).map(async id => [id, (await loadBeads(id).catch(() => null))?.issues ?? []])));
      if ([...touched.values()].some(row => row.cards.length)) await refreshCardIndex();
      const index = cardIndex.byRef;
      const resolveCard = (section, card) => {
        if (section) return index.get(`${section}/${card}`) ?? index.get(`${section}#${card}`) ?? null;
        for (const [ref, row] of index) if (ref.endsWith(`#${card}`)) return row;
        return null;
      };
      return withLinks(working, { events, issuesOf: id => issues.get(id) ?? [], defaultPrefixOf: id => PROJECT_DEFAULTS.find(row => row.id === id)?.prefix, resolveCard });
    } catch (error) {
      log(`[hub] could not link Working now: ${scrub(error.message)}`);
      return working;
    }
  }

  /** The sprint card an old review belongs to, found from its title; its files are the ones the summary names that exist. */
  async function inferCard(detail) {
    const card = findSprintCard(detail.fullTitle ?? detail.title, await allCards());
    if (!card) return null;
    const cardDir = `${card.section}/${card.folder}`;
    if (!CARD_DIR_RE.test(cardDir) || cardDir.includes('..')) return null;
    const cardFiles = [];
    for (const path of summaryFilePaths(detail.summary)) {
      try { await bucket.head(`${prefix}/${cardDir}/${path}`); } catch (error) { if (error.status === 404) continue; throw error; }
      cardFiles.push({ path, label: fileLabel(path) });
    }
    return { card: { id: card.id, title: card.title }, section: card.section, cardDir, cardFiles, ...(card.repo ? { repo: card.repo } : {}) };
  }

  /**
   * A Claude Code session's worktree folder (adjective-name-<6 hex>, or a task slug and 6 hex). The
   * session hooks named a project after its folder when the repository's CLAUDE.md had no Beads
   * project line, so those names are not projects: they stay out of the list unless one has a Beads copy.
   */
  const WORKTREE_NAME = /-[0-9a-f]{6}$/;

  /** Table projects take the table's name, order and runsOn and come first in table order; the rest follow alphabetically. */
  function orderProjects(rows) {
    return rows
      .map(row => { const known = defaultsOf(row.id); return known ? { ...row, name: known.name, order: known.order, runsOn: known.runsOn } : row; })
      .sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity) || (a.id < b.id ? -1 : 1));
  }

  /** The projects that have a Beads copy, with the table's order and names: one listing, nothing else read. */
  async function beadRows() {
    const found = new Map();
    const { objects } = await bucket.list(folder('beads'));
    for (const [id, pushedAt] of await beadsReader.projects(objects)) {
      if (validProject(id)) found.set(id, { id, name: titleCase(id), beads: true, ...(pushedAt ? { pushedAt } : {}) });
    }
    return orderProjects([...found.values()]);
  }

  /** The project named by each file of a create-only folder (asks, checklists, requests); only that file is read. */
  async function projectsIn(root, file, valid, at) {
    const folders = await listFolders(root, at);
    const rows = await pool(POOL, [...folders], async ([id, names]) => {
      if (!names.has(file) || !validId(id)) return null;
      const body = await cached(`${root}/${id}/${file}`);
      return valid(body) ? body.project : null;
    });
    return rows;
  }

  async function projects(at) {
    const found = new Map();
    const add = (id, patch = {}) => {
      if (!validProject(id)) return;
      found.set(id, { id, name: titleCase(id), beads: false, ...found.get(id), ...patch });
    };
    const { objects } = await bucket.list(folder('beads'));
    const [beads, asks, checklists, requests, window] = await Promise.all([
      beadsReader.projects(objects),
      projectsIn('asks', 'ask.json', ask => !!ask && typeof ask.question === 'string', at),
      projectsIn('checklists', 'checklist.json', validChecklist, at),
      projectsIn('requests', 'request.json', request => !!request && typeof request.text === 'string', at),
      loadEvents(at),
    ]);
    for (const [id, pushedAt] of beads) add(id, { beads: true, ...(pushedAt ? { pushedAt } : {}) });
    for (const project of [...asks, ...checklists, ...requests]) add(project);
    for (const event of window.events) add(event.project);
    return orderProjects([...found.values()].filter(row => row.beads || !WORKTREE_NAME.test(row.id)));
  }

  async function serveFile(response, rel) {
    const segments = String(rel ?? '').split('/');
    let listedSheet = null;
    if (segments[0] === 'team' && segments.length === 3) {
      // Only a PNG that passes the sheet check is served from team/; avatar files and everything else are not.
      const id = SHEET_PNG_RE.exec(segments[2] ?? '')?.[1];
      listedSheet = id && AGENTS.some(agent => agent.id === segments[1]) ? await sheets.find(segments[1], id) : null;
      if (!listedSheet) throw fail('That file is not served.', 400);
    }
    const picture = segments[0] === 'checklists' && validId(segments[1]) && (EVIDENCE_RE.test(segments[2] ?? '') || SHOT_RE.test(segments[2] ?? ''));
    if (segments.length !== 3 || !(picture || listedSheet || ['asks', 'requests', 'drawings'].includes(segments[0]))) throw fail('That file is not served.', 400);
    let object;
    try {
      object = await bucket.get(key(rel));
    } catch (error) {
      if (error.status === 404) throw fail('Not found', 404);
      throw error;
    }
    if (listedSheet && object.etag !== listedSheet.etag) throw fail('That file is not served.', 400);
    const headers = {
      'Content-Type': contentTypeOf(rel),
      'Cache-Control': 'private, max-age=300',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "sandbox; default-src 'none'; img-src 'self' data:",
      ...(object.etag ? { ETag: `"${object.etag}"` } : {}),
      ...(object.size ? { 'Content-Length': object.size } : {}),
    };
    response.writeHead(200, headers);
    if (!object.body) return response.end();
    // pipeline, not pipe: a body error or a client that leaves ends this one response and never throws on the process.
    pipeline(Readable.fromWeb(object.body), response, () => {});
  }

  async function drawingList() {
    const { objects } = await bucket.list(folder('drawings'));
    const found = new Map();
    for (const object of objects) {
      const [id, file] = object.key.slice(folder('drawings').length).split('/');
      if (!validDrawingId(id)) continue;
      const row = found.get(id) ?? { id, updated: '', hasPng: false, deleted: false };
      if (file === 'drawing.excalidraw') row.updated = object.lastModified ? new Date(object.lastModified).toISOString() : row.updated;
      if (file === 'drawing.png') row.hasPng = true;
      if (file === 'deleted.json') row.deleted = true;
      found.set(id, row);
    }
    return [...found.values()].filter(row => row.updated && !row.deleted).map(({ deleted, ...row }) => row).sort((a, b) => (a.updated < b.updated ? 1 : -1)).slice(0, 20);
  }

  async function saveDrawingNew(data, at) {
    const checked = checkDrawing({ scene: data.scene, png: data.png });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const id = newDrawingId(at);
      try {
        const written = await bucket.put(key(`drawings/${id}/drawing.excalidraw`), checked.sceneText, { contentType: 'application/json', ifNoneMatch: '*' });
        await bucket.put(key(`drawings/${id}/drawing.png`), checked.pngBuffer, { contentType: 'image/png' });
        return { status: 201, body: { id, etag: written.etag } };
      } catch (error) {
        if (error.status !== 412 || attempt === 2) throw error;
      }
    }
    throw fail('Could not find a free id; try again.', 409);
  }

  /**
   * Deleting a sketch writes deleted.json beside it, once: the list, a read and a save then act as if it
   * were gone, and nothing is removed from the bucket. Requests and answers keep the copy they were sent with.
   */
  const isDeleted = id => exists(`drawings/${id}/deleted.json`);
  async function deleteDrawing(id, user, at) {
    if (!validDrawingId(id) || !(await exists(`drawings/${id}/drawing.excalidraw`))) throw fail('No such drawing.', 404);
    try {
      await bucket.put(key(`drawings/${id}/deleted.json`), `${JSON.stringify({ at: at.toISOString(), by: user || 'local' }, null, 2)}\n`, { contentType: 'application/json', ifNoneMatch: '*' });
    } catch (error) {
      if (error.status !== 412) throw error; // deleted already: the same answer
    }
    return { status: 200, body: { deleted: id } };
  }

  async function saveDrawingOld(id, data) {
    if (!validDrawingId(id) || await isDeleted(id)) throw fail('No such drawing.', 404);
    const checked = checkDrawing({ scene: data.scene, png: data.png });
    const rel = `drawings/${id}/drawing.excalidraw`;
    const current = await fresh(rel);
    if (!current) throw fail('No such drawing.', 404);
    const conflict = latest => fail('This drawing changed since you opened it.', 409, { current: latest ? { text: latest.text, etag: latest.etag } : null });
    if ((data.base ?? null) !== current.etag) throw conflict(current);
    let written;
    try {
      written = await bucket.put(key(rel), checked.sceneText, { contentType: 'application/json', ifMatch: current.etag });
    } catch (error) {
      if (error.status !== 412) throw error;
      throw conflict(await fresh(rel));
    }
    try {
      await bucket.put(key(`drawings/${id}/drawing.png`), checked.pngBuffer, { contentType: 'image/png' });
    } catch {
      throw fail('The drawing was saved but its picture was not; save again.', 502);
    }
    return { status: 200, body: { etag: written.etag } };
  }

  const bodyLimit = (method, route) => {
    if (method !== 'POST') return 0;
    if (/^\/hub\/asks\/[^/]+\/answer$/.test(route) || route === '/hub/requests' || route.startsWith('/hub/drawings')) return LIMITS.big;
    if (/^\/hub\/checklists\/[^/]+\/files$/.test(route)) return LIMITS.big;
    if (route === '/hub/chat') return LIMITS.chat;
    return LIMITS.small;
  };

  /** help: the stored item a help chat is about, as its own detail route reads it. 400 for a kind that is none of the four, 404 for a missing item. */
  async function loadHelpItem(kind, id, at) {
    if (kind === 'ask') return askDetail(id, at);
    if (kind === 'checklist') return checklistDetail(id, at);
    if (kind === 'review') return reviewDetailFor(id, at);
    if (kind === 'blocked') {
      const { events } = await loadEvents(at);
      const row = deriveEventItems(events).blocked.find(item => item.id === id);
      if (!row) throw fail('This session is no longer blocked, or is not in the last 7 days.', 404);
      return row;
    }
    throw fail('No such kind of item.');
  }

  const planPauses = createPlanPauses({ listFolders, cached, now, log: line => log(scrub(line, 400)) });
  /**
   * The rows of a chat's jobs, built from the request files (30 s list, cleared by writes through this process). A proposed one carries what
   * one tap would do (`jobApproval`, read-only); a finished one the site path of its card.
   */
  async function jobRows(ids, { persona, windows = new Map() }, at) {
    let byId = new Map((await loadMapRequests(at)).map(item => [item.id, item]));
    // Hermes files through the card API, another process: a job the cached list does not know yet is looked for in a fresh list.
    if (ids.some(id => !byId.has(id))) { mapRequests = null; byId = new Map((await loadMapRequests(at)).map(item => [item.id, item])); }
    const rows = [];
    for (const id of ids) {
      const item = byId.get(id);
      if (!item || item.kind === 'ask') continue;
      try {
        const { request } = await requestFiles.loadOne(id, at);
        const check = item.state === 'proposed' ? await requestFiles.jobApproval(id, at) : null;
        rows.push(jobRow({ item, request, preset: presetOf(item.preset), check, verified: await verifyJobFile(id, request, windows.get(id)), persona, cardHref: item.finish?.card ? await cardHrefOf(item.finish.card) : undefined }));
      } catch (error) { log(scrub(`[hub] chat job ${id} has no row: ${error.message}`, 200)); }
    }
    return rows;
  }
  /**
   * The deliverables a job's linked work can be found in: Asks, lists of steps and requests (list rows), the events' `session-items`, and the
   * card index. Built once per call; `of(item, result, reportText)` is one job's list. A Beads title is best effort and never fails the answer.
   */
  async function deliverableSource(at, projectsOf = () => []) {
    const [asks, checklists, requests, window, cards] = await Promise.all([loadAsks(at), loadChecklists(at), loadRequests(at), loadEvents(at), cardResolver()]);
    const touched = touchedBySession(window.events);
    const titles = new Map();
    await pool(POOL, projectsOf(requests, touched).slice(0, 6), async project => {
      const issues = (await loadBeads(project).catch(() => null))?.issues ?? [];
      titles.set(project, new Map(issues.map(issue => [issue.id, issue.title])));
    });
    const input = { asks: asks.map(row => row.item), checklists: checklists.map(row => row.item), requests, card: ref => cards(ref) ?? undefined, taskTitle: (project, id) => titles.get(project)?.get(id) };
    return { requests, of: (item, result, reportText) => deliverablesOf({ ...input, item, result, reportText, touched: touched.get(item.run?.session) ?? null }) };
  }
  /** `GET /hub/jobs?project=&tab=`: the jobs of the last two months with what each delivered. Reads no report. */
  async function jobsView(query, at) {
    const project = (query.get('project') ?? '').slice(0, 80);
    const tab = query.get('tab') === 'running' ? 'running' : query.get('tab') === 'finished' ? 'finished' : '';
    // Titles of tasks are read only for the projects of jobs whose session touched one.
    const source = await deliverableSource(at, (requests, touched) => [...new Set(requests.filter(item => item.preset && (!project || item.project === project) && touched.get(item.run?.session)?.beads.length).map(item => item.project))]);
    return jobsList({ requests: source.requests, project, tab, preset: presetOf, build: item => source.of(item) });
  }
  /** A request's detail with what it delivered, read with its report (older Hermes jobs name their Asks only there). */
  async function requestDeliverables(detail, at) {
    const { request, state, result } = detail;
    if (!request.preset || !['done', 'failed', 'stopped', 'asking'].includes(state)) return null;
    const report = detail.report ? await bucket.getBytes(key(`requests/${request.id}/report.md`)).then(found => found?.buffer.toString('utf8') ?? '', () => '') : '';
    // Task titles only for the projects of tasks the job's session touched: a plain card job lists no Beads copy.
    const source = await deliverableSource(at, (rows, touched) => [...new Set((touched.get(rows.find(row => row.id === request.id)?.run?.session)?.beads ?? []).map(row => row.project))]);
    const item = source.requests.find(row => row.id === request.id);
    if (!item) return null;
    return source.of(item, result, report);
  }
  /** Whether a request is Hermes's own, made inside the turn that named it: its name, its claimed date and the object's own time (chat-jobs.mjs `verifyJob`). */
  async function verifyJobFile(id, request, window) {
    let modifiedMs = Number.NaN;
    try { modifiedMs = Date.parse((await bucket.head(key(`requests/${id}/request.json`))).lastModified); } catch { /* unverified */ }
    return verifyJob({ by: request.by, createdAt: request.createdAt, modifiedMs, window });
  }
  /** One job of a chat's one tap: verified again here, then the one signing path after the approval page's own checks. The list is read again afterwards. */
  async function approveJob(id, user, at, { window } = {}) {
    try {
      const { request } = await requestFiles.loadOne(id, at);
      const verified = await verifyJobFile(id, request, window);
      if (!verified.ok) throw fail(verified.why, 409);
      return await requestFiles.approveProposed(id, { user, at });
    } finally { mapRequests = null; }
  }

  const chat = createChat({ env, fetchImpl, key, fresh, bucket, loadAsks, loadRequests, loadHelpItem, readJson, json, fail, now, hermesRuns: hermesDispatch.runs, planPauses, personas: () => personaStore.table(), autoFirst: autoFirstLabel, copyApproval: hermesApprovals.copyApproval, readApproval: id => hermesApprovals.detail(id, now()), jobRows, approveJob, log: line => log(scrub(line, 400)) });

  const self = {
    enabled: on,
    /** The listing cache, for the tests. */
    listCache,
    async handle(args) { const run = () => self.handleRoute(args); return args.method === 'GET' && LIST_CACHED_ROUTES.test(String(args.route)) ? listCache.cachedReads(run) : run(); },
    /** The request module, for the later items that sign (follow-ups, policy) and for the Hermes follower to plug its hooks into. */
    requests: requestFiles,
    requestHooks: requestFiles.hooks,
    /** The cloud routines module (fire, record, cap), for the tests. */
    routines,
    avatar: avatarFlow,
    /** The sprint module (start, advance, sweep), for the tests. */
    sprints,
    rerun: rerunFlow,
    /** The persona store and the agent-edit flow, for the tests. */
    personas: personaStore,
    agentEdit: agentEditFlow,
    hermes: hermesDispatch,
    /** The chat module (its restart sweep), for the tests. */
    chat,
    /** The Hermes approvals module (copy, answer), for the tests. */
    approvals: hermesApprovals,
    /** Stops the followers and the sweep (shutdown, tests). */
    policy,
    close: async () => { chat.close(); policy.close(); sprints.close(); await routines.close(); await hermesDispatch.close(); },
    /** What this host tells the page about the Hub (merged into /api/capabilities). */
    capabilities({ signedIn = true, requireRemoteUser = false } = {}) {
      // approve: this host can sign an approval and the caller is signed in; policy lists the kinds approved without a tap (none yet).
      return {
        hub: on, ...chat.capabilities({ enabled: on, signedIn, requireRemoteUser }),
        // Only a host with the Hub on says anything about approving: the local service (no Hub) keeps its old answer.
        ...(on ? { approve: !!signingKey && signedIn, ...(signingKey && signedIn ? {} : { approveReason: signingKey ? 'Sign in to approve.' : approveReason }), policy: policy.kinds, cloudRepos: routines.cloudRepos() } : {}),
      };
    },
    /**
     * `/hub/discord/*`, for the Asks bot: exactly `GET /hub/discord/asks` and `POST /hub/discord/answer`, each with a
     * bearer token whose sha256 is HUB_DISCORD_TOKEN_SHA256. Always ends the request. Without that key and
     * HUB_DISCORD_OWNER_ID in the environment (the kill switch) it answers 404 to everyone. It reads no Remote-User.
     */
    async handleDiscord({ request, response, method, route, headers = request.headers }) {
      try {
        const hex = String(env.HUB_DISCORD_TOKEN_SHA256 ?? '').trim();
        const ownerId = String(env.HUB_DISCORD_OWNER_ID ?? '').trim();
        if (!on || !/^[0-9a-f]{64}$/i.test(hex) || !SNOWFLAKE.test(ownerId)) throw fail('Not found', 404);
        const listing = method === 'GET' && route === '/hub/discord/asks';
        const answering = method === 'POST' && route === '/hub/discord/answer';
        if (!listing && !answering) throw fail('Not found', 404);
        if (!bearerMatches(headers, hex)) throw fail('Send Authorization: Bearer <token>.', 401);
        const at = now();
        if (listing) json(response, 200, await discordList(at));
        else {
          const raw = await readJson(request, 4096);
          const done = await discordAnswer(raw, ownerId, at);
          json(response, done.status, done.body);
        }
      } catch (error) {
        if (response.headersSent) { response.end(); return true; }
        const unreachable = error instanceof S3Error || error instanceof TypeError;
        const status = unreachable ? 502 : error.status || 400;
        json(response, status, { error: unreachable ? `The inbox did not answer: ${error.message}` : error.message, ...(error.extra ?? {}) });
      }
      return true;
    },
    async handleRoute({ request, response, method, route, query = new URLSearchParams(), user = null, requireRemoteUser = false, contentOrigin = '' }) {
      if (!String(route).startsWith('/hub/')) return false;
      try {
        if (!on) throw fail('The Hub is off on this host.', 404);
        if (isChatRoute(route)) { await chat.handle({ request, response, method, route, user, requireRemoteUser }); return true; }
        const at = now();
        const limit = bodyLimit(method, route);
        let match;
        const reply = (answer, status = 200) => json(response, status, answer);
        const send = answer => json(response, answer.status, answer.body);

        if (method === 'GET') {
          if (route === '/hub/today' || route === '/hub/inbox' || route === '/hub/work') listCache.liveReads(() => { hermesDispatch.pageLoad(at); policy.pageLoad(at); sprints.pageLoad(at); void noteChangeResults(at); });
          if (route === '/hub/today') {
            const [asks, checklists, requests, window, hermesOpen, status] = await Promise.all([loadAsks(at), loadChecklists(at), loadRequests(at), loadEvents(at), hermesApprovals.loadOpen(at), loadPcStatus(at)]);
            const cloudOn = routines.dryRun || routines.cloudRepos().length > 0;
            const cloud = cloudOn ? await routines.capacity(at, { memo: true }).catch(() => null) : null;
            const today = buildToday({ asks: asks.map(row => row.item), checklists: checklists.map(row => row.item), requests, hermesApprovals: hermesOpen, events: await eventsWithRuns(window.events, requests, at), now: at, alerts: routines.alerts(), cloud, dismissed: dismissedAlerts(window.events), repoProjects: await repoProjects() });
            const working = await linkedWorking(workingNow({ status, events: window.events, requests, at, defaults: PROJECT_DEFAULTS }), window.events);
            // Running is what is at work: the PC's sessions when its status is fresh, else the event-derived list, and every taken request that has not finished. `running` stays for old clients.
            // A Hermes approval carries no project of its own; its request does, as on /hub/inbox. Without it the Today project filter would drop it.
            reply({ ...today, needsYou: fillProjects(today.needsYou, requests), counts: { ...today.counts, running: working.filter(isActive).length }, working, pc: status ? pcSummary(status, at) : null, wake: await wake.view(status, at) });
          } else if (route === '/hub/pc') {
            const status = await loadPcStatus(at);
            reply({ pc: status ? pcSummary(status, at) : null, status, wake: await wake.view(status, at) });
          } else if (route === '/hub/presence') {
            reply(await presence.view(at));
          } else if (route === '/hub/inbox') {
            const filter = inboxFilter(query.get('filter'));
            const [asks, checklists, requests, window, hermesOpen] = await Promise.all([loadAsks(at), loadChecklists(at), loadRequests(at), loadEvents(at), hermesApprovals.loadOpen(at)]);
            const askItems = asks.map(row => row.item);
            const listItems = checklists.map(row => row.item);
            const project = (query.get('project') ?? '').slice(0, 80);
            const repoMap = await repoProjects();
            const listed = fillProjects(buildInbox({ filter, asks: askItems, checklists: listItems, requests, hermesApprovals: hermesOpen, events: window.events, now: at, repoProjects: repoMap }), requests);
            const items = inProject(listed, project);
            // The chips count what waits in the chosen project; `projects` counts the list on screen per project, whichever is chosen.
            const waiting = inProject(fillProjects(buildToday({ asks: askItems, checklists: listItems, requests, hermesApprovals: hermesOpen, events: window.events, now: at, alerts: routines.alerts(), repoProjects: repoMap }).needsYou, requests), project);
            const counts = inboxCounts(waiting);
            // With detail=1, the first rows that are Asks or lists carry the same object their own route answers, so the
            // screen can show the options and the steps without a second request each. The rest come without.
            const withDetail = new Set(query.get('detail') === '1' ? items.filter(item => item.kind === 'ask' || item.kind === 'checklist').slice(0, INBOX_DETAIL_CAP) : []);
            const rows = await pool(POOL, items, async item => {
              const row = { ...item, needs: needsKindOf(item), describe: describeItem(item, at) };
              if (!withDetail.has(item)) return row;
              try { return { ...row, detail: item.kind === 'ask' ? await askDetail(item.id, at) : await checklistDetail(item.id, at) }; } catch { return row; }
            });
            reply({ items: rows, counts, subCounts: subCounts(waiting), projects: projectCounts(listed) });
          } else if ((match = /^\/hub\/asks\/([^/]+)$/.exec(route))) {
            reply(await askDetail(decodeURIComponent(match[1]), at));
          } else if ((match = /^\/hub\/checklists\/([^/]+)$/.exec(route))) {
            reply(await checklistDetail(decodeURIComponent(match[1]), at));
          } else if ((match = /^\/hub\/reviews\/([^/]+)$/.exec(route))) {
            reply(await reviewDetailFor(decodeURIComponent(match[1]), at));
          } else if ((match = /^\/hub\/hermes-approvals\/([^/]+)$/.exec(route))) {
            reply(await hermesApprovals.detail(decodeURIComponent(match[1]), at));
          } else if ((match = /^\/hub\/requests\/([^/]+)\/events$/.exec(route))) {
            await hermesDispatch.streamEvents(response, decodeURIComponent(match[1]));
          } else if (route === '/hub/jobs') {
            reply(await jobsView(query, at));
          } else if ((match = /^\/hub\/requests\/([^/]+)$/.exec(route))) {
            const detail = await requestFiles.detail(decodeURIComponent(match[1]), at);
            const cardHref = await cardHrefOf(detail.result?.card);
            // What the job delivered is a read of linked work: a failure there leaves the page without the list, never without the page.
            // Cached like the lists (15 s): only finished states reach it, so the running job's own state above stays live.
            const deliverables = await listCache.cachedReads(() => requestDeliverables(detail, at)).catch(error => { log(scrub(`[hub] deliverables of ${detail.request.id}: ${error.message}`, 200)); return null; });
            const preset = detail.request.preset ? presetOf(detail.request.preset) : null;
            reply({ ...detail, ...(cardHref ? { cardHref } : {}), ...(nothingToDo(detail.result) ? { nothing: true } : {}), ...(deliverables ? { deliverables } : {}), ...(preset ? { agent: preset.agent } : {}) });
          } else if (route.startsWith('/hub/presets')) {
            reply(await requestFiles.presets(route, query, at));
          } else if (route === '/hub/events') {
            const floor = at.getTime() - WINDOW_DAYS * DAY;
            const wanted = sendTime(query.get('since'))?.getTime() ?? at.getTime() - DAY;
            const since = Math.max(wanted, floor);
            const project = query.get('project');
            const [window, requests] = await Promise.all([loadEvents(at), loadRequests(at)]);
            const events = await eventsWithRuns(window.events, requests, at);
            reply({
              events: events.filter(event => !ALERT_MARKS.includes(event.kind) && event.kind !== SESSION_ITEMS && new Date(event.ts).getTime() >= since && (!project || event.project === project)),
              truncated: window.truncated,
            });
          } else if (route === '/hub/projects') {
            reply({ projects: await projects(at) });
          } else if (route === '/hub/work') {
            reply(buildWork(await loadWorkInputs(query.get('project'), at)));
          } else if (route === '/hub/search-text') {
            // The text the Work search reads: one project, or every project with Beads. Loaded only while a search is on.
            const only = query.get('project');
            if (only && !validProject(only)) throw fail('No such project.', 404);
            const ids = only ? [only] : (await beadRows()).map(row => row.id);
            const loaded = await pool(POOL, ids, async id => ({ id, ...(await loadBeads(id)) }));
            reply({ rows: loaded.flatMap(row => searchRows(row.issues.map(issue => ({ ...issue, project: row.id })))), at: at.toISOString() });
          } else if (route === '/hub/project-cards') {
            const project = query.get('project');
            if (!validProject(project)) throw fail('Say which project.', 400);
            reply({ ...await projectCards(project), agents: (await cardSectionOf(project)) === project });
          } else if (route === '/hub/card-writes') {
            reply(await cardWrites.rows({ section: query.get('section'), folder: query.get('folder'), limit: Number(query.get('limit')) || undefined, older: query.get('older') === '1' }));
          } else if (route === '/hub/card-write-sections') {
            reply(await cardWrites.settingView());
          } else if (route === '/hub/unasked') {
            const work = buildWork(await loadWorkInputs(null, at));
            reply({ items: unaskedOf(Object.values(work.lanes).flat()).map(card => ({ project: card.project, id: card.id, title: card.title, status: card.state, href: card.href, ...(card.reason ? { reason: card.reason } : {}), ...(card.mark ? { mark: card.mark } : {}) })) });
          } else if ((match = /^\/hub\/beads\/([^/]+)$/.exec(route))) {
            if (!validProject(match[1])) throw fail('No such project.', 404);
            reply(await loadBeads(match[1]));
          } else if ((match = /^\/hub\/map\/([^/]+)\/beads\/([^/]+)\/seed$/.exec(route))) {
            // What Spawn starts from for one bead (the Roadmap's Do it block): read at the tap, so the map payload does not carry descriptions.
            if (requireRemoteUser && !user) throw fail('Sign in to start work from a bead.', 401);
            const project = match[1];
            if (!validProject(project)) throw fail('No such project.', 404);
            const kind = query.get('kind') ?? '';
            if (!SEED_KINDS.includes(kind)) throw fail('The kind is build, mockup or research.', 400);
            const [{ issues }, marks] = await Promise.all([loadBeads(project), loadMarks(project)]);
            const issue = applyMarks(issues, marks, project).find(item => item.id === decodeURIComponent(match[2]));
            if (!issue) throw fail('No such task in this project.', 404);
            if (issue.status === 'closed') throw fail('That task is closed.', 400);
            reply(beadSeed(issue, kind));
          } else if ((match = /^\/hub\/map\/([^/]+)\/sprint\/([^/]+)$/.exec(route))) {
            // What a sprint on this milestone would run and leave out, and the sprint that is going.
            if (!validProject(match[1])) throw fail('No such project.', 404);
            reply(await sprints.preview(match[1], decodeURIComponent(match[2]), at));
          } else if ((match = /^\/hub\/map\/([^/]+)$/.exec(route))) {
            const project = match[1];
            if (!validProject(project)) throw fail('No such project.', 404);
            const [{ meta, issues }, window, asks, checklists, cards, marks, requests] = await Promise.all([loadBeads(project), loadEvents(at), loadAsks(at), loadChecklists(at), cardResolver(), loadMarks(project), loadMapRequests(at)]);
            const repo = meta?.repo || await projectRepo(project);
            const sprintRows = await sprints.summaries(project, at).catch(() => []);
            reply(buildMap({
              project, meta, issues: applyMarks(issues, marks, project), events: window.events, repo, cards,
              asks: asks.map(askRow), checklists: checklists.map(checklistRow), requests: requests.filter(item => item.project === project), runSprints: sprintRows, now: at,
            }));
          } else if (route === '/hub/file') {
            await serveFile(response, query.get('path'));
          } else if (route === '/hub/drawings') {
            reply({ drawings: await drawingList() });
          } else if ((match = /^\/hub\/drawings\/([^/]+)$/.exec(route))) {
            if (!validDrawingId(match[1]) || await isDeleted(match[1])) throw fail('No such drawing.', 404);
            const got = await fresh(`drawings/${match[1]}/drawing.excalidraw`);
            if (!got) throw fail('No such drawing.', 404);
            reply({ text: got.text, etag: got.etag });
          } else if (route === '/hub/team') {
            reply(await teamView(at));
          } else if (route === '/hub/team/templates') {
            // The templates carry their prompt text: same rule as the details.
            if (requireRemoteUser && !user) throw fail('Sign in to see the templates.', 401);
            reply({
              templates: PERSONA_TEMPLATES.map(item => ({ id: item.id, label: item.label, line: item.line, text: item.text('<name>', '<role>') })),
              retired: await personaStore.retiredList(), max: MAX_MADE_PERSONAS,
            });
          } else if ((match = /^\/hub\/team\/([a-z0-9-]+)\/details$/.exec(route))) {
            // Prompt text is not for an anonymous LAN read: same rule as the chat reads.
            if (requireRemoteUser && !user) throw fail('Sign in to see the prompts of this agent.', 401);
            const agent = (await allAgents()).find(item => item.id === match[1]);
            if (!agent) throw fail('No such agent.', 404);
            const exported = agent.profile ? await loadAgentConfig(at) : null;
            if (agent.profile) void noteChangeResults(at);
            reply(agentDetails({
              agent, exported, at, changes: agent.profile ? await loadProfileChanges(agent.profile, at) : [],
              persona: (await personaStore.table()).find(item => item.id === agent.id) ?? null,
              preset: agent.presets?.[0] ? presetOf(agent.presets[0]) : null,
            }));
          } else if ((match = /^\/hub\/team\/([a-z0-9-]+)\/persona$/.exec(route))) {
            // The prompt is not for an anonymous LAN read: same rule as the details.
            if (requireRemoteUser && !user) throw fail('Sign in to see the prompts of this agent.', 401);
            if (!(await allAgents()).some(item => item.id === match[1])) throw fail('No such agent.', 404);
            reply(await personaStore.versions(match[1]));
          } else if ((match = /^\/hub\/team\/([a-z0-9-]+)\/sheets$/.exec(route))) {
            reply(await sheetList(match[1], at));
          } else {
            throw fail('Not found', 404);
          }
          return true;
        }

        if (method !== 'POST') throw fail('Not found', 404);
        const raw = await readJson(request, limit);
        if ((match = /^\/hub\/asks\/([^/]+)\/(answer|snooze|cancel)$/.exec(route))) {
          const id = decodeURIComponent(match[1]);
          if (!validId(id)) throw fail('No such Ask.', 404);
          if (match[2] === 'answer') send(await answerAsk(id, raw, user, at));
          else if (match[2] === 'snooze') send(await snoozeAsk(id, raw, user, at));
          else send(await cancelAsk(id, user, at));
        } else if ((match = /^\/hub\/checklists\/([^/]+)\/items\/(\d{2})$/.exec(route))) {
          send(await markChecklistItem(decodeURIComponent(match[1]), match[2], raw, user, at));
        } else if ((match = /^\/hub\/checklists\/([^/]+)\/files$/.exec(route))) {
          send(await putChecklistFile(decodeURIComponent(match[1]), raw, at));
        } else if ((match = /^\/hub\/checklists\/([^/]+)\/submit$/.exec(route))) {
          send(await submitChecklist(decodeURIComponent(match[1]), raw, user, at));
        } else if (route === '/hub/alerts/dismiss' || route === '/hub/alerts/restore') {
          send(await markAlerts(route.endsWith('dismiss') ? 'alert-dismissed' : 'alert-restored', raw, user, at));
        } else if ((match = /^\/hub\/reviews\/([^/]+)\/done$/.exec(route))) {
          send(await markReviewDone(decodeURIComponent(match[1]), user, at));
        } else if ((match = /^\/hub\/blocked\/([^/]+)\/done$/.exec(route))) {
          send(await markReviewDone(decodeURIComponent(match[1]), user, at, 'blocked'));
        } else if ((match = /^\/hub\/needs\/([a-z]+)\/([^/]+)\/not-useful$/.exec(route))) {
          send(await notUseful(match[1], decodeURIComponent(match[2]), raw, user, at));
        } else if ((match = /^\/hub\/map\/([^/]+)\/sprint\/([^/]+)$/.exec(route))) {
          if (!user) throw fail('Sign in to start a sprint.', 401);
          const started = await sprints.start(decodeURIComponent(match[1]), decodeURIComponent(match[2]), Number(raw?.timebox), user, at, raw?.digest);
          mapRequests = null;
          send({ status: 201, body: started });
        } else if ((match = /^\/hub\/map\/([^/]+)\/marks$/.exec(route))) {
          if (!user) throw fail('Sign in to mark this.', 401);
          send(await markBead(decodeURIComponent(match[1]), raw, user, at));
        } else if (route === '/hub/presence') {
          send(await presence.set(raw, user, at));
        } else if (route === '/hub/card-writes/revert') {
          if (!user) throw fail('Sign in to revert this.', 401);
          writableSection(raw?.section);
          send(await cardWrites.revert(raw, user));
        } else if (route === '/hub/card-write-sections') {
          if (!user) throw fail('Sign in to change this.', 401);
          if (!raw?.save) writableSection(raw?.section);
          send(await cardWrites.setSection(raw, user));
        } else if (route === '/hub/pc/wake') {
          if (!user) throw fail('Sign in to wake the PC.', 401);
          send(await wake.send({ by: user, at }));
        } else if (route === '/hub/requests') {
          mapRequests = null;
          send(await requestFiles.create(raw, user, at));
        } else if ((match = /^\/hub\/hermes-approvals\/([^/]+)\/answer$/.exec(route))) {
          if (!user) throw fail('Sign in to answer.', 401);
          send(await hermesApprovals.answer(decodeURIComponent(match[1]), raw, user, at));
        } else if ((match = /^\/hub\/requests\/([^/]+)\/([a-z-]+)$/.exec(route))) {
          mapRequests = null;
          send(await requestFiles.post(decodeURIComponent(match[1]), match[2], raw, user, at));
        } else if (route === '/hub/drawings') {
          send(await saveDrawingNew(raw, at));
        } else if ((match = /^\/hub\/drawings\/([^/]+)\/delete$/.exec(route))) {
          send(await deleteDrawing(match[1], user, at));
        } else if ((match = /^\/hub\/drawings\/([^/]+)$/.exec(route))) {
          send(await saveDrawingOld(match[1], raw));
        } else if (route === '/hub/team/new') {
          if (!user) throw fail('Sign in to make a persona.', 401);
          send({ status: 201, body: await personaStore.create(raw, user, at) });
        } else if ((match = /^\/hub\/team\/([a-z0-9-]+)\/persona\/retire$/.exec(route))) {
          if (!user) throw fail('Sign in to retire a persona.', 401);
          send({ status: 200, body: await personaStore.retire(match[1], user, at) });
        } else if ((match = /^\/hub\/team\/([a-z0-9-]+)\/persona(\/revert)?$/.exec(route))) {
          if (!user) throw fail('Sign in to edit a persona.', 401);
          if (viewOnlyKey(raw)) throw fail(VIEW_ONLY_MESSAGE, 403);
          send({ status: 200, body: match[2] ? await personaStore.revert(match[1], raw, user, at) : await personaStore.save(match[1], raw, user, at) });
        } else if ((match = /^\/hub\/team\/([a-z0-9-]+)\/profile-change$/.exec(route))) {
          send(await requestProfileChange(match[1], raw, user, at, { headers: request.headers, contentOrigin }));
        } else if ((match = /^\/hub\/team\/([a-z0-9-]+)\/avatar$/.exec(route))) {
          send(await chooseAvatar(match[1], raw, user, at));
        } else {
          throw fail('Not found', 404);
        }
        return true;
      } catch (error) {
        if (response.headersSent) { response.end(); return true; }
        const unreachable = error instanceof S3Error || error instanceof TypeError;
        const status = unreachable ? 502 : error.status || 400;
        const message = unreachable ? `The inbox did not answer: ${error.message}` : error.message;
        json(response, status, { error: message, ...(error.extra ?? {}) });
        return true;
      }
    },
  };
  return self;
}
