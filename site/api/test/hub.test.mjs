// The Hub's routes on the published site's API, over the stand-in S3.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSiteApi } from '../server.mjs';
import { createBucket } from '../s3.mjs';
import { createHub, inboxKey } from '../hub.mjs';
import { askState, isBareClaudeCode } from '../hub-model.mjs';
import { startFakeS3 } from './fake-s3.mjs';
import { png } from './png.mjs';
import { askJson, cujTwo, eventJson, minutesAgo, requestJson, seeder, threeOptions } from './hub-fixtures.mjs';

const scene = (elements = []) => JSON.stringify({ type: 'excalidraw', version: 2, source: 'test', elements, appState: {}, files: {} });
const NOW = new Date();
const id = (slug, n = 'a1b2') => `${NOW.toISOString().slice(0, 10).replace(/-/g, '')}-probe-${slug}-${n}`;

async function fixture({ hub = true, requireRemoteUser = true, hubOptions = {} } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'buw-hub-'));
  const fake = await startFakeS3();
  const bucket = createBucket({ bucket: fake.bucket, endpoint: fake.endpoint, credentials: fake.credentials, region: 'us-east-1' });
  fake.seed('sections/inbox/workspace.json', '{"name":"Inbox","hidden":true,"entities":[]}\n', 'application/json');
  fake.seed('state.json', '{"version":1,"cards":{}}', 'application/json');
  const hubInstance = createHub({ bucket, enabled: hub, ...hubOptions });
  const server = createSiteApi({ bucket, templateDir: path.join(root, 'none'), stateFile: path.join(root, 'card-state.json'), sectionsTtl: 0, requireRemoteUser, hub: hubInstance });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const call = (method, route, data, headers = {}) => fetch(`${origin}/api${route}`, {
    method, headers: { ...(data === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    body: data === undefined ? undefined : typeof data === 'string' ? data : JSON.stringify(data),
  });
  const get = async route => { const answer = await call('GET', route); return { status: answer.status, body: await answer.json().catch(() => null) }; };
  const post = async (route, data, headers = { 'Remote-User': 'owner' }) => { const answer = await call('POST', route, data ?? {}, headers); return { status: answer.status, body: await answer.json().catch(() => null) }; };
  const close = async () => { server.close(); await fake.close(); };
  return { fake, seed: seeder(fake), get, post, call, origin, close };
}

test('askState: each row of the table, top to bottom, the first match winning', () => {
  const now = new Date('2026-10-26T12:00:00Z');
  const ask = { expiresAt: '2026-10-30T00:00:00Z' };
  const future = { until: '2026-10-26T13:00:00Z' };
  const past = { until: '2026-10-26T11:00:00Z' };
  assert.equal(askState(['cancel.json', 'answer.json', 'pickup.json'], ask, now).state, 'cancelled');
  assert.equal(askState(['answer.json', 'pickup.json'], ask, now).state, 'picked-up');
  assert.equal(askState(['answer.json', 'snooze.json'], ask, now, future).state, 'answered');
  assert.deepEqual(askState(['snooze.json'], ask, now, future), { state: 'snoozed', snoozedUntil: future.until });
  assert.equal(askState(['snooze.json'], ask, now, past).state, 'open', 'A snooze that ran out no longer counts.');
  assert.equal(askState(['snooze.json'], { expiresAt: '2026-10-25T00:00:00Z' }, now, past).state, 'expired');
  assert.equal(askState([], { expiresAt: '2026-10-25T00:00:00Z' }, now).state, 'expired');
  assert.equal(askState([], ask, now).state, 'open');
});

test('the Ask states through the API, including cancel + answer → cancelled', async () => {
  const { seed, get, close } = await fixture();
  try {
    const cases = {
      open: {}, answered: { 'answer.json': { at: 'x', by: 'o', choice: 'A' } }, 'picked-up': { 'answer.json': {}, 'pickup.json': { at: 'x', host: 'h' } },
      cancelled: { 'answer.json': {}, 'cancel.json': { at: 'x', by: 'o' } }, snoozed: { 'snooze.json': { at: 'x', by: 'o', until: new Date(Date.now() + 3600000).toISOString() } },
    };
    let n = 0;
    for (const [state, files] of Object.entries(cases)) {
      const ask = askJson({ id: id('state', `s${++n}${n}${n}${n}`.slice(0, 4)), now: NOW, options: threeOptions() });
      seed.ask(ask, { files });
      const got = await get(`/hub/asks/${ask.id}`);
      assert.equal(got.status, 200);
      assert.equal(got.body.state, state);
      assert.ok(got.body.files.includes('ask.json'));
    }
    const old = askJson({ id: id('old', 'z111'), now: new Date(NOW.getTime() - 10 * 86400000), expiresInDays: 7 });
    seed.ask(old);
    assert.equal((await get(`/hub/asks/${old.id}`)).body.state, 'expired');
    assert.equal((await get('/hub/asks/nope')).status, 404);
  } finally { await close(); }
});

test('an answer is created once, keeps the first answer on a second try, and refuses a cancelled Ask', async () => {
  const { fake, seed, post, get, close } = await fixture();
  try {
    const ask = askJson({ id: id('arc'), now: NOW, options: threeOptions() });
    seed.ask(ask);
    const first = await post(`/hub/asks/${ask.id}/answer`, { choice: 'B', note: 'shorter hang' });
    assert.equal(first.status, 201);
    assert.equal(first.body.state, 'answered');
    assert.equal(fake.json(`sections/inbox/asks/${ask.id}/answer.json`).by, 'owner');
    assert.equal(fake.json(`sections/inbox/asks/${ask.id}/answer.json`).choice, 'B');
    assert.equal((await get(`/hub/asks/${ask.id}`)).body.state, 'answered');
    const second = await post(`/hub/asks/${ask.id}/answer`, { choice: 'C' });
    assert.equal(second.status, 409);
    assert.equal(second.body.answer.choice, 'B');
    assert.equal(fake.json(`sections/inbox/asks/${ask.id}/answer.json`).choice, 'B');

    const dead = askJson({ id: id('dead', 'd111'), now: NOW, options: threeOptions() });
    seed.ask(dead, { files: { 'cancel.json': { at: 'x', by: 'agent' } } });
    const refused = await post(`/hub/asks/${dead.id}/answer`, { choice: 'A' });
    assert.equal(refused.status, 409);
    assert.match(refused.body.error, /cancelled/);

    const ran = askJson({ id: id('late', 'l111'), now: new Date(NOW.getTime() - 9 * 86400000) });
    seed.ask(ran);
    const expired = await post(`/hub/asks/${ran.id}/answer`, { note: 'hi' });
    assert.equal(expired.status, 409);
    assert.match(expired.body.error, /expired.*ran out at/);
  } finally { await close(); }
});

test('an answer with a drawing writes the scene and the picture before answer.json', async () => {
  const { fake, seed, post, close } = await fixture();
  try {
    const ask = askJson({ id: id('draw'), now: NOW, options: threeOptions() });
    seed.ask(ask);
    const answer = await post(`/hub/asks/${ask.id}/answer`, { choice: 'B', drawing: { scene: scene([{ type: 'rectangle', id: 'r' }]), png: png(200, 100, 40).toString('base64') } });
    assert.equal(answer.status, 201);
    assert.deepEqual(answer.body.answer.drawing, { excalidraw: 'answer.excalidraw', png: 'answer.png' });
    const writes = fake.log.filter(entry => entry.method === 'PUT' && entry.key.includes(`asks/${ask.id}/answer`)).map(entry => entry.key.split('/').pop());
    assert.deepEqual(writes, ['answer.excalidraw', 'answer.png', 'answer.json']);
    assert.equal(fake.objects.get(`sections/inbox/asks/${ask.id}/answer.png`).contentType, 'image/png');
    assert.equal(fake.objects.get(`sections/inbox/asks/${ask.id}/b.png`).body.length > 24, true, 'The option picture is untouched.');
  } finally { await close(); }
});

test('drawing files left by a failed answer do not block the next answer, and a real answer still wins', async () => {
  const { fake, seed, post, close } = await fixture();
  try {
    const ask = askJson({ id: id('stuck'), now: NOW, options: threeOptions() });
    seed.ask(ask);
    const base = `sections/inbox/asks/${ask.id}`;
    fake.seed(`${base}/answer.excalidraw`, scene([{ type: 'rectangle', id: 'old' }]), 'application/json');
    fake.seed(`${base}/answer.png`, png(10, 10, 1), 'image/png');
    const drawing = { scene: scene([{ type: 'rectangle', id: 'new' }]), png: png(200, 100, 40).toString('base64') };
    const answer = await post(`/hub/asks/${ask.id}/answer`, { choice: 'B', drawing });
    assert.equal(answer.status, 201, 'No answer.json exists, so the leftover drawing is overwritten.');
    assert.match(fake.text(`${base}/answer.excalidraw`), /"new"/);
    assert.deepEqual(fake.json(`${base}/answer.json`).drawing, { excalidraw: 'answer.excalidraw', png: 'answer.png' });
    const late = await post(`/hub/asks/${ask.id}/answer`, { choice: 'A', drawing });
    assert.equal(late.status, 409);
    assert.equal(late.body.answer.choice, 'B');
    // Drawing files written by a rival whose answer.json already exists are not overwritten.
    const other = askJson({ id: id('rival', 'c3d4'), now: NOW, options: threeOptions() });
    seed.ask(other);
    const rival = `sections/inbox/asks/${other.id}`;
    fake.seed(`${rival}/answer.excalidraw`, scene([{ type: 'rectangle', id: 'theirs' }]), 'application/json');
    fake.seed(`${rival}/answer.json`, JSON.stringify({ at: NOW.toISOString(), by: 'x', choice: 'A' }), 'application/json');
    assert.equal((await post(`/hub/asks/${other.id}/answer`, { choice: 'B', drawing })).status, 409);
    assert.match(fake.text(`${rival}/answer.excalidraw`), /"theirs"/);
  } finally { await close(); }
});

test('an answer is checked: a bad choice, a note when none is allowed, a drawing when none is allowed, an empty answer', async () => {
  const { seed, post, close } = await fixture();
  try {
    const ask = askJson({ id: id('rules'), now: NOW, options: threeOptions(), allowNote: false, allowDrawing: false });
    seed.ask(ask);
    assert.equal((await post(`/hub/asks/${ask.id}/answer`, { choice: 'Z' })).status, 400);
    assert.equal((await post(`/hub/asks/${ask.id}/answer`, { note: 'x' })).status, 400);
    assert.equal((await post(`/hub/asks/${ask.id}/answer`, { choice: 'A', drawing: { scene: scene(), png: png(10, 10).toString('base64') } })).status, 400);
    assert.equal((await post(`/hub/asks/${ask.id}/answer`, {})).status, 400);
    const open = askJson({ id: id('open', 'o111'), now: NOW, allowNote: true });
    seed.ask(open);
    assert.equal((await post(`/hub/asks/${open.id}/answer`, { note: 'x'.repeat(4001) })).status, 400);
    assert.equal((await post(`/hub/asks/${open.id}/answer`, { note: 'fine' })).status, 201);
  } finally { await close(); }
});

test('snooze twice: the second write is conditional on the first', async () => {
  const { fake, seed, post, get, close } = await fixture();
  try {
    const ask = askJson({ id: id('nap'), now: NOW });
    seed.ask(ask);
    const first = await post(`/hub/asks/${ask.id}/snooze`, { hours: 2 });
    assert.equal(first.status, 200);
    assert.equal(first.body.state, 'snoozed');
    assert.equal((await get(`/hub/asks/${ask.id}`)).body.state, 'snoozed');
    const second = await post(`/hub/asks/${ask.id}/snooze`, {});
    assert.equal(second.status, 200);
    const puts = fake.log.filter(entry => entry.method === 'PUT' && entry.key.endsWith(`${ask.id}/snooze.json`));
    assert.equal(puts.length, 2);
    assert.equal(puts[0].headers['if-none-match'], '*');
    assert.ok(puts[1].headers['if-match'], 'The second write replaces only the version it read.');
    assert.equal((await post(`/hub/asks/${ask.id}/snooze`, { hours: 25 })).status, 400);
    assert.equal((await post(`/hub/asks/${ask.id}/cancel`)).status, 200);
    assert.equal((await post(`/hub/asks/${ask.id}/cancel`)).status, 409);
    assert.equal((await post(`/hub/asks/${ask.id}/snooze`, {})).status, 409);
  } finally { await close(); }
});

test('a request is created, listed as open, and taken once an agent writes taken.json', async () => {
  const { fake, post, get, close } = await fixture();
  try {
    const made = await post('/hub/requests', { project: 'probe', text: 'Add a token vault for the secret password', when: 'next-sprint' });
    assert.equal(made.status, 201);
    assert.match(made.body.id, /^\d{8}-probe-add-a-vault-for-the-[a-z0-9]{4}$/, 'Words that look like secrets are dropped from the id.');
    const stored = fake.json(`sections/inbox/requests/${made.body.id}/request.json`);
    assert.equal(stored.by, 'owner');
    assert.equal(stored.when, 'next-sprint');
    let list = (await get('/hub/inbox?filter=requests')).body.items;
    assert.deepEqual(list.map(item => [item.kind, item.id, item.state]), [['request', made.body.id, 'open']]);
    fake.seed(`sections/inbox/requests/${made.body.id}/taken.json`, JSON.stringify({ at: 'x', host: 'h', bead: 'bd-9' }), 'application/json');
    list = (await get('/hub/inbox?filter=requests')).body.items;
    assert.deepEqual([list[0].state, list[0].bead], ['taken', 'bd-9']);
    assert.equal((await post('/hub/requests', { project: 'Bad Project', text: 'x', when: 'nightly' })).status, 400);
    assert.equal((await post('/hub/requests', { project: 'probe', text: '', when: 'nightly' })).status, 400);
    assert.equal((await post('/hub/requests', { project: 'probe', text: 'x', when: 'someday' })).status, 400);
  } finally { await close(); }
});

test('a request with a drawing keeps its scene and picture beside it', async () => {
  const { fake, post, close } = await fixture();
  try {
    const made = await post('/hub/requests', { project: 'probe', text: 'Make it look like this', when: 'record', drawing: { scene: scene(), png: png(64, 64).toString('base64') } });
    assert.equal(made.status, 201);
    const folder = `sections/inbox/requests/${made.body.id}`;
    assert.ok(fake.objects.has(`${folder}/request.excalidraw`) && fake.objects.has(`${folder}/request.png`));
    assert.deepEqual(fake.json(`${folder}/request.json`).drawing, { excalidraw: 'request.excalidraw', png: 'request.png' });
  } finally { await close(); }
});

test('Today and the Inbox: needs you, running and recent come from a seven-day window of events', async () => {
  const { seed, get, close } = await fixture();
  try {
    const ask = askJson({ id: id('today'), now: NOW, bead: 'bd-1' });
    seed.ask(ask);
    seed.event(eventJson({ kind: 'ready-for-review', ts: minutesAgo(NOW, 30), bead: 'bd-2', title: 'Review me', url: 'https://example.test/pr/2' }));
    seed.event(eventJson({ kind: 'blocked', ts: minutesAgo(NOW, 20), session: 'sess-b', title: 'Needs a permission' }));
    seed.event(eventJson({ kind: 'session-started', ts: new Date(NOW.getTime() - 2 * 86400000), session: 'sess-old', title: 'Old session' }));
    seed.event(eventJson({ kind: 'deployed', ts: new Date(NOW.getTime() - 3 * 86400000), title: 'Three days ago' }));
    seed.event(eventJson({ kind: 'alert', ts: minutesAgo(NOW, 10), title: 'Disk almost full' }));
    let today = (await get('/hub/today')).body;
    assert.equal(today.counts.needsYou, 3);
    assert.deepEqual(today.needsYou.map(item => item.kind), ['ask', 'review', 'blocked']);
    assert.equal(today.needsYou[2].url, undefined, 'A blocked item with no link has none; the bare claude.ai/code is gone.');
    assert.equal(today.needsYou[1].url, 'https://example.test/pr/2');
    assert.deepEqual(today.running.map(item => item.id), ['sess-old']);
    assert.match(today.running[0].title, /running since \d\d:\d\d$/);
    assert.ok(!today.recent.some(event => event.title === 'Three days ago'), 'Not in the last 24 hours.');
    assert.equal(today.counts.alerts, 1);
    assert.deepEqual((await get('/hub/inbox')).body.items.map(item => item.kind), ['ask', 'review', 'blocked']);
    assert.deepEqual((await get('/hub/inbox?filter=reviews')).body.items.map(item => item.id).length, 1);

    seed.event(eventJson({ kind: 'pr-merged', ts: minutesAgo(NOW, 5), bead: 'bd-2' }));
    seed.event(eventJson({ kind: 'session-ended', ts: minutesAgo(NOW, 4), session: 'sess-b' }));
    today = (await get('/hub/today')).body;
    assert.equal(today.counts.needsYou, 1);
    assert.deepEqual((await get('/hub/inbox?filter=blocked')).body.items, []);
    const events = (await get(`/hub/events?since=${encodeURIComponent(new Date(NOW.getTime() - 4 * 86400000).toISOString())}`)).body;
    assert.ok(events.events.some(event => event.title === 'Three days ago'));
    assert.equal(events.truncated, false);
    assert.equal((await get('/hub/events?project=nothing')).body.events.length, 0);
  } finally { await close(); }
});

test("a blocked item clears on its own session's next event, not another's", async () => {
  const { fake, seed, get, close } = await fixture();
  const APP = 'claude://claude.ai/epitaxy/local_00000000-0000-0000-0000-000000000001';
  const LINK = 'https://claude.ai/code/session_TESTabc123';
  const blocked = async hub => (await hub('/hub/inbox?filter=blocked')).body.items;
  const check = async hub => {
    const items = await blocked(hub);
    const by = session => items.filter(item => item.session === session);
    return { items, by };
  };
  try {
    seed.event(eventJson({ kind: 'session-started', ts: minutesAgo(NOW, 25), session: 'sess-b', title: 'B started' }));
    seed.event(eventJson({ kind: 'blocked', ts: minutesAgo(NOW, 20), session: 'sess-a', title: 'A needs a permission', url: LINK, appUrl: APP }));
    seed.event(eventJson({ kind: 'blocked', ts: minutesAgo(NOW, 18), session: 'sess-b', title: 'B needs a permission', url: 'https://claude.ai/code' }));
    seed.event(eventJson({ kind: 'blocked', ts: minutesAgo(NOW, 30), session: 'sess-c', title: 'C first' }));
    seed.event(eventJson({ kind: 'blocked', ts: minutesAgo(NOW, 8), session: 'sess-c', title: 'C again' }));
    let { items, by } = await check(get);
    assert.equal(items.length, 3);
    assert.equal(by('sess-a')[0].url, LINK);
    assert.equal(by('sess-a')[0].appUrl, APP);
    assert.equal(by('sess-b')[0].url, undefined, 'The bare link is no link, and the earlier session-started does not clear it.');
    assert.equal(by('sess-b')[0].appUrl, undefined);
    assert.equal(by('sess-c').length, 1);
    assert.equal(by('sess-c')[0].title, 'C again');
    assert.equal(new Set(items.map(item => item.id)).size, 3, 'One id per session.');

    seed.event(eventJson({ kind: 'resumed', ts: minutesAgo(NOW, 10), session: 'sess-a', title: 'A is back at work' }));
    seed.event(eventJson({ kind: 'alert', ts: minutesAgo(NOW, 9), session: 'sess-x', title: 'Another session speaks' }));
    ({ items, by } = await check(get));
    assert.deepEqual(items.map(item => item.session).sort(), ['sess-b', 'sess-c']);

    seed.event(eventJson({ kind: 'pr-opened', ts: minutesAgo(NOW, 5), session: 'sess-b', title: 'B opens a pull request' }));
    ({ items } = await check(get));
    assert.deepEqual(items.map(item => item.session), ['sess-c'], 'Any kind of later event clears it.');

    // A new Hub on the same bucket has no cache to lean on: the state is in the files.
    const server = createSiteApi({ bucket: createBucket({ bucket: fake.bucket, endpoint: fake.endpoint, credentials: fake.credentials, region: 'us-east-1' }), templateDir: path.join(tmpdir(), 'none'), stateFile: path.join(tmpdir(), `buw-state-${Date.now()}.json`), sectionsTtl: 0, requireRemoteUser: true, hub: createHub({ bucket: createBucket({ bucket: fake.bucket, endpoint: fake.endpoint, credentials: fake.credentials, region: 'us-east-1' }), enabled: true }) });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const fresh = async route => ({ body: await (await fetch(`http://127.0.0.1:${server.address().port}/api${route}`)).json() });
      assert.deepEqual((await blocked(fresh)).map(item => item.session), ['sess-c']);
    } finally { server.close(); }
  } finally { await close(); }
});

