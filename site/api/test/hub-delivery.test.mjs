// Where an answered Ask's answer went: deliveryOf over agent-written files, and the Ask route that serves it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSiteApi } from '../server.mjs';
import { createBucket } from '../s3.mjs';
import { createHub } from '../hub.mjs';
import { deliveryOf } from '../hub-model.mjs';
import { startFakeS3 } from './fake-s3.mjs';
import { askJson, checklistJson, seeder } from './hub-fixtures.mjs';


const NOW = new Date('2026-10-31T12:00:00Z');
const ago = minutes => new Date(NOW.getTime() - minutes * 60000).toISOString();
const answer = minutes => ({ choice: 'A', at: ago(minutes), by: 'owner' });
const watcher = (extra = {}) => ({ v: 1, session: 'abcd1234-5678', host: 'pc-one', folder: 'demo-repo', project: 'demo', at: ago(30), url: 'https://claude.ai/code/session_x', appUrl: 'claude://claude.ai/code/session_x', ...extra });
const run = input => deliveryOf({ at: NOW, ...input });

test('deliveryOf: nothing for an Ask nobody answered', () => {
  assert.equal(run({ answer: undefined, delivered: { how: 'woke', at: ago(1) }, watchers: [watcher()] }), undefined);
  assert.equal(run({ answer: null, watchers: [] }), undefined);
});

test('deliveryOf: delivered names the session, host, folder and how', () => {
  const got = run({ answer: answer(10), delivered: { v: 1, at: ago(2), session: 'abcd1234-5678', host: 'pc-one', how: 'woke' }, watchers: [watcher()] });
  assert.deepEqual(got, { state: 'delivered', how: 'woke', at: ago(2), host: 'pc-one', folder: 'demo-repo', session: 'abcd1234-5678' });
  const start = run({ answer: answer(10), delivered: { at: ago(2), session: 'zzzz9999', host: 'pc-two', how: 'start' }, watchers: [] });
  assert.equal(start.how, 'start');
  assert.equal(start.folder, undefined, 'No watcher file, no folder.');
});

test('deliveryOf: watching under 5 minutes, not delivered from 5 minutes on', () => {
  const young = run({ answer: answer(3), watchers: [watcher()] });
  assert.equal(young.state, 'watching');
  assert.equal(young.minutes, 3);
  assert.equal(young.folder, 'demo-repo');
  assert.equal(young.appUrl, 'claude://claude.ai/code/session_x');
  const old = run({ answer: answer(12), watchers: [watcher()] });
  assert.equal(old.state, 'stale');
  assert.equal(old.minutes, 12);
  assert.equal(run({ answer: answer(5), watchers: [watcher()] }).state, 'stale', 'Five minutes is the edge.');
});

test('deliveryOf: no watcher means none', () => {
  assert.deepEqual(run({ answer: answer(1), watchers: [] }), { state: 'none' });
  assert.deepEqual(run({ answer: answer(1) }), { state: 'none' });
  assert.deepEqual(run({ answer: answer(1), watchers: [{ session: 'bad session!' }, null, 'x'] }), { state: 'none' }, 'A watcher with no valid session id does not count.');
});

test('deliveryOf: a bad how, an unsafe link or an overlong folder is dropped', () => {
  const badHow = run({ answer: answer(1), delivered: { at: ago(1), how: 'telepathy', session: 'abcd1234' }, watchers: [watcher()] });
  assert.equal(badHow.state, 'watching', 'An unknown how is not a delivery.');
  const links = run({ answer: answer(1), watchers: [watcher({ url: 'http://claude.ai/code/x', appUrl: 'javascript:alert(1)' })] });
  assert.equal(links.url, undefined);
  assert.equal(links.appUrl, undefined);
  assert.equal(run({ answer: answer(1), watchers: [watcher({ url: 'https://claude.ai/code/x"onload=1' })] }).url, undefined);
  for (const bad of ['https://example.test/x', 'https://claude.ai.evil.example/x', 'https://evil.example/claude.ai', 'https://claude.ai@evil.example/x', 'https://claude.ai:8443@evil.example/', 'https://claude.ai:8443/x', 'https://xn--claude-ai-9za.example/x', 'https://claude.aievil.example/x', 'https://evilclaude.ai/x', 'claude://evil.example/x', 'claude://claude.ai.evil.example/x', 'claude://claude.ai@evil.example/x', 'https://claude.ai\@evil.example/x', 'HTTP://claude.ai/x']) {
    const got = run({ answer: answer(1), watchers: [watcher({ url: bad, appUrl: bad })] });
    assert.equal(got.url, undefined, bad);
    assert.equal(got.appUrl, undefined, bad);
  }
  for (const good of ['https://claude.ai', 'https://claude.ai/code/session_x', 'claude://claude.ai/code/session_x?a=1#b']) assert.equal(run({ answer: answer(1), watchers: [watcher({ url: good })] }).url, good);
  const long = run({ answer: answer(1), watchers: [watcher({ folder: 'f'.repeat(121), host: 'h'.repeat(121) })] });
  assert.equal(long.folder, undefined);
  assert.equal(long.host, undefined);
  assert.equal(run({ answer: answer(1), watchers: [watcher({ folder: 'a\nb' })] }).folder, undefined, 'No control characters.');
  assert.equal(run({ answer: answer(1), delivered: { how: 'woke', at: 'not a date' }, watchers: [] }).state, 'none');
});

