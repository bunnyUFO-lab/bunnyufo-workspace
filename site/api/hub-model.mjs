// The Hub's rules, with no I/O: Ask state, what Today and the Inbox show, ids and slugs, and the
// checks on what a request carries. hub.mjs reads the bucket and calls these; the tests call them
// directly. Everything is a function of its arguments (the clock included).
import { createHash } from 'node:crypto';

export const ID_RE = /^\d{8}-[a-z0-9-]+-[a-z0-9]{4}$/;
export const DRAWING_ID_RE = /^\d{8}-[a-z0-9]{6}$/;
export const PROJECT_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const WHEN = ['next-sprint', 'nightly', 'record'];
export const DAY = 24 * 60 * 60 * 1000;
export const WINDOW_DAYS = 7;

export const validId = value => typeof value === 'string' && value.length <= 120 && ID_RE.test(value);
export const validDrawingId = value => typeof value === 'string' && DRAWING_ID_RE.test(value);
export const validProject = value => typeof value === 'string' && PROJECT_RE.test(value);

/** "magic-loops" → "Magic Loops" (the same rule the site API uses for a section without a name). */
export const titleCase = id => String(id).split('-').filter(Boolean).map(word => word[0].toUpperCase() + word.slice(1)).join(' ');

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
export const randomId = (length, random = Math.random) => Array.from({ length }, () => ALPHABET[Math.floor(random() * ALPHABET.length)]).join('');

/** yyyymmdd and yyyymm in UTC. */
export const day8 = date => date.toISOString().slice(0, 10).replace(/-/g, '');
export const month6 = date => day8(date).slice(0, 6);
export const dayDash = date => date.toISOString().slice(0, 10);

/** This month and the one before, as the `asks/<yyyymm>` prefixes to list (UTC). */
export function monthPrefixes(now) {
  const previous = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return [month6(now), month6(previous)];
}

/** The last seven UTC days as `yyyy-mm-dd`, newest first. */
export function windowDays(now, days = WINDOW_DAYS) {
  return Array.from({ length: days }, (_, index) => dayDash(new Date(now.getTime() - index * DAY)));
}

const SKIP_WORDS = new Set(['token', 'secret', 'password', 'credential']);