test('a blocked item passes on only a real session link and an app link of the exact form', async () => {
  const { seed, get, close } = await fixture();
  try {
    const OK_APP = 'claude://claude.ai/epitaxy/local_00000000-0000-0000-0000-000000000002';
    seed.event(eventJson({ kind: 'blocked', ts: minutesAgo(NOW, 30), session: 's1', title: 'Evil app link', appUrl: 'claude://evil/x', url: 'http://claude.ai/code/session_TESTabc123' }));
    seed.event(eventJson({ kind: 'blocked', ts: minutesAgo(NOW, 29), session: 's2', title: 'Script link', appUrl: 'javascript:alert(1)', url: 'https://claude.ai/code/' }));
    seed.event(eventJson({ kind: 'blocked', ts: minutesAgo(NOW, 28), session: 's3', title: 'Good links', appUrl: OK_APP, url: 'https://claude.ai/code/session_TESTabc123' }));
    const items = (await get('/hub/inbox?filter=blocked')).body.items;
    const by = session => items.find(item => item.session === session);
    assert.equal(items.length, 3);
    for (const session of ['s1', 's2']) {
      assert.equal(by(session).url, undefined, session);
      assert.equal(by(session).appUrl, undefined, session);
    }
    assert.equal(by('s3').url, 'https://claude.ai/code/session_TESTabc123');
    assert.equal(by('s3').appUrl, OK_APP);
    assert.equal(isBareClaudeCode('https://claude.ai/code'), true);
    assert.equal(isBareClaudeCode('https://claude.ai/code/'), true);
    assert.equal(isBareClaudeCode('https://claude.ai/code/session_TESTabc123'), false);
  } finally { await close(); }
});

