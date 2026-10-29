// The Team routes: the agent list, statuses and the owner's avatar choice, over the stand-in S3.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSiteApi } from '../server.mjs';
import { createBucket } from '../s3.mjs';
import { createHub } from '../hub.mjs';
import { AGENTS, agentStatuses, BUILTIN_KEYS, checkAvatar } from '../hub-team.mjs';
import { BUILTIN_KEYS as CLIENT_KEYS } from '../../../src/hub/team/sprites.ts';
import { startFakeS3 } from './fake-s3.mjs';
import { eventJson, minutesAgo, pcStatusJson, seedPcStatus, seeder, teamAvatarJson } from './hub-fixtures.mjs';

const SITE = 'https://site.example';
const NOW = new Date();

async function fixture({ env = {} } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'buw-hub-team-'));
  const fake = await startFakeS3();
  const bucket = createBucket({ bucket: fake.bucket, endpoint: fake.endpoint, credentials: fake.credentials, region: 'us-east-1' });
  fake.seed('state.json', '{"version":1,"cards":{}}', 'application/json');
  const hub = createHub({ bucket, enabled: true, env });
  const server = createSiteApi({ bucket, templateDir: path.join(root, 'none'), stateFile: path.join(root, 'card-state.json'), sectionsTtl: 0, requireRemoteUser: true, hub, allowedOrigins: [SITE] });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const get = async route => { const answer = await fetch(`${origin}/api${route}`); return { status: answer.status, body: await answer.json().catch(() => null) }; };
  const post = async (route, data, user = 'owner') => {
    const answer = await fetch(`${origin}/api${route}`, {
      method: 'POST', headers: { Origin: SITE, 'Content-Type': 'application/json', ...(user ? { 'Remote-User': user } : {}) }, body: JSON.stringify(data),
    });
    return { status: answer.status, body: await answer.json().catch(() => null) };
  };
  const keys = () => [...fake.objects.keys()];
  return { fake, get, post, keys, seed: seeder(fake), close: async () => { server.close(); await fake.close(); } };
}

/** A Hermes stand-in that answers /health with no key. */
async function healthServer(status = 200) {
  let hits = 0;
  const server = createServer((request, response) => { hits += 1; response.writeHead(request.url === '/health' ? status : 404); response.end('{}'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, hits: () => hits, close: () => new Promise(resolve => server.close(resolve)) };
}

const agent = (body, id) => body.agents.find(row => row.id === id);
const pause = () => new Promise(resolve => setTimeout(resolve, 5));

test('BUILTIN_KEYS equals the client sprite list', () => {
  assert.deepEqual([...BUILTIN_KEYS].sort(), [...CLIENT_KEYS].sort());
});

test('the agent list is Hermes, Briefs and Claude Code', async () => {
  const f = await fixture();
  try {
    const { status, body } = await f.get('/hub/team');
    assert.equal(status, 200);
    assert.deepEqual(body.agents.map(row => row.id), ['hermes', 'briefs', 'claude']);
    assert.deepEqual(AGENTS.map(row => row.name), ['Hermes', 'Briefs', 'Claude Code']);
    assert.deepEqual(agent(body, 'hermes').sprite, { kind: 'builtin', key: 'hermes' }, 'No choice gives the default.');
    assert.equal(agent(body, 'claude').sprite.kind, 'random', 'Claude Code has no built-in of its own.');
    assert.equal(agent(body, 'hermes').model, 'Codex gpt-6-sol · Sonnet, then DeepSeek fallback');
    assert.equal(agent(body, 'briefs').model, 'Haiku 5.5 · DeepSeek fallback');
  } finally { await f.close(); }
});

test('an avatar choice round-trips, the newest wins, and posting the previous choice again is the undo', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.post('/hub/team/hermes/avatar', { kind: 'builtin', key: 'developer' })).status, 200);
    assert.deepEqual(agent((await f.get('/hub/team')).body, 'hermes').sprite, { kind: 'builtin', key: 'developer' });
    await pause();
    assert.equal((await f.post('/hub/team/hermes/avatar', { kind: 'random', salt: 9999 })).status, 200);
    assert.deepEqual(agent((await f.get('/hub/team')).body, 'hermes').sprite, { kind: 'random', salt: 9999, name: 'Hermes' });
    await pause();
    await f.post('/hub/team/hermes/avatar', { kind: 'builtin', key: 'developer' });
    assert.deepEqual(agent((await f.get('/hub/team')).body, 'hermes').sprite, { kind: 'builtin', key: 'developer' });
    const written = f.keys().filter(name => /sections\/inbox\/team\/hermes\/avatar-\d{8}T\d{6,9}Z-[a-z0-9]{4}\.json$/i.test(name));
    assert.equal(written.length, 3, 'Every choice is its own create-only file.');
    const first = JSON.parse(f.fake.text(written.sort()[0]));
    assert.deepEqual([first.kind, first.key, first.by], ['builtin', 'developer', 'owner']);
    assert.ok(first.at);
  } finally { await f.close(); }
});

