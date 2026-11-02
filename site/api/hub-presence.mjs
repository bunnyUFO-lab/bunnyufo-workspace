// The Away switch: `presence.json` at the root of the inbox, `{ v: 1, away, at, until, by }`.
//
// While it says away, hub-hooks on the owner's PC turns a session's single-choice question into a Hub Ask. The file is
// the owner's alone, in two ways: the card API refuses it to every limited token (OWNER_FILES), and it stamps a writer
// mark on anything it does write, which hub-hooks and this module both read as "not the owner's". The Hub writes it
// straight to the bucket with no mark. A switch left on turns itself off: `until` is at most 12 hours ahead.
const HOUR = 60 * 60 * 1000;
export const PRESENCE_FILE = 'presence.json';
export const MAX_AWAY_HOURS = 12;
export const DEFAULT_AWAY_HOURS = 12;

const time = value => { const parsed = typeof value === 'number' ? value : Date.parse(value ?? ''); return Number.isFinite(parsed) ? parsed : null; };

/**
 * What the file says now: away only when it is a v1 file that says `away: true` with an `until` ahead of `at` and at most
 * 12 hours ahead (a longer one was not written by this module). Anything else is "at the PC".
 */
export function presenceView(file, at) {
  const now = at.getTime();
  const until = time(file?.until);
  const away = file?.away === true && until !== null && until > now && until - now <= MAX_AWAY_HOURS * HOUR;
  return { away, until: away ? new Date(until).toISOString() : null, at: typeof file?.at === 'string' ? file.at : null, by: away && typeof file?.by === 'string' ? file.by : null };
}

/** `{ away, hours? }` → `{ away, hours }`, or a 400. `hours` is a whole number from 1 to 12 and counts only when away. */
export function checkPresenceRequest(raw, fail) {
  if (typeof raw?.away !== 'boolean') throw fail('Say away: true or false.');
  if (!raw.away) return { away: false, hours: 0 };
  if (raw.hours === undefined) return { away: true, hours: DEFAULT_AWAY_HOURS };
  if (!Number.isInteger(raw.hours) || raw.hours < 1 || raw.hours > MAX_AWAY_HOURS) throw fail(`hours is a whole number from 1 to ${MAX_AWAY_HOURS}.`);
  return { away: true, hours: raw.hours };
}

/**
 * @param bucket, key  the inbox bucket and its key prefix function
 * @param fail         `fail(message, status)` → an Error with a status
 */
export function createPresence({ bucket, key, fail, log = () => {} }) {
  /** The switch as the page shows it. A file with a writer mark came through the card API: it counts as off. */
  async function view(at) {
    const got = await bucket.getText(key(PRESENCE_FILE)).catch(error => { if (error?.status === 404) return null; throw error; });
    if (!got || got.metadata?.writer) return presenceView(null, at);
    let file = null;
    try { file = JSON.parse(got.text); } catch { log('[hub] presence.json is not JSON; reading it as off'); }
    return presenceView(file, at);
  }

  /** Flip the switch. Turning it off writes an already-expired file, so hub-hooks and the page both read "at the PC". */
  async function set(raw, user, at) {
    if (!user) throw fail('Sign in to change this.', 401);
    const { away, hours } = checkPresenceRequest(raw, fail);
    const until = new Date(at.getTime() + hours * HOUR);
    const file = { v: 1, away, at: at.toISOString(), until: until.toISOString(), by: String(user).slice(0, 120) };
    await bucket.put(key(PRESENCE_FILE), `${JSON.stringify(file, null, 2)}\n`, { contentType: 'application/json', cacheControl: 'no-store' });
    return { status: 200, body: presenceView(file, at) };
  }

  return { view, set };
}
