// Hermes request runs, against the fake Hermes and the stand-in S3. Nothing here reaches a real Hermes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { createSiteApi } from '../server.mjs';
import { createBucket } from '../s3.mjs';
import { createHub } from '../hub.mjs';
import { outcomeOf, cardOf, isQuotaError } from '../run-outcome.mjs';
import { startFakeHermes } from './fake-hermes.mjs';
import { startFakeS3 } from './fake-s3.mjs';
import { requestJson, seeder } from './hub-fixtures.mjs';

const SITE = 'https://site.example';
const KEY = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');
const TIMING = { reopenMs: 20, pollMs: 20, backoffMs: 20, backoffMaxMs: 40, tickMs: 10, sweepMs: 60_000 };
const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
let counter = 0;
const newId = slug => `${day}-probe-${slug}-${String.fromCharCode(97 + (counter % 26))}${String(++counter).padStart(3, '0')}`;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, what, ms = 8000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) assert.fail(`Timed out waiting for ${what}`);
    await wait(15);
  }
}

/** One S3, one Hermes, and as many hubs (site API processes) on them as a test wants. */
async function stack({ hermesOptions = {}, env = {}, timing = TIMING, noHermes = false } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'buw-hermes-'));
  const fake = await startFakeS3();
  const bucket = createBucket({ bucket: fake.bucket, endpoint: fake.endpoint, credentials: fake.credentials, region: 'us-east-1' });
  fake.seed('sections/inbox/workspace.json', '{"name":"Inbox","hidden":true,"entities":[]}\n', 'application/json');
  fake.seed('state.json', '{"version":1,"cards":{}}', 'application/json');
  const hermes = noHermes ? null : await startFakeHermes({ key: 'k', delayMs: 5, ...hermesOptions });
  const clock = { at: Date.now() };
  const opened = [];
  const addHub = async ({ fetchImpl, log } = {}) => {
    const hub = createHub({
      bucket, enabled: true, now: () => new Date(clock.at), hermesTiming: timing, log: log ?? (() => {}), ...(fetchImpl ? { fetchImpl } : {}),
      env: { HUB_SIGNING_KEY: KEY, ...(hermes ? { HERMES_URL: hermes.url, HERMES_API_KEY: 'k' } : {}), ...env },
    });
    const server = createSiteApi({ bucket, templateDir: path.join(root, 'none'), stateFile: path.join(root, `state-${opened.length}.json`), sectionsTtl: 0, requireRemoteUser: false, hub, allowedOrigins: [SITE] });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const call = async (method, route, data, headers = { 'Remote-User': 'owner' }) => {
      const answer = await fetch(`${origin}/api${route}`, {
        method, headers: { ...(method === 'GET' ? {} : { Origin: SITE, 'Content-Type': 'application/json' }), ...headers },
        body: method === 'GET' ? undefined : JSON.stringify(data ?? {}),
      });
      return { status: answer.status, body: await answer.json().catch(() => null) };
    };
    const api = {
      hub, origin, get: route => call('GET', route), post: (route, data, headers) => call('POST', route, data, headers),
      stop: async () => { await hub.close(); server.closeAllConnections(); server.close(); },
    };
    opened.push(api);
    return api;
  };
  const seed = seeder(fake);
  /** A proposed research request, ready to approve. */
  const propose = (slug = 'research', extra = {}) => {
    const id = newId(slug);
    seed.request({ ...requestJson({ id, now: new Date(clock.at) }), preset: 'research', target: 'hermes', origin: { kind: 'owner', name: 'owner' }, ...extra });
    return id;
  };
  const resultOf = id => fake.json(`sections/inbox/requests/${id}/result.json`);
  const file = (id, name) => fake.json(`sections/inbox/requests/${id}/${name}`);
  const close = async () => {
    for (const api of opened) await api.stop().catch(() => {});
    await hermes?.close();
    await fake.close();
  };
  return { fake, hermes, clock, addHub, propose, resultOf, file, seed, close };
}

// The fake loses a release that lands before the run reaches its hold step, so release again until every request has a result.
const releaseAll = (s, ids) => until(() => {
  for (const run of s.hermes.runs) if (!['completed', 'failed', 'cancelled'].includes(run.status)) s.hermes.release(run.id, 'Ok.\nCARD: assistant/x');
  return ids.every(id => s.resultOf(id));
}, 'all results');

