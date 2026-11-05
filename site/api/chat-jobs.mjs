// Jobs in a chat: which of the requests Hermes filed during a turn belong to that turn's reply, and the rows the page shows for them.
// Pure code, no I/O. hub-chat.mjs saves the ids on the assistant line (`jobs`); hub.mjs builds the rows from the request files.
import { ID_RE } from './hub-model.mjs';

/** `approve`: the most ids one tap takes. Above that the page shows an Approve on each row instead. */
export const JOB_LIMITS = { perLine: 6, lines: 40, rows: 24, approve: 3, textShown: 4000 };
/** How far a clock may be off: the time the file claims, the object's own time and the Hub's clock must agree within this. */
export const SKEW_MS = 120_000;
/** Who Hermes itself files as. Anything else that merely contains the word is not main Hermes. */
export const HERMES_BY = /^hermes(-main)?$/;
const GITHUB_PR = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/;

// A request id wherever it stands in a tool preview or a reply: the anchored pattern of hub-model.mjs, loose at both ends, but never
// inside a longer run of id characters.
const FIND = new RegExp(`(?<![a-z0-9-])${ID_RE.source.slice(1, -1)}(?![a-z0-9-])`, 'g');

/** The request ids a text names, in the order they first appear. */
export const idsIn = text => [...new Set(String(text ?? '').match(FIND) ?? [])];

/** A request item (not an Ask) of `createdSince`. Asks come out of the Ask list with `kind: 'ask'`. */
const isRequest = item => item.kind !== 'ask';

/**
 * Splits what Hermes created during a turn into the jobs of this reply and the rest.
 * - A conversation with a persona: every request found is a job, flagged, named or not (the token is shared, so this is detection after the fact).
 * - Otherwise: the requests whose id this run showed (a tool preview or the reply). The rest stays in `created`, with the Asks.
 * `jobs` is the ids only, at most `perLine`: the rows are always built from the request files.
 */
export function splitCreated(items, { seen = [], persona = null } = {}) {
  const named = new Set(seen);
  const jobs = items.filter(item => isRequest(item) && (persona || named.has(item.id))).slice(0, JOB_LIMITS.perLine);
  const taken = new Set(jobs.map(item => item.id));
  return { jobs: jobs.map(item => item.id), created: items.filter(item => !taken.has(item.id)) };
}

/** The job ids of a conversation, oldest first: from the newest `lines` lines, at most `rows` (the newest). */
export function jobIdsOf(lines) {
  const out = [];
  for (const line of lines.slice(-JOB_LIMITS.lines)) {
    if (line?.role !== 'assistant' || !Array.isArray(line.jobs)) continue;
    for (const id of line.jobs) if (typeof id === 'string' && !out.includes(id)) out.push(id);
  }
  return out.slice(-JOB_LIMITS.rows);
}

/** For each job id, the time of the turn that named it: from the user line before it to the reply's own time, in ms. The first turn that named it counts. */
export function jobWindowsOf(lines) {
  const windows = new Map();
  const recent = lines.slice(-JOB_LIMITS.lines);
  recent.forEach((line, index) => {
    if (line?.role !== 'assistant' || !Array.isArray(line.jobs)) return;
    const to = Date.parse(line.at);
    const before = recent[index - 1];
    const from = before?.role === 'user' ? Date.parse(before.at) : to - 600_000;
    if (!Number.isFinite(to) || !Number.isFinite(from)) return;
    const said = idsIn(line.text);   // the reply's own words: an id only a tool preview showed is not in them
    for (const id of line.jobs) if (typeof id === 'string' && !windows.has(id)) windows.set(id, { from, to, named: said.includes(id) });
  });
  return windows;
}

/**
 * Whether a request is Hermes's own proposal made in this reply's turn, as far as the Hub can tell: filed as Hermes itself (not a name that
 * contains it), and both the date the file claims and the object's own last-modified time fall inside the turn (give or take the clock skew).
 * A file dated ahead, or one whose object is older than the turn, is neither. → `{ ok: true }` or `{ ok: false, why }`.
 */