test('the Inbox filters: asks, answered, requests', async () => {
  const { seed, get, close } = await fixture();
  try {
    const open = askJson({ id: id('one', 'a111'), now: NOW });
    const answered = askJson({ id: id('two', 'a222'), now: NOW });
    const taken = askJson({ id: id('three', 'a333'), now: NOW });
    const dead = askJson({ id: id('four', 'a444'), now: NOW });
    seed.ask(open);
    seed.ask(answered, { files: { 'answer.json': { at: 'x', by: 'o' } } });
    seed.ask(taken, { files: { 'answer.json': {}, 'pickup.json': {} } });
    seed.ask(dead, { files: { 'cancel.json': {} } });
    seed.request(requestJson({ id: id('req', 'r111'), now: NOW }));
    const ids = async filter => (await get(`/hub/inbox?filter=${filter}`)).body.items.map(item => item.id).sort();
    assert.deepEqual(await ids('asks'), [open.id, answered.id].sort());
    assert.deepEqual(await ids('answered'), [answered.id, taken.id].sort());
    assert.deepEqual(await ids('needs-you'), [open.id]);
    assert.deepEqual(await ids('requests'), [id('req', 'r111')]);
  } finally { await close(); }
});

test('projects, Beads and the map', async () => {
  const { seed, get, close } = await fixture();
  try {
    const { issues, events } = cujTwo({ now: NOW });
    const meta = { pushedAt: minutesAgo(NOW, 20).toISOString(), host: 'pc.example.test', count: issues.length, repo: 'example/ml' };
    // A memory line and a bad line are skipped; the issues are kept.
    const lines = [JSON.stringify({ _type: 'memory', id: 'mem' }), 'not json', ...issues.map(line => JSON.stringify(line))];
    seed.put('beads/magic-loops.jsonl', lines.join(String.fromCharCode(10)) + String.fromCharCode(10), 'application/x-ndjson');
    seed.put('beads/magic-loops.meta.json', meta);
    for (const event of events) seed.event(event);
    seed.ask(askJson({ id: id('mapask', 'm111'), now: NOW, project: 'probe' }));
    const projects = (await get('/hub/projects')).body.projects;
    assert.deepEqual(projects.map(item => [item.id, item.name, item.beads]), [['magic-loops', 'Magic Loops', true], ['probe', 'Probe', false]]);
    assert.ok(projects[0].pushedAt);
    const beads = (await get('/hub/beads/magic-loops')).body;
    assert.equal(beads.issues.length, issues.length);
    assert.equal(beads.meta.repo, 'example/ml');
    assert.deepEqual((await get('/hub/beads/probe')).body, { meta: null, issues: [] });
    const map = (await get('/hub/map/magic-loops')).body;
    assert.equal(map.ageMinutes, 20);
    assert.equal(map.milestones.length, 3);
    assert.deepEqual(map.sprints, [{ name: 'sprint-3', milestones: [{ id: 'ml-m2', count: 4, total: 7 }] }]);
    assert.deepEqual((await get('/hub/map/probe')).body.milestones, []);
    assert.equal((await get('/hub/map/Bad_Id')).status, 404);
  } finally { await close(); }
});

