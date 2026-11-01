// Which plans are paused by a usage limit right now, read from what the site already saw (never from a call to a provider).
//
// Two kinds of evidence, both about a quota failure Hermes reported (a 429 or "quota" in the run's error, `isQuotaError`):
//   - a request run: a Hermes request whose first run (no model named, so Hermes's own default chain, which starts on Codex)
//     failed on quota is retried once on Anthropic, and the retry is recorded in `requests/<id>/hermes-retry.json` (`at` = the failure,
//     `until` when the error carried a reset time). That file is durable and is the only record of such a failure.
//   - a chat turn: a Hermes run that failed on quota is noted here in memory, for the provider the owner picked, or Codex on Auto.
//     It is lost on a restart; the hour below would have run out soon anyway.
// The cloud "usage pause" (routines.mjs) is a different plan: Claude cloud runs. It never says anything about a chat model.
//
// A pause ends when its reset time passes. When Hermes did not report one, the pause lasts PAUSE_MS from the failure. One hour is the
// same window the cloud queue already uses; Codex's real windows are longer (hours, a week), but a wrong guess here only costs a
// default on the next model for an hour, and an owner who picks the paused model by hand is not stopped. A failure on the paused
// model again simply starts the next hour.
import { isQuotaError } from './run-outcome.mjs';

export const PAUSE_MS = 60 * 60_000;
/** A reset time further away than this is not believed (a parse of something else). */
export const MAX_RESET_MS = 8 * 24 * 3600_000;
/** Hermes main's own primary: the provider a default-chain run fails on. */
export const DEFAULT_PROVIDER = 'openai-codex';
const READ_TTL_MS = 20_000;
const MAX_REQUESTS = 12;

const UNIT_MS = { d: 86400_000, h: 3600_000, m: 60_000 };
const ISO = /(?:until|resets?(?:\s+at)?|try\s+again\s+at|available\s+(?:again\s+)?at)\W{0,3}(\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)/i;
const IN = /(?:try\s+again|retry|resets?|available\s+again|renews?)\s+in\s+((?:\d+\s*(?:days?|d|hours?|hrs?|h|minutes?|mins?|m)\b[\s,]*(?:and\s+)?)+)/i;

/** The reset time an error text names ("try again in 3 hours 12 minutes", "resets at 2026-11-01T14:20:00Z") as an ISO string, or null. */
export function resetOf(error, at) {
  const text = String(error ?? '');
  const base = at instanceof Date ? at.getTime() : new Date(at).getTime();
  let when = null;
  const iso = ISO.exec(text);
  if (iso) when = new Date(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(iso[1]) ? iso[1] : `${iso[1]}Z`).getTime();
  else {
    const relative = IN.exec(text);
    if (relative) {
      let total = 0;
      for (const [, count, unit] of relative[1].matchAll(/(\d+)\s*(days?|d|hours?|hrs?|h|minutes?|mins?|m)\b/gi)) total += Number(count) * UNIT_MS[unit[0].toLowerCase()];
      when = total > 0 ? base + total : null;
    }
  }
  return Number.isFinite(when) && when > base && when - base <= MAX_RESET_MS ? new Date(when).toISOString() : null;
}

/**
 * The live pauses from pieces of evidence `{ provider, seen, until? }`: the newest evidence per provider decides, a pause ends at its
 * `until` (reported) or PAUSE_MS after it was seen, and one that has ended is dropped. Newest first by `seen`.
 */
export function pausesFrom(evidence, at) {
  const nowMs = at instanceof Date ? at.getTime() : new Date(at).getTime();
  const newest = new Map();
  for (const entry of evidence) {
    const seen = new Date(entry?.seen).getTime();
    if (!entry?.provider || !Number.isFinite(seen) || seen > nowMs + 5 * 60_000) continue;
    if (!newest.has(entry.provider) || seen > new Date(newest.get(entry.provider).seen).getTime()) newest.set(entry.provider, entry);
  }
  const out = [];
  for (const { provider, seen, until } of newest.values()) {
    const seenMs = new Date(seen).getTime();
    const reportedMs = until ? new Date(until).getTime() : NaN;   // a reset time further than MAX_RESET_MS from when it was seen is not believed, as on the write side
    const reported = Number.isFinite(reportedMs) && reportedMs > seenMs && reportedMs - seenMs <= MAX_RESET_MS ? new Date(reportedMs).toISOString() : null;
    const ends = reported ? new Date(reported).getTime() : new Date(seen).getTime() + PAUSE_MS;
    if (ends <= nowMs) continue;
    out.push({ provider, seen: new Date(seen).toISOString(), until: new Date(ends).toISOString(), reported: reported !== null });
  }
  return out.sort((a, b) => (a.seen < b.seen ? 1 : -1));
}

/** `listFolders('requests', at)` and `cached(rel)` are the Hub's own (hub.mjs); both read the inbox bucket only. */
export function createPlanPauses({ listFolders, cached, now = () => new Date(), log = () => {} }) {
  const noted = new Map();   // provider → { provider, seen, until }
  let memo = null;   // { at, rows }

  /** A chat turn failed with `error` on `provider`: remember it. Anything that is not a quota failure is ignored. */
  function note(provider, error, at = now()) {
    if (!provider || !isQuotaError(error)) return false;
    noted.set(provider, { provider, seen: at.toISOString(), until: resetOf(error, at) });
    return true;
  }

  async function fromRequests(at) {
    const evidence = [];
    const folders = await listFolders('requests', at);
    const ids = [...folders].filter(([, names]) => names.has('hermes-retry.json')).map(([id]) => id).sort().reverse().slice(0, MAX_REQUESTS);   // ids start with the day
    for (const id of ids) {
      const retry = await cached(`requests/${id}/hermes-retry.json`).catch(() => null);
      if (retry && typeof retry.at === 'string' && retry.reason === 'quota') evidence.push({ provider: DEFAULT_PROVIDER, seen: retry.at, until: typeof retry.until === 'string' ? retry.until : null });
    }
    return evidence;
  }

  /** The live pauses now. A read that fails is no pause, never an error. Kept for a few seconds: the Chat page asks on every open. */
  async function read(at = now()) {
    if (memo && at.getTime() - memo.at < READ_TTL_MS && at.getTime() >= memo.at) return pausesFrom([...memo.requests, ...noted.values()], at);
    let requests = memo?.requests ?? [];
    try { requests = await fromRequests(at); } catch (error) { log(`[chat] could not read the plan pauses: ${error.message}`); }
    memo = { at: at.getTime(), requests };
    return pausesFrom([...requests, ...noted.values()], at);
  }

  return { note, read };
}

/** What the page may see: per model id (a provider's pause is every model on it), no provider name. `models` is the chat-models table. */
export const pausesForClient = (pauses, models) => pauses.flatMap(pause => models.filter(model => model.provider === pause.provider).map(model => ({ model: model.id, seen: pause.seen, until: pause.until, reported: pause.reported })));