const approve = (api, id) => api.post(`/hub/requests/${id}/approve`, { target: 'hermes' });

test('outcomeOf: the CARD line wins, the rest is a failure with a reason', () => {
  const at = '2026-10-29T10:00:00.000Z';
  assert.equal(cardOf('Text\nCARD: assistant/tug-games\n'), 'assistant/tug-games');
  assert.equal(cardOf('CARD: assistant/a\nmore\nCARD: assistant/b'), 'assistant/b', 'The last line counts.');
  assert.equal(cardOf('CARD: other/x'), null);
  assert.equal(isQuotaError('Codex provider quota exhausted (429)'), true);
  assert.equal(isQuotaError('boom'), false);
  const done = outcomeOf({ run: { status: 'completed', output: 'Found it.\nCARD: assistant/x', usage: { total_tokens: 9 }, runtime: { provider: '', requested: { provider: 'anthropic' } } }, at });
  assert.deepEqual([done.outcome, done.card, done.by], ['card', 'assistant/x', 'hub']);
  assert.deepEqual(done.usage, { total_tokens: 9, requested: { provider: 'anthropic' } });
  assert.equal('provider' in done.usage, false, 'runtime.provider is never copied.');
  assert.match(outcomeOf({ run: { status: 'completed', output: 'No card' }, at }).summary, /without a card/);
  assert.equal(outcomeOf({ run: { status: 'cancelled', output: '' }, stopped: true, at }).reason, 'stopped');
  assert.equal(outcomeOf({ run: { status: 'cancelled', output: '' }, timedOut: true, at }).reason, 'time-limit');
  const quota = outcomeOf({ run: { status: 'failed', error: '429 usage limit reached' }, at });
  assert.deepEqual([quota.outcome, quota.reason, quota.summary], ['failed', 'usage-limit', 'Codex quota reached.']);
  assert.equal(outcomeOf({ run: { status: 'failed', error: 'boom' }, at }).reason, undefined);
  assert.match(outcomeOf({ run: { status: 'interrupted', error: 'Gateway shutdown' }, at }).summary, /interrupted/);
});

test('approve starts a run with the brief and no provider; with nobody watching, the result names the card', async () => {
  const s = await stack({ hermesOptions: { endWith: 'Tugs are a niche.\nCARD: assistant/tug-games' } });
  try {
    const api = await s.addHub();
    const id = s.propose();
    const approved = await approve(api, id);
    assert.equal(approved.status, 201, JSON.stringify(approved.body));
    const result = await until(() => s.resultOf(id), 'result.json');
    assert.deepEqual([result.outcome, result.card, result.by, result.v], ['card', 'assistant/tug-games', 'hub', 1]);
    assert.equal(result.summary, 'Tugs are a niche.\nCARD: assistant/tug-games');
    assert.ok(result.usage.total_tokens > 0);
    assert.equal(s.hermes.runs.length, 1);
    const [run] = s.hermes.runs;
    assert.deepEqual(Object.keys(run.body), ['input'], 'No provider and no model on an ordinary run.');
    assert.equal(run.key, id, 'The request id is the idempotency key.');
    assert.equal(run.body.input, s.file(id, 'approved.json').run.brief);
    assert.match(run.body.input, new RegExp(`Request ${id}`));
    assert.equal(s.file(id, 'hermes-run.json').runId, run.id);
    assert.deepEqual([s.file(id, 'taken.json').runner, s.file(id, 'taken.json').host], ['hermes', 'hub']);
    assert.equal(s.fake.text(`sections/inbox/requests/${id}/report.md`), 'Tugs are a niche.\nCARD: assistant/tug-games');
    assert.equal((await api.get(`/hub/requests/${id}`)).body.state, 'done');
  } finally { await s.close(); }
});

