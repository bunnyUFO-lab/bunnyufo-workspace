// The listing cache (list-cache.mjs) on its own, then the Hub over it: which routes repeat without a list,
// that every write clears what it covers, and that a cached read never decides a write.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSiteApi } from '../server.mjs';
import { createBucket } from '../s3.mjs';
import { createHub } from '../hub.mjs';
import { askRev } from '../hub-model.mjs';
import { createListCache } from '../list-cache.mjs';
import { startFakeS3 } from './fake-s3.mjs';
import { askJson, beadsIssue, checklistJson, eventJson, minutesAgo, pcStatusJson, requestJson, seedPcStatus, seeder, teamAvatarJson, threeOptions } from './hub-fixtures.mjs';
import { listenOnGoodPort } from '../../../server/listen.mjs';

const NOW = new Date();
const day = NOW.toISOString().slice(0, 10).replace(/-/g, '');
const SITE = 'https://site.example';
const OWNER = { 'Remote-User': 'owner' };
const isList = entry => entry.method === 'GET' && entry.key === '';

// ---- the wrapper alone ----------------------------------------------------------------------------

async function plain({ ttlMs = 15_000, ...options } = {}) {
  const fake = await startFakeS3();
  const raw = createBucket({ bucket: fake.bucket, endpoint: fake.endpoint, credentials: fake.credentials, region: 'us-east-1' });
  const clock = { time: 1_000_000 };
  const cache = createListCache({ bucket: raw, root: 'sections/inbox/', ttlMs, clock: () => clock.time, ...options });
  const lists = () => fake.log.filter(isList).length;
  return { fake, raw, cache, clock, lists, close: () => fake.close() };
}

test('1. with no TTL the bucket comes back untouched', async () => {
  const f = await plain({ ttlMs: 0 });
  try {
    assert.equal(f.cache.bucket, f.raw);
    assert.equal(await f.cache.cachedReads(() => 7), 7);
    assert.equal(await f.cache.liveReads(() => 8), 8);
    assert.equal(createListCache({ bucket: null, ttlMs: 15_000 }).bucket, null);
    assert.equal(createListCache({ bucket: f.raw, ttlMs: Number.NaN }).bucket, f.raw);
  } finally { await f.close(); }
});

test('2. only a cachedReads scope sees the cache; liveReads steps out of it and does not fill it', async () => {
  const f = await plain();
  try {
    f.fake.seed('sections/inbox/asks/a/ask.json', '{}');
    const list = () => f.cache.bucket.list('sections/inbox/asks/');
    await list(); await list();
    assert.equal(f.lists(), 2, 'Outside a scope every list is live.');
    await f.cache.cachedReads(async () => { await list(); await list(); });
    assert.equal(f.lists(), 3, 'Inside, one list serves both.');
    f.cache.clear();
    await f.cache.cachedReads(() => f.cache.liveReads(async () => { await list(); await list(); }));
    assert.equal(f.lists(), 5, 'A live scope inside a cached one lists live.');
    assert.equal(f.cache.size(), 0, 'And fills nothing.');
    await f.cache.cachedReads(async () => { await list(); await f.cache.liveReads(list); await list(); });
    assert.equal(f.lists(), 7, 'One cached fill and one live call.');
  } finally { await f.close(); }
});

test('3. a prefix outside the root is never cached', async () => {
  const f = await plain();
  try {
    await f.cache.cachedReads(async () => { await f.cache.bucket.list('sections/'); await f.cache.bucket.list('sections/'); await f.cache.bucket.list('sections/inbox-dev/'); await f.cache.bucket.list('sections/inbox-dev/'); });
    assert.equal(f.lists(), 4);
    assert.equal(f.cache.size(), 0);
  } finally { await f.close(); }
});

test('4. five concurrent lists of one prefix make one call; the delimiter is part of the key', async () => {
  const f = await plain();
  try {
    await f.cache.cachedReads(async () => {
      await Promise.all(Array.from({ length: 5 }, () => f.cache.bucket.list('sections/inbox/asks/')));
      assert.equal(f.lists(), 1);
      await f.cache.bucket.list('sections/inbox/asks/', { delimiter: '/' });
      assert.equal(f.lists(), 2);
    });
  } finally { await f.close(); }
});