export function verifyJob({ by, createdAt, modifiedMs, window }) {
  if (!HERMES_BY.test(String(by ?? ''))) return { ok: false, why: `It was filed as ${String(by ?? 'someone').slice(0, 40) || 'someone'}, not as Hermes. Open it to approve.` };
  const inside = time => Number.isFinite(time) && !!window && time >= window.from - SKEW_MS && time <= window.to + SKEW_MS;
  if (!inside(Date.parse(createdAt)) || !inside(modifiedMs)) return { ok: false, why: 'Its dates do not match this reply, so it may not have been made in it. Open it to approve.' };
  // One tap is for what the reply itself names. A preview can carry text Hermes never chose to say (a fetched page, a card).
  if (window.named === false) return { ok: false, why: 'It was not named in the reply, only in a tool preview. Open it to approve.' };
  return { ok: true };
}

/** The tokens a preset says it costs, in millions: `{ low, high }`, or undefined when its estimate is money or GPU time. */
export function tokensOf(estimate) {
  const text = String(estimate?.cost ?? '');
  const range = /(\d+(?:\.\d+)?)\s*[–-]\s*(\d+(?:\.\d+)?)\s*M tokens/.exec(text);
  if (range) return { low: Number(range[1]), high: Number(range[2]) };
  const single = /about (\d+(?:\.\d+)?)\s*M tokens/.exec(text);
  return single ? { low: Number(single[1]), high: Number(single[1]) } : undefined;
}

const PLACE = /the project's section, or in assistant/;
/**
 * Where a card job's card goes, said as plainly as it is known. `section` is what the Hub chose for the project (the section id), when the
 * caller knows it: then the text names it. Without it the text says what decides it. Text without the placeholder is returned as it is.
 */
export function producesAt(produces, section) {
  if (typeof produces !== 'string' || !PLACE.test(produces)) return produces;
  return produces.replace(PLACE, typeof section === 'string' && section ? section : "the project's section, or in assistant when agents may not write there");
}

/**
 * One row. `item` is the request's list row (state, title, finish...), `request` its request.json (the text), `preset` the preset table's
 * entry, `check` what `jobApproval` said for a proposed one, `verified` what `verifyJob` said, `cardHref` the site path of the card a finished job wrote, `cardSection` the section the Hub chose for its card.
 */
export function jobRow({ item, request, preset, check = null, verified = { ok: false }, persona = null, cardHref, cardSection }) {
  const flagged = !!persona;
  const proposed = item.state === 'proposed';
  const approvable = proposed && !flagged && verified.ok === true && check?.ok === true;
  const why = !proposed ? undefined : flagged ? `${persona.name} is not meant to propose jobs. Open it to decline or approve.` : !verified.ok ? verified.why : check && !check.ok ? check.why : undefined;
  const pr = typeof item.finish?.pr === 'string' && GITHUB_PR.test(item.finish.pr) ? item.finish.pr : undefined;
  const finish = item.finish ? { outcome: item.finish.outcome, ...(pr ? { pr } : {}), ...(item.finish.card ? { card: item.finish.card } : {}), ...(cardHref ? { cardHref } : {}) } : undefined;
  const repo = request?.repo ?? check?.repo;
  const tokens = tokensOf(preset?.estimate);
  return {
    id: item.id, title: item.title, text: String(request?.text ?? '').slice(0, JOB_LIMITS.textShown), project: item.project,
    ...(item.preset ? { preset: item.preset } : {}),
    ...(preset ? { agent: preset.agent, produces: producesAt(preset.produces, cardSection), minutes: preset.minutes, ...(preset.estimate ? { estimate: preset.estimate } : {}), ...(tokens ? { tokens } : {}) } : {}),
    ...(repo ? { repo } : {}), ...(request?.model ? { model: request.model } : {}), ...(request?.doneWhen ? { doneWhen: String(request.doneWhen).slice(0, 400) } : {}),
    ...((check?.target ?? item.target) ? { runsOn: check?.target ?? item.target } : {}),
    state: item.state, ...(item.stale ? { stale: item.stale } : {}),
    approvable, ...(why ? { why } : {}), ...(flagged ? { flag: 'persona' } : {}),
    by: item.by ?? '', writer: String(request?.origin?.name || item.by || '').slice(0, 80), verified: verified.ok === true,
    ...(finish ? { finish } : {}), ...(item.nothing ? { nothing: true } : {}),
  };
}
