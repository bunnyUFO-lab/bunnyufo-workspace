// Wake the PC: telling "asleep" from "off", and the one call that asks the home controller to wake it.
//
// The status file the PC writes about once a minute is the only probe: nothing here reaches into the PC. A wake is a
// record, `pc/wake-<stamp>.json` `{ at, by }`, written after the controller took the call. The URL it is sent to
// (`HUB_WAKE_URL`) is a secret: it is never put in a response, a log line, an error or a file.
import { markStamp, randomId } from './hub-model.mjs';

const MIN = 60 * 1000;
/** The report posts at least every 10 minutes; a status newer than this means the PC is on. */
export const AWAKE_MS = 12 * MIN;
/** How long a wake gets to show up as a new status before the PC counts as off. */
export const WAKING_MS = 5 * MIN;
/** After a wake that never showed a status, "off" is said for this long, then it is "asleep or off" again. */
export const OFF_MS = 60 * MIN;
/** A fresh status right after a wake is "woke" for this long. */
export const WOKE_MS = 30 * MIN;
/** At most one wake in this time. */
export const WAKE_GAP_MS = MIN;
export const WAKE_TIMEOUT_MS = 10 * 1000;

const time = value => { const parsed = typeof value === 'number' ? value : Date.parse(value ?? ''); return Number.isFinite(parsed) ? parsed : null; };

/**
 * The state of the PC from the newest status time and the newest wake time (Dates, ISO strings, ms or null), and the clock.
 *   awake         a status in the last 12 minutes
 *   woke          the same, when it is newer than a wake from the last 30 minutes (shown as awake)
 *   asleep-or-off older than that, and no wake since
 *   waking        a wake under 5 minutes old and no status since it
 *   off           a wake 5 minutes or more old (under an hour) and no status since it
 */
export function wakeState({ statusAt = null, wakeAt = null, now }) {
  const clock = time(now);
  const status = time(statusAt);
  const wake = time(wakeAt);
  const sinceWake = wake !== null && (status === null || status <= wake);
  if (status !== null && clock - status <= AWAKE_MS) return wake !== null && status > wake && clock - wake <= WOKE_MS ? 'woke' : 'awake';
  if (sinceWake && clock - wake < WAKING_MS) return 'waking';
  if (sinceWake && clock - wake < OFF_MS) return 'off';
  return 'asleep-or-off';
}

/** The states the screens offer the "Wake the PC" button in. */
export const canWake = state => state === 'asleep-or-off' || state === 'off';

/**
 * @param env        `HUB_WAKE_URL` (unset: no wake, the kill switch) and `HUB_WAKE_ON_APPROVE` (`1`: wake when a PC request is approved)
 * @param fetchImpl  `fetch`
 * @param bucket, key  the inbox bucket and its key prefix function (`key('pc/x')`)
 */
export function createWake({ env = {}, fetchImpl = fetch, bucket, key, fail, log = () => {}, timeoutMs = WAKE_TIMEOUT_MS }) {
  const url = String(env.HUB_WAKE_URL ?? '').trim();
  const onApprove = String(env.HUB_WAKE_ON_APPROVE ?? '').trim() === '1';
  const available = url !== '';
  let lastAt = 0; // this process's own gap guard, so two calls at once send one

  /** The newest wake record's time (ms) from the last two hours of names, or null. */
  async function latestWake(at) {
    const hour = date => markStamp(date).slice(0, 11);
    const names = [];
    for (const prefix of new Set([hour(new Date(at.getTime() - 60 * MIN)), hour(at)])) {
      const { objects } = await bucket.list(key(`pc/wake-${prefix}`));
      for (const object of objects) {
        const name = object.key.slice(key('pc/x').length - 1);
        const stamp = /^wake-(\d{8}T\d{9}Z)-[a-z0-9]{4}\.json$/.exec(name)?.[1];
        if (stamp) names.push(stamp);
      }
    }
    const newest = names.sort().at(-1);
    if (!newest) return null;
    const iso = `${newest.slice(0, 4)}-${newest.slice(4, 6)}-${newest.slice(6, 8)}T${newest.slice(9, 11)}:${newest.slice(11, 13)}:${newest.slice(13, 15)}.${newest.slice(15, 18)}Z`;
    return time(iso);
  }

  /** `{ state, wakeAvailable }` for the screens, from the newest status (or null) and the clock. */
  async function view(status, at) {
    const wakeAt = await latestWake(at).catch(() => null);
    return { state: wakeState({ statusAt: status?.at ?? null, wakeAt, now: at }), wakeAvailable: available };
  }

  /**
   * Send one wake. Throws a 404 when unset, a 429 inside the gap, a 502 when the controller did not take it. Writes the record after it did.
   * The answer never holds the URL.
   */
  async function send({ by, at }) {
    if (!available) throw fail('Not found', 404);
    const recent = await latestWake(at).catch(() => null);
    if (at.getTime() - lastAt < WAKE_GAP_MS || (recent !== null && at.getTime() - recent < WAKE_GAP_MS)) throw fail('The PC was asked to wake a moment ago. Wait a minute.', 429);
    lastAt = at.getTime();
    let ok = false;
    try {
      const answered = await fetchImpl(url, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
      ok = answered.status >= 200 && answered.status < 300;
      if (!ok) log(`[hub] the wake call answered ${answered.status}`);
    } catch (error) {
      log(`[hub] the wake call failed: ${error?.name ?? 'error'}`);
    }
    if (!ok) throw fail('The wake did not go through.', 502);
    const body = `${JSON.stringify({ at: at.toISOString(), by: by ?? 'hub' }, null, 2)}\n`;
    await bucket.put(key(`pc/wake-${markStamp(at)}-${randomId(4)}.json`), body, { contentType: 'application/json', ifNoneMatch: '*' }).catch(error => log(`[hub] the wake record was not written: ${error?.name ?? 'error'}`));
    return { status: 201, body: { sent: true, at: at.toISOString() } };
  }

  /**
   * Wake on Approve of a PC request: only with `HUB_WAKE_ON_APPROVE=1`, only when the PC reads as asleep or off, never throws.
   * → true when a wake was sent.
   */
  async function onApproval({ status, by, at }) {
    if (!available || !onApprove) return false;
    try {
      const state = (await view(status, at)).state;
      if (state !== 'asleep-or-off') return false;
      await send({ by, at });
      return true;
    } catch (error) {
      log(`[hub] wake on approve skipped: ${error?.status ?? 'error'}`);
      return false;
    }
  }

  return { available, onApprove, view, send, onApproval, latestWake };
}