test('drawings: a draft is created, listed, read, replaced on its etag and refused when stale', async () => {
  const { fake, post, get, close } = await fixture();
  try {
    const first = scene([{ type: 'rectangle', id: 'a' }]);
    const created = await post('/hub/drawings', { scene: first, png: png(100, 80).toString('base64') });
    assert.equal(created.status, 201);
    const draft = created.body.id;
    assert.match(draft, /^\d{8}-[a-z0-9]{6}$/);
    assert.ok(fake.objects.has(`sections/inbox/drawings/${draft}/drawing.png`));
    assert.deepEqual((await get('/hub/drawings')).body.drawings.map(item => [item.id, item.hasPng]), [[draft, true]]);
    const read = (await get(`/hub/drawings/${draft}`)).body;
    assert.equal(read.text, first);
    const second = scene([{ type: 'rectangle', id: 'a' }, { type: 'ellipse', id: 'b' }]);
    const saved = await post(`/hub/drawings/${draft}`, { scene: second, png: png(100, 80).toString('base64'), base: read.etag });
    assert.equal(saved.status, 200);
    const stale = await post(`/hub/drawings/${draft}`, { scene: first, png: png(100, 80).toString('base64'), base: read.etag });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.current.text, second);
    assert.equal((await post(`/hub/drawings/${draft}`, { scene: 'nope', png: 'x', base: saved.body.etag })).status, 400);
    assert.equal((await post('/hub/drawings/20260101-zzzzzz', { scene: first, png: png(10, 10).toString('base64'), base: 'x' })).status, 404);
  } finally { await close(); }
});