test('the events route streams the run and ends with state done; a finished run answers state at once', async () => {
  const s = await stack({ hermesOptions: { runScript: ['one ', { wait: 120 }, 'two', { end: 'All set.\nCARD: assistant/x' }] } });
  try {
    const api = await s.addHub();
    const id = s.propose();
    await approve(api, id);
    const text = await (await fetch(`${api.origin}/api/hub/requests/${id}/events`)).text();
    const events = [...text.matchAll(/event: ([\w.]+)\ndata: (.*)\n/g)].map(match => [match[1], JSON.parse(match[2])]);
    const names = events.map(([name]) => name);
    assert.ok(names.includes('message.delta') && names.includes('run.completed'));
    assert.deepEqual(events.at(-1), ['state', { state: 'done' }]);
    assert.deepEqual(events.filter(([name]) => name === 'message.delta').map(([, data]) => data.delta), ['one ', 'two']);
    assert.ok(names.indexOf('run.completed') < names.indexOf('state'));
    const again = await (await fetch(`${api.origin}/api/hub/requests/${id}/events`)).text();
    assert.equal(again, 'event: state\ndata: {"state":"done"}\n\n');
    const noRun = s.propose('norun');
    assert.equal((await api.get(`/hub/requests/${noRun}/events`)).status, 409);
  } finally { await s.close(); }
});

test('a dropped stream is re-opened from the last seq and still writes one result', async () => {
  const s = await stack({ hermesOptions: { dropStreamAfter: 2, runScript: ['a', 'b', 'c', 'd', 'e', { end: 'Done.\nCARD: assistant/dropped' }] } });
  try {
    const api = await s.addHub();
    const id = s.propose();
    await approve(api, id);
    const result = await until(() => s.resultOf(id), 'result.json');
    assert.equal(result.card, 'assistant/dropped');
    assert.equal(s.hermes.runs.length, 1);
  } finally { await s.close(); }
});

test('a new hub on the same S3 re-attaches to a running run and finishes it', async () => {
  const s = await stack({ hermesOptions: { runScript: ['start ', { hold: true }] } });
  try {
    const first = await s.addHub();
    const id = s.propose();
    await approve(first, id);
    await until(() => s.file(id, 'hermes-run.json'), 'hermes-run.json');
    await first.stop();
    assert.equal(s.resultOf(id), null, 'Nothing is written while no follower runs.');
    const second = await s.addHub();
    await until(() => second.hub.hermes.isLive(id), 'a follower after the restart');
    s.hermes.release(s.hermes.runs[0].id, 'Back again.\nCARD: assistant/restart');
    const result = await until(() => s.resultOf(id), 'result.json');
    assert.equal(result.card, 'assistant/restart');
    assert.equal(s.hermes.runs.length, 1, 'No second run was started.');
  } finally { await s.close(); }
});

test('when Hermes has dropped the event buffer, a new hub polls the status and writes one result', async () => {
  const s = await stack({ hermesOptions: { dropBufferAfterMs: 30, runScript: ['x ', { hold: true }] } });
  try {
    const first = await s.addHub();
    const id = s.propose();
    await approve(first, id);
    await until(() => s.file(id, 'hermes-run.json'), 'hermes-run.json');
    await first.stop();
    s.hermes.release(s.hermes.runs[0].id, 'Finished alone.\nCARD: assistant/polled');
    await wait(80);
    const second = await s.addHub();
    const result = await until(() => s.resultOf(id), 'result.json');
    assert.equal(result.card, 'assistant/polled');
    assert.equal((await second.get(`/hub/requests/${id}`)).body.state, 'done');
  } finally { await s.close(); }
});

test('a run Hermes no longer knows ends unknown, pointing at the assistant card made after the start', async () => {
  const s = await stack({ hermesOptions: { forgetRuns: true } });
  try {
    const today = new Date().toISOString().slice(0, 10);
    s.fake.seed('sections/assistant/workspace.json', JSON.stringify({ name: 'Assistant', entities: [
      { id: 'old', title: 'Old', folder: '2020-01-01_old', created: '2020-01-01' },
      { id: 'new', title: 'New', folder: `${today}_tugs`, created: today },
    ] }), 'application/json');
    const api = await s.addHub();
    const id = s.propose();
    await approve(api, id);
    const result = await until(() => s.resultOf(id), 'result.json');
    assert.deepEqual([result.outcome, result.reason, result.card], ['unknown', 'hermes-forgot', `assistant/${today}_tugs`]);
    assert.match(result.summary, /no longer knows/);
    assert.equal((await api.get(`/hub/requests/${id}`)).body.state, 'done');
  } finally { await s.close(); }
});

