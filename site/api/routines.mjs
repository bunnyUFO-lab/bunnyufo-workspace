// Cloud routines: firing a repo's Claude Code routine for an approved cloud request, and the record of every
// attempt. The site API is the one process that holds the signing key and the routine tokens, so it fires.
//
// Rules this module keeps (docs/workspaces.md, "Cloud runs"):
//  - The routine gets the request id and nothing else: the body is exactly `{"text":"<id>"}`. The routine
//    fetches the signed approval itself and checks the signature, so the payload holds no instruction to inject.
//  - Every attempt, good or bad, is one create-only file `requests/<id>/fire-<stamp>-<rand4>.json`. A fire that
//    answers 200 and starts nothing can be tried again, so attempts are never overwritten.
//  - The URL and the token never reach a log line, an error message or a file. A log line says `fire <id> -> <status>`.
//  - A day is the owner's day (`HUB_TIME_ZONE`, an IANA name, default UTC); `HUB_CLOUD_DAILY` (default 10) caps
//    the fires that answered ok. A request over the cap is still approved: it waits.
import { createPublicKey } from 'node:crypto';
import { randomId } from './hub-model.mjs';
import { sha256Hex, verify } from './signing.mjs';

/** The routines API's beta header; `HUB_ROUTINE_BETA` overrides it. */
export const ROUTINE_BETA = 'experimental-cc-routine-2026-04-01';
export const ROUTINE_VERSION = '2023-06-01';
export const DEFAULT_DAILY = 10;
export const FIRE_TIMEOUT_MS = 30_000;
/** A fire that answered ok is not retried by hand within this long: the run may be starting. */
export const RETRY_AFTER_MS = 10 * 60_000;

const MIN = 60_000;
const STAMP_RE = /^fire-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z-[a-z0-9]{4}\.json$/;

/** `owner/name` → `NAME` upper-cased with every non-alphanumeric as `_`: the middle of `CLAUDE_ROUTINE_<KEY>_URL`. */
export const repoKey = repo => String(repo ?? '').split('/').pop().toUpperCase().replace(/[^A-Z0-9]/g, '_');

const stampOf = date => date.toISOString().replace(/[-:.]/g, '');

