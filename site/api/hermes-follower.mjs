// Followers: one in-process task per Hermes run that reads its events from the start, keeps the last 500 for
// anyone watching, and calls back when the run ends. It does not know what a request is: `onEvent` and `onEnd`
// are the caller's. Where Hermes drops the event buffer (a few minutes after the last reader) it falls back to
// polling the run's status, which Hermes keeps. Only a 404 on the status means the run is unknown.

export const END_EVENTS = new Set(['run.completed', 'run.failed', 'run.cancelled', 'run.interrupted']);
export const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
const BUFFER = 500;

/**
 * @param runs       a `createHermesRuns()`
 * @param onEvent    `(follower, { seq, event, data }) => void|Promise`: called for every event, in order, and for an
 *                   approval found by polling (as an `approval.request`)
 * @param onEnd      `(follower, { run, unknown }) => void|Promise`: the run ended (`run` is its final status) or Hermes
 *                   no longer knows it (`unknown: true`). The follower is finished afterwards
 * @param timing     `reopenMs` between re-opens of a dropped stream (60 s), `pollMs` between status polls (30 s),
 *                   `backoffMs`/`backoffMaxMs` when Hermes is unreachable (1 min, doubling to 10), `tickMs` for the
 *                   time-limit check (15 s), `failuresBeforePoll` (10)
 */
export function createFollowers({ runs, onEvent = async () => {}, onEnd = async () => {}, log = () => {}, now = () => new Date(), timing = {}, sleep = ms => new Promise(resolve => { const timer = setTimeout(resolve, ms); timer.unref?.(); }) }) {
  const t = { reopenMs: 60_000, pollMs: 30_000, backoffMs: 60_000, backoffMaxMs: 600_000, tickMs: 15_000, failuresBeforePoll: 10, ...timing };
  const followers = new Map(); // run id -> follower
  // A nap that stopAll() cuts short.
  const nap = (follower, ms) => Promise.race([sleep(ms), new Promise(resolve => follower.abort.signal.addEventListener('abort', resolve, { once: true }))]);

  /**
   * `follow(context, runId, { since, limitAt })`: `context` is the caller's own object (the request id, whether this
   * is the retry); `limitAt` is a Date after which the follower stops the run and marks it `timedOut`.
   */
  function follow(context, runId, { since = -1, limitAt = null } = {}) {
    if (followers.has(runId)) return followers.get(runId);
    const follower = {
      context, runId, lastSeq: since, events: [], listeners: new Set(), ended: false, timedOut: false, stopped: false, abort: new AbortController(),
      seenControls: new Set(), done: null, stopSent: false, stopping: false,
    };
    followers.set(runId, follower);
    follower.done = loop(follower, limitAt).catch(error => log(`[hermes] follower for ${runId} failed: ${error.message}`)).finally(() => {
      follower.ended = true;
      for (const listener of [...follower.listeners]) listener(null);
      follower.listeners.clear();
      followers.delete(runId);
    });
    return follower;
  }

  const publish = (follower, entry) => {
    follower.events.push(entry);
    while (follower.events.length > BUFFER) follower.events.shift();
    for (const listener of [...follower.listeners]) listener(entry);
  };

  async function loop(follower, limitAt) {
    const { runId } = follower;
    // At the time limit the run is stopped, and the stop is sent again on every tick until Hermes takes it or the run ends:
    // a stop that failed once (Hermes unreachable, a 5xx) must not leave the run without a limit.
    const ticker = limitAt ? setInterval(() => {
      if (follower.ended || follower.stopSent || follower.stopping || now().getTime() < limitAt.getTime()) return;
      follower.timedOut = true;
      follower.stopping = true;
      runs.stop(runId).then(() => { follower.stopSent = true; }, error => log(`[hermes] could not stop ${runId} at its time limit, will retry: ${error.message}`)).finally(() => { follower.stopping = false; });
    }, t.tickMs) : null;
    ticker?.unref?.();
    let failures = 0;
    let delay = t.backoffMs;
    let bufferGone = false;
    try {
      while (!follower.stopped) {
        let view = null;
        let reached = false;
        if (!bufferGone && failures < t.failuresBeforePoll) {
          try {
            for await (const entry of runs.events(runId, { since: follower.lastSeq < 0 ? undefined : follower.lastSeq, signal: follower.abort.signal })) {
              failures = 0;
              delay = t.backoffMs;
              if (Number.isInteger(entry.seq)) follower.lastSeq = entry.seq;
              publish(follower, entry);
              await onEvent(follower, entry);
              if (END_EVENTS.has(entry.event)) { reached = true; break; }
            }
          } catch (error) {
            if (follower.stopped) return;
            if (error.status === 404) bufferGone = true;
            else failures += 1;
            if (error.code === 'unreachable' || error.code === 'not_configured') {
              await nap(follower, delay);
              delay = Math.min(delay * 2, t.backoffMaxMs);
              continue;
            }
          }
        }
        // The stream ended, dropped or was never there: the run's status says which.
        try {
          view = await runs.get(runId);
        } catch (error) {
          if (follower.stopped) return;
          log(`[hermes] Hermes did not answer for ${runId}: ${error.message}`);
          await nap(follower, delay);
          delay = Math.min(delay * 2, t.backoffMaxMs);
          continue;
        }
        delay = t.backoffMs;
        if (!view) { await onEnd(follower, { unknown: true }); return; }
        if (TERMINAL.has(view.status)) { await onEnd(follower, { run: view }); return; }
        if (reached) { await nap(follower, t.pollMs); continue; } // an end event the status has not caught up with yet
        for (const control of view.pending_controls ?? []) {
          const id = control.prompt_id ?? control.request_id;
          if (!id || follower.seenControls.has(id)) continue;
          follower.seenControls.add(id);
          await onEvent(follower, { seq: null, event: 'approval.request', data: { ...control, event: 'approval.request' }, polled: true });
        }
        await nap(follower, bufferGone || failures >= t.failuresBeforePoll ? t.pollMs : t.reopenMs);
      }
    } finally {
      if (ticker) clearInterval(ticker);
    }
  }

  return {
    follow,
    /** Replays the buffered events, then the live ones; `listener(null)` says the follower ended. Returns an unsubscribe. */
    subscribe(runId, listener) {
      const follower = followers.get(runId);
      if (!follower) return null;
      for (const entry of follower.events) listener(entry);
      follower.listeners.add(listener);
      return () => follower.listeners.delete(listener);
    },
    isLive: runId => followers.has(runId),
    get: runId => followers.get(runId) ?? null,
    count: () => followers.size,
    /** Ends every follower without writing anything (shutdown, tests). */
    async stopAll() {
      const all = [...followers.values()];
      for (const follower of all) { follower.stopped = true; follower.abort.abort(); }
      await Promise.all(all.map(follower => follower.done));
    },
  };
}