test('a review leaves Needs you once it is marked done, and stays gone', async () => {
  const { fake, seed, get, post, close } = await fixture();
  try {
    const withUrl = seed.event(eventJson({ kind: 'ready-for-review', ts: minutesAgo(NOW, 30), title: 'Has a link', url: 'https://example.test/pr/9' }));
    const withCard = seed.event(eventJson({ kind: 'ready-for-review', ts: minutesAgo(NOW, 20), title: 'Has a report', card: 'https://example.test/section#/card' }));
    const bare = seed.event(eventJson({ kind: 'ready-for-review', ts: minutesAgo(NOW, 10), title: 'Has nothing' }));
    const reviews = async () => (await get('/hub/today')).body.needsYou.filter(item => item.kind === 'review');
    const before = await reviews();
    assert.deepEqual(before.map(item => item.id).sort(), [bare, withCard, withUrl].sort());
    assert.equal(before.find(item => item.id === withCard).card, 'https://example.test/section#/card');
    assert.equal(before.find(item => item.id === withUrl).card, undefined);
    const doneKeys = () => fake.log.filter(entry => entry.method === 'PUT').map(entry => entry.key);
    fake.log.length = 0;

    const first = await post(`/hub/reviews/${withCard}/done`);
    assert.equal(first.status, 201);
    assert.deepEqual(first.body, { state: 'done' });
    const written = doneKeys();
    assert.equal(written.length, 1);
    assert.match(written[0], /^sections\/inbox\/events\/\d{4}-\d\d-\d\d\/\d{6}-hub-[a-z0-9]{4}\.json$/);
    const event = fake.json(written[0]);
    assert.equal(event.kind, 'review-done');
    assert.equal(event.review, withCard);
    assert.equal(event.title, 'Done: Has a report');
    assert.equal(event.by, 'owner');
    assert.equal(event.source, 'hub');

    assert.deepEqual((await reviews()).map(item => item.id).sort(), [bare, withUrl].sort());
    assert.deepEqual((await get('/hub/inbox?filter=reviews')).body.items.map(item => item.id).sort(), [bare, withUrl].sort());
    assert.equal((await get('/hub/today')).body.counts.needsYou, 2);
    // A new Hub on the same bucket has no cache to lean on.
    const other = createHub({ bucket: createBucket({ bucket: fake.bucket, endpoint: fake.endpoint, credentials: fake.credentials, region: 'us-east-1' }), enabled: true });
    const server = createSiteApi({ bucket: createBucket({ bucket: fake.bucket, endpoint: fake.endpoint, credentials: fake.credentials, region: 'us-east-1' }), templateDir: path.join(tmpdir(), 'none'), stateFile: path.join(tmpdir(), `buw-state-${Date.now()}.json`), sectionsTtl: 0, requireRemoteUser: true, hub: other });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const fresh = await (await fetch(`http://127.0.0.1:${server.address().port}/api/hub/inbox?filter=reviews`)).json();
      assert.deepEqual(fresh.items.map(item => item.id).sort(), [bare, withUrl].sort());
    } finally { server.close(); }

    fake.log.length = 0;
    const again = await post(`/hub/reviews/${withCard}/done`);
    assert.equal(again.status, 200);
    assert.deepEqual(again.body, { state: 'done' });
    assert.deepEqual(doneKeys(), [], 'A second click writes nothing.');

    for (const bad of ['20990101-nothing.json', '..%2Fx.json', 'a%2Fb.json', '.hidden.json', 'no-extension']) {
      assert.equal((await post(`/hub/reviews/${bad}/done`)).status, 404, bad);
    }
    assert.deepEqual(doneKeys(), []);
  } finally { await close(); }
});