test('Hermes busy (429) at the start is a failed start; no Hermes on the host makes it wait', async () => {
  const busy = await stack({ hermesOptions: { busy: true } });
  const none = await stack({ noHermes: true });
  try {
    const api = await busy.addHub();
    const id = busy.propose();
    assert.equal((await approve(api, id)).status, 201);
    const result = busy.resultOf(id);
    assert.deepEqual([result.outcome, result.reason], ['failed', 'start-failed']);
    assert.match(result.summary, /^Hermes did not start: .*busy.*429/);
    assert.equal(busy.file(id, 'hermes-run.json'), null);

    const bare = await none.addHub();
    const other = none.propose();
    const waiting = await approve(bare, other);
    assert.equal(waiting.status, 201);
    assert.match(waiting.body.waiting, /not set up/);
    assert.equal(none.resultOf(other), null, 'The approval waits; nothing is failed.');
  } finally { await busy.close(); await none.close(); }
});

test('the fourth approval is signed and waits; it starts when a run ends', async () => {
  const s = await stack({ hermesOptions: { runScript: ['go ', { hold: true }] } });
  try {
    const api = await s.addHub();
    const ids = [s.propose('a'), s.propose('b'), s.propose('c'), s.propose('d')];
    for (const id of ids.slice(0, 3)) assert.equal((await approve(api, id)).status, 201);
    await until(() => s.hermes.runs.length === 3, 'three runs');
    const fourth = await approve(api, ids[3]);
    assert.equal(fourth.status, 201, 'Approve never refuses for a cap.');
    assert.equal(fourth.body.waiting, '3 Hermes runs are going');
    assert.equal(fourth.body.state, 'approved');
    assert.ok(s.file(ids[3], 'approved.json').signature);
    assert.equal(s.file(ids[3], 'taken.json'), null);
    assert.equal(s.hermes.runs.length, 3);
    s.hermes.release(s.hermes.runs[0].id, 'Ok.\nCARD: assistant/one');
    await until(() => s.hermes.runs.length === 4, 'the waiting run to start');
    assert.equal(s.hermes.runs[3].key, ids[3]);
    await until(() => s.file(ids[3], 'hermes-run.json'), 'its hermes-run.json');
    await releaseAll(s, ids);
  } finally { await s.close(); }
});

test('the sweep starts the oldest waiting approval first', async () => {
  const s = await stack({ hermesOptions: { runScript: ['go ', { hold: true }] }, timing: { ...TIMING, sweepMs: 40 } });
  try {
    const api = await s.addHub();
    const ids = ['a', 'b', 'c', 'd', 'e'].map(slug => s.propose(slug));
    for (const id of ids) { await approve(api, id); s.clock.at += 1000; }
    await until(() => s.hermes.runs.length === 3, 'three runs');
    s.hermes.release(s.hermes.runs[1].id, 'Ok.\nCARD: assistant/x');
    await until(() => s.hermes.runs.length === 4, 'the next run');
    assert.equal(s.hermes.runs[3].key, ids[3], 'The older of the two waiting requests goes first.');
    await releaseAll(s, ids);
  } finally { await s.close(); }
});

test('stop writes the signed stop, stops the run, and the state is stopped', async () => {
  const s = await stack({ hermesOptions: { runScript: ['start ', { hold: true }] } });
  try {
    const api = await s.addHub();
    const id = s.propose();
    await approve(api, id);
    await until(() => s.file(id, 'hermes-run.json'), 'hermes-run.json');
    const stopped = await api.post(`/hub/requests/${id}/stop`, { reason: 'No longer needed' });
    assert.equal(stopped.status, 201, JSON.stringify(stopped.body));
    assert.ok(s.file(id, 'stop.json').signature);
    const result = await until(() => s.resultOf(id), 'result.json');
    assert.deepEqual([result.outcome, result.reason], ['failed', 'stopped']);
    assert.deepEqual(s.hermes.stops, [s.hermes.runs[0].id]);
    assert.equal(s.hermes.runs[0].status, 'cancelled');
    assert.equal((await api.get(`/hub/requests/${id}`)).body.state, 'stopped');
  } finally { await s.close(); }
});

test('a run past limits.minutes is stopped with time-limit (fake clock)', async () => {
  const s = await stack({ hermesOptions: { runScript: ['start ', { hold: true }] } });
  try {
    const api = await s.addHub();
    const id = s.propose();
    await approve(api, id);
    await until(() => s.file(id, 'hermes-run.json'), 'hermes-run.json');
    assert.equal(s.file(id, 'approved.json').limits.minutes, 30);
    s.clock.at += 29 * 60_000;
    await wait(60);
    assert.equal(s.hermes.stops.length, 0, 'Not yet.');
    s.clock.at += 2 * 60_000;
    const result = await until(() => s.resultOf(id), 'result.json');
    assert.deepEqual([result.outcome, result.reason], ['failed', 'time-limit']);
    assert.equal(s.hermes.runs[0].status, 'cancelled');
  } finally { await s.close(); }
});

