// Wake the PC: the state table, the route (Origin, sign-in, kill switch, one a minute, no URL in any answer) and wake on Approve.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { createSiteApi } from '../server.mjs';
import { createBucket } from '../s3.mjs';
import { createHub } from '../hub.mjs';
import { wakeState } from '../pc-wake.mjs';
import { startFakeS3 } from './fake-s3.mjs';
import { pcStatusJson, requestJson, seedPcStatus } from './hub-fixtures.mjs';
import { listenOnGoodPort } from '../../../server/listen.mjs';

const SITE = 'https://site.example';
const MIN = 60000;
const NOW = new Date();
const keyPair = generateKeyPairSync('ed25519');
const SIGNING = { HUB_SIGNING_KEY: keyPair.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64') };
const SECRET_PATH = '/hooks/SECRETWAKE789';

// --- the state table ---

test('wakeState: one case per state, with fixed clocks', () => {
  const now = new Date('2026-10-30T12:00:00Z');
  const ago = minutes => new Date(now.getTime() - minutes * MIN);
  const table = [
    ['awake: a status 11 minutes old', { statusAt: ago(11) }, 'awake'],
    ['awake: a status right now', { statusAt: ago(0) }, 'awake'],
    ['asleep-or-off: a status 13 minutes old, no wake', { statusAt: ago(13) }, 'asleep-or-off'],
    ['asleep-or-off: no status at all, no wake', {}, 'asleep-or-off'],
    ['asleep-or-off: an old wake and an older status', { statusAt: ago(200), wakeAt: ago(120) }, 'asleep-or-off'],
    ['waking: a wake 4 minutes old, no status since', { statusAt: ago(90), wakeAt: ago(4) }, 'waking'],
    ['waking: a wake 4 minutes old, never a status', { wakeAt: ago(4) }, 'waking'],
    ['off: a wake 5 minutes old, no status since', { statusAt: ago(90), wakeAt: ago(5) }, 'off'],
    ['off: a wake 30 minutes old, never a status', { wakeAt: ago(30) }, 'off'],
    ['woke: a status newer than a wake 8 minutes old', { statusAt: ago(2), wakeAt: ago(8) }, 'woke'],
    ['awake: a fresh status and a wake from 2 hours ago', { statusAt: ago(2), wakeAt: ago(120) }, 'awake'],
    ['awake: a fresh status older than the wake still counts', { statusAt: ago(6), wakeAt: ago(3) }, 'awake'],
    ['ISO strings work too', { statusAt: ago(2).toISOString(), wakeAt: ago(9).toISOString() }, 'woke'],
  ];
  for (const [name, input, expected] of table) assert.equal(wakeState({ ...input, now }), expected, name);
});

// --- the route and wake on Approve ---

/** A stand-in for the home controller on 127.0.0.1: counts the POSTs it gets and answers `answer.status`. */
async function fakeController() {
  const calls = [];
  const answer = { status: 200 };
  const server = http.createServer((request, response) => {
    let size = 0;
    request.on('data', chunk => { size += chunk.length; });
    request.on('end', () => { calls.push({ method: request.method, path: request.url, size }); response.statusCode = answer.status; response.end('{}'); });
  });
  await listenOnGoodPort(server, '127.0.0.1');
  return { calls, answer, url: `http://127.0.0.1:${server.address().port}${SECRET_PATH}`, close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections?.(); }) };
}

