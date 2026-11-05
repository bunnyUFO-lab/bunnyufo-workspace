// The poke that starts the apply Action: off without its two settings, one run for several marks, and only for what the Action applies.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { createApplyPoke, APPLY_POKE_DELAY_MS } from '../hub-apply-poke.mjs';
import { createSiteApi } from '../server.mjs';
import { createBucket } from '../s3.mjs';
import { createHub } from '../hub.mjs';
import { startFakeS3 } from './fake-s3.mjs';
import { askJson, beadsIssue, seeder, threeOptions } from './hub-fixtures.mjs';
import { listenOnGoodPort } from '../../../server/listen.mjs';

const ENV = { HUB_APPLY_DISPATCH_TOKEN: 'a-token-value', HUB_APPLY_DISPATCH_REPO: 'owner/control' };
const SITE = 'https://site.example';
const NOW = new Date();
const stamp = NOW.toISOString().slice(0, 10).replace(/-/g, '');

/** Timers run when the test says, and fetch only records. */
function world(env = ENV, answer = { ok: true, status: 204 }) {
  const timers = [];
  const sent = [];
  const logs = [];
  const poke = createApplyPoke({
    env,
    log: line => logs.push(line),
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return null; },
    fetchImpl: async (url, init) => { sent.push({ url, init }); if (answer instanceof Error) throw answer; return answer; },
  });
  return { poke, timers, sent, logs };
}

test('without both settings it is off: nothing is scheduled and nothing is sent', () => {
  for (const env of [{}, { HUB_APPLY_DISPATCH_TOKEN: 't' }, { HUB_APPLY_DISPATCH_REPO: 'owner/control' }, { ...ENV, HUB_APPLY_DISPATCH_REPO: 'not a repo' }]) {
    const { poke, timers } = world(env);
    poke.poke();
    assert.equal(poke.on, false);
    assert.equal(timers.length, 0);
  }
});

test('several pokes make one request, after the delay, to the apply workflow, with no data in it', async () => {
  const { poke, timers, sent } = world();
  poke.poke();
  poke.poke();
  poke.poke();
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, APPLY_POKE_DELAY_MS);
  assert.equal(sent.length, 0);
  await timers[0].fn();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, 'https://api.github.com/repos/owner/control/actions/workflows/apply.yml/dispatches');
  assert.equal(sent[0].init.method, 'POST');
  assert.equal(sent[0].init.body, '{"ref":"main"}');
  poke.poke();
  assert.equal(timers.length, 2, 'A poke after the send starts a new wait.');
});

test('a refused or failed request is logged without the token, and never throws', async () => {
  for (const answer of [{ ok: false, status: 403 }, new Error('network')]) {
    const { poke, timers, logs } = world(ENV, answer);
    poke.poke();
    await timers[0].fn();
    assert.equal(logs.length, 1);
    assert.ok(!logs[0].includes('a-token-value'));
  }
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'buw-poke-'));
  const fake = await startFakeS3();
  const bucket = createBucket({ bucket: fake.bucket, endpoint: fake.endpoint, credentials: fake.credentials, region: 'us-east-1' });
  fake.seed('sections/inbox/workspace.json', '{"name":"Inbox","hidden":true,"entities":[]}\n', 'application/json');
  fake.seed('state.json', '{"version":1,"cards":{}}', 'application/json');
  const sent = [];
  const fetchImpl = async (url, init) => { if (String(url).startsWith('https://api.github.com/')) { sent.push(String(url)); return { ok: true, status: 204 }; } return fetch(url, init); };
  const hubInstance = createHub({ bucket, enabled: true, env: { ...ENV, HUB_APPLY_DISPATCH_DELAY_MS: '1' }, fetchImpl });
  const server = createSiteApi({ bucket, templateDir: path.join(root, 'none'), stateFile: path.join(root, 'card-state.json'), sectionsTtl: 0, requireRemoteUser: true, hub: hubInstance, allowedOrigins: [SITE] });
  await listenOnGoodPort(server, '127.0.0.1');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const post = async (route, data) => {
    const answer = await fetch(`${origin}/api${route}`, { method: 'POST', headers: { Origin: SITE, 'Content-Type': 'application/json', 'Remote-User': 'owner' }, body: JSON.stringify(data) });
    return { status: answer.status, body: await answer.json().catch(() => null) };
  };
  return { seed: seeder(fake), post, sent, close: async () => { server.close(); await fake.close(); } };
}

test('an owner mark and an approved change list start the Action; a plain answer does not', async () => {
  const { seed, post, sent, close } = await fixture();
  try {
    const plain = askJson({ id: `${stamp}-probe-plain-a111`, now: NOW, options: threeOptions() });
    seed.ask(plain);
    assert.equal((await post(`/hub/asks/${plain.id}/answer`, { choice: 'A' })).status, 201);
    await sleep(30);
    assert.equal(sent.length, 0, 'A plain Ask changes nothing in Beads.');

    seed.beads('probe', [beadsIssue({ id: 'probe-1', title: 'a task' })], { pushedAt: NOW.toISOString(), host: 'pc.example.test', count: 1, repo: 'example/probe' });
    const marked = await post('/hub/map/probe/marks', { bead: 'probe-1', verdict: 'done' });
    assert.equal(marked.status, 201, JSON.stringify(marked.body));
    await sleep(30);
    assert.equal(sent.length, 1, 'A mark starts one run.');

    const changes = [{ op: 'close', bead: 'probe-1', reason: 'done' }];
    const plan = { ...askJson({ id: `${stamp}-probe-plan-a222`, now: NOW, kind: 'decision', allowDrawing: false, question: 'Apply this plan?' }), changes, decisions: undefined, options: undefined };
    seed.ask(plan);
    const approved = await post(`/hub/asks/${plan.id}/answer`, { decisions: { d1: { verdict: 'approve' } } });
    assert.equal(approved.status, 201, JSON.stringify(approved.body));
    await sleep(30);
    assert.equal(sent.length, 2, 'An approved change list starts one run.');
  } finally {
    await close();
  }
});
