// What Hermes's `delegate_task` started in a chat turn: one record per delegate, kept on the assistant line.
//
// Read from Hermes 0.22.5's source, and the session route checked live on 2026-11-04. A top-level `delegate_task` returns at
// once and its delegates run in the background, usually past the end of the run, so three sources feed one list:
//   - `tool.completed` (tool `delegate_task`): its `preview` is the first 500 characters of the handle,
//     `{ status: 'dispatched', mode, count, delegation_id, goals: [...] }`, so the last goal is often cut. `action: list` and the other
//     control calls start nothing.
//   - `subagent.start` and `subagent.complete` on the run's stream: `goal`, `task_index`, `task_count`, `subagent_id`, sometimes
//     `delegation_id`, and at the end `status`, `summary` (500 characters), `duration_seconds`. The stream closes when the run ends,
//     and anything later is lost.
//   - The session's messages (`GET /api/sessions/<run id>/messages`): when a batch ends, Hermes saves a row with
//     `display_kind: async_delegation_complete` whose text holds every delegate's whole result. That is the only source after the run.
import { stripInlineImages } from './inline-images.mjs';

export const DELEGATE_TOOL = 'delegate_task';
/** A delegate with no result after this long: Hermes may have restarted, and restarted delegates never report. */
export const DELEGATE_WAIT_MS = 2 * 60 * 60 * 1000;
const MAX_DELEGATES = 12;
const MAX_GOAL = 400;
const MAX_SUMMARY = 6000;
/** The results a line's note may carry: history goes to Hermes on every turn, and the whole text stays in its session. */
const NOTE_ROOM = 1200;
const NOTE_GOAL = 80;
const DONE = new Set(['completed', 'success']);

const cut = (value, length) => {
  const text = stripInlineImages(String(value ?? '')).trim();
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
};
const isIndex = value => Number.isInteger(value) && value >= 0;
const stateOf = status => (DONE.has(status) ? 'done' : 'failed');
/** A cut goal still matches the whole one. */
const sameGoal = (a, b) => {
  const [left, right] = [a, b].map(goal => String(goal ?? '').replace(/(…|\.\.\.)$/, '').trim());
  return !left || !right || left.startsWith(right) || right.startsWith(left);
};

/** The goals of a handle that may end in the middle of one: JSON strings read one at a time, the cut one kept with its mark. */
function goalsOf(text) {
  const start = /"goals":\s*\[/.exec(text);
  if (!start) return [];
  const goals = [];
  for (const [, body, closed] of text.slice(start.index + start[0].length).matchAll(/"((?:[^"\\]|\\.)*)("?)/g)) {
    const whole = closed ? body : body.replace(/\.\.\.$/, '').replace(/\\[^"]?$/, '');
    try { goals.push(`${JSON.parse(`"${whole}"`)}${closed ? '' : '…'}`); } catch { /* a broken escape: the name comes from subagent.start */ }
  }
  return goals;
}

/** What a `delegate_task` result started, or null for any other result (a refusal, `action: list`). */
export function dispatchOf(preview) {
  const text = String(preview ?? '');
  if (!/"status":\s*"dispatched"/.test(text)) return null;
  const goals = goalsOf(text);
  return {
    delegation: /"delegation_id":\s*"([^"]+)"/.exec(text)?.[1] ?? '',
    count: Math.max(Number(/"count":\s*(\d+)/.exec(text)?.[1]) || 0, goals.length, 1),
    goals,
  };
}

function findDelegate(list, { subagent, delegation, index, goal }) {
  const bySubagent = subagent ? list.findIndex(item => item.subagent === subagent) : -1;
  if (bySubagent >= 0) return bySubagent;
  return list.findIndex(item => item.index === index && (!subagent || !item.subagent) && (!delegation || !item.delegation || item.delegation === delegation) && sameGoal(item.goal, goal));
}

/** Folds one run event into the list. The same list comes back when the event changes nothing. */
export function foldDelegates(list, event, data) {
  if (event === 'tool.completed' && data.tool === DELEGATE_TOOL) {
    const dispatch = dispatchOf(data.preview);
    if (!dispatch) return list;
    const next = [...list];
    for (let index = 0; index < dispatch.count; index += 1) {
      const goal = cut(dispatch.goals[index], MAX_GOAL);
      const at = findDelegate(next, { delegation: dispatch.delegation, index, goal });
      if (at >= 0) next[at] = { ...next[at], count: dispatch.count, ...(dispatch.delegation ? { delegation: dispatch.delegation } : {}) };
      else if (next.length < MAX_DELEGATES) next.push({ id: `d${next.length + 1}`, ...(dispatch.delegation ? { delegation: dispatch.delegation } : {}), index, count: dispatch.count, goal, state: 'running' });
    }
    return next;
  }
  if (event !== 'subagent.start' && event !== 'subagent.complete') return list;
  const index = isIndex(data.task_index) ? data.task_index : 0;
  const subagent = typeof data.subagent_id === 'string' ? data.subagent_id : '';
  const delegation = typeof data.delegation_id === 'string' ? data.delegation_id : '';
  const goal = cut(data.goal, MAX_GOAL);
  const at = findDelegate(list, { subagent, delegation, index, goal });
  const known = at >= 0 ? list[at] : null;
  if (!known && list.length >= MAX_DELEGATES) return list;
  const merged = {
    ...(known ?? { id: `d${list.length + 1}`, state: 'running' }),
    ...(subagent ? { subagent } : {}),
    ...(delegation ? { delegation } : {}),
    index,
    count: Number.isInteger(data.task_count) ? data.task_count : known?.count ?? 1,
    goal: goal || known?.goal || '',   // this one is whole; the handle's may be cut
    ...(event === 'subagent.complete' ? {
      state: stateOf(data.status),
      summary: cut(data.summary ?? data.preview, MAX_SUMMARY),
      ...(Number.isFinite(data.duration_seconds) ? { seconds: Math.round(data.duration_seconds) } : {}),
    } : {}),
  };
  return at >= 0 ? list.map((item, position) => (position === at ? merged : item)) : [...list, merged];
}