test('a quota failure is retried once on Anthropic; the retry is recorded and its result is the request\'s', async () => {
  const s = await stack({ hermesOptions: { chain: [{ provider: 'openai-codex', model: 'gpt-6-sol' }], providerFailures: { 'openai-codex': 'Codex provider quota exhausted (429)' }, endWith: 'Second try.\nCARD: assistant/retried' } });
  try {
    const api = await s.addHub();
    const id = s.propose();
    await approve(api, id);
    const result = await until(() => s.resultOf(id), 'result.json');
    assert.equal(result.card, 'assistant/retried');
    assert.equal(s.hermes.runs.length, 2);
    assert.deepEqual(Object.keys(s.hermes.runs[0].body), ['input'], 'The first run names no provider.');
    assert.deepEqual([s.hermes.runs[1].body.provider, s.hermes.runs[1].body.model, s.hermes.runs[1].key], ['anthropic', 'claude-sonnet-5-5', `${id}-retry`]);
    const retry = s.file(id, 'hermes-retry.json');
    assert.deepEqual([retry.runId, retry.provider, retry.model, retry.reason], [s.hermes.runs[1].id, 'anthropic', 'claude-sonnet-5-5', 'quota']);
    assert.equal(s.file(id, 'hermes-run.json').runId, s.hermes.runs[0].id);
    const detail = (await api.get(`/hub/requests/${id}`)).body;
    assert.equal(detail.retry.reason, 'quota');
    assert.equal(detail.state, 'done');
  } finally { await s.close(); }
});

test('a second quota failure ends failed with usage-limit; there is no third run', async () => {
  const s = await stack({ hermesOptions: { failWith: 'Codex provider quota exhausted (429)' }, env: { HERMES_RETRY_MODEL: 'claude-test-model' } });
  try {
    const api = await s.addHub();
    const id = s.propose();
    await approve(api, id);
    const result = await until(() => s.resultOf(id), 'result.json');
    assert.deepEqual([result.outcome, result.reason], ['failed', 'usage-limit']);
    assert.match(result.summary, /Codex quota reached/);
    assert.equal(s.hermes.runs.length, 2);
    assert.equal(s.hermes.runs[1].body.model, 'claude-test-model');
    await wait(100);
    assert.equal(s.hermes.runs.length, 2);
  } finally { await s.close(); }
});

test('another failure is not retried; an interrupted run ends failed', async () => {
  const s = await stack({ hermesOptions: { runScript: ['x', { fail: 'The tool crashed' }] } });
  const t = await stack({ hermesOptions: { runScript: ['start ', { hold: true }] } });
  try {
    const api = await s.addHub();
    const id = s.propose();
    await approve(api, id);
    const result = await until(() => s.resultOf(id), 'result.json');
    assert.deepEqual([result.outcome, result.reason], ['failed', undefined]);
    assert.match(result.summary, /The tool crashed/);
    assert.equal(s.hermes.runs.length, 1);

    const other = await t.addHub();
    const interrupted = t.propose();
    await approve(other, interrupted);
    await until(() => t.hermes.runs.length === 1 && t.file(interrupted, 'hermes-run.json'), 'a run');
    t.hermes.interrupt(t.hermes.runs[0].id);
    const second = await until(() => t.resultOf(interrupted), 'result.json');
    assert.equal(second.outcome, 'failed');
    assert.match(second.summary, /interrupted/);
  } finally { await s.close(); await t.close(); }
});

test('a crash between taken.json and the run is picked up again under the same idempotency key', async () => {
  const s = await stack({ hermesOptions: { endWith: 'Recovered.\nCARD: assistant/again' } });
  try {
    const id = s.propose();
    const first = await s.addHub();
    await first.stop();
    // Approve with Hermes handing off nothing, as if the process died right after taken.json: sign by hand through a keyless-free hub.
    const quiet = await s.addHub();
    quiet.hub.requestHooks.handOff.hermes = async () => null;
    await approve(quiet, id);
    s.fake.seed(`sections/inbox/requests/${id}/taken.json`, JSON.stringify({ runner: 'hermes', host: 'hub', nonce: s.file(id, 'approved.json').nonce, at: new Date(s.clock.at).toISOString() }), 'application/json');
    assert.equal(s.hermes.runs.length, 0);
    await quiet.stop();
    await s.addHub();
    const result = await until(() => s.resultOf(id), 'result.json');
    assert.equal(result.card, 'assistant/again');
    assert.equal(s.hermes.runs.length, 1);
    assert.equal(s.hermes.runs[0].key, id);
  } finally { await s.close(); }
});