async function fixture({ env = {}, controller = true } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'buw-wake-'));
  const fake = await startFakeS3();
  const bucket = createBucket({ bucket: fake.bucket, endpoint: fake.endpoint, credentials: fake.credentials, region: 'us-east-1' });
  fake.seed('sections/inbox/workspace.json', '{"name":"Inbox","hidden":true,"entities":[]}\n', 'application/json');
  fake.seed('state.json', '{"version":1,"cards":{}}', 'application/json');
  const wakeServer = controller ? await fakeController() : null;
  const clock = { time: NOW.getTime() };
  const hub = createHub({ bucket, enabled: true, now: () => new Date(clock.time), env: { ...SIGNING, ...(wakeServer ? { HUB_WAKE_URL: wakeServer.url } : {}), ...env }, log: () => {} });
  const server = createSiteApi({ bucket, templateDir: path.join(root, 'none'), stateFile: path.join(root, 'card-state.json'), sectionsTtl: 0, requireRemoteUser: false, hub, allowedOrigins: [SITE] });
  await listenOnGoodPort(server, '127.0.0.1');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, route, data, headers = {}) => {
    const answered = await fetch(`${origin}/api${route}`, { method, headers: { ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }), ...headers }, body: method === 'GET' ? undefined : JSON.stringify(data ?? {}) });
    const text = await answered.text();
    let body = null;
    try { body = JSON.parse(text); } catch { /* not JSON */ }
    return { status: answered.status, body, text };
  };
  const post = (route, data, headers = { Origin: SITE, 'Remote-User': 'owner' }) => call('POST', route, data, headers);
  const wakeFiles = () => [...fake.objects.keys()].filter(name => /sections\/inbox\/pc\/wake-/.test(name));
  const status = minutes => seedPcStatus(fake, pcStatusJson({ now: new Date(clock.time), minutesOld: minutes }));
  let n = 0;
  /** A code task for the PC, proposed. */
  const pcRequest = () => {
    n += 1;
    const id = `${new Date(clock.time).toISOString().slice(0, 10).replace(/-/g, '')}-probe-wake${n}-w${String(n).padStart(3, '0')}`;
    const request = { ...requestJson({ id, now: new Date(clock.time) }), preset: 'code-task', target: 'pc', repo: 'example/probe', origin: { kind: 'owner', name: 'owner' } };
    fake.seed(`sections/inbox/requests/${id}/request.json`, `${JSON.stringify(request, null, 2)}\n`, 'application/json');
    return request;
  };
  return { fake, call, post, get: route => call('GET', route), wakeServer, wakeFiles, status, clock, pcRequest, close: async () => { server.close(); await fake.close(); await wakeServer?.close(); } };
}

test('POST /hub/pc/wake: one POST reaches the controller, a second inside a minute is 429, no answer holds the URL', async () => {
  const f = await fixture();
  try {
    const first = await f.post('/hub/pc/wake');
    assert.equal(first.status, 201, first.text);
    assert.deepEqual(f.wakeServer.calls, [{ method: 'POST', path: SECRET_PATH, size: 0 }], 'one POST with an empty body');
    assert.equal(f.wakeFiles().length, 1);
    const record = f.fake.json(f.wakeFiles()[0]);
    assert.deepEqual(Object.keys(record).sort(), ['at', 'by']);
    assert.equal(record.by, 'owner');
    const second = await f.post('/hub/pc/wake');
    assert.equal(second.status, 429);
    assert.equal(f.wakeServer.calls.length, 1, 'the second never reached the controller');
    f.clock.time += 61 * 1000;
    assert.equal((await f.post('/hub/pc/wake')).status, 201, 'a minute later it goes');
    assert.equal(f.wakeServer.calls.length, 2);
    for (const text of [first.text, second.text]) {
      assert.ok(!text.includes('SECRETWAKE'), 'no path');
      assert.ok(!text.includes('127.0.0.1'), 'no host');
    }
    const stored = [...f.fake.objects.keys()].map(name => f.fake.text(name) ?? '').join('\n');
    assert.ok(!stored.includes('SECRETWAKE'), 'nothing stored holds the URL');
  } finally { await f.close(); }
});

test('POST /hub/pc/wake: no user 401, no Origin 403, HUB_WAKE_URL unset 404, a controller that refuses or is down 502 without the URL', async () => {
  const f = await fixture();
  const off = await fixture({ controller: false });
  try {
    assert.equal((await f.post('/hub/pc/wake', {}, { Origin: SITE })).status, 401);
    assert.equal((await f.post('/hub/pc/wake', {}, { 'Remote-User': 'owner' })).status, 403, 'the Origin check');
    assert.equal((await f.post('/hub/pc/wake', {}, { Origin: 'https://evil.example', 'Remote-User': 'owner' })).status, 403);
    assert.equal(f.wakeServer.calls.length, 0);
    assert.equal((await off.post('/hub/pc/wake')).status, 404);
    assert.equal(off.wakeFiles().length, 0);

    f.wakeServer.answer.status = 500;
    const refused = await f.post('/hub/pc/wake');
    assert.equal(refused.status, 502);
    assert.ok(!refused.text.includes('SECRETWAKE') && !refused.text.includes('127.0.0.1'));
    assert.equal(f.wakeFiles().length, 0, 'a wake that did not go through leaves no record');
    await f.wakeServer.close();
    f.clock.time += 2 * MIN;
    const down = await f.post('/hub/pc/wake');
    assert.equal(down.status, 502);
    assert.ok(!down.text.includes('SECRETWAKE') && !down.text.includes('127.0.0.1'));
  } finally { await f.close().catch(() => {}); await off.close(); }
});