test('5. a failed list is not stored: everyone sharing it gets the error and the next call lists again', async () => {
  const f = await plain();
  try {
    f.fake.fail = key => key === '';
    await f.cache.cachedReads(async () => {
      const results = await Promise.allSettled([f.cache.bucket.list('sections/inbox/asks/'), f.cache.bucket.list('sections/inbox/asks/')]);
      assert.deepEqual(results.map(r => r.status), ['rejected', 'rejected']);
      assert.equal(f.lists(), 1);
      f.fake.fail = null;
      await f.cache.bucket.list('sections/inbox/asks/');
      assert.equal(f.lists(), 2);
    });
  } finally { await f.close(); }
});

test('6. an entry lives for the TTL, counted from when its load started', async () => {
  const f = await plain();
  try {
    await f.cache.cachedReads(async () => {
      const list = () => f.cache.bucket.list('sections/inbox/asks/');
      await list();
      f.clock.time += 14_900; await list();
      assert.equal(f.lists(), 1, 'A hit at 14.9 s.');
      f.clock.time += 100; await list();
      assert.equal(f.lists(), 2, 'A miss at 15 s.');
      f.clock.time -= 20_000; await list();
      assert.equal(f.lists(), 3, 'A clock that went back is no hit.');
    });
  } finally { await f.close(); }
});

test('7. put (ok and 412), putJson, copy and del drop the listings that cover the key and keep the others', async () => {
  const f = await plain();
  try {
    f.fake.seed('sections/inbox/asks/a/ask.json', '{}');
    const { bucket } = f.cache;
    const prime = () => f.cache.cachedReads(async () => { await bucket.list('sections/inbox/asks/'); await bucket.list('sections/inbox/asks/a/'); await bucket.list('sections/inbox/events/'); });
    const left = async () => { const before = f.lists(); await prime(); return 3 - (f.lists() - before); };
    await prime();
    assert.equal(await left(), 3, 'All three were stored.');
    await bucket.put('sections/inbox/asks/b/ask.json', '{}', { ifNoneMatch: '*' });
    assert.equal(await left(), 2, 'put dropped only the asks/ listing.');
    await assert.rejects(bucket.put('sections/inbox/asks/a/ask.json', '{}', { ifNoneMatch: '*' }), error => error.status === 412);
    assert.equal(await left(), 1, 'A refused put drops too: someone else wrote.');
    await bucket.putJson('sections/inbox/events/x.json', { a: 1 });
    assert.equal(await left(), 2, 'putJson reaches the wrapped put.');
    await bucket.copy('sections/inbox/asks/b/ask.json', 'sections/inbox/asks/a/copy.json');
    assert.equal(await left(), 1, 'copy is judged by its destination.');
    await bucket.del('sections/inbox/asks/a/copy.json');
    assert.equal(await left(), 1, 'del drops the listings above the key.');
  } finally { await f.close(); }
});

test('8. a write during an in-flight list: the load is not stored and a later read lists again', async () => {
  const f = await plain();
  try {
    await f.cache.cachedReads(async () => {
      const first = f.cache.bucket.list('sections/inbox/asks/');
      await f.cache.bucket.put('sections/inbox/asks/z/ask.json', '{}');
      await first;
      assert.equal(f.cache.size(), 0, 'The overlapped load was not stored.');
      const second = await f.cache.bucket.list('sections/inbox/asks/');
      assert.equal(f.lists(), 2);
      assert.equal(second.objects.length, 1, 'It sees the write.');
    });
  } finally { await f.close(); }
});

test('9. the entry and row bounds hold; clear empties the cache', async () => {
  const f = await plain({ maxEntries: 3, maxObjects: 5 });
  try {
    await f.cache.cachedReads(async () => { for (const name of 'abcde') await f.cache.bucket.list(`sections/inbox/${name}/`); });
    assert.ok(f.cache.size() <= 3);
    f.cache.clear();
    assert.equal(f.cache.size(), 0);
    for (let n = 0; n < 6; n += 1) f.fake.seed(`sections/inbox/big/${n}.json`, '{}');
    await f.cache.cachedReads(async () => { await f.cache.bucket.list('sections/inbox/big/'); await f.cache.bucket.list('sections/inbox/big/'); });
    assert.equal(f.lists(), 7, 'A listing over maxObjects is returned and not stored.');
  } finally { await f.close(); }
});