// --- review fixes: the time cap, and what leaves in text ---

const jsonResponse = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

test('the time limit stop is retried until Hermes takes it, and a failed stop does not lift the limit', async () => {
  const s = await stack({ hermesOptions: { runScript: ['start ', { hold: true }] } });
  try {
    let stopCalls = 0;
    const api = await s.addHub({
      fetchImpl: async (url, init) => {
        if (String(url).endsWith('/stop') && ++stopCalls === 1) return jsonResponse(500, { error: { message: 'down' } });
        return fetch(url, init);
      },
    });
    const id = s.propose();
    await approve(api, id);
    await until(() => s.file(id, 'hermes-run.json'), 'hermes-run.json');
    s.clock.at += 31 * 60_000;
    const result = await until(() => s.resultOf(id), 'result.json');
    assert.deepEqual([result.outcome, result.reason], ['failed', 'time-limit']);
    assert.ok(stopCalls >= 2, `stop was tried ${stopCalls} times`);
    assert.equal(s.hermes.stops.length, 1);
    assert.equal(s.hermes.runs[0].status, 'cancelled');
  } finally { await s.close(); }
});

test('the quota retry shares the first run\'s time limit instead of starting a new one', async () => {
  const s = await stack({ hermesOptions: { chain: [{ provider: 'openai-codex', model: 'gpt-6-sol' }], providerFailures: { 'openai-codex': '429 usage limit reached' }, runScript: ['second ', { hold: true }] } });
  try {
    let started = 0;
    const api = await s.addHub({
      fetchImpl: async (url, init) => {
        const answer = await fetch(url, init);
        if (init?.method === 'POST' && String(url).endsWith('/v1/runs') && ++started === 1) s.clock.at += 20 * 60_000; // the retry starts 20 minutes after the first run
        return answer;
      },
    });
    const id = s.propose();
    await approve(api, id);
    await until(() => s.file(id, 'hermes-retry.json'), 'hermes-retry.json');
    const first = s.file(id, 'hermes-run.json');
    const follower = api.hub.hermes.followers.get(s.file(id, 'hermes-retry.json').runId);
    assert.equal(follower.context.limitFrom, first.at, 'The limit counts from the first start.');
    assert.notEqual(follower.context.startedAt, first.at);
    s.clock.at += 11 * 60_000; // 31 minutes after the first start, 11 after the retry's
    const result = await until(() => s.resultOf(id), 'result.json');
    assert.equal(result.reason, 'time-limit');
  } finally { await s.close(); }
});

test('no URL or token leaves in a hand-off error: waiting, result.json, the 409 text and the log', async () => {
  const lines = [];
  const leak = 'connect failed https://hermes.internal.example/v1/runs?token=abc123 Bearer sekret-token-value';
  const s = await stack();
  try {
    const failing = await s.addHub({
      log: line => lines.push(line),
      fetchImpl: async (url, init) => (init?.method === 'POST' && String(url).endsWith('/v1/runs') ? jsonResponse(500, { error: { message: leak } }) : fetch(url, init)),
    });
    const id = s.propose();
    await approve(failing, id);
    const result = s.resultOf(id);
    assert.equal(result.reason, 'start-failed');
    assert.match(result.summary, /^Hermes did not start: /);
    for (const text of [JSON.stringify(result), ...lines]) assert.doesNotMatch(text, /hermes\.internal|https?:|abc123|sekret|Bearer/i, text);

    const throwing = await s.addHub({ log: line => lines.push(line) });
    throwing.hub.requestHooks.handOff.hermes = async () => { throw new Error(leak); };
    const other = s.propose('other');
    const answer = await approve(throwing, other);
    assert.equal(answer.status, 201);
    assert.match(answer.body.waiting, /^Could not start yet: /);
    for (const text of [answer.body.waiting, ...lines]) assert.doesNotMatch(text, /hermes\.internal|https?:|abc123|sekret|Bearer/i, text);
  } finally { await s.close(); }
});