test('no Hub write lands outside sections/inbox/, and inboxKey refuses what it should', async () => {
  const { fake, seed, post, close } = await fixture();
  try {
    const ask = askJson({ id: id('fence'), now: NOW, options: threeOptions() });
    seed.ask(ask);
    const ask2 = askJson({ id: id('fence', 'f222'), now: NOW });
    seed.ask(ask2);
    const ask3 = askJson({ id: id('fence', 'f333'), now: NOW });
    seed.ask(ask3);
    fake.log.length = 0;
    const picture = png(50, 50).toString('base64');
    await post(`/hub/asks/${ask.id}/answer`, { choice: 'A', drawing: { scene: scene(), png: picture } });
    await post(`/hub/asks/${ask2.id}/snooze`, {});
    await post(`/hub/asks/${ask2.id}/snooze`, {});
    await post(`/hub/asks/${ask3.id}/cancel`, {});
    const review = seed.event(eventJson({ kind: 'ready-for-review', title: 'Review' }));
    await post(`/hub/reviews/${review}/done`);
    await post('/hub/requests', { project: 'probe', text: 'hello', when: 'nightly', drawing: { scene: scene(), png: picture } });
    const draft = (await post('/hub/drawings', { scene: scene(), png: picture })).body;
    await post(`/hub/drawings/${draft.id}`, { scene: scene(), png: picture, base: draft.etag });
    const writes = fake.log.filter(entry => entry.method === 'PUT' || entry.method === 'DELETE');
    assert.ok(writes.length >= 10);
    assert.deepEqual(writes.filter(entry => !entry.key.startsWith('sections/inbox/')), []);
    assert.equal(writes.filter(entry => entry.method === 'DELETE').length, 0);

    for (const bad of ['../x', 'asks/../../magic-loops/a', '_x/y', 'asks/a/secret.json', 'asks//a', 'asks/.hidden/a', 'cards/a/b', 'asks', 'asks/a/token-file.json', '']) {
      assert.throws(() => inboxKey(bad), undefined, bad);
    }
    assert.equal(inboxKey('asks/20261026-probe-token-x-a1b2/ask.json'), 'sections/inbox/asks/20261026-probe-token-x-a1b2/ask.json', 'An Ask id that mentions a token is fine.');
  } finally { await close(); }
});