test('a bad key, a salt out of range, a bad kind and an unknown agent are refused', async () => {
  const f = await fixture();
  try {
    for (const body of [{ kind: 'builtin', key: 'nope' }, { kind: 'builtin' }, { kind: 'random', salt: 10000 }, { kind: 'random', salt: -1 }, { kind: 'random', salt: 1.5 }, { kind: 'random', salt: '3' }, { kind: 'url', key: 'x' }, {}]) {
      assert.equal((await f.post('/hub/team/hermes/avatar', body)).status, 400, JSON.stringify(body));
    }
    assert.equal((await f.post('/hub/team/stranger/avatar', { kind: 'builtin', key: 'developer' })).status, 404);
    assert.equal((await f.post('/hub/team/..%2Fasks/avatar', { kind: 'builtin', key: 'developer' })).status, 404);
    assert.equal(f.keys().filter(name => name.includes('/team/')).length, 0, 'Nothing was written.');
  } finally { await f.close(); }
});

test('an avatar choice needs a signed-in user', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.post('/hub/team/hermes/avatar', { kind: 'builtin', key: 'qa' }, null)).status, 401);
    assert.equal(f.keys().filter(name => name.includes('/team/')).length, 0);
  } finally { await f.close(); }
});

test('a stored file that is not a valid choice is skipped, and a stray name is ignored', async () => {
  const f = await fixture();
  try {
    f.seed.put('team/briefs/avatar-20260101T000000Z-aaaa.json', teamAvatarJson({ key: 'qa' }));
    f.seed.put('team/briefs/avatar-20260102T000000Z-bbbb.json', { kind: 'builtin', key: 'nope' });
    f.seed.put('team/briefs/avatar-zzz.json', teamAvatarJson({ key: 'artist' }));
    assert.deepEqual(agent((await f.get('/hub/team')).body, 'briefs').sprite, { kind: 'builtin', key: 'qa' });
  } finally { await f.close(); }
});

test('claude statuses follow the PC status and the events', async () => {
  const f = await fixture();
  try {
    assert.equal(agent((await f.get('/hub/team')).body, 'claude').status, 'offline', 'No status and no events.');
    seedPcStatus(f.fake, pcStatusJson({ now: NOW }));
    let row = agent((await f.get('/hub/team')).body, 'claude');
    assert.equal(row.status, 'working');
    assert.match(row.task, /^2 sessions · /);
    assert.equal(row.sessions.length, 2);
    f.seed.event(eventJson({ kind: 'blocked', ts: minutesAgo(NOW, 1), session: 'pc-sess-a', host: 'test-pc', title: 'Needs a decision' }));
    row = agent((await f.get('/hub/team')).body, 'claude');
    assert.equal(row.status, 'needs-you');
  } finally { await f.close(); }
});

test('claude is idle with only idle sessions on a live PC, and offline when the status is stale', async () => {
  const f = await fixture();
  try {
    const idle = [{ id: 'pc-sess-b', name: 'Hub polish', status: 'idle', kind: 'interactive', folder: 'probe', repo: 'probe', branch: 'main' }];
    seedPcStatus(f.fake, pcStatusJson({ now: NOW, sessions: idle }));
    assert.equal(agent((await f.get('/hub/team')).body, 'claude').status, 'idle');
  } finally { await f.close(); }
  const g = await fixture();
  try {
    seedPcStatus(g.fake, pcStatusJson({ now: NOW, minutesOld: 30 }));
    const row = agent((await g.get('/hub/team')).body, 'claude');
    assert.deepEqual([row.status, row.task], ['offline', 'The PC is asleep or off']);
  } finally { await g.close(); }
});

test('Hermes: not set up is offline; healthy is idle with the last chat and cached; down or failing is offline', async () => {
  const none = await fixture();
  try {
    const row = agent((await none.get('/hub/team')).body, 'hermes');
    assert.deepEqual([row.status, row.task], ['offline', 'Not set up']);
  } finally { await none.close(); }

  const up = await healthServer(200);
  const f = await fixture({ env: { HERMES_URL: `${up.url}/` } });
  try {
    f.seed.put('chat/20260101-abcd.jsonl', '{"role":"user","text":"hi"}\n', 'application/x-ndjson');
    const row = agent((await f.get('/hub/team')).body, 'hermes');
    assert.equal(row.status, 'idle');
    assert.match(row.task, /^Last chat /);
    await f.get('/hub/team');
    assert.equal(up.hits(), 1, 'Health is cached for 60 seconds.');
  } finally { await f.close(); await up.close(); }

  const gone = await healthServer(200);
  const dead = gone.url;
  await gone.close();
  const g = await fixture({ env: { HERMES_URL: dead } });
  try {
    const row = agent((await g.get('/hub/team')).body, 'hermes');
    assert.deepEqual([row.status, row.task], ['offline', 'Not answering']);
  } finally { await g.close(); }

  const sick = await healthServer(500);
  const h = await fixture({ env: { HERMES_URL: sick.url } });
  try {
    assert.equal(agent((await h.get('/hub/team')).body, 'hermes').status, 'offline');
  } finally { await h.close(); await sick.close(); }
});

test('agentStatuses and checkAvatar on their own', () => {
  const rows = agentStatuses({ working: [], pc: null, hermes: { ok: true }, lastChat: '', at: NOW });
  assert.deepEqual(rows.map(row => row.status), ['idle', 'idle', 'offline']);
  assert.equal(rows[0].task, 'No chats yet');
  assert.deepEqual(checkAvatar({ kind: 'random', salt: 0, extra: 1 }), { kind: 'random', salt: 0 });
  assert.equal(checkAvatar(null), null);
  assert.equal(checkAvatar([]), null);
});
