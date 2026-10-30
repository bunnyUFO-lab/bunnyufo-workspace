// Hermes request runs: what happens between "the owner approved a research request" and "result.json
// names a card". It glues the Hermes client (hermes-runs.mjs), the followers (hermes-follower.mjs) and the
// request files (hub-requests.mjs). The site API follows every run from its start, so a result is written
// even when nobody has the page open, and picks the runs up again after a restart.
//
// Rules this module keeps (docs/workspaces.md, "Requests"):
//  - An ordinary run is started with `{ input }` only: no provider, no model, so Hermes's own default and
//    fallback chain apply. Two exceptions: a run that failed on quota is started once more on Anthropic (Auto only),
//    and a run whose approval names a model (`run.model`, an id from chat-models.mjs) is started with that pair.
//  - At most 3 Hermes request runs go at a time. A fourth approval is signed and waits in `approved`; a run
//    that ends, and a 60-second sweep, start the oldest waiting one.
//  - Every file written is create-only. A 412 means another follower or process got there first.
import { TERMINAL, createFollowers } from './hermes-follower.mjs';
import { chatModelOf } from './chat-models.mjs';
import { createHermesRuns } from './hermes-runs.mjs';
import { createScrub } from './scrub.mjs';
import { isQuotaError, outcomeOf, reportOf, startFailedOutcome, unknownOutcome } from './run-outcome.mjs';

export const MAX_HERMES_RUNS = 3;
const FORWARD = new Set(['message.delta', 'tool.started', 'tool.completed', 'approval.request', 'approval.settled', 'run.completed', 'run.failed', 'run.cancelled', 'run.interrupted']);
const THROTTLE_MS = 30_000;
const REATTACH_MAX = 10;
const SSE_KEEPALIVE_MS = 15_000;

/**
 * @param requests      `createRequests()`: `loadOne`, `hooks`
 * @param putCreateOnly `(rel, body, type, conflictError)`
 * @param allCards      `() → [{ section, id, folder, created, updated }]`
 * @param onApproval    `(context, prompt) → Promise`: a Hermes approval to copy into the inbox (m3a-hermes-approvals)
 * @param timing        for the follower (reopenMs, pollMs, backoffMs, tickMs…), the HTTP client (timeoutMs, idleMs) and
 *                      `sweepMs` (60 s)
 */
