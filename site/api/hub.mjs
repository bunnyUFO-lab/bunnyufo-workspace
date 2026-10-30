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
// request.json are create-only and so never change; they are cached by key.
import { createHash, timingSafeEqual } from 'node:crypto';
import { Readable, pipeline } from 'node:stream';
import { S3Error, contentTypeOf } from './s3.mjs';
import { checkDrawing } from './card-writes.mjs';
import {
  askRev, cleanAsk, checkPlaytestSubmit, PLAYTEST_VERDICTS, CHECKLIST_LIMITS, checkChecklist, DAY, discordEligible, checklistItem, checklistEvidence, checklistProgress, EVIDENCE_PER_STEP, EVIDENCE_RE, SHOT_RE, SHOTS_PER_CHECKLIST, checklistState, markStamp, askItem, askState, buildInbox, buildToday, describeItem, inboxCounts, inboxFilter, needsKindOf, canAnswer, checkAnswer, CARD_DIR_RE, fileLabel, findSprintCard, summaryFilePaths, trackedRepo, monthPrefixes, newDrawingId,
  ALERT_KEY_RE, ALERT_MARKS, dismissedAlerts, checkHelp, deriveEventItems, randomId, REVIEW_FILE_RE, reviewDetail, reviewDone, titleCase, validDrawingId, validId, validProject, windowDays, WINDOW_DAYS,
} from './hub-model.mjs';
import { buildMap } from './hub-map.mjs';
import { createRequests } from './hub-requests.mjs';
import { createRoutines, loadRoutines, routineFor } from './routines.mjs';
import { createAvatar } from './hub-avatar.mjs';
import { loadSigningKey } from './signing.mjs';
import { createHermesDispatch } from './hermes-dispatch.mjs';
import { createScrub } from './scrub.mjs';
import { createHermesApprovals } from './hub-hermes-approvals.mjs';
import { createNotify } from './notify.mjs';
import { createPolicy } from './policy.mjs';
import { defaultsOf } from './project-defaults.mjs';
import { createBeadsReader } from './hub-beads.mjs';
import { createChat, isChatRoute } from './hub-chat.mjs';
import { buildWork } from './hub-work.mjs';
import { AGENTS, agentStatuses, AVATAR_FILE_RE, buildTeam, checkAvatar } from './hub-team.mjs';
import { createSheets, SHEET_PNG_RE, sheetSprite } from './hub-sheets.mjs';
import { isActive, pcSummary, STATUS_MAX_BYTES, validStatus, workingNow } from './hub-pc.mjs';
import { nothingToDo } from './nothing-to-do.mjs';
import { withRunEvents } from './hub-run-events.mjs';
import { createWake } from './pc-wake.mjs';
import { PROJECT_DEFAULTS } from './project-defaults.mjs';
import { checkOneImage } from './chat-images.mjs';

const FOLDERS = ['asks', 'checklists', 'requests', 'events', 'beads', 'drawings', 'chat', 'pc', 'team', 'hermes-approvals'];
// Copied from site/card-api/handler.mjs (SECRET), applied to each segment on its own: the card API
// applies it to a whole path, where an Ask whose id mentions a token would be refused as a file.
const SECRET = /(^|\/)(\.env(\..*)?|.*\.(pem|key|p12|pfx)|id_(rsa|ed25519)(\.pub)?|.*(secret|credential|password|token).*\.(json|txt|ya?ml))$/i;