/** The time in a `fire-<stamp>-<rand4>.json` name, or null. */
export function fireFileTime(name) {
  const m = STAMP_RE.exec(name);
  if (!m) return null;
  const time = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.${m[7]}Z`);
  return Number.isNaN(time) ? null : time;
}

/** The time zone to count days in: a valid IANA name, else UTC. */
function zoneOf(name) {
  const wanted = String(name ?? '').trim() || 'UTC';
  try { new Intl.DateTimeFormat('en-CA', { timeZone: wanted }); return wanted; } catch { return 'UTC'; }
}

/** `yyyy-mm-dd` of a date in a zone. */
export function dayIn(date, zone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** The first instant after `date` that falls on another day in the zone: the owner's next midnight. */
export function nextMidnight(date, zone) {
  const today = dayIn(date, zone);
  let low = date.getTime();
  let high = low + 26 * 3600_000;
  while (high - low > 1) {
    const mid = Math.floor((low + high) / 2);
    if (dayIn(new Date(mid), zone) === today) low = mid; else high = mid;
  }
  return new Date(high);
}

/**
 * The routine for a repo, or undefined. The key (the repo's name part) finds it; when the routine names its repo
 * (`CLAUDE_ROUTINE_<KEY>_REPO=owner/name`) the whole `owner/name` must match, so `other/name` cannot borrow it.
 */
export function routineFor(routines, repo) {
  const routine = routines.get(repoKey(repo));
  if (!routine) return undefined;
  return !routine.repo || routine.repo.toLowerCase() === String(repo).toLowerCase() ? routine : undefined;
}

/**
 * The routines the environment names: `CLAUDE_ROUTINE_<KEY>_URL` and `_TOKEN` as a pair, and optionally
 * `_REPO=owner/name`. Returns
 * `{ routines: Map<KEY, { url, token }>, incomplete: string[] }`. `incomplete` holds the key names that have
 * one half only (never a value), so the caller can log them once.
 */
export function loadRoutines(env = {}) {
  const found = new Map();
  for (const [name, value] of Object.entries(env)) {
    const match = /^CLAUDE_ROUTINE_([A-Z0-9_]+)_(URL|TOKEN|REPO)$/.exec(name);
    if (!match) continue;
    const entry = found.get(match[1]) ?? {};
    entry[match[2].toLowerCase()] = String(value ?? '').trim();
    found.set(match[1], entry);
  }
  const routines = new Map();
  const incomplete = [];
  for (const [key, entry] of found) {
    if (entry.url && entry.token) routines.set(key, { url: entry.url, token: entry.token, ...(/^[\w.-]+\/[\w.-]+$/.test(entry.repo ?? '') ? { repo: entry.repo } : {}) });
    else incomplete.push(`CLAUDE_ROUTINE_${key}_${entry.url ? 'TOKEN' : 'URL'}`);
  }
  return { routines, incomplete };
}

/**
 * @param bucket        the s3.mjs bucket (for the stored request.json bytes)
 * @param key           `inboxKey` bound to this hub's prefix and inbox
 * @param requests      `createRequests()`: `loadOne`, `hooks`
 * @param signingKey    the Ed25519 private key; its public half checks every approval before it is fired. Null: nothing is fired
 * @param timing        `{ timeoutMs }` for the fire call
 */
export function createRoutines({ env = {}, fetchImpl = fetch, bucket, key, requests, listFolders, putCreateOnly, cached, fail, signingKey = null, now = () => new Date(), log = () => {}, scrub = text => String(text ?? ''), timing = {} }) {
  const { routines, incomplete } = loadRoutines(env);
  const dryRun = String(env.HUB_ROUTINE_DRY_RUN ?? '').trim() === '1';
  const cap = Math.max(1, Number.parseInt(env.HUB_CLOUD_DAILY, 10) || DEFAULT_DAILY);
  const zone = zoneOf(env.HUB_TIME_ZONE);
  const beta = String(env.HUB_ROUTINE_BETA ?? '').trim() || ROUTINE_BETA;
  const timeoutMs = timing.timeoutMs ?? FIRE_TIMEOUT_MS;
  const publicKey = signingKey ? createPublicKey(signingKey) : null;
  for (const [name, routine] of routines) if (!routine.repo) log(`[hub] CLAUDE_ROUTINE_${name}_REPO is not set: the routine matches on the repo name alone`);
  for (const name of incomplete) log(`[hub] ${name} is set without its pair; that routine is ignored`);
  if (dryRun && routines.size) log('[hub] Cloud routine dry run is on (HUB_ROUTINE_DRY_RUN): nothing is fired, whatever routine keys are set');

  const hasRoutine = repo => dryRun || (!!repo && !!routineFor(routines, repo));
  const keys = () => [...routines.keys()];

  /** One POST to the routine's Fire URL. Never throws; never puts the URL, the token or a header in its answer. */
  async function fire({ repo, requestId }) {
    if (dryRun) return { ok: true, status: 0, dryRun: true };
    const routine = routineFor(routines, repo);
    if (!routine) return { ok: false, status: 0, reason: 'no-routine' };
    try {
      const response = await fetchImpl(routine.url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${routine.token}`, 'anthropic-beta': beta, 'anthropic-version': ROUTINE_VERSION, 'Content-Type': 'application/json',
        },
        body: JSON.stringify({ text: requestId }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const status = response.status;
      let body = null;
      try { body = await response.json(); } catch { /* an empty or odd body is fine */ }
      if (!response.ok) return { ok: false, status, reason: `http-${status}` };
      const session = typeof body?.claude_code_session_url === 'string' ? body.claude_code_session_url : undefined;
      const sessionId = typeof body?.claude_code_session_id === 'string' ? body.claude_code_session_id : undefined;
      return { ok: true, status, ...(session ? { session } : {}), ...(sessionId ? { sessionId } : {}) };
    } catch (error) {
      return { ok: false, status: 0, reason: error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'timeout' : 'network' };
    }
  }

  /** Write one attempt: `fire-<stamp>-<rand4>.json`, create-only. Returns the record. */
  async function recordFire(id, result, { repo, by = 'hub', at = now() } = {}) {
    const record = {
      v: 1, at: at.toISOString(), routine: repoKey(repo), ok: result.ok === true, status: result.status ?? 0,
      ...(result.session ? { session: result.session } : {}), ...(result.sessionId ? { sessionId: result.sessionId } : {}),
      ...(result.reason ? { reason: result.reason } : {}), ...(result.dryRun ? { dryRun: true } : {}), by,
    };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const conflict = fail('Could not record the fire; try again.', 409);
      try {
        await putCreateOnly(`requests/${id}/fire-${stampOf(at)}-${randomId(4)}.json`, `${JSON.stringify(record, null, 2)}\n`, 'application/json', conflict);
        return record;
      } catch (error) {
        if (error !== conflict || attempt === 2) throw error;
      }
    }
    return record;
  }

  /** The fires that answered ok on the owner's day of `at`, across all requests. */
  async function firesToday(at = now()) {
    const today = dayIn(at, zone);
    const folders = await listFolders('requests', at);
    const todays = [];
    for (const [id, names] of folders) {
      for (const name of names) {
        const time = fireFileTime(name);
        if (time !== null && dayIn(new Date(time), zone) === today) todays.push(`requests/${id}/${name}`);
      }
    }
    const bodies = await Promise.all(todays.map(rel => cached(rel)));
    return bodies.filter(body => body && body.ok === true).length;
  }

  /** `{ under, used, cap, next }`: whether another fire fits today, and when the count resets. */
  async function capacity(at = now()) {
    const used = await firesToday(at);
    return { under: used < cap, used, cap, next: nextMidnight(at, zone).toISOString() };
  }

  /**
   * An approval is good to fire when its signature is the server's own, `requestSha256` is the hash of the
   * stored request.json bytes, it names this request and the cloud, and it has not expired.
   * Returns `{ ok: true, approved }` or `{ ok: false, reason }`.
   */
  async function verifyApproval(id, at = now()) {
    if (!publicKey) return { ok: false, reason: 'no signing key' };
    const approved = await cached(`requests/${id}/approved.json`);
    if (!approved) return { ok: false, reason: 'no approval' };
    if (!verify(approved, publicKey)) return { ok: false, reason: 'bad signature' };
    if (approved.request !== id) return { ok: false, reason: 'names another request' };
    if (approved.target !== 'cloud') return { ok: false, reason: 'not a cloud approval' };
    if (!(Date.parse(approved.expires) > at.getTime())) return { ok: false, reason: 'expired' };
    const stored = await bucket.getBytes(key(`requests/${id}/request.json`)).catch(() => null);
    if (!stored) return { ok: false, reason: 'no request' };
    if (sha256Hex(stored.buffer) !== approved.requestSha256) return { ok: false, reason: 'request changed' };
    return { ok: true, approved };
  }

  // Fires are serialised so the daily count is read against a stable picture.
  let chain = Promise.resolve();
  const exclusive = fn => { const result = chain.then(fn); chain = result.catch(() => {}); return result; };

  /** Fire a verified request now and record it. The caller has checked the cap. */
  async function fireAndRecord(id, approved, by, at) {
    const result = await fire({ repo: approved.repo, requestId: id });
    log(`[hub] fire ${id} -> ${result.dryRun ? 'dry-run' : result.status || result.reason}`);
    const record = await recordFire(id, result, { repo: approved.repo, by, at });
    return { result, record };
  }

  /**
   * Called by the approve route after `approved.json` is written. Fires when today's count is under the cap;
   * otherwise records nothing and says the request waits. Never throws for a fire that failed: the approval stands.
   * Returns `{ fired, reason?, next?, waiting? }`.
   */
  const handOff = (id, { at = now() } = {}) => exclusive(async () => {
    const checked = await verifyApproval(id, at);
    if (!checked.ok) return { fired: false, reason: 'check-failed', waiting: `The approval failed the server's check (${checked.reason}).` };
    const room = await capacity(at);
    if (!room.under) return { fired: false, reason: 'daily-cap', next: room.next, waiting: 'The daily limit for cloud runs is used.' };
    const { result } = await fireAndRecord(id, checked.approved, 'hub', at);
    if (result.ok) return { fired: true };
    return { fired: false, reason: result.reason, waiting: `The cloud routine did not start (${result.reason}). Retry.` };
  });

  /** `POST /hub/requests/:id/fire`: Retry. */
  const retry = (id, user, at = now()) => exclusive(async () => {
    const { state, names, parts } = await requests.loadOne(id, at);
    if (state !== 'approved' || parts.approved?.target !== 'cloud') throw fail(`That request is ${state}${parts.approved ? ` on ${parts.approved.target}` : ''}; only an approved cloud request can be fired.`, 409);
    const fires = [];
    for (const name of names) if (fireFileTime(name) !== null) fires.push(name);
    const bodies = (await Promise.all(fires.sort().reverse().slice(0, 20).map(name => cached(`requests/${id}/${name}`)))).filter(Boolean);
    const newestOk = bodies.find(body => body.ok === true);
    if (newestOk) {
      const age = at.getTime() - Date.parse(newestOk.at);
      if (age < RETRY_AFTER_MS) throw fail(`It was fired ${Math.max(0, Math.floor(age / MIN))} min ago; wait for it to start.`, 409);
    }
    const room = await capacity(at);
    if (!room.under) throw fail(`Today's ${room.cap} cloud runs are used; it can fire after ${room.next}.`, 409);
    const checked = await verifyApproval(id, at);
    if (!checked.ok) throw fail('This approval failed the server\'s check.', 409);
    const { result, record } = await fireAndRecord(id, checked.approved, 'hub', at);
    return { status: 200, body: { fired: result.ok === true, ...(result.ok ? {} : { reason: result.reason }), fire: record } };
  });

  requests.hooks.handOff.cloud = handOff;
  requests.hooks.retryFire = retry;

  return {
    dryRun, cap, zone, hasRoutine, keys, fire, recordFire, firesToday, capacity, verifyApproval, handOff, retry, exclusive,
    /** The repo keys that have a routine (never URLs). */
    cloudRepos: () => keys(),
  };
}
