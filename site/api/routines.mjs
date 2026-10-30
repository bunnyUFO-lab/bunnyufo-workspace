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
/** An ok fire with no taken.json and no result.json after this long is "fired, not started". */
export const NOT_STARTED_MS = 20 * 60_000;
/** A 429 from the Fire URL, or a run that ended on a usage limit, pauses every cloud fire for this long. */
export const PAUSE_MS = 60 * 60_000;
/** Automatic retries of a fire that failed: this many minutes after the previous attempt. Then it stops and shows Retry. */
export const RETRY_BACKOFF_MIN = [5, 15, 45];
export const SWEEP_MS = 5 * 60_000;

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

/**
 * What to do next about a request with no ok fire, from its fire records (newest first). Pure.
 * A 429 is not a failure of the fire: it pauses the queue and costs no retry. Any other failure is retried
 * 5, 15 and 45 minutes after the one before it, then the request stops and shows Retry; a 4xx other than 429
 * is a configuration fault and stops at once.
 * Returns `{ go: true }`, `{ wait: true, next }` or `{ stop: true, reason }`.
 */
export function retryPlan(fires, at) {
  const failures = fires.filter(fire => fire && fire.ok === false && fire.status !== 429);
  const newest = failures[0];
  if (!newest) return { go: true };
  if (newest.reason === 'routine-repo-unset') return { stop: true, reason: newest.reason };
  if (newest.status >= 400 && newest.status < 500) return { stop: true, reason: newest.reason ?? `http-${newest.status}` };
  if (failures.length > RETRY_BACKOFF_MIN.length) return { stop: true, reason: newest.reason ?? 'failed' };
  const due = Date.parse(newest.at) + RETRY_BACKOFF_MIN[failures.length - 1] * 60_000;
  return due <= at.getTime() ? { go: true } : { wait: true, next: new Date(due).toISOString() };
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
 * A routine without `_REPO` is found but never fired (`routineUnbound`).
 */
export function routineFor(routines, repo) {
  const routine = routines.get(repoKey(repo));
  if (!routine) return undefined;
  return !routine.repo || routine.repo.toLowerCase() === String(repo).toLowerCase() ? routine : undefined;
}

/** True when a routine has no `_REPO`: it is never fired (fail closed), because the key alone is only the repo's name part. */
export const routineUnbound = routine => !routine.repo;

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
  for (const [name, routine] of routines) if (!routine.repo) log(`[hub] CLAUDE_ROUTINE_${name}_REPO is not set: that routine is refused until it is`);
  for (const name of incomplete) log(`[hub] ${name} is set without its pair; that routine is ignored`);
  if (dryRun && routines.size) log('[hub] Cloud routine dry run is on (HUB_ROUTINE_DRY_RUN): nothing is fired, whatever routine keys are set');

  // The queue's memory. A restart forgets the pause; the next 429 sets it again and costs one fire attempt.
  let pausedUntil = 0;
  let refused = new Map(); // request id -> { ts, project, title }: approvals the server's check refused
  let capacityMemo = null;
  const paused = at => pausedUntil > at.getTime();

  const hasRoutine = repo => dryRun || (!!repo && !!routineFor(routines, repo));
  const keys = () => [...routines.keys()];

  /** One POST to the routine's Fire URL. Never throws; never puts the URL, the token or a header in its answer. */
  async function fire({ repo, requestId }) {
    if (dryRun) return { ok: true, status: 0, dryRun: true };
    const routine = routineFor(routines, repo);
    if (!routine) return { ok: false, status: 0, reason: 'no-routine' };
    if (routineUnbound(routine)) {
      log(`[hub] not fired: CLAUDE_ROUTINE_${repoKey(repo)}_REPO is not set, so the routine is refused (set it to owner/name)`);
      return { ok: false, status: 0, reason: 'routine-repo-unset' };
    }
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
  async function capacity(at = now(), { memo = false } = {}) {
    if (memo && capacityMemo && capacityMemo.at === at.getTime() && Date.now() - capacityMemo.made < 5000) return capacityMemo.value;
    const used = await firesToday(at);
    const value = { under: used < cap, used, cap, next: nextMidnight(at, zone).toISOString() };
    capacityMemo = { at: at.getTime(), made: Date.now(), value };
    return value;
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
    capacityMemo = null;
    if (result.status === 429) pausedUntil = Math.max(pausedUntil, at.getTime() + PAUSE_MS);
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
    // Another fire may have got in while this waited for the lock (a sweep, Retry): never fire twice.
    if ((await readFires(id, await freshNames(id))).some(fire => fire.ok === true)) return { fired: true };
    const limited = { fired: false, reason: 'usage-limit', waiting: 'Cloud runs are paused on a usage limit.' };
    if (paused(at)) return { ...limited, next: new Date(pausedUntil).toISOString() };
    const { result } = await fireAndRecord(id, checked.approved, 'hub', at);
    if (result.ok) return { fired: true };
    if (result.status === 429) return { ...limited, next: new Date(pausedUntil).toISOString() };
    return { fired: false, reason: result.reason, waiting: `The cloud routine did not start (${result.reason}). Retry.` };
  });

  /** The file names in `requests/<id>/` right now (a fresh listing, never the sweep's earlier one). */
  async function freshNames(id) {
    const base = key(`requests/${id}/x`).slice(0, -1);
    const { objects } = await bucket.list(base);
    return new Set(objects.map(object => object.key.slice(base.length)).filter(name => name && !name.includes('/')));
  }

  /** The newest `limit` fire records of a request, newest first. */
  async function readFires(id, names, limit = 20) {
    const picked = [...names].filter(name => fireFileTime(name) !== null).sort().reverse().slice(0, limit);
    return (await Promise.all(picked.map(name => cached(`requests/${id}/${name}`)))).filter(Boolean);
  }

  /** `POST /hub/requests/:id/fire`: Retry. */
  const retry = (id, user, at = now()) => exclusive(async () => {
    const { state, names, parts } = await requests.loadOne(id, at);
    if (state !== 'approved' || parts.approved?.target !== 'cloud') throw fail(`That request is ${state}${parts.approved ? ` on ${parts.approved.target}` : ''}; only an approved cloud request can be fired.`, 409);
    const bodies = await readFires(id, names);
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

  /**
   * Where a cloud request stands, for the list row and the detail: `{ status, reason?, next?, fires? }`, or null when
   * the request is not an approved cloud request. `queued` (nothing fired, nothing in the way), `fired`, `waiting`
   * (`daily-cap`, `usage-limit` or `retry`, with `next`), `fire-failed` (stopped; Retry) and `not-started`
   * (an ok fire 20 minutes old and no taken.json or result.json; never re-fired by itself).
   */
  async function cloudStatus(id, { names, state, approved }, at = now(), { withFires = false } = {}) {
    if (state !== 'approved' || approved?.target !== 'cloud') return null;
    const fires = await readFires(id, names);
    const out = status => ({ ...status, ...(withFires ? { fires } : {}) });
    const okFire = fires.find(fire => fire.ok === true);
    if (okFire) {
      const age = at.getTime() - Date.parse(okFire.at);
      return out(age > NOT_STARTED_MS ? { status: 'not-started', since: new Date(Date.parse(okFire.at) + NOT_STARTED_MS).toISOString() } : { status: 'fired' });
    }
    const plan = retryPlan(fires, at);
    if (plan.stop) return out({ status: 'fire-failed', reason: plan.reason });
    if (plan.wait) return out({ status: 'waiting', reason: 'retry', next: plan.next });
    if (paused(at)) return out({ status: 'waiting', reason: 'usage-limit', next: new Date(pausedUntil).toISOString() });
    const room = await capacity(at, { memo: true });
    if (!room.under) return out({ status: 'waiting', reason: 'daily-cap', next: room.next });
    return out({ status: 'queued' });
  }

  /**
   * One pass over every approved cloud request that has not started: verify, then fire the ones that may fire.
   * Candidates are approved, not taken, not stopped or declined, with no result, and no ok fire; oldest approval first.
   * A forged or changed approval writes nothing, is logged and raises a Today alert. Returns what it did.
   */
  async function sweepOnce(at) {
    const done = { fired: [], waiting: [], refused: [] };
    const folders = await listFolders('requests', at);
    const refusedNow = new Map();
    // A run that ended on a usage limit pauses the queue, as a 429 does.
    for (const [id, names] of folders) {
      if (!names.has('result.json') || !names.has('approved.json')) continue;
      const result = await cached(`requests/${id}/result.json`);
      // result.json is the run's own file: a date in the future is ignored, and the pause never outlasts 60 minutes from now.
      const ended = Date.parse(result?.at);
      if (result?.reason === 'usage-limit' && Number.isFinite(ended) && ended <= at.getTime() + 60_000 && ended + PAUSE_MS > at.getTime()) {
        pausedUntil = Math.max(pausedUntil, Math.min(ended + PAUSE_MS, at.getTime() + PAUSE_MS));
      }
    }
    const candidates = [];
    for (const [id, names] of folders) {
      if (!names.has('approved.json')) continue;
      if (['taken.json', 'result.json', 'stop.json', 'declined.json'].some(file => names.has(file))) continue;
      const approved = await cached(`requests/${id}/approved.json`);
      if (!approved || approved.target !== 'cloud') continue;
      candidates.push({ id, names, approved });
    }
    candidates.sort((a, b) => (String(a.approved.at) < String(b.approved.at) ? -1 : String(a.approved.at) > String(b.approved.at) ? 1 : a.id < b.id ? -1 : 1));
    for (const { id, names, approved } of candidates) {
      const fires = await readFires(id, names);
      if (fires.some(fire => fire.ok === true)) continue;
      const checked = await verifyApproval(id, at);
      if (!checked.ok) {
        if (checked.reason === 'expired') continue;
        log(`[hub] skip ${id}: ${checked.reason}`);
        const request = await cached(`requests/${id}/request.json`);
        refusedNow.set(id, { ts: refused.get(id)?.ts ?? at.toISOString(), project: approved.project ?? request?.project, title: String(request?.title ?? request?.text ?? id).replace(/\s+/g, ' ').trim().slice(0, 80) });
        done.refused.push(id);
        continue;
      }
      const plan = retryPlan(fires, at);
      if (!plan.go) { done.waiting.push({ id, reason: plan.stop ? 'fire-failed' : 'retry' }); continue; }
      const outcome = await exclusive(async () => {
        // Look again inside the lock: an approve or Retry that held it has since fired or ended this request.
        const nowNames = await freshNames(id);
        if (['taken.json', 'result.json', 'stop.json', 'declined.json'].some(file => nowNames.has(file))) return { skipped: true };
        const nowFires = await readFires(id, nowNames);
        if (nowFires.some(fire => fire.ok === true)) return { skipped: true };
        if (!retryPlan(nowFires, at).go) return { waiting: 'retry' };
        if (paused(at)) return { waiting: 'usage-limit' };
        const room = await capacity(at);
        if (!room.under) return { waiting: 'daily-cap' };
        const { result } = await fireAndRecord(id, checked.approved, 'sweep', at);
        return result.status === 429 ? { waiting: 'usage-limit' } : { fired: true };
      });
      if (outcome.skipped) continue;
      if (outcome.fired) done.fired.push(id); else done.waiting.push({ id, reason: outcome.waiting });
    }
    refused = refusedNow;
    return done;
  }

  // Sweeps never overlap: a second call while one runs gets the same answer.
  let inflight = null;
  function sweep(at = now()) {
    if (!inflight) inflight = sweepOnce(at).finally(() => { inflight = null; });
    return inflight;
  }

  let timer = null;
  /** Sweep now and every 5 minutes, only when there is something to fire with. Safe to call twice. */
  function start() {
    if (timer || !signingKey || !(routines.size || dryRun)) return;
    const run = () => sweep().catch(error => log(`[hub] cloud sweep failed: ${scrub(error.message, 120)}`));
    run();
    timer = setInterval(run, timing.sweepMs ?? SWEEP_MS);
    timer.unref();
  }
  const close = async () => { if (timer) clearInterval(timer); timer = null; await inflight?.catch(() => {}); };

  requests.hooks.handOff.cloud = handOff;
  requests.hooks.retryFire = retry;
  requests.hooks.cloudStatus = cloudStatus;

  return {
    dryRun, cap, zone, hasRoutine, keys, fire, recordFire, firesToday, capacity, verifyApproval, handOff, retry, exclusive, cloudStatus, sweep, start, close,
    /** Today alerts for approvals the server's check refused, as `kind: alert` rows. */
    alerts: () => [...refused].map(([id, row]) => ({ ts: row.ts, kind: 'alert', source: 'request', request: id, project: row.project, title: `Approval for ${row.title} failed the server's check` })),
    /** The repo keys that have a routine (never URLs). */
    cloudRepos: () => keys(),
  };
}
