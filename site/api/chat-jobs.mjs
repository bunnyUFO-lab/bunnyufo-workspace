// Jobs in a chat: which of the requests Hermes filed during a turn belong to that turn's reply, and the rows the page shows for them.
// Pure code, no I/O. hub-chat.mjs saves the ids on the assistant line (`jobs`); hub.mjs builds the rows from the request files.
import { ID_RE } from './hub-model.mjs';

export const JOB_LIMITS = { perLine: 6, lines: 40, rows: 24, approve: 6, textShown: 4000 };

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

/**
 * One row. `item` is the request's list row (state, title, finish...), `request` its request.json (the text), `preset` the preset table's
 * entry, `check` what `jobApproval` said for a proposed one, `cardHref` the site path of the card a finished job wrote.
 */
export function jobRow({ item, request, preset, check = null, persona = null, cardHref }) {
  const flagged = !!persona;
  const proposed = item.state === 'proposed';
  const approvable = proposed && !flagged && check?.ok === true;
  const why = flagged && proposed ? `${persona.name} is not meant to propose jobs. Open it to decline or approve.` : proposed && check && !check.ok ? check.why : undefined;
  const finish = item.finish ? { outcome: item.finish.outcome, ...(item.finish.pr ? { pr: item.finish.pr } : {}), ...(item.finish.card ? { card: item.finish.card } : {}), ...(cardHref ? { cardHref } : {}) } : undefined;
  return {
    id: item.id, title: item.title, text: String(request?.text ?? '').slice(0, JOB_LIMITS.textShown), project: item.project,
    ...(item.preset ? { preset: item.preset } : {}),
    ...(preset ? { agent: preset.agent, produces: preset.produces } : {}),
    ...((check?.target ?? item.target) ? { runsOn: check?.target ?? item.target } : {}),
    state: item.state, ...(item.stale ? { stale: item.stale } : {}),
    approvable, ...(why ? { why } : {}), ...(flagged ? { flag: 'persona' } : {}),
    by: item.by ?? '', ...(finish ? { finish } : {}), ...(item.nothing ? { nothing: true } : {}),
  };
}
