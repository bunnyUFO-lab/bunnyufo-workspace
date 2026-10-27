// The Progress map's model, with no I/O: a project's Beads issues, the events that name them and
// the open Asks become milestones → features → tasks, each with a state, signs and sprint labels.
// The layout (positions, zoom) is the browser's job; this is the part worth testing.
//
// Beads 1.3.2 export format: one issue per line; `dependencies[]` holds `{ issue_id,
// depends_on_id, type }` with type `parent-child` (the child holds the link) or `blocks` (the
// blocked issue holds it).
import { chronological } from './hub-model.mjs';

const isMilestoneIssue = issue => issue.issue_type === 'milestone' || (issue.labels ?? []).some(label => label === 'milestone' || label === 'wayfinder:map');
const isGroupType = issue => issue.issue_type === 'epic' || issue.issue_type === 'feature';

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

/**
 * @param events chronological or not; only those naming a task's bead matter
 * @param asks   [{ id, bead?, state }] with the Ask's derived state
 */
export function buildMap({ project, meta = null, issues = [], events = [], asks = [], now = new Date() }) {
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

  // A label inherited by a child (bd's default) must not turn a feature into a milestone.
  const milestoneIssues = issues.filter(issue => isMilestoneIssue(issue) && !(parentOf.has(issue.id) && isMilestoneIssue(byId.get(parentOf.get(issue.id)))));
  const milestoneIds = new Set(milestoneIssues.map(issue => issue.id));

  const asksByBead = new Map();
  for (const ask of asks) {
    if (ask.bead && (ask.state === 'open' || ask.state === 'snoozed')) asksByBead.set(ask.bead, ask.id);
  }
  const eventsByBead = new Map();
  for (const event of chronological(events)) {
    if (!event.bead) continue;
    if (!eventsByBead.has(event.bead)) eventsByBead.set(event.bead, []);
    eventsByBead.get(event.bead).push(event);
  }

  const taskState = issue => {
    if (issue.status === 'closed') return 'done';
    if (asksByBead.has(issue.id) || (issue.labels ?? []).includes('needs-owner')) return 'you';
    if (issue.status === 'in_progress') return 'doing';
    if (issue.status === 'open' && blockers(issue).every(id => !byId.has(id) || byId.get(id).status === 'closed')) return 'next';
    return 'later';
  };

  const signsOf = (issue, state) => {
    const list = eventsByBead.get(issue.id) ?? [];
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
  };

  const toTask = issue => {
    const state = taskState(issue);
    const { signs, prUrl, prs } = signsOf(issue, state);
    return {
      id: issue.id, title: issue.title ?? issue.id, state, status: issue.status ?? 'open', signs,
      sprints: (issue.labels ?? []).filter(label => label.startsWith('sprint:')).map(label => label.slice(7)),
      deps: blockers(issue).filter(id => byId.has(id)),
      ...(asksByBead.has(issue.id) ? { ask: asksByBead.get(issue.id) } : {}),
      ...(prUrl ? { prUrl } : {}),
      ...(prs.length ? { prs } : {}),
      ...(issue.closed_at ? { closedAt: issue.closed_at } : {}),
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

  const makeFeature = (id, title, taskIssues) => {
    const tasks = taskIssues.map(toTask);
    return { id, title, state: roll(tasks.map(task => task.state)), tasks };
  };
  const makeMilestone = (id, title, features) => ({
    id, title, state: roll(features.flatMap(feature => feature.tasks.map(task => task.state))), features,
  });

  const milestones = orderSiblings(milestoneIssues, blockers).map(milestone => {
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
  });

  // Whatever no milestone reaches: groups with children become features, the rest one pile.
  const unplaced = issues.filter(issue => !placed.has(issue.id));
  const features = [];
  const loose = [];
  for (const issue of orderSiblings(unplaced, blockers)) {
    if (placed.has(issue.id) || milestoneIds.has(issue.id)) continue;
    const parent = parentOf.get(issue.id);
    if (parent && !placed.has(parent) && unplaced.some(other => other.id === parent)) continue;   // shown with its parent
    if (isGroupType(issue)) {
      placed.add(issue.id);
      const tasks = collect(issue);
      if (tasks.length) features.push(makeFeature(issue.id, issue.title ?? issue.id, tasks));
    } else {
      placed.add(issue.id);
      loose.push(issue, ...collect(issue));
    }
  }
  if (loose.length) features.push(makeFeature('~none~other', 'Other tasks', loose));
  if (features.length) milestones.push(makeMilestone('~none', 'Not in a milestone', features));

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
  const sprints = [...sprintInfo.values()].sort((a, b) => (a.first < b.first ? -1 : a.first > b.first ? 1 : a.name < b.name ? -1 : 1)).map(({ name, milestones: list }) => ({ name, milestones: list }));

  for (const milestone of milestones) for (const feature of milestone.features) for (const task of feature.tasks) delete task.createdAt;

  const pushed = meta?.pushedAt ? new Date(meta.pushedAt).getTime() : NaN;
  return {
    project, meta,
    ageMinutes: Number.isNaN(pushed) ? null : Math.max(0, Math.floor((now.getTime() - pushed) / 60000)),
    milestones, sprints,
  };
}
