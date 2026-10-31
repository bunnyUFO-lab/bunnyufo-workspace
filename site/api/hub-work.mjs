// Work's six lanes, with no I/O: Beads issues, requests and Hermes runs become cards in
// backlog, ready, running, blocked, review or done. Pure; the route loads the inputs.
import { eventsByBeadOf, issueSigns, milestoneIssuesOf } from './hub-map.mjs';
import { beadOfBranch, pcSummary } from './hub-pc.mjs';

export const LANES = ['backlog', 'ready', 'running', 'blocked', 'review', 'done'];
export const BACKLOG_KEEP = 50;
export const DONE_KEEP = 30;
export const DONE_DAYS = 14;
const DAY = 86400000;

const stamp = value => { const time = new Date(value ?? '').getTime(); return Number.isNaN(time) ? 0 : time; };
const newest = (a, b) => stamp(b.updatedAt) - stamp(a.updatedAt) || (a.key < b.key ? -1 : 1);

/**
 * The sessions of a fresh PC status, by the bead their branch names. A bead id starts with its
 * project prefix, so each distinct prefix in `issues` is tried against every branch.
 */
function liveByBead(status, issues, now) {
  const live = new Map();
  if (!status || !Array.isArray(status.sessions) || pcSummary(status, now).state !== 'on') return live;
  const prefixes = new Set(issues.map(issue => issue.id.split('-')[0]));
  for (const row of status.sessions) {
    if (!row.branch || (row.status !== 'busy' && row.status !== 'idle')) continue;
    for (const prefix of prefixes) {
      const bead = beadOfBranch(row.branch, prefix);
      if (!bead) continue;
      const entry = { host: status.host, session: row.id, state: row.status === 'busy' ? 'working' : 'idle' };
      // A busy session wins over an idle one on the same bead.
      if (!live.has(bead) || entry.state === 'working') live.set(bead, entry);
    }
  }
  return live;
}

function beadCards({ issues, events, asks, status, now }) {
  const byId = new Map(issues.map(issue => [issue.id, issue]));
  const hasChildren = new Set();
  const parentOf = new Map();
  const blockersOf = new Map();
  for (const issue of issues) {
    for (const dep of issue.dependencies ?? []) {
      if (dep.issue_id !== issue.id) continue;
      if (dep.type === 'parent-child' && byId.has(dep.depends_on_id)) { hasChildren.add(dep.depends_on_id); parentOf.set(issue.id, dep.depends_on_id); }
      else if (dep.type === 'blocks') {
        if (!blockersOf.has(issue.id)) blockersOf.set(issue.id, []);
        blockersOf.get(issue.id).push(dep.depends_on_id);
      }
    }
  }
  const askOf = new Map();
  for (const ask of asks) if (ask.bead && (ask.state === 'open' || ask.state === 'snoozed')) askOf.set(ask.bead, ask.id);
  const ctx = { eventsByBead: eventsByBeadOf(events) };
  const live = liveByBead(status, issues, now);

  const milestones = new Set(milestoneIssuesOf(issues, parentOf).map(issue => issue.id));
  const cards = [];
  for (const issue of issues) {
    if (milestones.has(issue.id) || hasChildren.has(issue.id)) continue;
    const closed = issue.status === 'closed';
    const { signs } = issueSigns(issue, closed ? 'done' : 'open', ctx);
    const openBlocker = (blockersOf.get(issue.id) ?? []).map(id => byId.get(id)).find(blocker => blocker && blocker.status !== 'closed');
    let lane;
    let why;
    if (closed) lane = 'done';
    else if (askOf.has(issue.id) || (issue.labels ?? []).includes('needs-owner')) { lane = 'blocked'; why = 'needs you'; }
    else if (signs.includes('pr') || signs.includes('review')) lane = 'review';
    else if (issue.status === 'in_progress') lane = 'running';
    else if (issue.status === 'deferred') lane = 'backlog';
    else if (issue.status === 'blocked' || openBlocker) { lane = 'blocked'; why = openBlocker ? `blocked by ${openBlocker.id} ${openBlocker.title ?? ''}`.trim() : 'blocked'; }
    else if (issue.status === 'open') lane = 'ready';
    else continue;
    const project = issue.project ?? '';
    cards.push({
      key: `bead:${issue.id}`, source: 'beads', id: issue.id, project, title: issue.title ?? issue.id,
      lane, state: issue.status ?? 'open', ...(why ? { why } : {}), signs,
      ...(live.has(issue.id) && !closed ? { live: live.get(issue.id) } : {}),
      updatedAt: (closed ? issue.closed_at : null) ?? issue.updated_at ?? issue.created_at ?? '',
      href: `#/~hub/map/${encodeURIComponent(project)}/${encodeURIComponent(issue.id)}`,
    });
  }
  return cards;
}

