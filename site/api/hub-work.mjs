// Work's six lanes, with no I/O: Beads issues, requests and Hermes runs become cards in
// backlog, ready, running, blocked, review or done. Pure; the route loads the inputs.
import { eventsByBeadOf, issueSigns, milestoneIssuesOf } from './hub-map.mjs';
import { plainText, summaryOf } from './hub-map-notes.mjs';
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

export const REASON_MAX = 120;

/**
 * One line on why a needs-owner item needs the owner: the reason in its notes ("needs-owner: ..."), else the first
 * sentence of its description, clipped to about 120 characters. Empty when the bead says nothing usable.
 */
export function reasonOf(issue) {
  const fromNotes = /(?:^|\n)\s*(?:[-*]\s*)?needs[- ]owner\s*[:–—-]\s*(.+)/i.exec(String(issue?.notes ?? ''));
  const text = fromNotes ? plainText(fromNotes[1]) : (summaryOf(issue?.description) ?? '').split(/(?<=[.!?])\s+(?=[A-Z0-9"(])/)[0];
  return text.length > REASON_MAX ? `${text.slice(0, REASON_MAX - 1).trimEnd()}…` : text;
}

function beadCards({ issues, events, asks, checklists, needs, status, now }) {
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
  // What is asked of the owner about a bead: an open or snoozed Ask first, then an open checklist, then any other Needs you item.
  const askedOf = new Map();
  const note = (bead, kind, id, href) => { if (bead && !askedOf.has(bead)) askedOf.set(bead, { kind, id, href }); };
  for (const ask of asks) if (ask.state === 'open' || ask.state === 'snoozed') note(ask.bead, 'ask', ask.id, `#/~hub/ask/${encodeURIComponent(ask.id)}`);
  for (const list of checklists) if (list.state === 'open') note(list.bead, 'checklist', list.id, `#/~hub/checklist/${encodeURIComponent(list.id)}`);
  for (const need of needs) note(need.bead, need.kind, need.id, '#/~hub/needs');
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
    let nothingAsked = false;
    const asked = askedOf.get(issue.id);
    const labelled = (issue.labels ?? []).includes('needs-owner');
    // An item behind an open blocker is not the owner's yet: it waits in Blocked without the nothing-asked warning.
    const mine = labelled && !openBlocker;
    // A done or not-needed mark the owner just made on such an item: it stays on Today (muted, with Undo) until a session applies it.
    const markedUnasked = closed && labelled && !openBlocker && !asked && ['done', 'not-needed'].includes(issue._mark?.verdict);
    if (closed) lane = 'done';
    else if (asked || mine) {
      lane = 'blocked';
      nothingAsked = !asked;
      why = nothingAsked ? 'needs you · nothing asked yet' : 'needs you';
    }
    else if (labelled) { lane = 'blocked'; why = `blocked by ${openBlocker.id} ${openBlocker.title ?? ''}`.trim(); }
    else if (signs.includes('pr') || signs.includes('review')) lane = 'review';
    else if (issue.status === 'in_progress') lane = 'running';
    else if (issue.status === 'deferred') lane = 'backlog';
    else if (issue.status === 'blocked' || openBlocker) { lane = 'blocked'; why = openBlocker ? `blocked by ${openBlocker.id} ${openBlocker.title ?? ''}`.trim() : 'blocked'; }
    else if (issue.status === 'open') lane = 'ready';
    else continue;
    const project = issue.project ?? '';
    cards.push({
      key: `bead:${issue.id}`, source: 'beads', id: issue.id, project, title: issue.title ?? issue.id,
      lane, state: issue.status ?? 'open', type: issue.issue_type ?? 'task', labels: issue.labels ?? [], ...(why ? { why } : {}), signs,
      ...(!closed && asked ? { asked } : {}), ...(nothingAsked ? { nothingAsked: true } : {}),
      ...(nothingAsked || markedUnasked ? { reason: reasonOf(issue) } : {}),
      ...(markedUnasked ? { markedUnasked: true, mark: { verdict: issue._mark.verdict, at: issue._mark.at } } : {}),
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

/** The cards that say they need the owner but ask nothing: Today and the board count the same list. */
export const unaskedOf = cards => cards.filter(card => card.nothingAsked || card.markedUnasked);

/**
 * @param issues      Beads issues, each carrying its `project`
 * @param requests    request items (`requestItem`): { id, project, title, at, state, bead? }
 * @param hermesRuns  [{ id, project?, title?, state: 'running' | 'waiting' | 'completed', updatedAt }]
 * @param events      the event window
 * @param asks        [{ id, bead, state }] with the Ask's derived state
 * @param checklists  [{ id, bead, state }] with the checklist's derived state
 * @param needs       [{ bead, kind, id }]: every other Needs you item that names a bead
 * @param status      the PC status or null
 */
export function buildWork({ issues = [], requests = [], hermesRuns = [], events = [], asks = [], checklists = [], needs = [], status = null, now = new Date() }) {
  const all = [...beadCards({ issues, events, asks, checklists, needs, status, now }), ...requestCards({ requests, events }), ...runCards(hermesRuns)];
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