test('deliveryOf: at most 3 watchers are read, the newest shown', () => {
  const watchers = ['aaaaaaaa1', 'bbbbbbbb2', 'cccccccc3', 'dddddddd4'].map((session, index) => watcher({ session, folder: `r${index}`, at: ago(40 - index * 10) }));
  const got = run({ answer: answer(1), watchers });
  assert.equal(got.watchers, 3);
  assert.equal(got.folder, 'r2', 'The fourth file is never read; the newest of the first three leads.');
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'buw-delivery-'));
  const fake = await startFakeS3();
  const bucket = createBucket({ bucket: fake.bucket, endpoint: fake.endpoint, credentials: fake.credentials, region: 'us-east-1' });
  fake.seed('sections/inbox/workspace.json', '{"name":"Inbox","hidden":true,"entities":[]}\n', 'application/json');
  fake.seed('state.json', '{"version":1,"cards":{}}', 'application/json');
  const hub = createHub({ bucket, enabled: true, now: () => NOW });
  const server = createSiteApi({ bucket, templateDir: path.join(root, 'none'), stateFile: path.join(root, 'card-state.json'), sectionsTtl: 0, requireRemoteUser: false, hub, allowedOrigins: ['https://site.example'] });
  await listenOnGoodPort(server, '127.0.0.1');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const get = async route => { const reply = await fetch(`${origin}/api${route}`); return reply.json(); };
  return { fake, seed: seeder(fake), get, close: async () => { server.close(); await fake.close(); } };
}

test('GET /api/hub/asks/:id carries delivery for an answered Ask only', async () => {
  const { seed, get, close } = await fixture();
  try {
    const day = NOW.toISOString().slice(0, 10).replace(/-/g, '');
    const open = askJson({ id: `${day}-probe-open-a1b1`, now: NOW });
    seed.ask(open, { files: { 'watch-abcd1234.json': watcher() } });
    assert.equal('delivery' in await get(`/hub/asks/${open.id}`), false, 'An open Ask has none.');
    const none = askJson({ id: `${day}-probe-none-a1b2`, now: NOW });
    seed.ask(none, { files: { 'answer.json': answer(1) } });
    assert.deepEqual((await get(`/hub/asks/${none.id}`)).delivery, { state: 'none' });
    const watched = askJson({ id: `${day}-probe-seen-a1b3`, now: NOW });
    seed.ask(watched, { files: { 'answer.json': answer(8), 'watch-abcd1234.json': watcher() } });
    const stale = (await get(`/hub/asks/${watched.id}`)).delivery;
    assert.equal(stale.state, 'stale');
    assert.equal(stale.folder, 'demo-repo');
    const done = askJson({ id: `${day}-probe-done-a1b4`, now: NOW });
    seed.ask(done, { files: { 'answer.json': answer(8), 'watch-abcd1234.json': watcher(), 'delivered.json': { v: 1, at: ago(1), session: 'abcd1234-5678', host: 'pc-one', how: 'turn' } } });
    const delivered = (await get(`/hub/asks/${done.id}`)).delivery;
    assert.equal(delivered.state, 'delivered');
    assert.equal(delivered.how, 'turn');
    assert.equal(delivered.folder, 'demo-repo');
    // An overwritten file shows its new body, not the one read before.
    seed.put(`asks/${done.id}/delivered.json`, { v: 1, at: ago(1), session: 'abcd1234-5678', host: 'pc-one', how: 'start' });
    assert.equal((await get(`/hub/asks/${done.id}`)).delivery.how, 'start');
  } finally { await close(); }
});

test('GET /api/hub/checklists/:id carries delivery for a submitted checklist only, read fresh, with the same link rule', async () => {
  const { seed, get, close } = await fixture();
  try {
    const day = NOW.toISOString().slice(0, 10).replace(/-/g, '');
    const list = tail => checklistJson({ id: `${day}-probe-list-${tail}`, now: NOW });
    const open = list('b1b1');
    seed.checklist(open);
    seed.put(`checklists/${open.id}/watch-abcd1234.json`, watcher());
    assert.equal('delivery' in await get(`/hub/checklists/${open.id}`), false, 'An unsubmitted checklist has none.');
    const none = list('b1b2');
    seed.checklist(none);
    seed.submit(none.id, { at: ago(1) });
    assert.deepEqual((await get(`/hub/checklists/${none.id}`)).delivery, { state: 'none' });
    const stale = list('b1b3');
    seed.checklist(stale);
    seed.submit(stale.id, { at: ago(9) });
    seed.put(`checklists/${stale.id}/watch-abcd1234.json`, watcher({ url: 'https://claude.ai.evil.example/x', appUrl: 'claude://claude.ai/code/s' }));
    const late = (await get(`/hub/checklists/${stale.id}`)).delivery;
    assert.equal(late.state, 'stale');
    assert.equal(late.url, undefined, 'A look-alike host gets no link.');
    assert.equal(late.appUrl, 'claude://claude.ai/code/s');
    const done = list('b1b4');
    seed.checklist(done);
    seed.submit(done.id, { at: ago(9) });
    seed.put(`checklists/${done.id}/watch-abcd1234.json`, watcher());
    seed.put(`checklists/${done.id}/delivered.json`, { v: 1, at: ago(1), session: 'abcd1234-5678', host: 'pc-one', how: 'turn' });
    assert.equal((await get(`/hub/checklists/${done.id}`)).delivery.how, 'turn');
    seed.put(`checklists/${done.id}/delivered.json`, { v: 1, at: ago(1), session: 'abcd1234-5678', host: 'pc-one', how: 'woke' });
    assert.equal((await get(`/hub/checklists/${done.id}`)).delivery.how, 'woke', 'An overwritten file shows its new body.');
  } finally { await close(); }
});
