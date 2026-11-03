// Sprints on the PC (ws-im1.2.2): a sprint is a chain of ordinary runs, one `sprint-item` request per bead, one at a time. The
// owner starts it on a milestone; the Hub snapshots the beads into a signed `requests/<head>/sprint.json`, signs item 1, and a sweep
// signs each next item when the one before it is done. Every item is an ordinary signed approval: no wider allow list, nothing can
// merge. The approval carries `run.sprint = { head, seq, of, until, after }`, which the PC watcher uses to start the run on the
// previous item's pushed branch and to cap its time (scripts/pc-dispatch/README.md, "Sprint items").
//
// The Hub is the only guard on `after`: the watcher accepts `after: null` for an item that follows a card-only item, so a lost or
// missing `after` would start a later item from main. `approveRequest` therefore never takes `after` from a caller: it works it out
// from the chain's own files (`afterOf` over `chainOf`) and refuses when an earlier item is missing, foreign or unfinished.
//
// This module has the pure parts (eligibility, the signed document, the chain and the step table) and the module that writes.
import { createPublicKey } from 'node:crypto';
import { BEAD_ID, applyMarks } from './hub-marks.mjs';
import { buildMap, isWayfinderQuestion } from './hub-map.mjs';
import { plainText } from './hub-map-notes.mjs';
import { newRequestId, validId, validProject } from './hub-model.mjs';
import { defaultsOf } from './project-defaults.mjs';
import { newNonce, sign, verify } from './signing.mjs';

/** The most items a sprint holds: the PC's `caps.perDay` is 10. */
export const SPRINT_MAX_ITEMS = 8;
/** Under this many minutes left, no new item starts and the sprint ends `timebox`. */
export const MIN_ITEM_MINUTES = 20;
/** The timeboxes the sheet offers, in minutes: 90m, 4h and "until done" (8 h at most). */
export const TIMEBOXES = [90, 240, 480];
const DESCRIPTION_MAX = 3000;
const TITLE_MAX = 200;
const DONE_MAX = 400;
const SWEEP_MS = 60_000;
const OPEN_ITEM = ['proposed', 'approved', 'taken', 'running', 'stopping'];

/** The request id of item `seq`: the head itself for item 1, else the head plus `-s002` (four characters, so it is a request id). */
export const itemId = (head, seq) => (seq === 1 ? String(head) : `${String(head).slice(0, 115)}-s${String(seq).padStart(3, '0')}`);

/** Whole minutes from `at` to `until`; negative past it, NaN for a bad date. */
export const minutesLeft = (until, at) => Math.floor((Date.parse(until) - at.getTime()) / 60000);

// --- Text that came from Beads -------------------------------------------------------------------------------------