test('10. a cached answer is frozen', async () => {
  const f = await plain();
  try {
    f.fake.seed('sections/inbox/asks/a/ask.json', '{}');
    await f.cache.cachedReads(async () => {
      const got = await f.cache.bucket.list('sections/inbox/asks/');
      assert.throws(() => got.objects.push({}), TypeError);
      assert.throws(() => { got.objects[0].key = 'x'; }, TypeError);
      assert.throws(() => got.prefixes.push('x'), TypeError);
    });
  } finally { await f.close(); }
});

// ---- the Hub over it --------------------------------------------------------------------------------

async function fixture({ inbox = 'inbox', fake: shared, clock = { time: NOW.getTime() }, cacheMs = 15_000, env = {} } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'buw-list-cache-'));
  const fake = shared ?? await startFakeS3();
  const bucket = createBucket({ bucket: fake.bucket, endpoint: fake.endpoint, credentials: fake.credentials, region: 'us-east-1' });
  fake.seed(`sections/${inbox}/workspace.json`, '{"name":"Inbox","hidden":true,"entities":[]}\n', 'application/json');
  fake.seed('state.json', '{"version":1,"cards":{}}', 'application/json');
  const logs = [];
  const hub = createHub({ bucket, enabled: true, inbox, env, log: line => logs.push(line), listCacheMs: cacheMs, now: () => new Date(clock.time) });
  const server = createSiteApi({ bucket, templateDir: path.join(root, 'none'), stateFile: path.join(root, 'card-state.json'), sectionsTtl: 0, requireRemoteUser: true, allowedOrigins: [SITE], hub });
  await listenOnGoodPort(server, '127.0.0.1');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, route, data, headers = OWNER) => {
    const answer = await fetch(`${origin}/api${route}`, {
      method, headers: { ...(method === 'GET' ? {} : { Origin: SITE }), ...(data === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
      body: data === undefined ? undefined : typeof data === 'string' ? data : JSON.stringify(data),
    });
    return { status: answer.status, body: await answer.json().catch(() => null) };
  };
  const get = (route, headers) => call('GET', route, undefined, headers);
  const post = (route, data, headers) => call('POST', route, data ?? {}, headers);
  const lists = () => fake.log.filter(isList);
  const listed = () => lists().map(entry => entry.prefix);
  return { fake, hub, clock, get, post, call, logs, lists, listed, seed: seeder(fake, `sections/${inbox}`), prefix: `sections/${inbox}`, close: async () => { server.close(); if (!shared) await fake.close(); } };
}

const NINE = ['/hub/today', '/hub/inbox', '/hub/work', '/hub/projects', '/hub/team', '/hub/events?since=2000-01-01', '/hub/search-text', '/hub/unasked', '/hub/map/mk'];

function seedEverything(f) {
  const { seed, fake } = f;
  const ask = askJson({ id: `${day}-mk-pick-a1b2`, project: 'mk', bead: 'mk-ask', now: minutesAgo(NOW, 10), options: threeOptions() });
  seed.ask(ask);
  seed.ask(askJson({ id: `${day}-mk-snz-c3d4`, project: 'mk', now: minutesAgo(NOW, 9), options: threeOptions() }), { extra: { 'snooze.json': { until: new Date(NOW.getTime() + 3_600_000).toISOString(), at: NOW.toISOString(), by: 'owner' } } });
  seed.checklist(checklistJson({ id: `${day}-mk-chk-e5f6`, project: 'mk', now: minutesAgo(NOW, 8) }), [{ item: '01' }]);
  seed.request(requestJson({ id: `${day}-mk-req-a7b8`, project: 'mk', now: minutesAgo(NOW, 7) }));
  seed.request(requestJson({ id: `${day}-only-req-a9b0`, project: 'onlyreq', now: minutesAgo(NOW, 7) }));
  seed.event(eventJson({ kind: 'pr-opened', ts: minutesAgo(NOW, 6), project: 'onlyevt', bead: 'mk-task', url: 'https://example.test/pr/1' }));
  seed.event(eventJson({ kind: 'ready-for-review', ts: minutesAgo(NOW, 5), project: 'mk', title: 'PR ready' }));
  seed.beads('mk', [
    beadsIssue({ id: 'mk-m', title: 'Milestone', type: 'milestone' }), beadsIssue({ id: 'mk-f', title: 'Feature', type: 'epic', parent: 'mk-m' }),
    beadsIssue({ id: 'mk-ask', title: 'Pick', parent: 'mk-f', labels: ['needs-owner'] }), beadsIssue({ id: 'mk-task', title: 'Task', parent: 'mk-f' }),
  ], { pushedAt: minutesAgo(NOW, 5).toISOString(), host: 'pc.example.test', count: 4, repo: 'example/mk' });
  seed.put(`bead-marks/mk/mk-task/${day}T000000000Z-done-aaaa.json`, { bead: 'mk-task', verdict: 'done', at: minutesAgo(NOW, 3).toISOString(), by: 'owner' });
  seedPcStatus(fake, pcStatusJson({ now: NOW, sessions: [{ id: 's1', status: 'busy', project: 'mk' }] }), f.prefix);
  seed.put(`team/developer/avatar-${day}T000000Z-ab12.json`, teamAvatarJson({ now: NOW }));
  return ask;
}

test('11. every cached route repeats with no list call, and /projects with no S3 call at all', async () => {
  const f = await fixture();
  try {
    seedEverything(f);
    for (const route of NINE) assert.equal((await f.get(route)).status, 200, `${route} primes`);
    for (const route of NINE) {
      const before = f.fake.log.length;
      const listsBefore = f.lists().length;
      assert.equal((await f.get(route)).status, 200, route);
      assert.equal(f.lists().length - listsBefore, 0, `${route} repeated with a list call: ${f.fake.log.slice(before).filter(isList).map(e => e.prefix)}`);
      if (route === '/hub/projects') assert.equal(f.fake.log.length - before, 0, '/projects repeats with no S3 call.');
    }
  } finally { await f.close(); }
});

test('12. a cold Today, Projects and Work together list no prefix twice', async () => {
  const f = await fixture();
  try {
    seedEverything(f);
    await Promise.all(['/hub/today', '/hub/projects', '/hub/work'].map(route => f.get(route)));
    const seen = f.listed();
    assert.deepEqual(seen.filter((prefix, index) => seen.indexOf(prefix) !== index), []);
  } finally { await f.close(); }
});

test('13. a write through this process is on the next read, with no clock change', async () => {
  const f = await fixture();
  try {
    const ask = askJson({ id: `${day}-mk-wr-a1b2`, project: 'mk', bead: 'mk-task', now: minutesAgo(NOW, 10), options: threeOptions() });
    f.seed.ask(ask);
    const list = playtestChecklist(f);
    f.seed.beads('mk', [beadsIssue({ id: 'mk-m', title: 'M', type: 'milestone' }), beadsIssue({ id: 'mk-f', title: 'F', type: 'epic', parent: 'mk-m' }), beadsIssue({ id: 'mk-task', title: 'T', parent: 'mk-f', labels: ['needs-owner'] })], { pushedAt: minutesAgo(NOW, 5).toISOString(), host: 'pc.example.test', count: 3, repo: 'example/mk' });
    const review = f.seed.event(eventJson({ kind: 'ready-for-review', ts: minutesAgo(NOW, 5), project: 'mk', title: 'PR ready' }));
    f.seed.event(eventJson({ kind: 'alert', ts: minutesAgo(NOW, 20), title: 'Brief failed', project: 'mk' }));
    const needs = async () => (await f.get('/hub/today')).body.needsYou.map(item => item.id);
    const inbox = async () => (await f.get('/hub/inbox')).body;
    const today = (await f.get('/hub/today')).body;
    assert.ok((await needs()).includes(ask.id));
    await inbox();
    const row = async () => (await f.get('/hub/map/mk')).body.milestones.flatMap(m => m.features.flatMap(x => x.tasks)).find(task => task.id === 'mk-task');
    const before = JSON.stringify(await row());

    assert.equal((await f.post(`/hub/asks/${ask.id}/answer`, { choice: 'A' })).status, 201);
    assert.ok(!(await needs()).includes(ask.id), 'The answered Ask left Today.');
    assert.ok(!(await inbox()).items.some(item => item.id === ask.id && item.state === 'open'), 'And the Inbox.');

    const done = async () => (await inbox()).items.find(item => item.id === list.id);
    assert.equal((await done()).done, 0);
    assert.equal((await f.post(`/hub/checklists/${list.id}/items/01`, { done: true })).status, 200);
    assert.equal((await done()).done, 1, 'The tick shows.');
    await f.get('/hub/projects');
    assert.equal((await f.post('/hub/requests', { project: 'brandnew', text: 'Add a thing', when: 'nightly' })).status, 201);
    assert.ok((await f.get('/hub/projects')).body.projects.some(p => p.id === 'brandnew'), 'The new project shows in /projects.');

    const key = (await f.get('/hub/today')).body.alerts[0].key;
    assert.equal((await f.post('/hub/alerts/dismiss', { keys: [key] })).status, 201);
    assert.equal((await f.get('/hub/today')).body.counts.alerts, 0);

    assert.equal((await f.post(`/hub/reviews/${review}/done`)).status, 201);
    assert.ok(!(await needs()).includes(review));

    assert.equal((await f.post('/hub/map/mk/marks', { bead: 'mk-task', verdict: 'done' })).status, 201);
    assert.notEqual(JSON.stringify(await row()), before, 'The mark shows on the map.');
    assert.ok(today);
  } finally { await f.close(); }
});

function playtestChecklist(f) {
  const list = checklistJson({ id: `${day}-mk-pl-e5f6`, project: 'mk', now: minutesAgo(NOW, 8) });
  f.seed.checklist(list);
  return list;
}

test('13b. submitting a checklist is on the next read', async () => {
  const f = await fixture();
  try {
    const list = playtestChecklist(f);
    const row = async () => (await f.get('/hub/inbox')).body.items.find(item => item.id === list.id);
    assert.equal((await row()).done, 0);
    for (let n = 1; n <= list.items.length; n += 1) assert.equal((await f.post(`/hub/checklists/${list.id}/items/${String(n).padStart(2, '0')}`, { done: true })).status, 200);
    assert.equal((await row()).done, list.items.length, 'The items show.');
    const first = (await row()).state;
    const submitted = await f.post(`/hub/checklists/${list.id}/submit`, {});
    assert.equal(submitted.status, 201, JSON.stringify(submitted.body));
    assert.notEqual((await row())?.state, first, 'The submit shows.');
  } finally { await f.close(); }
});

test('13c. a Discord answer is on the next read', async () => {
  const token = 'buwd_test-token-for-the-cache-test';
  const f = await fixture({ env: { HUB_DISCORD_TOKEN_SHA256: createHash('sha256').update(token).digest('hex'), HUB_DISCORD_OWNER_ID: '100000000000000001' } });
  try {
    const ask = askJson({ id: `${day}-mk-dc-a1b2`, project: 'mk', now: minutesAgo(NOW, 10), options: [{ id: 'A', label: 'Yes' }, { id: 'B', label: 'No' }], allowDrawing: false });
    f.seed.ask(ask);
    assert.ok((await f.get('/hub/today')).body.needsYou.some(item => item.id === ask.id));
    const body = { ask: ask.id, choice: 'A', rev: askRev(f.fake.text(`${f.prefix}/asks/${ask.id}/ask.json`)), user: '100000000000000001', interaction: '200000000000000001', message: '300000000000000001' };
    const answered = await f.call('POST', '/hub/discord/answer', body, { Authorization: `Bearer ${token}` });
    assert.equal(answered.status, 201, JSON.stringify(answered.body));
    assert.ok(!(await f.get('/hub/today')).body.needsYou.some(item => item.id === ask.id));
  } finally { await f.close(); }
});

test('14. a write from outside shows at the TTL and not before', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.get('/hub/projects')).body.projects.length, 0);
    f.seed.request(requestJson({ id: `${day}-late-req-a1b2`, project: 'late', now: NOW }));
    assert.equal((await f.get('/hub/projects')).body.projects.length, 0, 'Not inside the window.');
    f.clock.time += 14_900;
    assert.equal((await f.get('/hub/projects')).body.projects.length, 0);
    f.clock.time += 100;
    assert.deepEqual((await f.get('/hub/projects')).body.projects.map(p => p.id), ['late']);
  } finally { await f.close(); }
});