test('access: reads are open, writes need a signed-in user, capabilities say hub: true and chat: false', async () => {
  const { seed, get, post, call, close } = await fixture();
  try {
    seed.ask(askJson({ id: id('access'), now: NOW }));
    assert.equal((await post('/hub/requests', { project: 'probe', text: 'x', when: 'nightly' }, {})).status, 401);
    assert.equal((await call('POST', `/hub/asks/${id('access')}/cancel`, {})).status, 401);
    assert.equal((await call('POST', '/hub/reviews/120000-pc-000001.json/done', {})).status, 401);
    assert.equal((await get('/hub/today')).status, 200);
    const open = await (await call('GET', '/capabilities')).json();
    assert.equal(open.hub, true);
    assert.equal(open.chat, false);
    assert.equal(open.transcribe, false);
    assert.equal(open.write, false);
    const signed = await (await call('GET', '/capabilities', undefined, { 'Remote-User': 'owner' })).json();
    assert.equal(signed.hub, true);
    assert.equal(signed.write, true);
  } finally { await close(); }
});

test('with the Hub off every /hub/ route answers 404 and capabilities say so', async () => {
  const { get, post, call, close } = await fixture({ hub: false });
  try {
    assert.equal((await get('/hub/today')).status, 404);
    assert.match((await get('/hub/today')).body.error, /off on this host/);
    assert.equal((await post('/hub/requests', { project: 'probe', text: 'x', when: 'nightly' })).status, 404);
    assert.equal((await (await call('GET', '/capabilities')).json()).hub, false);
    const bare = createSiteApi({ requireRemoteUser: false });
    await new Promise(resolve => bare.listen(0, '127.0.0.1', resolve));
    const caps = await (await fetch(`http://127.0.0.1:${bare.address().port}/api/capabilities`)).json();
    bare.close();
    assert.deepEqual([caps.hub, caps.chat, caps.transcribe], [false, false, false]);
  } finally { await close(); }
});

test('body limits: 8 MB for answers, requests and drawings, 256 KB elsewhere', async () => {
  const { seed, post, close } = await fixture();
  try {
    const ask = askJson({ id: id('big'), now: NOW });
    seed.ask(ask);
    const filler = 'x'.repeat(9 * 1024 * 1024);
    assert.equal((await post(`/hub/asks/${ask.id}/answer`, { note: filler })).status, 413);
    assert.equal((await post(`/hub/asks/${ask.id}/snooze`, { junk: 'x'.repeat(300 * 1024) })).status, 413);
    assert.equal((await post('/hub/requests', { project: 'probe', text: 'x', when: 'nightly', junk: 'y'.repeat(300 * 1024) })).status, 201, 'Requests take up to 8 MB because they may carry a drawing.');
    // A 7 MB body with a real picture gets past the size check (the picture itself is under 6 MB).
    const picture = png(100, 100, 5 * 1024 * 1024).toString('base64');
    const answer = await post(`/hub/asks/${ask.id}/answer`, { note: 'ok', drawing: { scene: scene(), png: picture } });
    assert.equal(answer.status, 201);
  } finally { await close(); }
});

test('GET /hub/file serves only asks, requests and drawings, with their content type', async () => {
  const { seed, call, close } = await fixture();
  try {
    const ask = askJson({ id: id('file'), now: NOW, options: threeOptions() });
    seed.ask(ask);
    seed.put('chat/x.jsonl', '{"role":"user"}\n');
    assert.equal((await call('GET', '/hub/file?path=chat/x.jsonl')).status, 400);
    assert.equal((await call('GET', '/hub/file?path=events/2026-10-26/a.json')).status, 400);
    assert.equal((await call('GET', '/hub/file?path=asks/../chat/x.jsonl')).status, 400);
    assert.equal((await call('GET', `/hub/file?path=asks/${ask.id}/nothing.png`)).status, 404);
    const image = await call('GET', `/hub/file?path=asks/${ask.id}/a.png`);
    assert.equal(image.status, 200);
    assert.equal(image.headers.get('content-type'), 'image/png');
    assert.equal(image.headers.get('cache-control'), 'private, max-age=300');
    assert.equal((await image.arrayBuffer()).byteLength > 24, true);
  } finally { await close(); }
});