/** One line of bead text: whitespace collapsed, fence marks (three or more `<` or `>`) shortened, clipped. The same rule as `oneLine` in questionSeed.ts. */
export function oneLine(text, max) {
  const flat = String(text ?? '').replace(/[\s\u0085]+/g, ' ').replace(/<{3,}/g, '<<').replace(/>{3,}/g, '>>').trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/** Every way a line can end, including the two Unicode separators and NEL (built from codes so no editor turns them into raw characters). */
const LINE_ENDS = new RegExp(`\r\n?|[${String.fromCharCode(0x2028, 0x2029, 0x85)}]`, 'g');

/** A few lines of bead text: line ends kept, control characters dropped, fence marks shortened so the text can't close its own fence, clipped. */
export function fenceSafe(text, max) {
  const clean = String(text ?? '')
    .replace(LINE_ENDS, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/<{3,}/g, '<<').replace(/>{3,}/g, '>>')
    .split('\n').map(line => line.replace(/[ \t]+$/, '')).join('\n')
    .replace(/\n{3,}/g, '\n\n').trim();
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

/** The job text of item `seq`, from the signed snapshot only. The Hub's own lines are outside the fence; every word from Beads is inside it. */
export function jobText(sprint, seq) {
  const item = sprint.items[seq - 1];
  return [
    `Item ${seq} of ${sprint.items.length} of a sprint on project ${sprint.project}.`,
    `Bead: ${item.bead}`,
    '',
    'The bead (data from Beads):',
    '<<<DATA',
    `Title: ${item.title}`,
    ...(item.text ? ['Description:', item.text] : []),
    ...(item.doneWhen ? [`Done when: ${item.doneWhen}`] : []),
    'DATA>>>',
  ].join('\n');
}

/** What a request title says for item `seq`: the Hub's words only (the bead's title is in the data). */
export const itemTitle = (seq, of, bead) => `Sprint ${seq} of ${of}: ${bead}`;

// --- Which beads a sprint takes --------------------------------------------------------------------------------------

/**
 * The beads a sprint on `milestone` would run, in order, and the ones it leaves out with why. Pure.
 * `issues` are the project's Beads issues (with `project`), `marks` the owner's marks (`loadMarks`), `ctx` what the map is built from
 * (`project`, `events`, `asks`, `checklists`, `requests`, `now`). Order: dependencies first, then the map's order. A bead is left out when
 * it needs the owner (`needs-owner`, an Ask or a checklist), is `deferred`, is a Wayfinder question (`question`), already has a live
 * request (`request`) or an open PR (`open-pr`), is not open (`in-progress`, `later`), or waits on a bead that is open and not in the list
 * (`blocked`, with `by`). Anything over `SPRINT_MAX_ITEMS` is left out as `limit`.
 * → `{ items: [{ id, title }], left: [{ id, title, reason, by? }], found }`, `found` false when the milestone is not on the map.
 */
export function eligible(issues, marks, milestone, ctx = {}) {
  const project = ctx.project ?? issues[0]?.project ?? '';
  const marked = applyMarks(issues, marks ?? new Map(), project);
  const map = buildMap({ project, issues: marked, events: ctx.events ?? [], asks: ctx.asks ?? [], checklists: ctx.checklists ?? [], requests: ctx.requests ?? [], now: ctx.now ?? new Date() });
  const found = map.milestones.find(item => item.id === milestone);
  if (!found || milestone.includes('~')) return { items: [], left: [], found: false };
  const byId = new Map(marked.map(issue => [issue.id, issue]));
  const tasks = found.features.flatMap(feature => feature.tasks).filter(task => task.state !== 'done' && task.status !== 'closed');
  const left = [];
  const out = (task, reason, extra = {}) => left.push({ id: task.id, title: task.title, reason, ...extra });
  let candidates = [];
  for (const task of tasks) {
    const open = (task.prs ?? []).some(pr => pr.state === 'open') || task.signs.includes('pr');
    if (!BEAD_ID.test(task.id)) out(task, 'later');
    else if (task.state === 'you') out(task, 'needs-owner');
    else if (task.status === 'deferred') out(task, 'deferred');
    else if (isWayfinderQuestion(marked, task.id)) out(task, 'question');
    else if (task.run) out(task, 'request');
    else if (open) out(task, 'open-pr');
    else if (task.status === 'in_progress') out(task, 'in-progress');
    else if (task.status !== 'open') out(task, 'later');
    else candidates.push(task);
  }
  // A bead whose open blocker is not in the list waits for it; leaving it out can leave out the ones that wait on it, so repeat.
  for (let changed = true; changed;) {
    changed = false;
    const inList = new Set(candidates.map(task => task.id));
    const next = [];
    for (const task of candidates) {
      const blocker = task.deps.find(id => byId.get(id)?.status !== 'closed' && !inList.has(id));
      if (blocker) { out(task, 'blocked', { by: blocker }); changed = true; } else next.push(task);
    }
    candidates = next;
  }
  // Dependency order, ties in the map's order.
  const ordered = [];
  const placed = new Set();
  const remaining = [...candidates];
  while (remaining.length) {
    const at = remaining.findIndex(task => task.deps.every(id => placed.has(id) || !remaining.some(other => other.id === id)));
    const [task] = remaining.splice(at < 0 ? 0 : at, 1);   // a cycle: the rest falls back to the map's order
    ordered.push(task);
    placed.add(task.id);
  }
  for (const task of ordered.slice(SPRINT_MAX_ITEMS)) out(task, 'limit');
  return { items: ordered.slice(0, SPRINT_MAX_ITEMS).map(task => ({ id: task.id, title: task.title })), left, found: true };
}

// --- The signed snapshot ---------------------------------------------------------------------------------------------

const isoDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));