/** The first five words of a request, lower-cased, minus the ones that look like secrets. */
export function requestSlug(text, limit = 40) {
  const words = String(text ?? '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).filter(word => !SKIP_WORDS.has(word));
  return words.slice(0, 5).join('-').slice(0, limit).replace(/-+$/, '');
}

export function newRequestId(project, text, now, random = Math.random) {
  const slug = requestSlug(text) || 'request';
  return `${day8(now)}-${project}-${slug}-${randomId(4, random)}`.slice(0, 120);
}

export const newDrawingId = (now, random = Math.random) => `${day8(now)}-${randomId(6, random)}`;

/**
 * The Ask's state from the file names in its folder, top to bottom, the first match winning.
 * `snooze` is the body of snooze.json and is only needed when that file is there.
 * → { state: 'cancelled' | 'picked-up' | 'answered' | 'snoozed' | 'expired' | 'open', snoozedUntil? }
 */
export function askState(names, ask, now, snooze = null) {
  const has = name => (names instanceof Set ? names.has(name) : names.includes(name));
  if (has('cancel.json')) return { state: 'cancelled' };
  if (has('pickup.json')) return { state: 'picked-up' };
  if (has('answer.json')) return { state: 'answered' };
  if (has('snooze.json') && snooze?.until && new Date(snooze.until).getTime() > now.getTime()) return { state: 'snoozed', snoozedUntil: snooze.until };
  if (ask?.expiresAt && now.getTime() > new Date(ask.expiresAt).getTime()) return { state: 'expired' };
  return { state: 'open' };
}

export const canAnswer = state => state === 'open' || state === 'snoozed';

/** A run that has said nothing for this long is not running; a request taken this long ago with no run is lost. */
export const RUN_STALE_MS = 20 * 60 * 1000;

/** The time a run file's name carries: `run-<yyyymmddThhmmssmmmZ>-<rand4>.json`, or null. */
export function runFileTime(name) {
  const match = /^run-(\d{8}T\d{9}Z)-[a-z0-9]{4}\.json$/.exec(String(name));
  const time = match ? new Date(stampIso(match[1])).getTime() : NaN;
  return Number.isNaN(time) ? null : time;
}

/**
 * The state of a request.
 *
 * Called with a Set or an array of file names it answers as it always did for a request made the old way:
 * `taken` when taken.json is there, else `open`. Called with
 * `{ names, request, approved, taken, result, newestRunAt, hermesLive, pcBusy, now }` it applies the table in
 * docs/workspaces.md ("Requests"), the first match winning. A request without a `preset` is a legacy one and
 * only ever reads `declined`, `taken` or `open`. `newestRunAt` is a Date or a time in ms, `hermesLive` says a
 * follower is on the request's Hermes run, `pcBusy(session)` says the PC report shows that session busy.
 */
export function requestState(input) {
  if (input instanceof Set || Array.isArray(input)) return (input instanceof Set ? input.has('taken.json') : input.includes('taken.json')) ? 'taken' : 'open';
  const { names = [], request = null, approved = null, taken = null, result = null, newestRunAt = null, hermesLive = false, pcBusy = () => false, now = new Date() } = input ?? {};
  const has = name => (names instanceof Set ? names.has(name) : names.includes(name));
  const nowMs = now.getTime();
  const isTaken = has('taken.json');
  if (has('declined.json')) return 'declined';
  if (!request?.preset) return isTaken ? 'taken' : 'open';
  const hasResult = has('result.json');
  const lastRun = newestRunAt == null ? NaN : newestRunAt instanceof Date ? newestRunAt.getTime() : Number(newestRunAt);
  const running = isTaken && !hasResult && ((Number.isFinite(lastRun) && nowMs - lastRun < RUN_STALE_MS) || hermesLive === true || pcBusy(taken?.session) === true);
  const takenAt = new Date(taken?.at ?? '').getTime();
  const lost = isTaken && !hasResult && !running && Number.isFinite(takenAt) && nowMs - takenAt > RUN_STALE_MS;
  if (has('stop.json')) return hasResult || !isTaken || lost ? 'stopped' : 'stopping';
  if (hasResult) {
    if (result?.outcome === 'question') return 'asking';
    return result?.outcome === 'failed' ? 'failed' : 'done';
  }
  if (running) return 'running';
  if (lost) return 'lost';
  if (isTaken) return 'taken';
  if (has('approved.json')) {
    const expires = new Date(approved?.expires ?? '').getTime();
    return Number.isFinite(expires) && nowMs > expires ? 'expired' : 'approved';
  }
  return 'proposed';
}

// --- Checklists: state comes from file names alone (see docs/workspaces.md, "Checklists") ---

export const CHECKLIST_MARK_RE = /^(tick|untick)-(\d{2})-(\d{8}T\d{9}Z)-([a-z0-9]{4})\.json$/;
export const PLATFORMS = ['web', 'windows', 'mac', 'linux', 'android', 'ios'];
export const PLAYTEST_VERDICTS = { ship: 'Ship it', 'fix-first': 'Fix first', rethink: 'Rethink' };
export const PLAYTEST_LIMITS = { look: 2000, issues: 30, issue: 500 };
export const CHECKLIST_LIMITS = { title: 200, items: 50, text: 200, group: 80, guide: 4000, context: 4000, link: 2000, file: 256 * 1024, note: 2000 };

const nameList = names => (names instanceof Set ? [...names] : [...names]);

/** `20261027T143012123Z` → `2026-10-27T14:30:12.123Z`. */
export const stampIso = stamp => `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}.${stamp.slice(15, 18)}Z`;

/** A Date as the stamp in a mark file's name (UTC, milliseconds, no separators). */
export const markStamp = date => date.toISOString().replace(/[-:.]/g, '');

/** Picture files in a checklist's folder: a step's evidence, and a playtest issue's screenshot. JPEG and PNG only. */
export const EVIDENCE_RE = /^evidence-(\d{2})-(\d{8}T\d{9}Z)-([a-z0-9]{4})\.(png|jpg)$/;
export const SHOT_RE = /^shot-(\d{8}T\d{9}Z)-([a-z0-9]{4})\.(png|jpg)$/;
export const EVIDENCE_PER_STEP = 5;
export const SHOTS_PER_CHECKLIST = 30;

/**
 * The picture files of a checklist from its file names: the newest evidence file per step (greatest stamp,
 * then the greater rand4), how many each step has, and the screenshots oldest first.
 * → { evidence: Map<item, { file, at, count }>, shots: [{ file, at }] }
 */
export function checklistEvidence(names) {
  const best = new Map();
  const shots = [];
  for (const name of nameList(names)) {
    const e = EVIDENCE_RE.exec(name);
    if (e) {
      const [, item, stamp, rand] = e;
      const rank = `${stamp}-${rand}`;
      const current = best.get(item);
      best.set(item, { rank: current && current.rank > rank ? current.rank : rank, file: current && current.rank > rank ? current.file : name, at: current && current.rank > rank ? current.at : stampIso(stamp), count: (current?.count ?? 0) + 1 });
      continue;
    }
    const s = SHOT_RE.exec(name);
    if (s) shots.push({ rank: `${s[1]}-${s[2]}`, file: name, at: stampIso(s[1]) });
  }
  shots.sort((a, b) => (a.rank < b.rank ? -1 : 1));
  return {
    evidence: new Map([...best].map(([item, { file, at, count }]) => [item, { file, at, count }])),
    shots: shots.map(({ file, at }) => ({ file, at })),
  };
}

/** First match wins: cancel.json → 'cancelled', pickup.json → 'picked-up', submit.json → 'submitted', else 'open'. */
export function checklistState(names) {
  const list = nameList(names);
  if (list.includes('cancel.json')) return 'cancelled';
  if (list.includes('pickup.json')) return 'picked-up';
  if (list.includes('submit.json')) return 'submitted';
  return 'open';
}

/**
 * The winning mark of each item from the file names, whatever order they come in: the greatest stamp,
 * the greater rand4 on a tie. Never S3's LastModified. → Map<item, { done, at (ISO), name }>
 */
export function checklistMarks(names) {
  const best = new Map();
  for (const name of nameList(names)) {
    const match = CHECKLIST_MARK_RE.exec(name);
    if (!match) continue;
    const [, action, item, stamp, rand] = match;
    const key = `${stamp}-${rand}`;
    const current = best.get(item);
    if (!current || key > current.key) best.set(item, { key, done: action === 'tick', at: stampIso(stamp), name });
  }
  return new Map([...best].map(([item, { done, at, name }]) => [item, { done, at, name }]));
}

/** How many of the checklist's own items are ticked. A mark for an item that does not exist is ignored. */
export function checklistProgress(checklist, names) {
  const marks = checklistMarks(names);
  const ids = (Array.isArray(checklist?.items) ? checklist.items : []).map(item => item.id);
  return { done: ids.filter(id => marks.get(id)?.done).length, total: ids.length, marks };
}

export function checklistItem(checklist, names) {
  const state = checklistState(names);
  const { done, total } = checklistProgress(checklist, names);
  return {
    kind: 'checklist', id: checklist.id, project: checklist.project, title: clip(checklist.title), at: checklist.createdAt, state, done, total,
    ...(checklist.kind === 'playtest' ? { playtest: true, platform: PLATFORMS.includes(checklist.platform) ? checklist.platform : 'web' } : {}),
    ...(checklist.bead ? { bead: checklist.bead } : {}),
    ...(checklist.from?.host ? { host: checklist.from.host } : {}),
    ...(checklist.from?.tool ? { tool: clip(checklist.from.tool, 40) } : {}),
    ...(checklist.from?.session ? { session: checklist.from.session } : {}),
  };
}

/** The problems with a checklist.json (or the input shape of one, without the ids) against the contract's limits; an empty list means it is valid. */
export function checkChecklist(raw) {
  const problems = [];
  const L = CHECKLIST_LIMITS;
  const text = (value, min, max) => typeof value === 'string' && value.trim().length >= min && value.length <= max;
  const link = value => typeof value === 'string' && value.length <= L.link && /^https?:\/\//i.test(value);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return ['the file is not an object'];
  if (!text(raw.title, 1, L.title)) problems.push(`title is 1 to ${L.title} characters`);
  if (raw.context !== undefined && !text(raw.context, 0, L.context)) problems.push(`context is at most ${L.context} characters`);
  if (raw.card !== undefined && !link(raw.card)) problems.push('card is an http:// or https:// link of at most 2000 characters');
  const playtest = raw.kind === 'playtest';
  if (raw.kind !== undefined && raw.kind !== 'steps' && !playtest) problems.push('kind is "steps" or "playtest"');
  if (playtest) {
    if (typeof raw.build !== 'string' || !/^https:\/\//i.test(raw.build) || raw.build.length > L.link) problems.push('build is an https:// link of at most 2000 characters');
    if (raw.platform !== undefined && !PLATFORMS.includes(raw.platform)) problems.push(`platform is one of ${PLATFORMS.join(', ')}`);
    if (raw.lookFor !== undefined && !text(raw.lookFor, 0, PLAYTEST_LIMITS.look)) problems.push(`lookFor is at most ${PLAYTEST_LIMITS.look} characters`);
  } else {
    for (const name of ['build', 'platform', 'lookFor']) if (raw[name] !== undefined) problems.push(`${name} belongs to a playtest`);
  }
  if (!Array.isArray(raw.items) || raw.items.length < 1 || raw.items.length > L.items) problems.push(`items is a list of 1 to ${L.items}`);
  else {
    raw.items.forEach((item, index) => {
      const at = `item ${index + 1}`;
      if (!item || typeof item !== 'object' || Array.isArray(item)) { problems.push(`${at} is not an object`); return; }
      if (!text(item.text, 1, L.text)) problems.push(`${at}: text is 1 to ${L.text} characters`);
      if (item.group !== undefined && !text(item.group, 0, L.group)) problems.push(`${at}: group is at most ${L.group} characters`);
      if (item.guide !== undefined && !text(item.guide, 0, L.guide)) problems.push(`${at}: guide is at most ${L.guide} characters`);
      if (item.link !== undefined && !link(item.link)) problems.push(`${at}: link is an http:// or https:// link of at most 2000 characters`);
      if (item.id !== undefined && item.id !== String(index + 1).padStart(2, '0')) problems.push(`${at}: id is its position (${String(index + 1).padStart(2, '0')})`);
    });
  }
  if (Buffer.byteLength(JSON.stringify(raw)) > L.file) problems.push('the file is over 256 KB');
  return problems;
}

const clip = (value, length = 160) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, length);

// --- Design reviews: an Ask with an image and decisions (see docs/workspaces.md, "Asks") ---

export const DECISION_LIMITS = { count: 10, text: 200, detail: 500, note: 1000 };
export const VERDICTS = ['approve', 'change', 'skip'];
export const ASK_IMAGE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;

/** The decisions of an Ask when they are valid (1 to 10, ids d1..dN in order, text and detail within limits); null when absent or malformed. */
export function validDecisions(ask) {
  const list = ask?.decisions;
  if (!Array.isArray(list) || list.length < 1 || list.length > DECISION_LIMITS.count) return null;
  const ok = list.every((item, index) => item && typeof item === 'object' && !Array.isArray(item) && item.id === `d${index + 1}`
    && typeof item.text === 'string' && item.text.trim().length >= 1 && item.text.length <= DECISION_LIMITS.text
    && (item.detail === undefined || (typeof item.detail === 'string' && item.detail.length <= DECISION_LIMITS.detail)));
  return ok ? list : null;
}

/** Whether an Ask is a Design review: it has decisions, a picture, or an option with a picture. */
export function isDesignReview(ask) {
  if (!ask || typeof ask !== 'object') return false;
  if (validDecisions(ask)) return true;
  if (typeof ask.image === 'string' && ASK_IMAGE_RE.test(ask.image)) return true;
  return Array.isArray(ask.options) && ask.options.some(option => option && typeof option === 'object' && typeof option.image === 'string' && option.image);
}

/**
 * An Ask file is an agent's, so `decisions` and `image` are checked when it is read: a malformed field is dropped and the
 * Ask shows as a plain Question. `bad` names what was dropped, for one log line.
 */
export function cleanAsk(ask) {
  const bad = [];
  let out = ask;
  if (ask.decisions !== undefined && !validDecisions(ask)) { const { decisions: _drop, ...rest } = out; out = rest; bad.push('decisions'); }
  if (ask.image !== undefined && !(typeof ask.image === 'string' && ASK_IMAGE_RE.test(ask.image))) { const { image: _drop, ...rest } = out; out = rest; bad.push('image'); }
  return { ask: out, bad };
}

export function askItem(ask, state) {
  const decisions = validDecisions(ask);
  const design = isDesignReview(ask);
  const takes = design && !decisions && Array.isArray(ask.options) ? ask.options.length : 0;
  return {
    kind: 'ask', id: ask.id, project: ask.project, title: clip(ask.question), at: ask.createdAt, state: state.state,
    ...(design ? { design: true } : {}),
    ...(decisions ? { decisions: decisions.length } : {}),
    ...(takes ? { takes } : {}),
    ...(ask.bead ? { bead: ask.bead } : {}),
    ...(state.snoozedUntil ? { summary: `Snoozed until ${state.snoozedUntil}` } : {}),
    ...(ask.from?.host ? { host: ask.from.host } : {}),
    ...(ask.from?.tool ? { tool: clip(ask.from.tool, 40) } : {}),
    ...(ask.from?.session ? { session: ask.from.session } : {}),
  };
}

/**
 * A request as a list row. `extra` carries what the state needed: `approved` and `result` (their `target`,
 * `outcome` and `at`). A request still waiting for the owner's approval is a Needs you row of kind `approval`.
 * `since` is when it reached a state that wants a look (failed, lost, expired).
 */
export function requestItem(request, state, taken, extra = {}) {
  const { approved = null, result = null, cloud = null } = extra;
  const target = approved?.target ?? request.target;
  const since = cloud?.since ? cloud.since : state === 'failed' ? result?.at : state === 'lost' && taken?.at ? new Date(new Date(taken.at).getTime() + RUN_STALE_MS).toISOString() : state === 'expired' ? approved?.expires : undefined;
  return {
    kind: state === 'proposed' ? 'approval' : state === 'asking' ? 'run-question' : 'request', id: request.id, project: request.project, title: request.title ? clip(request.title) : clip(request.text), at: request.createdAt, state,
    ...(taken?.bead ? { bead: taken.bead } : {}),
    ...(request.by ? { by: request.by } : {}),
    ...(request.preset ? { preset: request.preset } : {}),
    ...(state === 'asking' && result?.question ? { question: result.question, ...(result.summary ? { summary: result.summary } : {}) } : {}),
    ...(target ? { target } : {}),
    ...(cloud ? { cloud: { status: cloud.status, ...(cloud.reason ? { reason: cloud.reason } : {}), ...(cloud.next ? { next: cloud.next } : {}) } } : {}),
    ...(request.origin ? { origin: request.origin } : {}),
    ...(extra.offer ? { offer: extra.offer, ...(approved?.at ? { approvedAt: approved.at } : {}) } : {}),
    ...(state === 'failed' && result?.reason === 'approval-refused' ? { reason: 'approval-refused' } : {}),
    ...(typeof since === 'string' ? { since } : {}),
  };
}

const byTime = (a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : String(a.file ?? '') < String(b.file ?? '') ? -1 : 1);

/** Events oldest first; the file name breaks ties, since it starts with hhmmss. */
export const chronological = events => [...events].sort(byTime);

const time = ts => {
  const date = new Date(ts);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(11, 16);
};

/** The bare `https://claude.ai/code` opens a new, empty chat, so it is no link to a session. */
export const isBareClaudeCode = url => /^https:\/\/claude\.ai\/code\/?$/i.test(String(url ?? '').trim());

/** A blocked session's web link: https, and not the bare one. Anything else is no link. */
export const blockedSessionUrl = url => (typeof url === 'string' && /^https:\/\//i.test(url) && !isBareClaudeCode(url) ? url : undefined);

/** The desktop app's link to a session: exactly `claude://claude.ai/epitaxy/local_<uuid>`. */
export const blockedAppUrl = url => (typeof url === 'string' && /^claude:\/\/claude\.ai\/epitaxy\/local_[0-9a-f-]{36}$/.test(url) ? url : undefined);

/** What a review row shows without opening it: each leg's result, and how many screenshots came with it. */
const reviewExtras = event => {
  const verdicts = Array.isArray(event.verdicts)
    ? event.verdicts.filter(verdict => verdict && ['smoke', 'review', 'qa'].includes(verdict.leg) && ['pass', 'fail', 'noted'].includes(verdict.result)).map(verdict => ({ leg: verdict.leg, result: verdict.result }))
    : [];
  return { ...(verdicts.length ? { verdicts } : {}), ...(Array.isArray(event.screenshots) && event.screenshots.length ? { shots: event.screenshots.length } : {}) };
};

const eventItem = (kind, event, extra = {}) => ({
  kind, id: event.file, project: event.project, title: event.title, at: event.ts,
  ...(event.bead ? { bead: event.bead } : {}), ...(event.url ? { url: event.url } : {}),
  ...(typeof event.card === 'string' && event.card ? { card: event.card } : {}),
  ...(event.host ? { host: event.host } : {}), ...(event.session ? { session: event.session } : {}),
  ...(event.summary ? { summary: event.summary } : {}), ...extra,
});

/**
 * Reviews, blocked sessions and running sessions from a window of events (any order).
 * - review: `ready-for-review` with no later `pr-merged` for the same bead (the same url when
 *   there is no bead), and that no `review-done` event names (its `review` is the review's file name);
 * - blocked: `blocked` with no later event of any kind from the same session (a `resumed`, a
 *   `session-ended`, a newer `blocked`, anything that carries the session). A `blocked` with no
 *   session stays until the window drops it. Only a real session link (`url`, not the bare
 *   https://claude.ai/code) and a desktop link (`appUrl`) are kept;
 * - running: `session-started` with no later `session-ended` or newer `session-started` for the same session.
 */
export function deriveEventItems(events) {
  const ordered = chronological(events);
  const after = (event, test) => ordered.some(other => byTime(event, other) < 0 && test(other));
  const done = new Set(ordered.filter(event => event.kind === 'review-done' && typeof event.review === 'string').map(event => event.review));
  const reviews = [];
  const blocked = [];
  const running = [];
  for (const event of ordered) {
    if (event.kind === 'ready-for-review') {
      const merged = after(event, other => other.kind === 'pr-merged' && (event.bead ? other.bead === event.bead : !!event.url && other.url === event.url));
      if (!merged && !done.has(event.file)) reviews.push(eventItem('review', event, reviewExtras(event)));
    } else if (event.kind === 'blocked') {
      const resolved = !!event.session && after(event, other => other.session === event.session);
      if (resolved || done.has(event.file)) continue;
      const appUrl = blockedAppUrl(event.appUrl);
      blocked.push(eventItem('blocked', { ...event, url: blockedSessionUrl(event.url) }, { id: event.session || event.file, file: event.file, ...(appUrl ? { appUrl } : {}) }));
    } else if (event.kind === 'session-started' && event.session) {
      // A later start from the same session replaces this one: a session runs once, whatever restarted it.
      const ended = after(event, other => other.session === event.session && (other.kind === 'session-ended' || other.kind === 'session-started'));
      if (!ended) running.push(eventItem('session', event, { id: event.session, title: `${event.project || 'session'} · running since ${time(event.ts)}` }));
    }
  }
  const newest = (a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0);
  return { reviews: reviews.sort(newest), blocked: blocked.sort(newest), running: running.sort(newest) };
}

const newest = (a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0);

/** Today's screen from the derived pieces. `events` is the whole window, newest first. */
export function buildToday({ asks, checklists = [], requests = [], hermesApprovals = [], events, now, alerts: extraAlerts = [], cloud = null }) {
  const { reviews, blocked, running } = deriveEventItems(events);
  const openAsks = asks.filter(item => item.state === 'open').sort(newest);
  // A list with every item ticked still waits for Submit, so it stays until it is submitted or withdrawn.
  const openChecklists = checklists.filter(item => item.state === 'open').sort(newest);
  // A request that waits for the owner's approval is Needs you; one that failed, was lost or expired is an alert.
  const approvals = requests.filter(item => item.kind === 'approval' || item.kind === 'run-question').sort(newest);
  const hermes = [...hermesApprovals].sort(newest);
  const needsYou = [...openAsks, ...openChecklists, ...reviews, ...blocked, ...approvals, ...hermes];
  const since = now.getTime() - DAY;
  const recent = events.filter(event => new Date(event.ts).getTime() >= since);
  const requestAlerts = requests
    .filter(item => ['failed', 'lost', 'expired'].includes(item.state) && new Date(item.since ?? item.at).getTime() >= since)
    .map(item => ({ ts: item.since ?? item.at, kind: 'alert', source: 'request', request: item.id, project: item.project, title: item.reason === 'approval-refused' ? `Cloud run refused the approval: ${item.title}` : `Request ${item.state}: ${item.title}` }));
  // A cloud request that fired and never started, or whose fire stopped failing, stays an alert until it is dealt with; Retry is on its row.
  const cloudAlerts = requests
    .filter(item => item.cloud?.status === 'not-started' || item.cloud?.status === 'fire-failed')
    .map(item => ({
      ts: item.since ?? item.at, kind: 'alert', source: 'request', request: item.id, project: item.project, retry: true,
      title: item.cloud.status === 'not-started' ? `Cloud run did not start: ${item.title}` : `Cloud run could not be fired: ${item.title}`,
    }));
  // Offers: what the owner could do now. A PC request that has waited 6 hours may move to the cloud.
  const offers = requests.filter(item => item.offer === 'move-to-cloud')
    .map(item => ({ kind: 'move-to-cloud', request: item.id, project: item.project, title: item.title, since: item.approvedAt }))
    .sort((a, b) => (a.since < b.since ? -1 : 1));
  const alerts = [...recent.filter(event => event.kind === 'alert'), ...requestAlerts, ...cloudAlerts, ...extraAlerts];
  return {
    counts: { needsYou: needsYou.length, running: running.length, recent: recent.length, alerts: alerts.length },
    needsYou, running, recent, alerts, at: now.toISOString(),
    ...(offers.length ? { offers } : {}),
    // Cloud runs fired on the owner's day against the daily cap; absent when no cloud routine is set up.
    ...(cloud ? { cloud: { used: cloud.used, cap: cloud.cap, next: cloud.next } } : {}),
  };
}

export const REVIEW_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}\.json$/;

/** The `review-done` event that hides one review or one blocked row. `review` is the file name of the `ready-for-review` or `blocked` event, which is `event`. */
export function reviewDone({ review, event, user, at }) {
  return {
    ts: at.toISOString(), kind: 'review-done', review, title: `Done: ${clip(event.title)}`,
    ...(event.project ? { project: event.project } : {}), ...(event.bead ? { bead: event.bead } : {}),
    host: 'hub', source: 'hub', by: user || 'local',
  };
}

// The kind of a row on Needs you. src/lib/needsKinds.ts mirrors these rules: change both together.
export const NEEDS_KINDS = ['question', 'design', 'steps', 'playtest', 'unstick', 'pr', 'approval'];

export function needsKindOf(item) {
  switch (item.kind) {
    case 'checklist': return item.playtest === true ? 'playtest' : 'steps';
    case 'review': return 'pr';
    case 'blocked': return 'unstick';
    case 'request': return 'approval';
    case 'approval': return 'approval';
    case 'hermes-approval': return 'approval';
    case 'run-question': return 'question';
    case 'ask': return item.design === true ? 'design' : 'question';
    default: return 'question';
  }
}

export const INBOX_FILTERS = ['all', ...NEEDS_KINDS, 'answered', 'requests'];

/** Old filter names, kept so links in Discord history and bookmarks still land on the right chip. */
export const INBOX_FILTER_ALIASES = { 'needs-you': 'all', asks: 'question', todo: 'steps', reviews: 'pr', blocked: 'unstick' };

/** The filter a request names, old names mapped to new ones; anything unknown is `all`. */
export function inboxFilter(raw) {
  const mapped = Object.prototype.hasOwnProperty.call(INBOX_FILTER_ALIASES, raw) ? INBOX_FILTER_ALIASES[raw] : raw;
  return INBOX_FILTERS.includes(mapped) ? mapped : 'all';
}

/** The Needs you list for one filter. `all` keeps the order Today uses: open Asks, open checklists, reviews, blocked sessions. */
export function buildInbox({ filter: raw, asks, checklists = [], requests, hermesApprovals = [], events, now }) {
  const filter = inboxFilter(raw);
  if (filter === 'requests') return [...requests].sort(newest);
  if (filter === 'answered') {
    return [...asks.filter(item => item.state === 'answered' || item.state === 'picked-up'), ...checklists.filter(item => item.state === 'submitted' || item.state === 'picked-up')].sort(newest);
  }
  const needs = buildToday({ asks, checklists, requests, hermesApprovals, events, now }).needsYou;
  return filter === 'all' ? needs : needs.filter(item => needsKindOf(item) === filter);
}

/** How many items wait per kind (and in all): the chips' numbers. */
export function inboxCounts(needsYou) {
  const counts = { all: needsYou.length };
  for (const kind of NEEDS_KINDS) counts[kind] = 0;
  for (const item of needsYou) { const kind = needsKindOf(item); if (kind in counts) counts[kind] += 1; }
  return counts;
}

const LEG_NAME = { smoke: 'Smoke', review: 'Review', qa: 'QA' };

/**
 * Four plain sentences for a Needs you card: what it is, where it stands, what the owner does next, and
 * what blocks it. `who` is the sender (tool and host), `age` the item's age in minutes.
 */
export function describeItem(item, now) {
  const kind = needsKindOf(item);
  const where = item.bead ? `bead ${item.bead}` : item.project ? `project ${item.project}` : 'an agent';
  const who = (item.kind === 'ask' || item.kind === 'checklist' ? [item.tool, item.host] : [item.host]).filter(Boolean).join(' · ');
  const minutes = Math.max(0, Math.floor((now.getTime() - new Date(item.at).getTime()) / 60000));
  const base = { kind, who, age: Number.isFinite(minutes) ? minutes : 0 };
  if (item.kind === 'run-question') return { ...base, what: 'Hermes asks a question', state: 'The run paused for your answer', next: 'Answer and run again, or close it', blocker: 'Your answer' };
  // A request made the old way is listed under the requests filter and reads as before; only a proposal to approve is an approval.
  switch (kind === 'approval' && item.kind === 'request' ? 'question' : kind) {
    case 'steps':
      return { ...base, what: 'Steps only you can do', state: `${item.done ?? 0} of ${item.total ?? 0} done`, next: 'Tick each step, then Submit', blocker: 'Your hands' };
    case 'playtest':
      return {
        ...base, what: `A build to play on ${item.platform ?? 'web'}`, state: item.done > 0 ? `${item.done} of ${item.total ?? 0} tried` : 'Build is live',
        next: 'Play it, rate it, list issues', blocker: 'Your verdict',
      };
    case 'pr': {
      const legs = Array.isArray(item.verdicts) ? item.verdicts.map(verdict => `${LEG_NAME[verdict.leg]} ${verdict.result}`).join(' · ') : '';
      return { ...base, what: 'A pull request ready for you', state: legs || 'Ready for review', next: 'Open it or mark it done', blocker: 'Merging stays yours' };
    }
    case 'unstick':
      return { ...base, what: 'A session waiting on you', state: /\?\s*$/.test(item.summary ?? '') ? 'Asked a question' : 'Paused at a prompt', next: 'Open the session', blocker: 'Your answer in the session' };
    case 'approval':
      if (item.kind === 'hermes-approval') {
        return { ...base, what: 'Hermes asks to write a protected file', state: 'Waiting; Hermes denies it after 5 minutes', next: 'Approve once or deny', blocker: 'Your answer' };
      }
      return { ...base, what: item.preset ? `A ${item.preset} job to approve` : 'A job to approve', state: item.target ? `Proposed for ${item.target}` : 'Waiting for your approval', next: 'Approve, edit or decline it', blocker: 'Your approval' };
    case 'design': {
      const picks = !item.decisions && item.takes > 0;
      return {
        ...base,
        what: item.decisions ? `${item.decisions} ${item.decisions === 1 ? 'decision' : 'decisions'} on one design` : picks ? `${item.takes} takes to pick from` : 'A design to look over',
        state: item.state === 'snoozed' ? item.summary || 'Snoozed' : 'Waiting for your review',
        next: picks ? 'Pick one, or draw on them' : 'Approve, change or skip each one', blocker: 'Your review',
      };
    }
    default:
      return {
        ...base, what: `A question from ${where}`,
        state: item.state === 'snoozed' ? item.summary || 'Snoozed' : 'Waiting for your answer',
        next: 'Pick an option or write a note', blocker: 'Your answer',
      };
  }
}

export const HELP_CHAT_RE = /^\d{8}-[a-z0-9]{6}$/;

/** The shape of `help` on an answer or a submission: `{ chat: <conversation id> }`, or nothing. Returns the chat id or null; the chat itself is checked against the item by the caller. */
export function checkHelp(help) {
  if (help === undefined || help === null) return null;
  if (typeof help !== 'object' || Array.isArray(help) || typeof help.chat !== 'string' || !HELP_CHAT_RE.test(help.chat)) throw Object.assign(new Error('help is { "chat": "<conversation id>" }.'), { status: 400 });
  return help.chat;
}

/** What a posted answer must hold, checked against the Ask. Throws a 400 with a plain reason. */
export function checkAnswer(ask, data) {
  checkHelp(data?.help);
  const fail = message => Object.assign(new Error(message), { status: 400 });
  const { choice, note, drawing, decisions } = data ?? {};
  const asked = validDecisions(ask);
  if (decisions !== undefined && decisions !== null) {
    if (!asked) throw fail('This Ask has no decisions.');
    if (typeof decisions !== 'object' || Array.isArray(decisions)) throw fail('Decisions are an object of verdicts by decision id.');
    for (const id of Object.keys(decisions)) if (!asked.some(item => item.id === id)) throw fail(`There is no decision ${id}.`);
    for (const item of asked) {
      const entry = decisions[item.id];
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw fail(`Give a verdict for decision ${item.id}.`);
      if (!VERDICTS.includes(entry.verdict)) throw fail(`The verdict for ${item.id} is approve, change or skip.`);
      if (entry.note !== undefined && entry.note !== null && (typeof entry.note !== 'string' || entry.note.length > DECISION_LIMITS.note)) throw fail(`A note on a decision is text of at most ${DECISION_LIMITS.note} characters.`);
    }
  } else if (asked) {
    throw fail('Give a verdict for every decision.');
  }
  if (choice !== undefined && choice !== null) {
    const options = Array.isArray(ask.options) ? ask.options : [];
    if (typeof choice !== 'string' || (options.length && !options.some(option => option.id === choice)) || (!options.length)) {
      throw fail('That is not one of the options.');
    }
  }
  if (note !== undefined && note !== null) {
    if (typeof note !== 'string' || note.length > 4000) throw fail('A note is text of at most 4000 characters.');
    if (!ask.allowNote) throw fail('This Ask takes no note.');
  }
  if (drawing !== undefined && drawing !== null) {
    if (!ask.allowDrawing) throw fail('This Ask takes no drawing.');
  }
  const has = value => value !== undefined && value !== null && value !== '';
  if (!has(choice) && !has(note) && !has(drawing) && !asked) throw fail('Choose an option, write a note or draw something.');
}

/**
 * What a playtest's submission must hold, checked against its checklist and the file names in its folder: a rating of 1 to 5, a
 * verdict, and up to 30 issues whose `shot` is a screenshot that exists. Throws a 400 with a plain reason.
 * → { rating, verdict, issues }
 */
export function checkPlaytestSubmit(checklist, data, names) {
  const fail = message => Object.assign(new Error(message), { status: 400 });
  const { rating, verdict, issues } = data ?? {};
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw fail('A rating is a whole number from 1 to 5.');
  if (typeof verdict !== 'string' || !Object.prototype.hasOwnProperty.call(PLAYTEST_VERDICTS, verdict)) throw fail('The verdict is ship, fix-first or rethink.');
  const list = issues === undefined || issues === null ? [] : issues;
  if (!Array.isArray(list) || list.length > PLAYTEST_LIMITS.issues) throw fail(`Issues are a list of at most ${PLAYTEST_LIMITS.issues}.`);
  const have = new Set(names instanceof Set ? names : names ?? []);
  const clean = list.map((issue, index) => {
    if (!issue || typeof issue !== 'object' || Array.isArray(issue)) throw fail(`Issue ${index + 1} is not an object.`);
    if (typeof issue.text !== 'string' || issue.text.trim().length < 1 || issue.text.length > PLAYTEST_LIMITS.issue) throw fail(`Issue ${index + 1}: text is 1 to ${PLAYTEST_LIMITS.issue} characters.`);
    if (issue.shot !== undefined && issue.shot !== null) {
      if (typeof issue.shot !== 'string' || !SHOT_RE.test(issue.shot) || !have.has(issue.shot)) throw fail(`Issue ${index + 1}: that screenshot is not in this checklist.`);
    }
    return { text: issue.text.trim(), ...(issue.shot ? { shot: issue.shot } : {}) };
  });
  return { rating, verdict, issues: clean };
}

// --- Discord buttons ---

export const DISCORD_MAX_OPTIONS = 5;
const DISCORD_LABEL_MAX = 80;
const DISCORD_CUSTOM_ID_MAX = 100;

/** The Ask as it was posted: the sha256 of the bytes of ask.json, cut to 16 hex characters. */
export const askRev = text => createHash('sha256').update(typeof text === 'string' ? Buffer.from(text, 'utf8') : text).digest('hex').slice(0, 16);

/**
 * Whether an Ask may be answered with a Discord button. The only place the rule lives; the bot asks the
 * server and never decides on its own.
 * → { ok: true } | { ok: false, reason }
 */
export function discordEligible(ask) {
  const no = reason => ({ ok: false, reason });
  if (!ask || typeof ask !== 'object') return no('not an Ask');
  if (ask.requirePasskey === true) return no('This Ask requires a passkey.');
  if (ask.allowDrawing === true) return no('This Ask takes a drawing.');
  if (ask.decisions !== undefined && ask.decisions !== null) return no('A design review stays in the Hub.');
  if (ask.image !== undefined && ask.image !== null) return no('An Ask with a picture stays in the Hub.');
  const options = ask.options;
  if (!Array.isArray(options) || options.length < 2 || options.length > DISCORD_MAX_OPTIONS) return no(`Buttons need 2 to ${DISCORD_MAX_OPTIONS} options.`);
  const seen = new Set();
  for (const option of options) {
    if (!option || typeof option !== 'object') return no('An option is not an object.');
    if (typeof option.id !== 'string' || !option.id) return no('An option has no id.');
    if (seen.has(option.id)) return no('Two options share an id.');
    seen.add(option.id);
    if (typeof option.label !== 'string' || !option.label.trim() || option.label.length < 1 || option.label.length > DISCORD_LABEL_MAX) return no(`A button label is 1 to ${DISCORD_LABEL_MAX} characters.`);
    if (option.image !== undefined && option.image !== null) return no('An option with a picture stays in the Hub.');
    if (`a:${ask.id}:${option.id}`.length > DISCORD_CUSTOM_ID_MAX) return no('An option id is too long for a button.');
  }
  return { ok: true };
}

// A review's detail: what a `ready-for-review` event carries, checked field by field, because an
// agent wrote it. A bad entry is dropped and never passed on.

const httpUrl = value => (typeof value === 'string' && value.length <= 2000 && /^https?:\/\//i.test(value) ? value : undefined);
const httpsUrl = value => (typeof value === 'string' && value.length <= 2000 && /^https:\/\//i.test(value) ? value : undefined);
/** A screenshot must come from GitHub's raw host: an agent's event must not make the owner's browser fetch from anywhere else. */
const rawImageUrl = value => (httpsUrl(value) && /^https:\/\/raw\.githubusercontent\.com\//i.test(value) ? value : undefined);
const PR_RE = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/;
export const CARD_DIR_RE = /^[a-z0-9][a-z0-9-]{0,63}\/[A-Za-z0-9][\w.-]{0,119}$/;
const CARD_FILE_RE = /^(?:[A-Za-z0-9][\w.-]*\/){1,3}[A-Za-z0-9][\w.-]*\.md$/;
const VERDICT_LEGS = ['smoke', 'review', 'qa'];
const VERDICT_RESULTS = ['pass', 'fail', 'noted'];

/** The label of a card file by its first folder: briefs/ → Brief, reviews/ → Review (QA triage when the name has -qa), qa/ → QA report, builds/ → Build report. */
export function fileLabel(path) {
  const parts = String(path).split('/');
  const name = parts[parts.length - 1];
  switch (parts[0]) {
    case 'briefs': return 'Brief';
    case 'reviews': return name.includes('-qa') ? 'QA triage' : 'Review';
    case 'qa': return 'QA report';
    case 'builds': return 'Build report';
    default: return name;
  }
}

/**
 * Screenshot urls grouped into before/after pairs. The words `before` and `after` come out of the
 * file name (whole words between `-` or `_`, anywhere in it) and what is left names the pair. An
 * image with neither word is `other`. Order of first appearance is kept.
 * → [{ label, before?, after?, other? }]
 */
export function screenshotPairs(urls) {
  const pairs = [];
  for (const url of urls) {
    let name = '';
    try { name = decodeURIComponent(new URL(url).pathname.split('/').pop() ?? ''); } catch { name = String(url).split('/').pop() ?? ''; }
    const words = name.replace(/\.[A-Za-z0-9]+$/, '').split(/[-_]+/).filter(Boolean);
    const rest = words.filter(word => !/^(before|after)$/i.test(word));
    const slot = words.some(word => /^before$/i.test(word)) ? 'before' : words.some(word => /^after$/i.test(word)) ? 'after' : 'other';
    const label = rest.join(' ');
    const found = pairs.find(pair => pair.label === label && !(slot in pair));
    if (found) found[slot] = url;
    else pairs.push({ label, [slot]: url });
  }
  return pairs;
}

/** The detail of one `ready-for-review` event, or null when no such event is in `events` (any order). */
export function reviewDetail(events, id) {
  const event = events.find(candidate => candidate.kind === 'ready-for-review' && candidate.file === id);
  if (!event) return null;
  const text = (value, length) => (typeof value === 'string' && value.trim() ? clip(value, length) : undefined);
  const url = httpUrl(event.url);
  const card = httpUrl(event.card);
  const prs = (Array.isArray(event.prs) ? event.prs : []).filter(value => typeof value === 'string' && PR_RE.test(value)).slice(0, 10);
  const cardDir = typeof event.cardDir === 'string' && CARD_DIR_RE.test(event.cardDir) && !event.cardDir.includes('..') ? event.cardDir : undefined;
  const cardFiles = cardDir
    ? (Array.isArray(event.cardFiles) ? event.cardFiles : [])
      .filter(path => typeof path === 'string' && path.length <= 200 && CARD_FILE_RE.test(path) && !path.split('/').includes('..'))
      .slice(0, 12).map(path => ({ path, label: fileLabel(path) }))
    : [];
  const shots = (Array.isArray(event.screenshots) ? event.screenshots : []).map(rawImageUrl).filter(Boolean).slice(0, 12);
  const deployUrl = httpsUrl(event.deployUrl);
  const verdicts = (Array.isArray(event.verdicts) ? event.verdicts : [])
    .filter(verdict => verdict && typeof verdict === 'object' && VERDICT_LEGS.includes(verdict.leg) && VERDICT_RESULTS.includes(verdict.result) && typeof verdict.text === 'string')
    .slice(0, 3).map(verdict => ({ leg: verdict.leg, result: verdict.result, text: String(verdict.text).slice(0, 300) }));
  const done = events.find(candidate => candidate.kind === 'review-done' && candidate.review === id);
  const summary = typeof event.summary === 'string' && event.summary.trim() ? event.summary.slice(0, 4000) : undefined;
  return {
    id, title: text(event.title, 200) ?? 'Review', at: event.ts,
    ...(summary ? { summary } : {}),
    ...(text(event.project, 80) ? { project: text(event.project, 80) } : {}),
    ...(text(event.host, 80) ? { host: text(event.host, 80) } : {}),
    ...(text(event.source, 80) ? { source: text(event.source, 80) } : {}),
    ...(url ? { url } : {}), ...(card ? { card } : {}),
    ...(prs.length ? { prs } : {}),
    ...(cardDir ? { cardDir } : {}), ...(cardFiles.length ? { cardFiles } : {}),
    ...(shots.length ? { screenshots: screenshotPairs(shots) } : {}),
    ...(deployUrl ? { deployUrl } : {}),
    ...(verdicts.length ? { verdicts } : {}),
    done: !!done,
    ...(done ? { doneAt: done.ts, ...(typeof done.by === 'string' ? { doneBy: clip(done.by, 80) } : {}) } : {}),
  };
}

// Old reviews carry no links. The card they belong to is found from the title, and the files it
// cites from the summary; the server checks every path, as for a review that carries its own.

const SLUG_TITLE_RE = /^([a-z][a-z0-9-]{1,63}):/;
const SPRINT_WORDS_RE = /\s+(sprint|report)$/i;
const plainTitle = value => { let text = String(value ?? '').trim().toLowerCase(); while (SPRINT_WORDS_RE.test(text)) text = text.replace(SPRINT_WORDS_RE, ''); return text; };

/** The run name a title starts with (`hub-polish: x` → `hub-polish`), or undefined. */
export const titleRun = title => SLUG_TITLE_RE.exec(String(title ?? ''))?.[1];

/** The lead phrase of a title: the text before the first `(` or `:`, minus a trailing "sprint" or "report"; undefined under three words. */
export function titleLead(title) {
  const lead = plainTitle(String(title ?? '').split(/[(:]/)[0]);
  return lead.split(/\s+/).filter(Boolean).length >= 3 ? lead : undefined;
}

/**
 * The one card a review belongs to, or null. `cards` is `[{ section, id, title, folder }]`.
 * First rule: the title starts with `<run>:` and exactly one card id contains the run.
 * Second rule: exactly one card title starts with the title's lead phrase.
 */
export function findSprintCard(title, cards) {
  const run = titleRun(title);
  const byRun = run ? cards.filter(card => card.id.includes(run)) : [];
  if (byRun.length === 1) return byRun[0];
  const lead = titleLead(title);
  const byTitle = lead ? cards.filter(card => plainTitle(card.title).startsWith(lead)) : [];
  return byTitle.length === 1 ? byTitle[0] : null;
}

/** The card files a summary names (`briefs/x.md`, `qa/y.md`, any `folder/name.md`), in order, without repeats, none through `..`. */
export function summaryFilePaths(summary) {
  const found = [];
  for (const match of String(summary ?? '').matchAll(/(?<![\w./-])(?:[\w.-]+\/){1,3}[\w.-]+\.md(?![\w-])/g)) {
    const path = match[0];
    if (path.length <= 200 && CARD_FILE_RE.test(path) && !path.split('/').some(part => part.startsWith('.')) && !found.includes(path)) found.push(path);
  }
  return found.slice(0, 12);
}

/** `owner/repo` from a section's `tracked.repo`, or undefined. */
export const trackedRepo = value => (typeof value === 'string' && /^[\w.-]+\/[\w.-]+$/.test(value) ? value : undefined);