test("a review's detail carries its checked links", async () => {
  const { seed, get, post, close } = await fixture();
  try {
    const shot = name => `https://raw.githubusercontent.com/example/app/pr-assets/ws-1/${name}`;
    const file = seed.event(eventJson({
      kind: 'ready-for-review', ts: minutesAgo(NOW, 30), title: 'Detail probe', summary: 'Two pull requests.', url: 'https://example.test/pr/1', card: 'https://example.test/one#/card',
      extra: {
        prs: ['https://github.com/example/app/pull/3', 'https://github.com/example/app/issues/4', 'https://example.test/pull/5'],
        cardDir: 'one/sprint-card',
        cardFiles: ['briefs/x-1.md', 'reviews/x-1-qa.md', 'reviews/x-1.md', 'qa/report.md', 'builds/b.md', 'notes/other.md', '../x.md', 'briefs/../../x.md', 'a.md', 'briefs/x.html'],
        screenshots: [shot('before-board-phone.png'), shot('after-board-phone.png'), shot('x-desktop-before.png'), shot('x-desktop-after.png'), 'http://example.test/a.png', 'javascript:alert(1)', 'https://example.test/other-host.png', 'https://raw.githubusercontent.com.example.test/x.png', shot('single.png')],
        deployUrl: 'http://example.test',
        verdicts: [{ leg: 'smoke', result: 'pass', text: 'Green' }, { leg: 'deploy', result: 'pass', text: 'x' }, { leg: 'review', result: 'maybe', text: 'x' }, { leg: 'qa', result: 'noted', text: 'y'.repeat(400) }],
      },
    }));
    const badDir = seed.event(eventJson({ kind: 'ready-for-review', ts: minutesAgo(NOW, 20), title: 'Bad dir', extra: { cardDir: '../x', cardFiles: ['briefs/x.md'] } }));
    const old = seed.event(eventJson({ kind: 'ready-for-review', ts: minutesAgo(NOW, 10), title: 'Old one', url: '', card: '' }));

    const answer = await get(`/hub/reviews/${file}`);
    assert.equal(answer.status, 200);
    const detail = answer.body;
    assert.equal(detail.id, file);
    assert.equal(detail.title, 'Detail probe');
    assert.equal(detail.summary, 'Two pull requests.');
    assert.equal(detail.project, 'probe');
    assert.equal(detail.host, 'pc.example.test');
    assert.equal(detail.url, 'https://example.test/pr/1');
    assert.equal(detail.card, 'https://example.test/one#/card');
    assert.deepEqual(detail.prs, ['https://github.com/example/app/pull/3']);
    assert.equal(detail.cardDir, 'one/sprint-card');
    assert.deepEqual(detail.cardFiles, [
      { path: 'briefs/x-1.md', label: 'Brief' }, { path: 'reviews/x-1-qa.md', label: 'QA triage' }, { path: 'reviews/x-1.md', label: 'Review' },
      { path: 'qa/report.md', label: 'QA report' }, { path: 'builds/b.md', label: 'Build report' }, { path: 'notes/other.md', label: 'other.md' },
    ]);
    assert.deepEqual(detail.screenshots, [
      { label: 'board phone', before: shot('before-board-phone.png'), after: shot('after-board-phone.png') },
      { label: 'x desktop', before: shot('x-desktop-before.png'), after: shot('x-desktop-after.png') },
      { label: 'single', other: shot('single.png') },
    ]);
    assert.equal(detail.deployUrl, undefined);
    assert.deepEqual(detail.verdicts.map(verdict => [verdict.leg, verdict.result, verdict.text.length]), [['smoke', 'pass', 5], ['qa', 'noted', 300]]);
    assert.equal(detail.done, false);

    const second = (await get(`/hub/reviews/${badDir}`)).body;
    assert.equal(second.cardDir, undefined);
    assert.equal(second.cardFiles, undefined);

    const plain = (await get(`/hub/reviews/${old}`)).body;
    assert.deepEqual(Object.keys(plain).sort(), ['at', 'done', 'host', 'id', 'project', 'source', 'title']);

    assert.equal((await post(`/hub/reviews/${file}/done`)).status, 201);
    const after = await get(`/hub/reviews/${file}`);
    assert.equal(after.status, 200);
    assert.equal(after.body.done, true);
    assert.equal(after.body.doneBy, 'owner');
    assert.ok(after.body.doneAt);

    assert.equal((await get('/hub/reviews/20990101-nothing.json')).status, 404);
    assert.equal((await get('/hub/reviews/a%2Fb.json')).status, 404);
    const doneEvent = (await get('/hub/events?since=2000-01-01')).body.events.find(event => event.kind === 'review-done');
    assert.equal((await get(`/hub/reviews/${doneEvent.file}`)).status, 404);
    assert.equal((await get('/hub/reviews/20990101-nothing.json')).body.error, 'This review is not in the last 7 days.');
  } finally { await close(); }
});

test('no Hub list repeats a key: not in Needs you, any Inbox filter, or the running sessions', async () => {
  const { seed, get, close } = await fixture();
  try {
    const same = minutesAgo(NOW, 30);
    seed.event(eventJson({ kind: 'blocked', ts: minutesAgo(NOW, 40), session: 'sess-a', title: 'First prompt' }));
    seed.event(eventJson({ kind: 'blocked', ts: same, session: 'sess-a', title: 'Second prompt' }));
    seed.event(eventJson({ kind: 'blocked', ts: same, session: 'sess-a', title: 'Third prompt, same second' }));
    seed.event(eventJson({ kind: 'blocked', ts: minutesAgo(NOW, 25), session: 'sess-b', title: 'Blocked, then it started again' }));
    seed.event(eventJson({ kind: 'session-started', ts: minutesAgo(NOW, 20), session: 'sess-b', title: 'b started' }));
    seed.event(eventJson({ kind: 'blocked', ts: minutesAgo(NOW, 15), title: 'No session one' }));
    seed.event(eventJson({ kind: 'blocked', ts: minutesAgo(NOW, 15), title: 'No session two' }));
    seed.event(eventJson({ kind: 'session-started', ts: minutesAgo(NOW, 50), session: 'sess-c', title: 'c started' }));
    seed.event(eventJson({ kind: 'session-started', ts: minutesAgo(NOW, 10), session: 'sess-c', title: 'c started again, never ended' }));
    seed.event(eventJson({ kind: 'ready-for-review', ts: minutesAgo(NOW, 9), title: 'Review one' }));
    seed.event(eventJson({ kind: 'ready-for-review', ts: minutesAgo(NOW, 8), title: 'Review two' }));
    const repeated = (items, key) => { const keys = items.map(key); return keys.filter((value, index) => keys.indexOf(value) !== index); };
    const kindId = item => `${item.kind}-${item.id}`;
    const today = (await get('/hub/today')).body;
    assert.deepEqual(repeated(today.needsYou, kindId), [], 'Needs you');
    assert.deepEqual(repeated(today.running, item => item.id), [], 'running');
    for (const filter of ['needs-you', 'asks', 'reviews', 'requests', 'blocked', 'answered']) {
      assert.deepEqual(repeated((await get(`/hub/inbox?filter=${filter}`)).body.items, kindId), [], filter);
    }
    assert.equal(today.needsYou.filter(item => item.kind === 'blocked' && item.id === 'sess-a').length, 1);
  } finally { await close(); }
});