/**
 * The sprint document if it is one the Hub signed (`public` is the verifying key), else null. Checks the shape too, because everything
 * downstream (the job text of each item, the run block, the time left) is made from it.
 */
export function checkSprintDoc(doc, publicKey) {
  if (!doc || typeof doc !== 'object' || !verify(doc, publicKey)) return null;
  if (doc.v !== 1 || doc.kind !== 'sprint' || doc.request !== undefined) return null;
  if (!validId(doc.head) || !validProject(doc.project) || typeof doc.repo !== 'string' || !doc.repo || typeof doc.milestone !== 'string' || typeof doc.by !== 'string') return null;
  if (!TIMEBOXES.includes(doc.timebox) || !isoDate(doc.until) || !isoDate(doc.at)) return null;
  if (!Array.isArray(doc.items) || doc.items.length < 1 || doc.items.length > SPRINT_MAX_ITEMS) return null;
  const good = doc.items.every((item, index) => item && item.seq === index + 1 && BEAD_ID.test(String(item.bead)) && typeof item.title === 'string' && typeof item.text === 'string'
    && (item.doneWhen === undefined || typeof item.doneWhen === 'string'));
  return good ? doc : null;
}

// --- The chain -------------------------------------------------------------------------------------------------------

const cleanReason = value => (typeof value === 'string' ? value.replace(/[^A-Za-z0-9 ._-]/g, '').slice(0, 40) : '');
const httpsOnly = value => (typeof value === 'string' && /^https:\/\//i.test(value) ? value.slice(0, 500) : undefined);

/**
 * The items that exist, in order, with their state: `[{ seq, id, state, outcome?, reason?, pr? }]`. It stops at the first item that does
 * not exist. An item at one of the sprint's ids that the Hub did not make for it (not written by the site, not the preset, another bead or
 * head, an approval that does not verify or names another place in the chain) has state `foreign`: it never counts.
 * `deps` is `{ loadOne(id, at), siteWrote(id), publicKey }`.
 */
export async function chainOf(sprint, deps, at, upTo = sprint.items.length) {
  const chain = [];
  for (let seq = 1; seq <= upTo; seq += 1) {
    const id = itemId(sprint.head, seq);
    let loaded;
    try { loaded = await deps.loadOne(id, at); } catch (error) { if (error?.status === 404) break; throw error; }
    const { request, parts, state } = loaded;
    const approval = parts.approved;
    const approvalOk = !approval || (verify(approval, deps.publicKey) && approval.request === id && approval.run?.sprint?.head === sprint.head && approval.run.sprint.seq === seq);
    const own = request.preset === 'sprint-item' && request.origin?.kind === 'owner' && request.bead === sprint.items[seq - 1].bead
      && request.sprint?.head === sprint.head && request.sprint?.seq === seq && request.project === sprint.project && approvalOk && await deps.siteWrote(id);
    const result = parts.result;
    chain.push({
      seq, id, state: own ? state : 'foreign',
      ...(typeof result?.outcome === 'string' ? { outcome: result.outcome } : {}),
      ...(cleanReason(result?.reason) ? { reason: cleanReason(result.reason) } : {}),
      ...(httpsOnly(result?.pr) ? { pr: httpsOnly(result.pr) } : {}),
    });
  }
  return chain;
}

/**
 * The previous item an item `seq` stacks on, from the chain alone: the last earlier item that finished with a pull request, or null when
 * none did (item 1, or only card-only items before it). Every earlier item must exist, be the Hub's and be `done` with outcome `pr` or `card`;
 * otherwise `{ error }`, and nothing is signed. This is the guard: the watcher takes `after: null` as "start at main".
 */
export function afterOf(chain, seq) {
  let after = null;
  for (let k = 1; k < seq; k += 1) {
    const item = chain.find(entry => entry.seq === k);
    if (!item) return { error: `Item ${k} of the sprint does not exist, so item ${seq} cannot start.` };
    if (item.state !== 'done') return { error: `Item ${k} of the sprint is ${item.state}, so item ${seq} cannot start.` };
    if (item.outcome !== 'pr' && item.outcome !== 'card') return { error: `Item ${k} of the sprint did not finish with a pull request or a card, so item ${seq} cannot start.` };
    if (item.outcome === 'pr') after = item.id;
  }
  return { after };
}

/**
 * What the sweep does next for a sprint, from its chain. Pure.
 * → `{ create: seq }` | `{ approve: seq }` | `{ wait: true }` | `{ end: reason, detail? }`.
 */
export function stepOf(sprint, chain, at) {
  const left = minutesLeft(sprint.until, at);
  const last = chain[chain.length - 1];
  if (!last) return left < MIN_ITEM_MINUTES ? { end: 'timebox' } : { create: 1 };
  // Every item before the last must have finished with a pull request or a card; one that did not (or is not the Hub's) ends the sprint.
  for (const earlier of chain.slice(0, -1)) {
    if (earlier.state !== 'done') return { end: earlier.state, ...(earlier.reason ? { detail: earlier.reason } : {}) };
    if (earlier.outcome !== 'pr' && earlier.outcome !== 'card') return { end: 'unexpected-outcome', detail: cleanReason(earlier.outcome) };
  }
  if (last.state === 'proposed') return { approve: last.seq };
  if (OPEN_ITEM.includes(last.state)) return { wait: true };
  if (last.state !== 'done') return { end: last.state, ...(last.reason ? { detail: last.reason } : {}) };
  if (last.outcome !== 'pr' && last.outcome !== 'card') return { end: 'unexpected-outcome', detail: cleanReason(last.outcome) };
  if (last.seq >= sprint.items.length) return { end: 'finished' };
  if (!(left >= MIN_ITEM_MINUTES)) return { end: 'timebox' };
  return { create: last.seq + 1 };
}

const END_WORDS = {
  finished: 'All items done',
  timebox: 'Stopped: time ran out',
  failed: 'Stopped: an item failed',
  lost: 'Stopped: the PC lost an item',
  stopped: 'Stopped: you stopped it',
  expired: 'Stopped: an item was not picked up in time',
  asking: 'Stopped: an item asked a question',
  declined: 'Stopped: an item was declined',
  foreign: 'Stopped: an item did not match the sprint',
  'unexpected-outcome': 'Stopped: an item ended without a pull request or a card',
  refused: 'Stopped: the Hub could not sign the next item',
};
/** The words after "Stopped:" for an end reason (and the run's own reason when it gave one). */
export const endWords = (reason, detail) => `${END_WORDS[reason] ?? `Stopped: ${reason}`}${detail && detail !== reason && reason !== 'finished' && reason !== 'timebox' ? ` (${detail})` : ''}`;

// --- The module ------------------------------------------------------------------------------------------------------

/**
 * @param requests       `createRequests(...)`: `loadOne`, `siteWrote`, `createFixed`, `approveRequest`
 * @param listFolders    `(root, at) → Map<id, Set<file name>>`
 * @param cached         reads a create-only JSON file through the cache (null when missing)
 * @param putCreateOnly  `(rel, body, contentType, conflict, metadata) → Promise`, throwing `conflict` on a 412
 * @param signingKey     the Ed25519 private key, or null: starting answers 503 and the sweep does nothing
 * @param writeEvent     `(event, at) → Promise`: one create-only Hub event
 * @param loadInputs     `(project, at) → { issues, marks, events, asks, checklists, requests }`: what `eligible` is built from
 * @param repoOf         `(project) → Promise<'owner/name' | undefined>`
 * @param fail           `(message, status) → Error`
 */
export function createSprints({ requests, listFolders, cached, putCreateOnly, signingKey = null, writeEvent, loadInputs, repoOf, fail, now = () => new Date(), log = () => {}, sweepMs = SWEEP_MS }) {
  const publicKey = signingKey ? createPublicKey(signingKey) : null;
  const deps = { loadOne: (id, at) => requests.loadOne(id, at), siteWrote: id => requests.siteWrote(id), publicKey };
  let lastCheck = 0;

  const readSprint = async head => (publicKey && validId(head) ? checkSprintDoc(await cached(`requests/${head}/sprint.json`), publicKey) : null);
  const write = (id, file, body, conflict) => putCreateOnly(`requests/${id}/${file}`, `${JSON.stringify(body, null, 2)}\n`, 'application/json', conflict);

  /** Every sprint in the listing window: `[{ head, sprint, ended }]`, newest first. A forged or unreadable sprint.json is skipped. */
  async function listSprints(at) {
    const rows = [];
    for (const [id, names] of await listFolders('requests', at)) {
      if (!names.has('sprint.json')) continue;
      const sprint = await readSprint(id);
      if (!sprint || sprint.head !== id) continue;
      const ended = names.has('sprint-end.json') ? await cached(`requests/${id}/sprint-end.json`) : null;
      rows.push({ head: id, sprint, ended: ended ? { reason: String(ended.reason ?? ''), at: ended.at, prs: Number(ended.prs) || 0 } : names.has('sprint-end.json') ? { reason: 'unknown' } : null });
    }
    return rows.sort((a, b) => (a.sprint.at < b.sprint.at ? 1 : a.sprint.at > b.sprint.at ? -1 : a.head < b.head ? 1 : -1));
  }

  const openSprint = async (project, at) => (await listSprints(at)).find(row => row.sprint.project === project && !row.ended) ?? null;

  /** Why a project can't run a sprint, or ''. */
  function whyNot(project) {
    const defaults = defaultsOf(project);
    if (project === 'bunnylink' || defaults?.runsOn === 'at-pc') return 'Sprints run on the PC. Bunnylink work is started by you at the PC.';
    if (defaults?.runsOn !== 'pc') return `Sprints run on the PC. ${defaults?.name ?? project} has no PC runs.`;
    return '';
  }

  /** `GET /hub/map/:project/sprint/:milestone`: what a sprint would run and leave out, and the sprint that is going, if any. */
  async function preview(project, milestone, at) {
    if (!validProject(project)) throw fail('No such project.', 404);
    const active = await openSprint(project, at);
    const activeView = active ? { head: active.head, milestone: active.sprint.milestone, until: active.sprint.until } : null;
    const why = whyNot(project);
    if (why) return { allowed: false, why, items: [], left: [], active: activeView, max: SPRINT_MAX_ITEMS };
    const inputs = await loadInputs(project, at);
    const result = eligible(inputs.issues, inputs.marks, milestone, { project, ...inputs, now: at });
    if (!result.found) throw fail('No such milestone.', 404);
    return { allowed: true, items: result.items, left: result.left, active: activeView, max: SPRINT_MAX_ITEMS };
  }

  /** The sprints of one project for the map: the newest per milestone, with the beads they run. */
  async function summaries(project, at) {
    if (!signingKey) return [];
    return (await listSprints(at)).filter(row => row.sprint.project === project).map(({ head, sprint, ended }) => ({
      head, milestone: sprint.milestone, until: sprint.until, at: sprint.at,
      items: sprint.items.map(item => ({ seq: item.seq, id: itemId(head, item.seq), bead: item.bead, title: item.title })), ...(ended ? { ended } : {}),
    }));
  }

  /** Make item `seq` (create-only: an item that exists is left as it is). Returns the id. */
  async function createItem(sprint, seq, at) {
    const id = itemId(sprint.head, seq);
    const item = sprint.items[seq - 1];
    try {
      await requests.createFixed({
        project: sprint.project, preset: 'sprint-item', repo: sprint.repo, title: itemTitle(seq, sprint.items.length, item.bead), text: jobText(sprint, seq),
        bead: item.bead, sprint: { head: sprint.head, seq }, textOrigin: { kind: 'agent', name: 'Beads' },
      }, { id, user: sprint.by, at });
    } catch (error) {
      if (error?.status !== 409) throw error;
    }
    return id;
  }

  /** Close the sprint: sign `sprint-end.json` (create-only) and, for the one writer that made it, the alert. */
  async function endSprint(sprint, chain, reason, detail, at) {
    const prs = chain.filter(entry => entry.outcome === 'pr' && entry.state === 'done').length;
    const clash = fail('That sprint has already ended.', 409);
    const body = sign({ v: 1, kind: 'sprint-end', head: sprint.head, project: sprint.project, reason, ...(detail ? { detail } : {}), items: sprint.items.length, prs, at: at.toISOString(), by: 'hub', nonce: newNonce() }, signingKey);
    try {
      await write(sprint.head, 'sprint-end.json', body, clash);
    } catch (error) {
      if (error === clash) return false;
      throw error;
    }
    const title = `Sprint on ${oneLine(sprint.title, 80)}: ${prs} of ${sprint.items.length} PRs open. ${endWords(reason, detail)}`;
    try {
      await writeEvent({ ts: at.toISOString(), kind: 'alert', project: sprint.project, title, host: 'hub', source: 'hub', sprint: sprint.head, by: 'hub' }, at);
    } catch (error) {
      log(`[hub] sprint ${sprint.head} ended but its alert was not written: ${String(error.message).slice(0, 120)}`);
    }
    return true;
  }

  /** One step of one sprint. Idempotent: safe to run again at any point, and from two places at once only through the queue. */
  async function advanceNow(head, at) {
    const sprint = await readSprint(head);
    if (!sprint) return { skipped: 'not a sprint of the Hub' };
    if (await cached(`requests/${head}/sprint-end.json`)) return { ended: true };
    const chain = await chainOf(sprint, deps, at);
    const step = stepOf(sprint, chain, at);
    if (step.wait) return { waiting: true };
    if (step.end) { await endSprint(sprint, chain, step.end, step.detail, at); return { ended: step.end }; }
    const seq = step.create ?? step.approve;
    const id = step.create ? await createItem(sprint, seq, at) : itemId(head, seq);
    try {
      await requests.approveRequest(id, { target: 'pc', by: sprint.by, at });
    } catch (error) {
      // A refusal ends the sprint, unless the item was approved in the meantime (the other writer won); a storage error waits for the next sweep.
      if (!(error?.status >= 400 && error?.status < 500)) throw error;
      const now = (await chainOf(sprint, deps, at, seq)).find(entry => entry.seq === seq);
      if (now && now.state !== 'proposed') return { approved: id };
      log(`[hub] sprint ${head}: item ${seq} was refused: ${String(error.message).slice(0, 120)}`);
      await endSprint(sprint, chain, 'refused', '', at);
      return { ended: 'refused', why: error.message };
    }
    return { approved: id };
  }

  // One queue, like policy.mjs: a sweep asked for while one runs waits its turn and sees what the first left.
  let queue = Promise.resolve();
  const queued = work => { const turn = queue.then(work); queue = turn.catch(() => {}); return turn; };
  const advance = (head, at = now()) => queued(() => advanceNow(head, at));

  async function sweepNow(at) {
    if (!signingKey) return [];
    const done = [];
    for (const [id, names] of await listFolders('requests', at)) {
      if (!names.has('sprint.json') || names.has('sprint-end.json')) continue;
      try { done.push({ head: id, ...(await advanceNow(id, at)) }); } catch (error) { log(`[hub] sprint ${id} could not advance: ${String(error.message).slice(0, 120)}`); }
    }
    return done;
  }
  const sweep = (at = now()) => queued(() => sweepNow(at));

  /**
   * `POST /hub/map/:project/sprint/:milestone { timebox }`: snapshot the eligible beads into a signed sprint.json, then sign item 1.
   * One sprint per project at a time (409). → `{ head, items, until }`.
   */
  function start(project, milestone, timebox, user, at) {
    return queued(async () => {
      if (!signingKey) throw fail('Approvals are not set up on this host, so a sprint cannot start.', 503);
      if (!user) throw fail('Sign in to start a sprint.', 401);
      if (!validProject(project)) throw fail('No such project.', 404);
      if (!TIMEBOXES.includes(timebox)) throw fail(`The timebox is ${TIMEBOXES.join(', ')} minutes.`, 400);
      const why = whyNot(project);
      if (why) throw fail(why, 400);
      const repo = await repoOf(project);
      if (!repo) throw fail('This project tracks no repository, so a sprint has nowhere to open pull requests.', 400);
      if (await openSprint(project, at)) throw fail('A sprint is already going on this project. Stop its current item to end it.', 409);
      const inputs = await loadInputs(project, at);
      const picked = eligible(inputs.issues, inputs.marks, milestone, { project, ...inputs, now: at });
      if (!picked.found) throw fail('No such milestone.', 404);
      if (!picked.items.length) throw fail('Nothing to run: every task of this milestone is left out.', 409);
      const marked = applyMarks(inputs.issues, inputs.marks ?? new Map(), project);
      const byId = new Map(marked.map(issue => [issue.id, issue]));
      const milestoneIssue = byId.get(milestone);
      const items = picked.items.map((row, index) => {
        const issue = byId.get(row.id);
        const doneWhen = typeof issue.acceptance_criteria === 'string' ? oneLine(plainText(issue.acceptance_criteria), DONE_MAX) : '';
        return {
          seq: index + 1, bead: row.id, title: oneLine(issue.title ?? row.id, TITLE_MAX),
          text: fenceSafe(issue.description, DESCRIPTION_MAX), ...(doneWhen ? { doneWhen } : {}),
        };
      });
      for (let attempt = 0; ; attempt += 1) {
        const head = newRequestId(project, `sprint ${milestone}`, at);
        const body = sign({
          v: 1, kind: 'sprint', head, project, repo, milestone, title: oneLine(milestoneIssue?.title ?? milestone, 120), timebox,
          until: new Date(at.getTime() + timebox * 60000).toISOString(), by: user, at: at.toISOString(), nonce: newNonce(), items,
        }, signingKey);
        const clash = fail('Could not find a free id; try again.', 409);
        try {
          await write(head, 'sprint.json', body, clash);
        } catch (error) {
          if (error === clash && attempt < 2) continue;
          throw error;
        }
        const first = await advanceNow(head, at);
        if (first.ended) throw fail(first.why ? `The first item could not start: ${first.why}` : `The sprint ended at once (${first.ended}).`, 409);
        return { head, items: items.length, until: body.until };
      }
    });
  }

  let timer = null;
  let ready = Promise.resolve();
  if (signingKey && sweepMs > 0) {
    timer = setInterval(() => { sweep().catch(error => log(`[hub] sprint sweep failed: ${error.message}`)); }, sweepMs);
    timer.unref?.();
  }

  return {
    preview, start, advance, sweep, summaries, ready, openSprint: (project, at = now()) => openSprint(project, at),
    /** On a page load, at most once per 30 s. */
    pageLoad(at = now()) {
      if (!signingKey || sweepMs <= 0 || Date.now() - lastCheck < 30_000) return;
      lastCheck = Date.now();
      sweep(at).catch(error => log(`[hub] sprint sweep failed: ${error.message}`));
    },
    close() { clearInterval(timer); },
  };
}