test('15. a cached read does not decide a write: every check lists live', async () => {
  const token = 'buwd_test-token-for-the-cache-test';
  const f = await fixture({ env: { HUB_DISCORD_TOKEN_SHA256: createHash('sha256').update(token).digest('hex'), HUB_DISCORD_OWNER_ID: '100000000000000001' } });
  try {
    const mk = (slug, n) => { const made = askJson({ id: `${day}-mk-${slug}-${n}`, project: 'mk', now: minutesAgo(NOW, 10), options: [{ id: 'A', label: 'Yes' }, { id: 'B', label: 'No' }], allowDrawing: false }); f.seed.ask(made); return made; };
    const cancelled = mk('canc', 'a1b2'); const answered = mk('ans', 'c3d4'); const discord = mk('dis', 'e5f6');
    const list = playtestChecklist(f);
    await f.get('/hub/today'); await f.get('/hub/inbox');

    // A refused answer first: it reads the Ask's folder, which a cached POST scope would keep.
    for (const made of [cancelled, answered]) assert.equal((await f.post(`/hub/asks/${made.id}/answer`, { choice: 'Z' })).status, 400);
    f.seed.put(`asks/${cancelled.id}/cancel.json`, { at: NOW.toISOString(), by: 'agent' });
    const one = await f.post(`/hub/asks/${cancelled.id}/answer`, { choice: 'A' });
    assert.equal(one.status, 409, JSON.stringify(one.body));
    assert.match(one.body.error, /cancel/i);

    f.seed.put(`asks/${answered.id}/answer.json`, { choice: 'B', at: NOW.toISOString(), by: 'owner' });
    const two = await f.post(`/hub/asks/${answered.id}/answer`, { choice: 'A' });
    assert.equal(two.status, 409);
    assert.equal(two.body.answer.choice, 'B', 'The winning answer comes back.');

    f.seed.submit(list.id);
    assert.equal((await f.post(`/hub/checklists/${list.id}/items/01`, { done: true })).status, 409);

    f.seed.put(`asks/${discord.id}/answer.json`, { choice: 'B', at: NOW.toISOString(), by: 'owner' });
    const rev = askRev(f.fake.text(`${f.prefix}/asks/${discord.id}/ask.json`));
    const three = await f.call('POST', '/hub/discord/answer', { ask: discord.id, choice: 'A', rev, user: '100000000000000001', interaction: '200000000000000001', message: '300000000000000001' }, { Authorization: `Bearer ${token}` });
    assert.equal(three.status, 409);
  } finally { await f.close(); }
});

