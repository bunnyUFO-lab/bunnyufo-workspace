// The Progress map's model, with no I/O: a project's Beads issues, the events that name them and
// the open Asks become milestones → features → tasks, each with a state, signs and sprint labels.
// The layout (positions, zoom) is the browser's job; this is the part worth testing.
//
// Beads 1.3.2 export format: one issue per line; `dependencies[]` holds `{ issue_id,
// depends_on_id, type }` with type `parent-child` (the child holds the link) or `blocks` (the
// blocked issue holds it).
import { chronological } from './hub-model.mjs';
import { plainText, summaryOf, prsFromIssue, commitsFromIssue, cardRefsOf } from './hub-map-notes.mjs';

export const isMilestoneIssue = issue => issue.issue_type === 'milestone' || (issue.labels ?? []).some(label => label === 'milestone' || label === 'wayfinder:map');
const isGroupType = issue => issue.issue_type === 'epic' || issue.issue_type === 'feature';

/**
 * The title of each sprint: of the group issues (epic, feature, milestone) that carry `sprint:<name>`, the one whose parent does not carry it,
 * the oldest first when several do. A sprint with no such issue has no title. Returns a Map of name to title.
 */
export function sprintTitlesOf(issues) {
  const byId = new Map(issues.map(issue => [issue.id, issue]));
  const parentOf = new Map();
  for (const issue of issues) for (const dep of issue.dependencies ?? []) if (dep.issue_id === issue.id && dep.type === 'parent-child') parentOf.set(issue.id, dep.depends_on_id);
  const best = new Map();
  for (const issue of issues) {
    if (!(isGroupType(issue) || issue.issue_type === 'milestone')) continue;
    const parent = byId.get(parentOf.get(issue.id));
    for (const label of issue.labels ?? []) {
      if (!label.startsWith('sprint:')) continue;
      if ((parent?.labels ?? []).includes(label)) continue;
      const name = label.slice(7);
      const have = best.get(name);
      const older = !have || (issue.created_at ?? '') < (have.created_at ?? '') || ((issue.created_at ?? '') === (have.created_at ?? '') && issue.id < have.id);
      if (older) best.set(name, issue);
    }
  }
  return new Map([...best].map(([name, issue]) => [name, issue.title ?? issue.id]));
}

/** Roll a list of child states up into one, as the prototype's `roll` does. */
export function roll(states) {
  if (!states.length) return 'later';
  if (states.every(state => state === 'done')) return 'done';
  if (states.includes('you')) return 'you';
  if (states.includes('doing')) return 'doing';
  if (states.includes('next')) return 'next';
  if (states.some(state => state === 'done')) return 'doing';
  return 'later';
}

const created = issue => String(issue.created_at ?? '');

/**
 * Items ordered by a topological sort over `blocks` among themselves, ties and cycles by
 * `created_at`, then id. `blockers(item)` lists the ids that must come first.
 */
