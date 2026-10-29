// What a finished Hermes request run means: the one place that turns Hermes's final status into a request's
// `result.json`. A pure function, so the follower, the tests and (later) the question rule share one rule.

const clip = (value, length) => String(value ?? '').slice(0, length);
const flat = (value, length) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, length);

/** `assistant/<folder>` from the last `CARD:` line of the output, or null. */
export function cardOf(output) {
  const matches = [...String(output ?? '').matchAll(/^[ \t]*CARD:[ \t]*(assistant\/[A-Za-z0-9._-]+)[ \t]*$/gm)];
  return matches.length ? matches.at(-1)[1] : null;
}

/**
 * The question a finished run ends with, or null. Only a run's last paragraph counts (after the last blank line), with
 * Markdown emphasis and trailing space removed: it must end in `?` and be at most 600 characters. A `CARD:` line always
 * wins, so callers check `cardOf` first. Chat turns never use this rule.
 */
export function questionOf(output) {
  const text = String(output ?? '').trim();
  if (!text || cardOf(text)) return null;
  const last = text.split(/\r?\n[ \t]*\r?\n/).at(-1) ?? '';
  const plain = last.replace(/[*_`~]+/g, '').replace(/\s+/g, ' ').trim();
  return plain.endsWith('?') && plain.length <= 600 ? plain : null;
}

/** True when a failed run's error reads as the plan's quota running out. */
export const isQuotaError = error => /429|quota/i.test(String(error ?? ''));

/**
 * The `result.json` body for a run that has ended.
 * @param run      Hermes's final view: `{ status, output, usage, runtime, error }`
 * @param stopped  our signed `stop.json` exists
 * @param timedOut the follower stopped it at the time limit
 * @param retried  this is the one retry on Anthropic after a quota failure
 * @param at       an ISO time
 */
export function outcomeOf({ run, stopped = false, timedOut = false, retried = false, at }) {
  const output = String(run.output ?? '');
  const usage = run.usage && Object.keys(run.usage).length ? { ...run.usage, ...(run.runtime?.requested ? { requested: run.runtime.requested } : {}) } : undefined;
  const base = { v: 1, by: 'hub', at, ...(usage ? { usage } : {}) };
  if (timedOut && run.status !== 'completed') return { ...base, outcome: 'failed', reason: 'time-limit', summary: 'The run reached its time limit and was stopped.' };
  if (run.status === 'completed') {
    const card = cardOf(output);
    if (card) return { ...base, outcome: 'card', card, summary: clip(output, 500) };
    const question = questionOf(output);
    if (question) return { ...base, outcome: 'question', question, summary: clip(output, 500) };
    return { ...base, outcome: 'failed', summary: 'Hermes finished without a card.' };
  }
  if (stopped || run.status === 'cancelled') {
    return { ...base, outcome: 'failed', ...(stopped ? { reason: 'stopped' } : {}), summary: stopped ? 'Stopped by you.' : 'Hermes cancelled the run.' };
  }
  if (run.status === 'interrupted') return { ...base, outcome: 'failed', summary: `Hermes interrupted the run${run.error ? `: ${flat(run.error, 300)}` : '.'}` };
  if (isQuotaError(run.error)) return { ...base, outcome: 'failed', reason: 'usage-limit', summary: retried ? 'Codex quota reached; the retry on Anthropic failed too.' : 'Codex quota reached.' };
  return { ...base, outcome: 'failed', summary: `The run failed${run.error ? `: ${flat(run.error, 300)}` : '.'}` };
}

/** The result when Hermes no longer knows the run: points at the newest card it may have made. */
export function unknownOutcome({ card, at }) {
  return {
    v: 1, outcome: 'unknown', reason: 'hermes-forgot', ...(card ? { card } : {}),
    summary: 'Hermes no longer knows this run. Check the card, or Approve again.', by: 'hub', at,
  };
}

/** The result when a run could not be started at all. */
export const startFailedOutcome = ({ reason, at }) => ({ v: 1, outcome: 'failed', reason: 'start-failed', summary: `Hermes did not start: ${flat(reason, 300) || 'no reason given'}`, by: 'hub', at });

/** `report.md` is the run's output, at most 256 KB. */
export const reportOf = output => clip(output, 256 * 1024);