test('16. two callers get the same body from one cached listing', async () => {
  const f = await fixture();
  try {
    seedEverything(f);
    for (const route of ['/hub/today', '/hub/team', '/hub/projects']) {
      const alice = await f.get(route, { 'Remote-User': 'alice' });
      const before = f.lists().length;
      const bob = await f.get(route, { 'Remote-User': 'bob' });
      assert.equal(f.lists().length, before, `${route}: bob lists nothing.`);
      assert.deepEqual(bob.body, alice.body, route);
    }
  } finally { await f.close(); }
});

test('17. the page-load kicks run live, on every read', async () => {
  const f = await fixture();
  try {
    let calls = 0;
    const kicks = [];
    const eventsPrefix = `${f.prefix}/events/${new Date(f.clock.time).toISOString().slice(0, 10)}/`;
    f.hub.policy.pageLoad = () => { calls += 1; kicks.push(f.hub.listCache.bucket.list(eventsPrefix)); };
    await f.get('/hub/today'); await f.get('/hub/today');
    await Promise.all(kicks);
    assert.equal(calls, 2);
    assert.equal(f.listed().filter(prefix => prefix === eventsPrefix).length, 3, 'One cached load plus one live list per kick.');
  } finally { await f.close(); }
});

test('18. two sections on one bucket do not cross', async () => {
  const fake = await startFakeS3();
  const real = await fixture({ fake });
  const dev = await fixture({ fake, inbox: 'inbox-dev' });
  try {
    await real.get('/hub/projects'); await dev.get('/hub/projects');
    const before = fake.log.length;
    assert.equal((await dev.post('/hub/requests', { project: 'devonly', text: 'Add a thing', when: 'nightly' })).status, 201);
    const after = fake.log.length;
    const repeat = await real.get('/hub/projects');
    assert.equal(fake.log.slice(after).filter(isList).length, 0, 'The other section still repeats from its cache.');
    assert.equal(repeat.body.projects.length, 0);
    assert.ok(after > before);
  } finally { await real.close(); await dev.close(); await fake.close(); }
});