/** A task's text without what only Hermes can open: transcripts live inside its host. */
const resultText = body => body.split(/\r?\n/).filter(line => !/^Full live transcript\b/.test(line)).join('\n').trim();

const TASK_HEADER = /^--- [✓⚠✗] TASK (\d+)\/(\d+)(?:: ([\s\S]*?))?  \(status=([^,)\s]+)([^\n]*)\) ---$/gmu;

/** A saved completion row as `{ delegation, tasks, error }`, or null when the text is something else. */
export function parseDelivery(content) {
  const text = String(content ?? '');
  const head = /^\[ASYNC DELEGATION (BATCH COMPLETE|COMPLETE|TASK FAILED) — ([^\],\s]+)(?:, task (\d+)\/(\d+))?\]/.exec(text);
  if (!head) return null;
  const [, kind, delegation, oneBased, total] = head;
  if (kind === 'TASK FAILED') {
    const error = /^Error: (.*)$/m.exec(text)?.[1] ?? '';
    return { delegation, tasks: [{ index: Number(oneBased) - 1, count: Number(total), goal: /^Task: (.*)$/m.exec(text)?.[1] ?? '', status: /^Status: (\S+)/m.exec(text)?.[1] ?? 'failed', summary: error }] };
  }
  if (kind === 'COMPLETE') {
    const status = /^Status: (\S+)/m.exec(text)?.[1] ?? 'completed';
    const seconds = Number(/Duration: ([\d.]+)s/.exec(text)?.[1]);
    const result = text.split(/^--- RESULT ---$/m)[1] ?? '';
    return { delegation, tasks: [{ index: 0, count: 1, goal: '', status, summary: resultText(result), ...(Number.isFinite(seconds) ? { seconds } : {}) }] };
  }
  const found = [...text.matchAll(TASK_HEADER)];
  const tasks = found.map((match, position) => {
    const seconds = Number(/, ([\d.]+)s\b/.exec(match[5])?.[1]);
    return {
      index: Number(match[1]) - 1, count: Number(match[2]), goal: match[3] ?? '', status: match[4],
      summary: resultText(text.slice(match.index + match[0].length, found[position + 1]?.index ?? text.length)),
      ...(Number.isFinite(seconds) ? { seconds } : {}),
    };
  });
  const error = tasks.length ? '' : /^--- ERROR ---\s*\n(.*)$/m.exec(text)?.[1] ?? '';
  return { delegation, tasks, ...(error ? { error } : {}) };
}

/**
 * The results of a line's finished delegates, as a note for the history Hermes gets: each Hub turn is a new run, and they reach it no other
 * way. Empty when none has finished. Each row gets a fair part of what is left, so a long result leaves room for the rest.
 */
export function delegatesNote(line) {
  const finished = (Array.isArray(line?.delegates) ? line.delegates : []).filter(item => item.state === 'done' || item.state === 'failed');
  if (!finished.length) return '';
  let room = NOTE_ROOM;
  const rows = finished.map((item, at) => {
    const flat = `- ${cut(item.goal, NOTE_GOAL) || 'Delegate'} (${item.state}): ${item.summary || 'no result'}`.replace(/\s+/g, ' ');
    const row = cut(flat, Math.floor(room / (finished.length - at)));
    room -= row.length;
    return row;
  });
  return [`[Hub: results of the delegates this reply started. … marks one cut short.]`, ...rows].join('\n');
}

export const hasRunningDelegate = line => Array.isArray(line?.delegates) && line.delegates.some(item => item.state === 'running');

/**
 * Applies saved completion rows to the delegates still running. Past `DELEGATE_WAIT_MS` the rest become `unknown`, so the page stops
 * waiting. The same list comes back when nothing changed.
 */
export function settleDelegates(list, rows, ageMs) {
  const deliveries = (rows ?? []).map(row => parseDelivery(row?.content)).filter(Boolean);
  // In the order Hermes saved them: a batch's row, with the whole results, comes after any early failure notice.
  let changed = false;
  const next = list.map(item => {
    if (item.state !== 'running' && item.state !== 'failed') return item;
    let updated = item;
    for (const delivery of deliveries) {
      if (item.delegation && delivery.delegation !== item.delegation) continue;
      const task = delivery.tasks.find(entry => entry.index === item.index && (item.delegation || sameGoal(item.goal, entry.goal)));
      if (task && (item.state === 'running' || task.summary.length > (updated.summary?.length ?? 0))) {
        updated = { ...updated, ...(item.delegation ? {} : { delegation: delivery.delegation }), state: stateOf(task.status), summary: cut(task.summary, MAX_SUMMARY), ...(task.seconds !== undefined ? { seconds: Math.round(task.seconds) } : {}) };
      } else if (!task && delivery.error && updated.state === 'running' && item.delegation) {
        updated = { ...updated, state: 'failed', summary: cut(delivery.error, MAX_SUMMARY) };
      }
    }
    if (updated === item && item.state === 'running' && ageMs > DELEGATE_WAIT_MS) updated = { ...item, state: 'unknown' };
    if (updated !== item) changed = true;
    return updated;
  });
  return changed ? next : list;
}