const REQUEST_LANE = {
  open: 'backlog', proposed: 'backlog',
  approved: 'ready', taken: 'ready',
  running: 'running',
  stopping: 'running',
  lost: 'blocked', failed: 'blocked', 'at-pc': 'blocked', asking: 'blocked', expired: 'blocked',
  done: 'done',
};
const REQUEST_WHY = {
  lost: 'lost: no word from the run for 20 minutes',
  failed: 'the run failed',
  'at-pc': 'waiting for the PC',
  asking: 'asked you a question',
  expired: 'the approval ran out',
  stopping: 'stopping',
};

/** Why an approved cloud request is not running yet. The usage pause is its own reason: it is not the daily count. */
const CLOUD_WHY = { 'usage-limit': 'waiting on the cloud usage pause', 'daily-cap': 'waiting: the daily cloud limit is used' };

function requestCards({ requests, events }) {
  const ctx = { eventsByBead: eventsByBeadOf(events) };
  const cards = [];
  for (const request of requests) {
    if (request.state === 'declined' || request.state === 'stopped') continue;
    let lane = REQUEST_LANE[request.state] ?? 'backlog';
    // Done with a pull request still open is waiting for review.
    if (lane === 'done' && request.bead && issueSigns({ id: request.bead, status: 'open' }, 'open', ctx).signs.includes('pr')) lane = 'review';
    const why = (request.state === 'approved' && request.cloud?.status === 'waiting' ? CLOUD_WHY[request.cloud.reason] : null) ?? REQUEST_WHY[request.state];
    cards.push({
      key: `request:${request.id}`, source: 'request', id: request.id, project: request.project ?? '', title: request.title,
      lane, state: request.state === 'open' ? 'proposed' : request.state,
      ...(why ? { why } : {}), signs: [],
      updatedAt: request.at ?? '', href: `#/~hub/request/${encodeURIComponent(request.id)}`,
    });
  }
  return cards;
}

function runCards(hermesRuns) {
  const cards = [];
  for (const run of hermesRuns) {
    const lane = run.state === 'running' ? 'running' : run.state === 'waiting' || run.state === 'waiting-approval' ? 'blocked' : run.state === 'completed' ? 'done' : null;
    if (!lane) continue;
    cards.push({
      key: `run:${run.id}`, source: 'hermes', id: run.id, project: run.project ?? '', title: run.title ?? 'Hermes run',
      lane, state: run.state, ...(lane === 'blocked' ? { why: 'needs you' } : {}), signs: [],
      updatedAt: run.updatedAt ?? '', href: '#/~hub/team',
    });
  }
  return cards;
}

/**
 * @param issues      Beads issues, each carrying its `project`
 * @param requests    request items (`requestItem`): { id, project, title, at, state, bead? }
 * @param hermesRuns  [{ id, project?, title?, state: 'running' | 'waiting' | 'completed', updatedAt }]
 * @param events      the event window
 * @param asks        [{ id, bead, state }] with the Ask's derived state
 * @param status      the PC status or null
 */
export function buildWork({ issues = [], requests = [], hermesRuns = [], events = [], asks = [], status = null, now = new Date() }) {
  const all = [...beadCards({ issues, events, asks, status, now }), ...requestCards({ requests, events }), ...runCards(hermesRuns)];
  const lanes = Object.fromEntries(LANES.map(lane => [lane, []]));
  const counts = Object.fromEntries(LANES.map(lane => [lane, 0]));
  const floor = now.getTime() - DONE_DAYS * DAY;
  for (const card of all) {
    if (card.lane === 'done' && stamp(card.updatedAt) < floor) continue;
    lanes[card.lane].push(card);
    counts[card.lane] += 1;
  }
  for (const lane of LANES) lanes[lane].sort(newest);
  lanes.backlog = lanes.backlog.slice(0, BACKLOG_KEEP);
  lanes.done = lanes.done.slice(0, DONE_KEEP);
  return { lanes, counts, at: now.toISOString() };
}