test('19. /projects reads no snooze, no result and no workspace.json, and gives the same projects', async () => {
  const f = await fixture();
  try {
    const ask = askJson({ id: `${day}-snz-ask-a1b2`, project: 'snz', now: minutesAgo(NOW, 10), options: threeOptions() });
    f.seed.ask(ask, { extra: { 'snooze.json': { until: new Date(NOW.getTime() + 3_600_000).toISOString(), at: NOW.toISOString(), by: 'owner' } } });
    const req = requestJson({ id: `${day}-fromreq-a1b2`, project: 'fromreq', now: minutesAgo(NOW, 5) });
    f.seed.request(req);
    f.seed.put(`requests/${req.id}/approved.json`, { v: 1, request: req.id, target: 'pc' });
    f.seed.put(`requests/${req.id}/result.json`, { outcome: 'done', summary: 'x' });
    f.fake.seed('sections/bunnylink/workspace.json', '{"tracked":{"repo":"example/probe"}}', 'application/json');
    f.seed.event(eventJson({ kind: 'pr-opened', ts: minutesAgo(NOW, 6), project: 'fromevt' }));
    f.seed.event(eventJson({ kind: 'pr-opened', ts: minutesAgo(NOW, 6), project: 'wt-alpha-0a1b2c' }));
    f.seed.beads('withbeads', [beadsIssue({ id: 'wb-1' })], { pushedAt: NOW.toISOString(), host: 'pc.example.test', count: 1, repo: 'example/wb' });
    f.fake.log.length = 0;
    const answer = await f.get('/hub/projects');
    assert.equal(answer.status, 200);
    const reads = f.fake.log.filter(e => e.method === 'GET' && e.key).map(e => e.key);
    assert.deepEqual(reads.filter(key => /snooze\.json|result\.json|approved\.json|bunnylink\/workspace\.json/.test(key)), []);
    assert.deepEqual(answer.body.projects.map(p => p.id).sort(), ['fromevt', 'fromreq', 'snz', 'withbeads'], 'A worktree-named id stays out.');
    assert.equal(answer.body.projects.find(p => p.id === 'withbeads').beads, true);
  } finally { await f.close(); }
});

test('20. search-text with no project lists nothing under asks, checklists, requests or events, and keeps every Beads project', async () => {
  const f = await fixture();
  try {
    seedEverything(f);
    f.seed.beads('other', [beadsIssue({ id: 'ot-1', title: 'Other thing' })], { pushedAt: NOW.toISOString(), host: 'pc.example.test', count: 1, repo: 'example/ot' });
    f.fake.log.length = 0;
    const answer = await f.get('/hub/search-text');
    assert.equal(answer.status, 200);
    assert.deepEqual(f.listed().filter(prefix => /\/(asks|checklists|requests|events)\//.test(prefix)), []);
    assert.deepEqual([...new Set(answer.body.rows.map(row => row.project))].sort(), ['mk', 'other']);
  } finally { await f.close(); }
});