test('GET /hub/pc and /hub/today carry wake: { state, wakeAvailable }, following the status and the wake', async () => {
  const f = await fixture();
  const off = await fixture({ controller: false });
  try {
    assert.deepEqual((await f.get('/hub/pc')).body.wake, { state: 'asleep-or-off', wakeAvailable: true });
    assert.deepEqual((await off.get('/hub/pc')).body.wake, { state: 'asleep-or-off', wakeAvailable: false });
    f.status(20);
    assert.equal((await f.get('/hub/today')).body.wake.state, 'asleep-or-off', 'a 20 minute old status');
    await f.post('/hub/pc/wake');
    f.clock.time += 2 * MIN;
    assert.equal((await f.get('/hub/pc')).body.wake.state, 'waking');
    f.clock.time += 4 * MIN;
    assert.equal((await f.get('/hub/pc')).body.wake.state, 'off');
    f.status(0);
    assert.equal((await f.get('/hub/pc')).body.wake.state, 'woke');
    assert.equal((await f.get('/hub/today')).body.pc.state, 'on', 'pcSummary.state is unchanged');
  } finally { await f.close(); await off.close(); }
});

test('Approve of a PC request wakes a stale PC once when HUB_WAKE_ON_APPROVE=1, and never when the PC is awake or the switch is off', async () => {
  const stale = await fixture({ env: { HUB_WAKE_ON_APPROVE: '1' } });
  const awake = await fixture({ env: { HUB_WAKE_ON_APPROVE: '1' } });
  const switchOff = await fixture();
  const down = await fixture({ env: { HUB_WAKE_ON_APPROVE: '1' } });
  try {
    stale.status(20);
    const request = stale.pcRequest();
    const approved = await stale.post(`/hub/requests/${request.id}/approve`, { target: 'pc' });
    assert.equal(approved.status, 201, approved.text);
    assert.equal(approved.body.wake, 'sent');
    assert.equal(stale.wakeServer.calls.length, 1);
    assert.equal(stale.wakeFiles().length, 1);
    assert.ok(!approved.text.includes('SECRETWAKE'));
    // A second approval inside the minute is still approved; the wake is rate limited and says nothing.
    const again = await stale.post(`/hub/requests/${stale.pcRequest().id}/approve`, { target: 'pc' });
    assert.equal(again.status, 201);
    assert.equal(again.body.wake, undefined);
    assert.equal(stale.wakeServer.calls.length, 1);

    awake.status(2);
    assert.equal((await awake.post(`/hub/requests/${awake.pcRequest().id}/approve`, { target: 'pc' })).status, 201);
    assert.equal(awake.wakeServer.calls.length, 0, 'an awake PC is not woken');

    switchOff.status(20);
    assert.equal((await switchOff.post(`/hub/requests/${switchOff.pcRequest().id}/approve`, { target: 'pc' })).status, 201);
    assert.equal(switchOff.wakeServer.calls.length, 0, 'HUB_WAKE_ON_APPROVE unset: the button only');

    // A controller that is down never fails the approval.
    down.status(20);
    await down.wakeServer.close();
    const request2 = down.pcRequest();
    const survived = await down.post(`/hub/requests/${request2.id}/approve`, { target: 'pc' });
    assert.equal(survived.status, 201);
    assert.ok(down.fake.text(`sections/inbox/requests/${request2.id}/approved.json`), 'approved.json is written');
  } finally { await stale.close(); await awake.close(); await switchOff.close(); await down.close().catch(() => {}); }
});

test('Approve of a request for another target does not wake the PC', async () => {
  const f = await fixture({ env: { HUB_WAKE_ON_APPROVE: '1' } });
  try {
    f.status(20);
    const request = { ...f.pcRequest(), id: '20261030-probe-hermes-h001', preset: 'research', target: 'hermes', repo: undefined };
    f.fake.seed(`sections/inbox/requests/${request.id}/request.json`, `${JSON.stringify(request)}\n`, 'application/json');
    await f.post(`/hub/requests/${request.id}/approve`, { target: 'hermes' });
    assert.equal(f.wakeServer.calls.length, 0);
  } finally { await f.close(); }
});
