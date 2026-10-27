// The Hub's rules, with no I/O: Ask state, what Today and the Inbox show, ids and slugs, and the
// checks on what a request carries. hub.mjs reads the bucket and calls these; the tests call them
// directly. Everything is a function of its arguments (the clock included).

export const ID_RE = /^\d{8}-[a-z0-9-]+-[a-z0-9]{4}$/;
export const DRAWING_ID_RE = /^\d{8}-[a-z0-9]{6}$/;
export const PROJECT_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const WHEN = ['next-sprint', 'nightly', 'record'];
export const DAY = 24 * 60 * 60 * 1000;
export const WINDOW_DAYS = 7;
export const REVIEW_URL_FALLBACK = 'https://claude.ai/code';

export const validId = value => typeof value === 'string' && value.length <= 120 && ID_RE.test(value);
export const validDrawingId = value => typeof value === 'string' && DRAWING_ID_RE.test(value);
export const validProject = value => typeof value === 'string' && PROJECT_RE.test(value);

/** "magic-loops" → "Magic Loops" (the same rule the site API uses for a section without a name). */
export const titleCase = id => String(id).split('-').filter(Boolean).map(word => word[0].toUpperCase() + word.slice(1)).join(' ');

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
export const randomId = (length, random = Math.random) => Array.from({ length }, () => ALPHABET[Math.floor(random() * ALPHABET.length)]).join('');

/** yyyymmdd and yyyymm in UTC. */
export const day8 = date => date.toISOString().slice(0, 10).replace(/-/g, '');
export const month6 = date => day8(date).slice(0, 6);
export const dayDash = date => date.toISOString().slice(0, 10);

/** This month and the one before, as the `asks/<yyyymm>` prefixes to list (UTC). */
export function monthPrefixes(now) {
  const previous = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return [month6(now), month6(previous)];
}

/** The last seven UTC days as `yyyy-mm-dd`, newest first. */
export function windowDays(now, days = WINDOW_DAYS) {
  return Array.from({ length: days }, (_, index) => dayDash(new Date(now.getTime() - index * DAY)));
}

const SKIP_WORDS = new Set(['token', 'secret', 'password', 'credential']);

/** The first five words of a request, lower-cased, minus the ones that look like secrets. */
export function requestSlug(text, limit = 40) {
  const words = String(text ?? '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).filter(word => !SKIP_WORDS.has(word));
  return words.slice(0, 5).join('-').slice(0, limit).replace(/-+$/, '');
}

export function newRequestId(project, text, now, random = Math.random) {
  const slug = requestSlug(text) || 'request';
  return `${day8(now)}-${project}-${slug}-${randomId(4, random)}`.slice(0, 120);
}

export const newDrawingId = (now, random = Math.random) => `${day8(now)}-${randomId(6, random)}`;

/**
 * The Ask's state from the file names in its folder, top to bottom, the first match winning.
 * `snooze` is the body of snooze.json and is only needed when that file is there.
 * → { state: 'cancelled' | 'picked-up' | 'answered' | 'snoozed' | 'expired' | 'open', snoozedUntil? }
 */
export function askState(names, ask, now, snooze = null) {
  const has = name => (names instanceof Set ? names.has(name) : names.includes(name));
  if (has('cancel.json')) return { state: 'cancelled' };
  if (has('pickup.json')) return { state: 'picked-up' };
  if (has('answer.json')) return { state: 'answered' };
  if (has('snooze.json') && snooze?.until && new Date(snooze.until).getTime() > now.getTime()) return { state: 'snoozed', snoozedUntil: snooze.until };
  if (ask?.expiresAt && now.getTime() > new Date(ask.expiresAt).getTime()) return { state: 'expired' };
  return { state: 'open' };
}

export const canAnswer = state => state === 'open' || state === 'snoozed';

/** What a request says about itself plus whether an agent took it. */
export const requestState = names => ((names instanceof Set ? names.has('taken.json') : names.includes('taken.json')) ? 'taken' : 'open');

const clip = (value, length = 160) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, length);

export function askItem(ask, state) {
  return {
    kind: 'ask', id: ask.id, project: ask.project, title: clip(ask.question), at: ask.createdAt, state: state.state,
    ...(ask.bead ? { bead: ask.bead } : {}),
    ...(state.snoozedUntil ? { summary: `Snoozed until ${state.snoozedUntil}` } : {}),
    ...(ask.from?.host ? { host: ask.from.host } : {}),
    ...(ask.from?.session ? { session: ask.from.session } : {}),
  };
}

export function requestItem(request, state, taken) {
  return {
    kind: 'request', id: request.id, project: request.project, title: clip(request.text), at: request.createdAt, state,
    ...(taken?.bead ? { bead: taken.bead } : {}),
    ...(request.by ? { by: request.by } : {}),
  };
}

const byTime = (a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : String(a.file ?? '') < String(b.file ?? '') ? -1 : 1);

/** Events oldest first; the file name breaks ties, since it starts with hhmmss. */
export const chronological = events => [...events].sort(byTime);

const time = ts => {
  const date = new Date(ts);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(11, 16);
};