export function orderSiblings(items, blockers) {
  const ids = new Set(items.map(item => item.id));
  const compare = (a, b) => (created(a) < created(b) ? -1 : created(a) > created(b) ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const waiting = new Map(items.map(item => [item.id, new Set(blockers(item).filter(id => ids.has(id) && id !== item.id))]));
  const placed = [];
  const done = new Set();
  const left = new Set(items.map(item => item.id));
  const byId = new Map(items.map(item => [item.id, item]));
  while (left.size) {
    const ready = [...left].map(id => byId.get(id)).filter(item => [...waiting.get(item.id)].every(id => done.has(id))).sort(compare);
    // A cycle: nothing is ready, so the rest falls back to date order.
    const next = ready.length ? ready[0] : [...left].map(id => byId.get(id)).sort(compare)[0];
    placed.push(next);
    done.add(next.id);
    left.delete(next.id);
  }
  return placed;
}

const DESTINATION_MAX = 280;

/** The first paragraph under a `## Destination` heading, as plain text clipped to 280 characters; null when there is none. */
export function destinationOf(description) {
  const lines = String(description ?? '').split(/\r?\n/);
  const at = lines.findIndex(line => /^#{2}\s+destination\s*#*\s*$/i.test(line.trim()));
  if (at < 0) return null;
  const paragraph = [];
  for (const line of lines.slice(at + 1)) {
    if (/^#{1,6}\s/.test(line.trim())) break;
    if (!line.trim()) { if (paragraph.length) break; continue; }
    paragraph.push(line);
  }
  const text = plainText(paragraph.join(' '));
  if (!text) return null;
  return text.length > DESTINATION_MAX ? `${text.slice(0, DESTINATION_MAX - 1).trimEnd()}…` : text;
}

const SECTION_MAX = 600;
const wayfinderType = issue => (issue.labels ?? []).find(label => label.startsWith('wayfinder:') && label !== 'wayfinder:map')?.slice('wayfinder:'.length);

/** The text under a `## <name>` heading up to the next heading, as plain text clipped to `max` characters; null when there is none. */
export function sectionOf(description, name, max = SECTION_MAX) {
  const lines = String(description ?? '').split(/\r?\n/);
  const at = lines.findIndex(line => new RegExp(`^#{2}\\s+${name}\\s*#*\\s*$`, 'i').test(line.trim()));
  if (at < 0) return null;
  const body = [];
  for (const line of lines.slice(at + 1)) {
    if (/^#{1,6}\s/.test(line.trim())) break;
    body.push(line);
  }
  const text = plainText(body.join(' '));
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/**
 * Whether `bead` is an open Wayfinder question: open, labelled `wayfinder:<type>` (not `:map`), and the child of an open
 * `wayfinder:map`. The one rule the Roadmap's "Answer here" and the Ask-to-mark step share. `issues` are Beads issues, with or without marks.
 */
export function isWayfinderQuestion(issues, bead) {
  const byId = new Map(issues.map(issue => [issue.id, issue]));
  const issue = byId.get(bead);
  if (!issue || issue.status === 'closed' || !wayfinderType(issue)) return false;
  const parent = (issue.dependencies ?? []).find(dep => dep.issue_id === issue.id && dep.type === 'parent-child');
  const map = parent && byId.get(parent.depends_on_id);
  return !!map && map.status !== 'closed' && (map.labels ?? []).includes('wayfinder:map');
}

/**
 * The Wayfinder header: the open issue labelled `wayfinder:map` with the newest `updated_at`, the
 * destination in its description, its closed children as decisions and its open children with a
 * `wayfinder:<type>` label (not `:map`) as open questions, oldest first, at most 8. Each question carries what a
 * run or a session needs: the `## Question` text, the open issues it waits for and the ones it unlocks (titles), the
 * Library cards it names. Null without a map.
 */
function wayfinderOf(issues, childrenOf, blockersOf) {
  const maps = issues.filter(issue => issue.status !== 'closed' && (issue.labels ?? []).includes('wayfinder:map'));
  if (!maps.length) return null;
  const map = maps.reduce((best, issue) => (String(issue.updated_at ?? '') > String(best.updated_at ?? '') ? issue : best));
  const kids = childrenOf.get(map.id) ?? [];
  const byId = new Map(issues.map(issue => [issue.id, issue]));
  const titleOf = issue => issue.title ?? issue.id;
  const open = kids
    .filter(issue => issue.status !== 'closed')
    .map(issue => ({ issue, type: wayfinderType(issue) }))
    .filter(row => row.type)
    .sort((a, b) => (created(a.issue) < created(b.issue) ? -1 : created(a.issue) > created(b.issue) ? 1 : a.issue.id < b.issue.id ? -1 : 1))
    .slice(0, 8)
    .map(({ issue, type }) => {
      const question = sectionOf(issue.description, 'question');
      const blockedBy = (blockersOf.get(issue.id) ?? []).map(id => byId.get(id)).filter(blocker => blocker && blocker.status !== 'closed').map(titleOf);
      const unlocks = issues.filter(other => other.status !== 'closed' && (blockersOf.get(other.id) ?? []).includes(issue.id)).sort((a, b) => (created(a) < created(b) ? -1 : created(a) > created(b) ? 1 : 0)).map(titleOf);
      const cards = cardRefsOf(issue);
      return { id: issue.id, title: titleOf(issue), type, ...(question ? { question } : {}), blockedBy, unlocks, ...(cards.length ? { cards } : {}) };
    });
  return {
    mapId: map.id, mapTitle: titleOf(map), destination: destinationOf(map.description), notes: sectionOf(map.description, 'notes'),
    decisions: kids.filter(issue => issue.status === 'closed').length, open,
  };
}

/**
 * The issues the map treats as milestones. A label a child inherited from its milestone (bd's
 * default) must not turn a feature into a milestone, so one whose parent is also a milestone is not.
 * `parentOf` maps an issue id to its parent id; Work uses the same rule.
 */
export function milestoneIssuesOf(issues, parentOf) {
  const byId = new Map(issues.map(issue => [issue.id, issue]));
  return issues.filter(issue => isMilestoneIssue(issue) && !(parentOf.has(issue.id) && isMilestoneIssue(byId.get(parentOf.get(issue.id)))));
}

/**
 * The issues the map treats as roadmaps: an `epic` labelled `roadmap` that is not a milestone, with no parent or a parent that is itself a roadmap.
 * Exactly `epic`: `bd create --parent` copies labels to children, so a task or feature that inherited `roadmap` must not become one.
 * A parent cycle makes none of its members roadmaps.
 */
export function roadmapIssuesOf(issues, parentOf) {
  const byId = new Map(issues.map(issue => [issue.id, issue]));
  const candidate = issue => !!issue && issue.issue_type === 'epic' && (issue.labels ?? []).includes('roadmap') && !isMilestoneIssue(issue);
  const memo = new Map();
  const is = (issue, seen) => {
    if (memo.has(issue.id)) return memo.get(issue.id);
    if (!candidate(issue) || seen.has(issue.id)) return false;
    const parent = parentOf.get(issue.id);
    const ok = parent === undefined || is(byId.get(parent), new Set([...seen, issue.id]));
    memo.set(issue.id, ok);
    return ok;
  };
  return issues.filter(issue => is(issue, new Set()));
}

/** Events grouped by the bead they name, oldest first. */
export function eventsByBeadOf(events) {
  const grouped = new Map();
  for (const event of chronological(events)) {
    if (!event.bead) continue;
    if (!grouped.has(event.bead)) grouped.set(event.bead, []);
    grouped.get(event.bead).push(event);
  }
  return grouped;
}

/**
 * The signs on one issue (working, idle, new, pr, ci-failed, review, deployed) and its PRs.
 * `ctx.eventsByBead` is `eventsByBeadOf(events)`; `state` is the map state ('done' hides live signs.)
 */
export function issueSigns(issue, state, ctx) {
  const list = ctx.eventsByBead.get(issue.id) ?? [];
  const signs = [];
  let prUrl;
  if (state !== 'done') {
    const session = [...list].reverse().find(event => event.kind === 'session-started' || event.kind === 'session-ended');
    if (session?.kind === 'session-started') signs.push('working');
    else if (session) signs.push('idle');
    if (issue.status === 'open' && !list.length) signs.push('new');
  }
  const lastIndex = kind => list.map(event => event.kind).lastIndexOf(kind);
  const open = kind => { const at = lastIndex(kind); return at >= 0 && lastIndex('pr-merged') < at ? list[at] : null; };
  const pr = open('pr-opened');
  if (pr) { signs.push('pr'); prUrl = pr.url; }
  const ci = [...list].reverse().find(event => event.kind === 'ci-failed' || event.kind === 'ci-passed');
  if (ci?.kind === 'ci-failed') signs.push('ci-failed');
  if (open('ready-for-review')) signs.push('review');
  if (list.some(event => event.kind === 'deployed')) signs.push('deployed');
  // Every PR the bead had, open or merged, in the order they opened. Entries without a url are kept so they still count.
  const prs = [];
  for (const event of list) {
    if (event.kind === 'pr-opened') prs.push({ ...(event.url ? { url: event.url } : {}), state: 'open', at: event.ts });
    else if (event.kind === 'pr-merged') {
      const same = event.url ? prs.find(entry => entry.url === event.url) : null;
      const targets = event.url ? (same ? [same] : []) : prs.filter(entry => entry.state === 'open');
      for (const entry of targets) { entry.state = 'merged'; entry.at = event.ts; }
      if (!targets.length) prs.push({ ...(event.url ? { url: event.url } : {}), state: 'merged', at: event.ts });
    }
  }
  return { signs, prUrl, prs };
}

const MAX_CARDS = 5;
const prNumberOf = url => { const match = /\/pull\/(\d+)(?:[/?#]|$)/.exec(String(url ?? '')); return match ? Number(match[1]) : undefined; };

/**
 * The PRs the events saw merged with the ones Beads records: a row for the same number keeps the
 * event's state; a Beads-only row keeps its own, or is merged when the task is closed and says nothing,
 * and is dated with the issue (`at`: closed or last updated) since Beads holds no PR dates.
 */
function mergePrs(eventRows, beadsRows, closed, at) {
  const rows = eventRows.map(row => { const number = prNumberOf(row.url); return number ? { ...row, number } : row; });
  const known = new Set(rows.map(row => row.number).filter(Boolean));
  const extra = beadsRows.filter(row => !known.has(row.number)).sort((a, b) => a.number - b.number)
    .map(row => {
      const state = row.state ?? (closed ? 'merged' : undefined);
      return { number: row.number, ...(row.url ? { url: row.url } : {}), ...(state ? { state } : {}), at };
    });
  return [...extra, ...rows];
}

/** The request states that mean a run is under way or waiting: no second run is offered for the bead. */
const LIVE_RUN = new Set(['proposed', 'approved', 'taken', 'running', 'stopping', 'asking', 'lost']);

/**
 * @param events chronological or not; only those naming a task's bead matter
 * @param asks   [{ id, bead?, state }] with the Ask's derived state
 * @param checklists [{ id, bead?, state }]: an open checklist naming a bead counts like an Ask for `you`
 * @param repo   the project's repository (a GitHub remote or `owner/name`), to link PRs and commits
 * @param cards  `ref → { title, href } | null` for `section/folder` or `section#id`; unresolved refs are dropped
 * @param requests [{ id, bead?, state, at }]: a task with a live one from the Hub gets `run: { id, state }` (the newest)
 * @param runSprints [{ head, milestone, until, items: [{ id, seq, bead, title }], ended? }] newest first (`createSprints().summaries`): a milestone gets
 *   `sprint: { head, until, items: [{ id, bead, title, state, pr? }], ended? }` for its newest one; an item whose request does not exist yet is `waiting`
 */
export function buildMap({ project, meta = null, issues = [], events = [], asks = [], checklists = [], repo = '', cards = () => null, requests = [], runSprints = [], now = new Date() }) {
  const byId = new Map(issues.map(issue => [issue.id, issue]));
  const parentOf = new Map();
  const childrenOf = new Map();
  const blockersOf = new Map();
  for (const issue of issues) {
    for (const dep of issue.dependencies ?? []) {
      if (dep.issue_id !== issue.id) continue;
      if (dep.type === 'parent-child' && byId.has(dep.depends_on_id)) {
        parentOf.set(issue.id, dep.depends_on_id);
        if (!childrenOf.has(dep.depends_on_id)) childrenOf.set(dep.depends_on_id, []);
        childrenOf.get(dep.depends_on_id).push(issue);
      } else if (dep.type === 'blocks') {
        if (!blockersOf.has(issue.id)) blockersOf.set(issue.id, []);
        blockersOf.get(issue.id).push(dep.depends_on_id);
      }
    }
  }
  const blockers = issue => blockersOf.get(issue.id) ?? [];
  const children = issue => childrenOf.get(issue.id) ?? [];

  const milestoneIssues = milestoneIssuesOf(issues, parentOf);
  const milestoneIds = new Set(milestoneIssues.map(issue => issue.id));
  const roadmapIssues = roadmapIssuesOf(issues, parentOf);
  const roadmapIds = new Set(roadmapIssues.map(issue => issue.id));
  /** The nearest roadmap above an issue (walking parents; a cycle ends the walk), or undefined. */
  const roadmapAbove = id => {
    const seen = new Set([id]);
    for (let at = parentOf.get(id); at !== undefined && !seen.has(at); at = parentOf.get(at)) {
      if (roadmapIds.has(at)) return at;
      seen.add(at);
    }
    return undefined;
  };

  const asksByBead = new Map();
  for (const ask of asks) {
    if (ask.bead && (ask.state === 'open' || ask.state === 'snoozed')) asksByBead.set(ask.bead, ask.id);
  }
  const checklistsByBead = new Map();
  for (const list of checklists) {
    if (list.bead && list.state === 'open' && !checklistsByBead.has(list.bead)) checklistsByBead.set(list.bead, list.id);
  }
  const eventsByBead = eventsByBeadOf(events);
  // The newest request made from each bead that has not ended: the sheet shows it instead of offering a second run.
  const runsByBead = new Map();
  for (const request of requests) {
    if (!request.bead || !LIVE_RUN.has(request.state)) continue;
    const have = runsByBead.get(request.bead);
    if (!have || String(request.at ?? '') > String(have.at ?? '')) runsByBead.set(request.bead, request);
  }

  // The Library cards an issue names itself, then the ones its events came from, resolved and at most five.
  const cardsOf = issue => {
    const refs = [...cardRefsOf(issue), ...(eventsByBead.get(issue.id) ?? []).map(event => event.cardDir).filter(Boolean)];
    const out = [];
    for (const ref of new Set(refs)) {
      let card = null;
      try { card = cards(ref); } catch { card = null; }
      if (card?.href && !out.some(row => row.href === card.href)) out.push({ title: card.title ?? ref, href: card.href });
    }
    return out.slice(0, MAX_CARDS);
  };
  // What a feature or milestone that is a real issue says about itself.
  const notesOf = id => {
    const issue = id.includes('~') ? null : byId.get(id);
    if (!issue) return {};
    const summary = summaryOf(issue.description);
    const cardRows = cardsOf(issue);
    return {
      ...(summary ? { summary } : {}),
      ...(issue.closed_at ? { closedAt: issue.closed_at } : {}),
      ...(issue.close_reason ? { closeReason: issue.close_reason } : {}),
      ...(cardRows.length ? { cards: cardRows } : {}),
    };
  };

  const taskState = issue => {
    if (issue.status === 'closed') return 'done';
    if (asksByBead.has(issue.id) || checklistsByBead.has(issue.id) || (issue.labels ?? []).includes('needs-owner')) return 'you';
    if (issue.status === 'in_progress') return 'doing';
    if (issue.status === 'open' && blockers(issue).every(id => !byId.has(id) || byId.get(id).status === 'closed')) return 'next';
    return 'later';
  };

  const toTask = issue => {
    const state = taskState(issue);
    const { signs, prUrl, prs: eventPrs } = issueSigns(issue, state, { eventsByBead });
    const prs = mergePrs(eventPrs, prsFromIssue(issue, repo), issue.status === 'closed', issue.closed_at ?? issue.updated_at ?? '');
    const summary = summaryOf(issue.description);
    const commits = commitsFromIssue(issue, repo);
    const cardRows = cardsOf(issue);
    return {
      id: issue.id, title: issue.title ?? issue.id, state, status: issue.status ?? 'open', signs,
      sprints: (issue.labels ?? []).filter(label => label.startsWith('sprint:')).map(label => label.slice(7)),
      deps: blockers(issue).filter(id => byId.has(id)),
      ...(asksByBead.has(issue.id) ? { ask: asksByBead.get(issue.id) } : {}),
      ...(state === 'you' && checklistsByBead.has(issue.id) ? { checklist: checklistsByBead.get(issue.id) } : {}),
      ...(state === 'you' ? { you: asksByBead.has(issue.id) ? 'ask' : checklistsByBead.has(issue.id) ? 'checklist' : 'label' } : {}),
      ...(runsByBead.has(issue.id) ? { run: { id: runsByBead.get(issue.id).id, state: runsByBead.get(issue.id).state } } : {}),
      ...(summary ? { summary } : {}),
      ...(issue.close_reason ? { closeReason: issue.close_reason } : {}),
      ...(issue._mark ? { mark: { verdict: issue._mark.verdict, at: issue._mark.at, pending: true, ...(issue._mark.reason ? { reason: issue._mark.reason } : {}) } } : {}),
      ...(cardRows.length ? { cards: cardRows } : {}),
      ...(commits.length ? { commits } : {}),
      ...(prUrl ? { prUrl } : {}),
      ...(prs.length ? { prs } : {}),
      ...(issue.closed_at ? { closedAt: issue.closed_at } : {}),
      ...(issue.updated_at ? { updatedAt: issue.updated_at } : {}),
      createdAt: issue.created_at,
    };
  };

  const placed = new Set();
  // Every non-group descendant of an issue, in order; nested groups are walked through, not shown.
  const collect = issue => {
    const out = [];
    for (const child of orderSiblings(children(issue), blockers)) {
      if (milestoneIds.has(child.id) || placed.has(child.id)) continue;
      if (isGroupType(child)) out.push(...collect(child));
      else { out.push(child); placed.add(child.id); out.push(...collect(child)); }
    }
    return out;
  };

  // A closed feature or milestone with no tasks is done work, not later work: roll([]) alone would call it `later`.
  const stateOf = (id, states) => (states.length ? roll(states) : byId.get(id)?.status === 'closed' ? 'done' : roll(states));
  const makeFeature = (id, title, taskIssues) => {
    const tasks = taskIssues.map(toTask);
    return { id, title, state: stateOf(id, tasks.map(task => task.state)), ...notesOf(id), tasks };
  };
  // The newest sprint on a milestone, each item with the state and PR of its own request.
  const requestsById = new Map(requests.map(request => [request.id, request]));
  const sprintOf = id => {
    const row = runSprints.find(item => item.milestone === id);
    if (!row) return {};
    const items = row.items.map(item => {
      const request = requestsById.get(item.id);
      return { id: item.id, bead: item.bead, title: item.title, state: request?.state ?? 'waiting', ...(request?.finish?.pr ? { pr: request.finish.pr } : {}) };
    });
    return { sprint: { head: row.head, until: row.until, items, ...(row.ended ? { ended: row.ended } : {}) } };
  };
  const makeMilestone = (id, title, features) => ({
    id, title, state: stateOf(id, features.flatMap(feature => feature.tasks.map(task => task.state))), ...notesOf(id), ...sprintOf(id), features,
  });

  /** A milestone from an issue: its child groups are features, its loose children one more. */
  const milestoneOf = milestone => {
    placed.add(milestone.id);
    const features = [];
    const loose = [];
    for (const child of orderSiblings(children(milestone), blockers)) {
      if (milestoneIds.has(child.id)) continue;
      placed.add(child.id);
      if (isGroupType(child)) features.push(makeFeature(child.id, child.title ?? child.id, collect(child)));
      else { loose.push(child); loose.push(...collect(child)); }
    }
    if (loose.length) features.push(makeFeature(`${milestone.id}~other`, `${milestone.title ?? milestone.id} · other tasks`, loose));
    return makeMilestone(milestone.id, milestone.title ?? milestone.id, features);
  };
  const milestones = orderSiblings(milestoneIssues, blockers).map(milestoneOf);
  // A roadmap is a place for milestones, not one: it is placed so its group children become rings of their own and its loose tasks a pile.
  for (const id of roadmapIds) placed.add(id);

  // Whatever no milestone reaches: an epic with children is a ring of its own (it is not "not in a milestone"), the loose rest one pile.
  const unplaced = issues.filter(issue => !placed.has(issue.id));
  const features = [];
  const loose = [];
  const piles = new Map();
  for (const issue of orderSiblings(unplaced, blockers)) {
    if (placed.has(issue.id) || milestoneIds.has(issue.id)) continue;
    const parent = parentOf.get(issue.id);
    if (parent && !placed.has(parent) && unplaced.some(other => other.id === parent)) continue;   // shown with its parent
    if (isGroupType(issue)) {
      const kept = milestoneOf(issue);
      if (kept.features.length) milestones.push(kept);
    } else {
      placed.add(issue.id);
      // A loose task straight under a roadmap goes to that roadmap's pile, not to "Not in a milestone".
      const pile = roadmapIds.has(parent) ? (piles.get(parent) ?? piles.set(parent, []).get(parent)) : loose;
      pile.push(issue, ...collect(issue));
    }
  }
  const pileMilestones = roadmapIssues.filter(issue => piles.has(issue.id)).map(issue => {
    const title = issue.title ?? issue.id;
    return { ...makeMilestone(`${issue.id}~tasks`, `${title} · tasks`, [makeFeature(`${issue.id}~tasks~other`, 'Other tasks', piles.get(issue.id))]), roadmap: issue.id };
  });
  milestones.push(...pileMilestones);
  if (loose.length) features.push(makeFeature('~none~other', 'Other tasks', loose));
  if (features.length) milestones.push(makeMilestone('~none', 'Not in a milestone', features));

  // Each milestone with a roadmap above it names it (the flat list stays whole: Work, sprints and search read it).
  for (const milestone of milestones) {
    if (milestone.roadmap || milestone.id.includes('~')) continue;
    const above = roadmapAbove(milestone.id);
    if (above) milestone.roadmap = above;
  }
  // Left out entirely when there are none, so a project with no roadmap label answers as it did.
  const roadmaps = orderSiblings(roadmapIssues, blockers).map(issue => {
    const own = milestones.filter(milestone => milestone.roadmap === issue.id).map(milestone => milestone.state);
    const state = own.length ? roll(own) : issue.status === 'closed' ? 'done' : 'later';
    const parent = parentOf.get(issue.id);
    return { id: issue.id, title: issue.title ?? issue.id, state, ...(parent ? { parent } : {}) };
  });

  // Sprint bands: each `sprint:<name>` label, with the milestones it touches.
  const sprintInfo = new Map();
  for (const milestone of milestones) {
    const tasks = milestone.features.flatMap(feature => feature.tasks);
    const counts = new Map();
    for (const task of tasks) {
      for (const name of task.sprints) {
        counts.set(name, (counts.get(name) ?? 0) + 1);
        const info = sprintInfo.get(name) ?? { name, first: '', milestones: [] };
        if (!info.first || (task.createdAt && task.createdAt < info.first)) info.first = task.createdAt ?? info.first;
        sprintInfo.set(name, info);
      }
    }
    for (const [name, count] of counts) sprintInfo.get(name).milestones.push({ id: milestone.id, count, total: tasks.length });
  }
  const sprintTitles = sprintTitlesOf(issues);
  const sprints = [...sprintInfo.values()].sort((a, b) => (a.first < b.first ? -1 : a.first > b.first ? 1 : a.name < b.name ? -1 : 1)).map(({ name, milestones: list }) => ({ name, ...(sprintTitles.has(name) ? { title: sprintTitles.get(name) } : {}), milestones: list }));

  for (const milestone of milestones) for (const feature of milestone.features) for (const task of feature.tasks) delete task.createdAt;

  const pushed = meta?.pushedAt ? new Date(meta.pushedAt).getTime() : NaN;
  return {
    project, meta,
    ageMinutes: Number.isNaN(pushed) ? null : Math.max(0, Math.floor((now.getTime() - pushed) / 60000)),
    milestones, sprints,
    ...(roadmaps.length ? { roadmaps } : {}),
    wayfinder: wayfinderOf(issues, childrenOf, blockersOf),
  };
}