const MB = 1024 * 1024;
const LIMITS = { big: 8 * MB, chat: 64 * 1024, small: 256 * 1024 };
const CACHE_MAX = 5000;
const EVENT_CAP = 2000;
const POOL = 16;
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
export function createHub({ bucket = null, prefix = 'sections', inbox = 'inbox', enabled = false, env = {}, fetchImpl = fetch, now = () => new Date(), log = console.log, hermesTiming = {} } = {}) {
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
    for (const month of monthPrefixes(at)) {
      const { objects } = await bucket.list(key(`${root}/${month}`));
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
    for (const day of windowDays(at, days)) {
      const { objects } = await bucket.list(key(`events/${day}`) + '/');
      for (const object of objects) {
        const file = object.key.split('/').pop();
        if (file.endsWith('.json')) names.push({ day, file });
      }
    }
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
  // Approvals are signed with HUB_SIGNING_KEY. A key that does not parse turns Approve off (and says so) instead of stopping the API.
  let signingKey = null;
  let approveReason = 'Approvals are signed on the server; open mission control on the site.';
  try { signingKey = loadSigningKey(env); } catch (error) { approveReason = 'The signing key on the server is not valid.'; log(`[hub] ${error.message}`); }
  const scrub = createScrub(env);
  // Cloud routines (CLAUDE_ROUTINE_<REPO_KEY>_URL/_TOKEN): which repos can run in the cloud, known before the request module is made.
  const routineSet = loadRoutines(env);
  const dryRun = String(env.HUB_ROUTINE_DRY_RUN ?? '').trim() === '1';
  const hasCloud = repo => dryRun || (!!repo && !!routineFor(routineSet.routines, repo));
  const requestFiles = createRequests({ bucket, key, cached, putCreateOnly, listFolders, pool, fail, projectRepo, hasCloud, cloudRepos: () => [...routineSet.routines.keys()], signingKey, approveReason, log, scrub,
    cloudNever: String(env.HUB_CLOUD_NEVER ?? '').split(',').map(name => name.trim()).filter(Boolean),
    repoProjects: PROJECT_DEFAULTS.map(row => row.id),
    // Repos beyond the projects' own, for Spawn's picker: `HUB_KNOWN_REPOS=owner/name,owner/other`. Bad entries are dropped.
    extraRepos: String(env.HUB_KNOWN_REPOS ?? '').split(',').map(item => item.trim()).filter(Boolean),
  });
  const routines = createRoutines({ env, fetchImpl, bucket, key, requests: requestFiles, listFolders, putCreateOnly, cached, fail, signingKey, now, log: line => log(scrub(line, 400)), scrub });
  // The sprite flow: an answer to an avatar Ask starts the sheet run or chooses the sheet (hub-avatar.mjs).
  const avatarFlow = createAvatar({ requests: requestFiles, chooseAvatar: (agentId, raw, user, at) => chooseAvatar(agentId, raw, user, at), agents: AGENTS.map(agent => agent.id), log });
  // A proposal that policy would sign carries a note once the day's limit is reached, so the list says why it waits for a tap.
  const loadRequests = async at => policy.annotate(await requestFiles.loadRequests(at));
  // Hermes request runs: the hand-off, the followers and the re-attach after a restart. Idle without HERMES_URL and HERMES_API_KEY.
  const notify = createNotify({ env, fetchImpl, log: line => log(scrub(line, 400)) });
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
  // The cloud fire queue: sweeps approved cloud requests at start and every 5 minutes. Idle without a routine (or the dry run) and a key.
  if (on) routines.start();
  if (on && hermesDispatch.runs.configured) hermesDispatch.reattach().catch(error => log(`[hub] could not re-attach Hermes runs: ${scrub(error.message)}`));

  /** Every copy of the project's Beads export, merged: the newest version of each issue wins. */
  async function loadBeads(project) {
    return beadsReader.load(project);
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
      for (const prefix of prefixes) {
        const { objects } = await bucket.list(key(`pc/status-${prefix}`));
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

  // "Wake the PC": HUB_WAKE_URL unset turns it off. Approve of a PC request wakes it too when HUB_WAKE_ON_APPROVE=1 (hub-pc, pc-wake).
  const wake = createWake({ env, fetchImpl, bucket, key, fail, log: line => log(scrub(line, 200)) });
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
    await Promise.all(AGENTS.map(async agent => {
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

  async function teamView(at) {
    const [window, status, hermes, lastChat, choices] = await Promise.all([loadEvents(at), loadPcStatus(at), hermesState(), lastChatAt().catch(() => ''), avatarChoices()]);
    const working = workingNow({ status, events: window.events, at, defaults: PROJECT_DEFAULTS });
    const statuses = agentStatuses({ working, pc: status ? pcSummary(status, at) : null, hermes, lastChat, at });
    return { agents: buildTeam({ statuses, choices }) };
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
    if (!AGENTS.some(agent => agent.id === agentId)) throw fail('No such agent.', 404);
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

  async function askDetail(id, at) {
    const { ask, names } = await askFolder(id);
    const snooze = names.has('snooze.json') ? (await fresh(`asks/${id}/snooze.json`))?.value : null;
    const state = askState(names, ask, at, snooze);
    const read = async name => (names.has(name) ? cached(`asks/${id}/${name}`) : undefined);
    const [answer, pickup, cancel] = await Promise.all([read('answer.json'), read('pickup.json'), read('cancel.json')]);
    return {
      ...ask, ...state,
      ...(answer ? { answer } : {}), ...(pickup ? { pickup } : {}), ...(cancel ? { cancel } : {}),
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

  async function checklistDetail(id) {
    const { checklist, names } = await checklistFolder(id);
    const state = checklistState(names);
    const { done, total, marks } = checklistProgress(checklist, names);
    const read = async name => (names.has(name) ? cached(`checklists/${id}/${name}`) : undefined);
    const [submit, pickup, cancel] = await Promise.all([read('submit.json'), read('pickup.json'), read('cancel.json')]);
    const pictures = checklistEvidence(names);
    return {
      ...checklist, state, done, total,
      evidence: Object.fromEntries([...pictures.evidence].map(([item, { file, at }]) => [item, { file, at }])),
      shots: pictures.shots,
      items: checklist.items.map(item => ({ ...item, done: !!marks.get(item.id)?.done, ...(marks.get(item.id) ? { at: marks.get(item.id).at } : {}) })),
      ...(submit ? { submit } : {}), ...(pickup ? { pickup } : {}), ...(cancel ? { cancel } : {}),
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

  async function answerAsk(id, data, user, at, response) {
    if (await exists(`asks/${id}/answer.json`)) throw await alreadyAnswered(id);
    const { ask, names } = await askFolder(id);
    const snooze = names.has('snooze.json') ? (await fresh(`asks/${id}/snooze.json`))?.value : null;
    const { state } = askState(names, ask, at, snooze);
    if (!canAnswer(state)) {
      throw fail(state === 'expired' ? `This Ask is expired: it ran out at ${ask.expiresAt}.` : `This Ask is ${state.replace('-', ' ')}.`, 409);
    }
    checkAnswer(ask, data);
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
    // The answer stands whatever happens next. An avatar Ask may start the sheet run or choose the sheet.
    const avatar = await avatarFlow.afterAnswer({ ask, answer, user, at });
    return { status: 201, body: { state: 'answered', answer, ...(avatar ? { avatar } : {}) } };
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
    const detail = reviewDetail(events, id);
    if (!detail) throw missing();
    if (!detail.card) {
      const inferred = await inferCard(detail).catch(() => null);
      if (inferred) detail.inferred = inferred;
    }
    return detail;
  }

  /** Every card of every card section: `sections/<id>/workspace.json` entities, with the section's tracked repo. */
  async function allCards() {
    const { prefixes } = await bucket.list(`${prefix}/`, { delimiter: '/' });
    const sections = prefixes.map(name => name.slice(prefix.length + 1).replace(/\/$/, '')).filter(id => /^[a-z0-9][a-z0-9-]{0,63}$/.test(id) && !/^inbox(-[a-z0-9]+)?$/.test(id));
    const lists = await pool(6, sections, async section => {
      const got = await bucket.getJson(`${prefix}/${section}/workspace.json`).catch(() => null);
      const entities = got?.value?.entities;
      if (!Array.isArray(entities)) return [];
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
  let cardIndex = { at: 0, byRef: new Map() };
  const cardRow = row => ({ title: row.title, href: `/${encodeURIComponent(row.section)}#/${encodeURIComponent(row.id)}` });
  /** Make sure the index is no older than a minute (`maxAge` ms), listing the sections at most once per call. */
  async function refreshCardIndex(maxAge = 60000) {
    if (now().getTime() - cardIndex.at <= maxAge) return;
    // A failed listing also counts as a try, so an S3 outage does not list every section for every lookup.
    const at = now().getTime();
    try {
      const byRef = new Map();
      for (const row of await allCards()) {
        byRef.set(`${row.section}/${row.folder}`, cardRow(row));
        if (!byRef.has(`${row.section}#${row.id}`)) byRef.set(`${row.section}#${row.id}`, cardRow(row));
      }
      cardIndex = { at, byRef };
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

  /** The sprint card an old review belongs to, found from its title; its files are the ones the summary names that exist. */
  async function inferCard(detail) {
    const card = findSprintCard(detail.title, await allCards());
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

  async function projects(at) {
    const found = new Map();
    const add = (id, patch = {}) => {
      if (!validProject(id)) return;
      found.set(id, { id, name: titleCase(id), beads: false, ...found.get(id), ...patch });
    };
    const { objects } = await bucket.list(folder('beads'));
    for (const [id, pushedAt] of await beadsReader.projects(objects)) add(id, { beads: true, ...(pushedAt ? { pushedAt } : {}) });
    const [asks, checklists, requests, window] = await Promise.all([loadAsks(at), loadChecklists(at), loadRequests(at), loadEvents(at)]);
    for (const row of asks) add(row.ask.project);
    for (const row of checklists) add(row.checklist.project);
    for (const item of requests) add(item.project);
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
    if (kind === 'checklist') return checklistDetail(id);
    if (kind === 'review') return reviewDetailFor(id, at);
    if (kind === 'blocked') {
      const { events } = await loadEvents(at);
      const row = deriveEventItems(events).blocked.find(item => item.id === id);
      if (!row) throw fail('This session is no longer blocked, or is not in the last 7 days.', 404);
      return row;
    }
    throw fail('No such kind of item.');
  }

  const chat = createChat({ env, fetchImpl, key, fresh, bucket, loadAsks, loadRequests, loadHelpItem, readJson, json, fail, now, hermesRuns: hermesDispatch.runs, copyApproval: hermesApprovals.copyApproval, readApproval: id => hermesApprovals.detail(id, now()) });

  const self = {
    enabled: on,
    /** The request module, for the later items that sign (follow-ups, policy) and for the Hermes follower to plug its hooks into. */
    requests: requestFiles,
    requestHooks: requestFiles.hooks,
    /** The cloud routines module (fire, record, cap), for the tests. */
    routines,
    avatar: avatarFlow,
    hermes: hermesDispatch,
    /** The Hermes approvals module (copy, answer), for the tests. */
    approvals: hermesApprovals,
    /** Stops the followers and the sweep (shutdown, tests). */
    policy,
    close: async () => { policy.close(); await routines.close(); await hermesDispatch.close(); },
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
    async handle({ request, response, method, route, query = new URLSearchParams(), user = null, requireRemoteUser = false }) {
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
          if (route === '/hub/today' || route === '/hub/inbox' || route === '/hub/work') { hermesDispatch.pageLoad(at); policy.pageLoad(at); }
          if (route === '/hub/today') {
            const [asks, checklists, requests, window, hermesOpen] = await Promise.all([loadAsks(at), loadChecklists(at), loadRequests(at), loadEvents(at), hermesApprovals.loadOpen(at)]);
            const status = await loadPcStatus(at);
            const cloudOn = routines.dryRun || routines.cloudRepos().length > 0;
            const cloud = cloudOn ? await routines.capacity(at, { memo: true }).catch(() => null) : null;
            const today = buildToday({ asks: asks.map(row => row.item), checklists: checklists.map(row => row.item), requests, hermesApprovals: hermesOpen, events: await eventsWithRuns(window.events, requests, at), now: at, alerts: routines.alerts(), cloud, dismissed: dismissedAlerts(window.events) });
            const working = workingNow({ status, events: window.events, requests, at, defaults: PROJECT_DEFAULTS });
            // Running is what is at work: the PC's sessions when its status is fresh, else the event-derived list, and every taken request that has not finished. `running` stays for old clients.
            reply({ ...today, counts: { ...today.counts, running: working.filter(isActive).length }, working, pc: status ? pcSummary(status, at) : null, wake: await wake.view(status, at) });
          } else if (route === '/hub/pc') {
            const status = await loadPcStatus(at);
            reply({ pc: status ? pcSummary(status, at) : null, status, wake: await wake.view(status, at) });
          } else if (route === '/hub/inbox') {
            const filter = inboxFilter(query.get('filter'));
            const [asks, checklists, requests, window, hermesOpen] = await Promise.all([loadAsks(at), loadChecklists(at), loadRequests(at), loadEvents(at), hermesApprovals.loadOpen(at)]);
            const askItems = asks.map(row => row.item);
            const listItems = checklists.map(row => row.item);
            const items = buildInbox({ filter, asks: askItems, checklists: listItems, requests, hermesApprovals: hermesOpen, events: window.events, now: at });
            const counts = inboxCounts(buildToday({ asks: askItems, checklists: listItems, requests, hermesApprovals: hermesOpen, events: window.events, now: at, alerts: routines.alerts() }).needsYou);
            // With detail=1, the first rows that are Asks or lists carry the same object their own route answers, so the
            // screen can show the options and the steps without a second request each. The rest come without.
            const withDetail = new Set(query.get('detail') === '1' ? items.filter(item => item.kind === 'ask' || item.kind === 'checklist').slice(0, INBOX_DETAIL_CAP) : []);
            const rows = await pool(POOL, items, async item => {
              const row = { ...item, needs: needsKindOf(item), describe: describeItem(item, at) };
              if (!withDetail.has(item)) return row;
              try { return { ...row, detail: item.kind === 'ask' ? await askDetail(item.id, at) : await checklistDetail(item.id) }; } catch { return row; }
            });
            reply({ items: rows, counts });
          } else if ((match = /^\/hub\/asks\/([^/]+)$/.exec(route))) {
            reply(await askDetail(decodeURIComponent(match[1]), at));
          } else if ((match = /^\/hub\/checklists\/([^/]+)$/.exec(route))) {
            reply(await checklistDetail(decodeURIComponent(match[1])));
          } else if ((match = /^\/hub\/reviews\/([^/]+)$/.exec(route))) {
            reply(await reviewDetailFor(decodeURIComponent(match[1]), at));
          } else if ((match = /^\/hub\/hermes-approvals\/([^/]+)$/.exec(route))) {
            reply(await hermesApprovals.detail(decodeURIComponent(match[1]), at));
          } else if ((match = /^\/hub\/requests\/([^/]+)\/events$/.exec(route))) {
            await hermesDispatch.streamEvents(response, decodeURIComponent(match[1]));
          } else if ((match = /^\/hub\/requests\/([^/]+)$/.exec(route))) {
            const detail = await requestFiles.detail(decodeURIComponent(match[1]), at);
            const cardHref = await cardHrefOf(detail.result?.card);
            reply({ ...detail, ...(cardHref ? { cardHref } : {}), ...(nothingToDo(detail.result) ? { nothing: true } : {}) });
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
              events: events.filter(event => !ALERT_MARKS.includes(event.kind) && new Date(event.ts).getTime() >= since && (!project || event.project === project)),
              truncated: window.truncated,
            });
          } else if (route === '/hub/projects') {
            reply({ projects: await projects(at) });
          } else if (route === '/hub/work') {
            const only = query.get('project');
            if (only && !validProject(only)) throw fail('No such project.', 404);
            const ids = only ? [only] : (await projects(at)).filter(row => row.beads).map(row => row.id);
            const [loaded, requests, window, asks, status] = await Promise.all([
              pool(POOL, ids, async id => ({ id, ...(await loadBeads(id)) })), loadRequests(at), loadEvents(at), loadAsks(at), loadPcStatus(at),
            ]);
            reply(buildWork({
              issues: loaded.flatMap(row => row.issues.map(issue => ({ ...issue, project: row.id }))),
              requests: only ? requests.filter(item => item.project === only) : requests,
              events: window.events, asks: asks.map(row => ({ id: row.ask.id, bead: row.ask.bead, state: row.state.state })), status, now: at,
            }));
          } else if ((match = /^\/hub\/beads\/([^/]+)$/.exec(route))) {
            if (!validProject(match[1])) throw fail('No such project.', 404);
            reply(await loadBeads(match[1]));
          } else if ((match = /^\/hub\/map\/([^/]+)$/.exec(route))) {
            const project = match[1];
            if (!validProject(project)) throw fail('No such project.', 404);
            const [{ meta, issues }, window, asks, cards] = await Promise.all([loadBeads(project), loadEvents(at), loadAsks(at), cardResolver()]);
            const repo = meta?.repo || await projectRepo(project);
            reply(buildMap({
              project, meta, issues, events: window.events, repo, cards,
              asks: asks.map(row => ({ id: row.ask.id, bead: row.ask.bead, state: row.state.state })), now: at,
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
        } else if (route === '/hub/pc/wake') {
          if (!user) throw fail('Sign in to wake the PC.', 401);
          send(await wake.send({ by: user, at }));
        } else if (route === '/hub/requests') {
          send(await requestFiles.create(raw, user, at));
        } else if ((match = /^\/hub\/hermes-approvals\/([^/]+)\/answer$/.exec(route))) {
          if (!user) throw fail('Sign in to answer.', 401);
          send(await hermesApprovals.answer(decodeURIComponent(match[1]), raw, user, at));
        } else if ((match = /^\/hub\/requests\/([^/]+)\/([a-z-]+)$/.exec(route))) {
          send(await requestFiles.post(decodeURIComponent(match[1]), match[2], raw, user, at));
        } else if (route === '/hub/drawings') {
          send(await saveDrawingNew(raw, at));
        } else if ((match = /^\/hub\/drawings\/([^/]+)\/delete$/.exec(route))) {
          send(await deleteDrawing(match[1], user, at));
        } else if ((match = /^\/hub\/drawings\/([^/]+)$/.exec(route))) {
          send(await saveDrawingOld(match[1], raw));
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