const eventItem = (kind, event, extra = {}) => ({
  kind, id: event.file, project: event.project, title: event.title, at: event.ts,
  ...(event.bead ? { bead: event.bead } : {}), ...(event.url ? { url: event.url } : {}),
  ...(typeof event.card === 'string' && event.card ? { card: event.card } : {}),
  ...(event.host ? { host: event.host } : {}), ...(event.session ? { session: event.session } : {}),
  ...(event.summary ? { summary: event.summary } : {}), ...extra,
});

/**
 * Reviews, blocked sessions and running sessions from a window of events (any order).
 * - review: `ready-for-review` with no later `pr-merged` for the same bead (the same url when
 *   there is no bead), and that no `review-done` event names (its `review` is the review's file name);
 * - blocked: `blocked` with no later `session-ended` or `session-started` for the same session;
 * - running: `session-started` with no later `session-ended` for the same session.
 */
export function deriveEventItems(events) {
  const ordered = chronological(events);
  const after = (event, test) => ordered.some(other => byTime(event, other) < 0 && test(other));
  const done = new Set(ordered.filter(event => event.kind === 'review-done' && typeof event.review === 'string').map(event => event.review));
  const reviews = [];
  const blocked = [];
  const running = [];
  for (const event of ordered) {
    if (event.kind === 'ready-for-review') {
      const merged = after(event, other => other.kind === 'pr-merged' && (event.bead ? other.bead === event.bead : !!event.url && other.url === event.url));
      if (!merged && !done.has(event.file)) reviews.push(eventItem('review', event));
    } else if (event.kind === 'blocked') {
      const resolved = !!event.session && after(event, other => other.session === event.session && (other.kind === 'session-ended' || other.kind === 'session-started'));
      if (!resolved) blocked.push(eventItem('blocked', event, { id: event.session || event.file, url: event.url || REVIEW_URL_FALLBACK }));
    } else if (event.kind === 'session-started' && event.session) {
      const ended = after(event, other => other.session === event.session && other.kind === 'session-ended');
      if (!ended) running.push(eventItem('session', event, { id: event.session, title: `${event.project || 'session'} · running since ${time(event.ts)}` }));
    }
  }
  const newest = (a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0);
  return { reviews: reviews.sort(newest), blocked: blocked.sort(newest), running: running.sort(newest) };
}

const newest = (a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0);

/** Today's screen from the derived pieces. `events` is the whole window, newest first. */
export function buildToday({ asks, events, now }) {
  const { reviews, blocked, running } = deriveEventItems(events);
  const openAsks = asks.filter(item => item.state === 'open').sort(newest);
  const needsYou = [...openAsks, ...reviews, ...blocked];
  const since = now.getTime() - DAY;
  const recent = events.filter(event => new Date(event.ts).getTime() >= since);
  const alerts = recent.filter(event => event.kind === 'alert');
  return {
    counts: { needsYou: needsYou.length, running: running.length, recent: recent.length, alerts: alerts.length },
    needsYou, running, recent, alerts, at: now.toISOString(),
  };
}

export const REVIEW_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}\.json$/;

/** The `review-done` event that hides one review. `review` is the file name of the `ready-for-review` event, which is `event`. */
export function reviewDone({ review, event, user, at }) {
  return {
    ts: at.toISOString(), kind: 'review-done', review, title: `Done: ${clip(event.title)}`,
    ...(event.project ? { project: event.project } : {}), ...(event.bead ? { bead: event.bead } : {}),
    host: 'hub', source: 'hub', by: user || 'local',
  };
}

export const INBOX_FILTERS = ['needs-you', 'asks', 'reviews', 'requests', 'blocked', 'answered'];

/** The Inbox's list for one filter. */
export function buildInbox({ filter, asks, requests, events, now }) {
  const { reviews, blocked } = deriveEventItems(events);
  switch (filter) {
    case 'asks': return asks.filter(item => item.state !== 'cancelled' && item.state !== 'picked-up').sort(newest);
    case 'reviews': return reviews;
    case 'requests': return [...requests].sort(newest);
    case 'blocked': return blocked;
    case 'answered': return asks.filter(item => item.state === 'answered' || item.state === 'picked-up').sort(newest);
    default: return buildToday({ asks, events, now }).needsYou;
  }
}

/** What a posted answer must hold, checked against the Ask. Throws a 400 with a plain reason. */
export function checkAnswer(ask, data) {
  const fail = message => Object.assign(new Error(message), { status: 400 });
  const { choice, note, drawing } = data ?? {};
  if (choice !== undefined && choice !== null) {
    const options = Array.isArray(ask.options) ? ask.options : [];
    if (typeof choice !== 'string' || (options.length && !options.some(option => option.id === choice)) || (!options.length)) {
      throw fail('That is not one of the options.');
    }
  }
  if (note !== undefined && note !== null) {
    if (typeof note !== 'string' || note.length > 4000) throw fail('A note is text of at most 4000 characters.');
    if (!ask.allowNote) throw fail('This Ask takes no note.');
  }
  if (drawing !== undefined && drawing !== null) {
    if (!ask.allowDrawing) throw fail('This Ask takes no drawing.');
  }
  const has = value => value !== undefined && value !== null && value !== '';
  if (!has(choice) && !has(note) && !has(drawing)) throw fail('Choose an option, write a note or draw something.');
}