export function createHermesDispatch({ env = {}, fetchImpl = fetch, requests, listFolders, putCreateOnly, cached, fail, allCards, now = () => new Date(), log: rawLog = () => {}, timing = {}, onApproval = null, scrub = createScrub(env) }) {
  // Every line this module logs and every reason it stores goes through the one scrub: no URL or token leaves in text.
  const log = line => rawLog(scrub(line, 400));
  const runs = createHermesRuns({ env, fetchImpl, timeoutMs: timing.timeoutMs, idleMs: timing.idleMs });
  const byRequest = new Map(); // request id -> the run id being followed
  const sweepMs = timing.sweepMs ?? 60_000;
  const retryModel = String(env.HERMES_RETRY_MODEL ?? '').trim() || 'claude-sonnet-5-5';

  // Starts are serialised so the cap is counted against a stable picture.
  let chain = Promise.resolve();
  const exclusive = fn => { const result = chain.then(fn); chain = result.catch(() => {}); return result; };

  const EXISTS = Object.assign(new Error('exists'), { status: 409 });
  /** Create-only write; false when the file is already there. */
  async function writeOnce(id, file, body, type = 'application/json') {
    try {
      await putCreateOnly(`requests/${id}/${file}`, typeof body === 'string' ? body : `${JSON.stringify(body, null, 2)}\n`, type, EXISTS);
      return true;
    } catch (error) {
      if (error === EXISTS) return false;
      throw error;
    }
  }

  const readFile = async (id, names, file) => (names.has(file) ? cached(`requests/${id}/${file}`) : null);

  async function writeResult(id, outcome, output) {
    if (output) await writeOnce(id, 'report.md', reportOf(output), 'text/markdown');
    await writeOnce(id, 'result.json', outcome);
  }

  /** Requests of this and last month, as `[id, names]`. */
  const folders = async at => [...(await listFolders('requests', at))];
  const going = async at => (await folders(at)).filter(([, names]) => names.has('hermes-run.json') && !names.has('result.json')).length;

  const limitAtOf = (approved, from) => new Date(new Date(from).getTime() + (approved?.limits?.minutes ?? 30) * 60_000);

  // `limitFrom` is when the request first started: the quota retry shares the first run's time limit, it does not get a fresh one.
  function attach(id, runId, approved, { retry = false, startedAt, limitFrom = startedAt }) {
    byRequest.set(id, runId);
    return followers.follow({ id, retry, startedAt, limitFrom, approved }, runId, { limitAt: limitAtOf(approved, limitFrom) });
  }

  /** Start the run of an approved request. Called with the lock held. Returns `{ waiting? }` or null. */
  async function begin(id, at) {
    const { parts, state } = await requests.loadOne(id, at);
    const { approved } = parts;
    if (state !== 'approved' || approved?.target !== 'hermes') return null;
    if (!runs.configured) return { waiting: 'Hermes is not set up on this host.' };
    if (await going(at) >= MAX_HERMES_RUNS) return { waiting: `${MAX_HERMES_RUNS} Hermes runs are going` };
    if (!await writeOnce(id, 'taken.json', { runner: 'hermes', host: 'hub', nonce: approved.nonce, at: at.toISOString() })) return null;
    await launch(id, approved, at);
    return null;
  }

  /** Start (or, after a crash, start again under the same idempotency key) and follow. */
  async function launch(id, approved, at) {
    let runId;
    try {
      const pick = chatModelOf(approved.run.model);   // the signed id; a value the list does not know fails the start
      ({ runId } = await runs.start({ input: approved.run.brief, idempotencyKey: id, ...(pick.provider ? { provider: pick.provider, model: pick.model } : {}) }));
    } catch (error) {
      await writeResult(id, startFailedOutcome({ reason: scrub(error.status ? `${error.message} (${error.status})` : error.message), at: at.toISOString() }));
      return;
    }
    await writeOnce(id, 'hermes-run.json', { runId, at: at.toISOString() });
    attach(id, runId, approved, { startedAt: at.toISOString() });
  }

  /** The hook for hub-requests: hand an approved request to Hermes. */
  const handOff = (id, { at = now() } = {}) => exclusive(() => begin(id, at));

  /** Start waiting approvals, oldest first, while there is room. */
  async function startWaiting(at = now()) {
    return exclusive(async () => {
      const waiting = [];
      for (const [id, names] of await folders(at)) {
        if (!names.has('approved.json') || names.has('taken.json') || names.has('stop.json') || names.has('declined.json') || names.has('result.json')) continue;
        const approved = await cached(`requests/${id}/approved.json`);
        if (approved?.target !== 'hermes' || new Date(approved.expires).getTime() < at.getTime()) continue;
        waiting.push({ id, at: approved.at });
      }
      waiting.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : 1));
      for (const { id } of waiting) {
        const answer = await begin(id, at);
        if (answer?.waiting) break;
      }
    });
  }

  async function startRetry(context, at) {
    const { id, approved } = context;
    const provider = 'anthropic';
    let runId;
    try {
      ({ runId } = await runs.start({ input: approved.run.brief, provider, model: retryModel, idempotencyKey: `${id}-retry` }));
    } catch (error) {
      await writeResult(id, startFailedOutcome({ reason: `the retry on Anthropic failed: ${scrub(error.message)}`, at: at.toISOString() }));
      return;
    }
    await writeOnce(id, 'hermes-retry.json', { runId, at: at.toISOString(), provider, model: retryModel, reason: 'quota' });
    attach(id, runId, approved, { retry: true, startedAt: at.toISOString(), limitFrom: context.limitFrom });
  }

  async function stateOfEnd(id, at) {
    try { return await requests.loadOne(id, at); } catch { return null; }
  }

  /** The follower's end: write report.md and result.json, or start the one quota retry. */
  async function onEnd(follower, { run, unknown }) {
    const context = follower.context;
    const { id } = context;
    const at = now();
    const loaded = await stateOfEnd(id, at);
    const names = loaded?.names ?? new Set();
    const stopped = names.has('stop.json');
    try {
      if (unknown) {
        await writeResult(id, unknownOutcome({ card: await newestCardSince(context.startedAt), at: at.toISOString() }));
      } else if (run.status === 'failed' && isQuotaError(run.error) && !context.approved?.run?.model && !context.retry && !names.has('hermes-retry.json') && !stopped && !follower.timedOut) {
        await startRetry(context, at);
        return;
      } else {
        await writeResult(id, outcomeOf({ run: { ...run, error: scrub(run.error) }, stopped, timedOut: follower.timedOut, retried: context.retry, at: at.toISOString() }), run.output);
      }
    } finally {
      if (byRequest.get(id) === follower.runId) byRequest.delete(id);
    }
    startWaiting().catch(error => log(`[hermes] could not start a waiting run: ${error.message}`));
  }

  /** The newest assistant card made after the run started, or null. */
  async function newestCardSince(startedAt) {
    const day = String(startedAt).slice(0, 10);
    let cards = [];
    try { cards = (await allCards()).filter(card => card.section === 'assistant'); } catch { return null; }
    const dated = cards.map(card => ({ card, when: String(card.created ?? card.updated ?? '') })).filter(row => row.when && (row.when.length > 10 ? row.when >= startedAt : row.when >= day));
    dated.sort((a, b) => (a.when < b.when ? 1 : -1));
    return dated[0] ? `assistant/${dated[0].card.folder}` : null;
  }

  const followers = createFollowers({
    runs, log, now, timing,
    async onEvent(follower, entry) {
      if (entry.event === 'approval.request' && onApproval) {
        try { await onApproval(follower.context, entry.data, follower.runId, { polled: entry.polled === true }); } catch (error) { log(`[hermes] could not copy an approval: ${error.message}`); }
      }
    },
    onEnd,
  });

  /** Follow every Hermes run that has no result and no follower, and restart a start that crashed. At most 10. */
  async function reattach(at = now()) {
    if (!runs.configured) return 0;
    let count = 0;
    for (const [id, names] of await folders(at)) {
      if (count >= REATTACH_MAX) break;
      if (names.has('result.json') || byRequest.has(id)) continue;
      const hasRun = names.has('hermes-run.json');
      if (!hasRun && !names.has('taken.json')) continue;
      const approved = await readFile(id, names, 'approved.json');
      if (approved?.target !== 'hermes') continue;
      if (hasRun) {
        const retry = await readFile(id, names, 'hermes-retry.json');
        const run = retry ?? await cached(`requests/${id}/hermes-run.json`);
        if (!run?.runId) continue;
        const first = retry ? await cached(`requests/${id}/hermes-run.json`) : run;
        attach(id, run.runId, approved, { retry: !!retry, startedAt: run.at, limitFrom: first?.at ?? run.at });
        count += 1;
      } else {
        const taken = await readFile(id, names, 'taken.json');
        if (taken?.runner !== 'hermes') continue;
        await exclusive(async () => { if (!byRequest.has(id)) await launch(id, approved, at); });
        count += 1;
      }
    }
    return count;
  }

  let lastCheck = 0;
  /** Called on page loads: make sure the runs have followers, at most once per 30 s per process. */
  function pageLoad(at = now()) {
    if (!runs.configured || Date.now() - lastCheck < THROTTLE_MS) return;
    lastCheck = Date.now();
    reattach(at).catch(error => log(`[hermes] re-attach failed: ${error.message}`));
  }

  /** The hook for stop: ask Hermes to stop the request's run. The follower then writes the result. */
  async function stopRun(id) {
    const at = now();
    const { names } = await requests.loadOne(id, at);
    if (!names.has('hermes-run.json')) return;
    const retry = await readFile(id, names, 'hermes-retry.json');
    const run = retry ?? await cached(`requests/${id}/hermes-run.json`);
    if (!run?.runId) return;
    if (!byRequest.has(id)) await reattach(at);
    await runs.stop(run.runId);
  }

  /** `GET /hub/requests/:id/events`: server-sent events from the follower, then `state`, then the end. */
  async function streamEvents(response, id) {
    const at = now();
    const { names, parts } = await requests.loadOne(id, at);
    if (!names.has('hermes-run.json')) throw fail('That request has no Hermes run.', 409);
    response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no', Connection: 'keep-alive' });
    const send = (event, data) => { if (!response.destroyed) response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
    const keepalive = setInterval(() => { if (!response.destroyed) response.write(': keepalive\n\n'); }, SSE_KEEPALIVE_MS);
    let unsubscribe = null;
    const end = () => { clearInterval(keepalive); unsubscribe?.(); if (!response.destroyed) response.end(); };
    response.on('close', () => { clearInterval(keepalive); unsubscribe?.(); });
    const finish = async () => {
      const after = await stateOfEnd(id, now());
      send('state', { state: after?.state ?? 'unknown' });
      end();
    };
    if (parts.result) { await finish(); return; }
    if (!byRequest.has(id)) await reattach(at);
    const watch = runId => {
      unsubscribe = followers.subscribe(runId, entry => {
        if (entry) { if (FORWARD.has(entry.event)) send(entry.event, entry.data); return; }
        const next = byRequest.get(id);
        if (next && next !== runId && followers.isLive(next)) { watch(next); return; }
        finish().catch(() => end());
      });
      return unsubscribe;
    };
    const runId = byRequest.get(id);
    if (!runId || !watch(runId)) await finish();
  }

  let sweepTimer = null;
  if (runs.configured) {
    sweepTimer = setInterval(() => { startWaiting().catch(error => log(`[hermes] sweep failed: ${error.message}`)); }, sweepMs);
    sweepTimer.unref?.();
  }

  // Plug into the request module.
  requests.hooks.hermesLive = id => byRequest.has(id);
  requests.hooks.handOff.hermes = handOff;
  requests.hooks.stopRun = stopRun;

  return {
    runs, followers, handOff, startWaiting, reattach, pageLoad, stopRun, streamEvents, isLive: id => byRequest.has(id),
    async close() { clearInterval(sweepTimer); await followers.stopAll(); },
    /** For the tests: wait for every follower to finish. */
    async idle() { await Promise.all([...byRequest.values()].map(runId => followers.get(runId)?.done)); },
  };
}

export { TERMINAL };
