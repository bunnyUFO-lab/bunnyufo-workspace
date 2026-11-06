// The message search index (chat-index.mjs) and its route, GET /hub/chat/search.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createChatIndex, searchWords, snippetOf } from '../chat-index.mjs';
import { createSiteApi } from '../server.mjs';
import { createBucket } from '../s3.mjs';
import { createHub } from '../hub.mjs';
import { startFakeS3 } from './fake-s3.mjs';
import { startFakeHermes } from './fake-hermes.mjs';
import { listenOnGoodPort } from '../../../server/listen.mjs';

const jsonl = lines => `${lines.map(line => JSON.stringify(line)).join('\n')}\n`;
const at = n => `2026-11-0${n}T10:00:00.000Z`;

/** A bucket and `fresh` over a map, counting transcript reads and listings. */
function stub(files = {}) {
  const store = new Map(Object.entries(files).map(([id, text]) => [id, { text, etag: `e${id}-1`, at: Date.parse(at(2)) }]));
  const calls = { list: 0, get: [] };
  let tick = 0;
  return {
    calls,
    set(id, text, when) { const old = store.get(id); tick += 1; store.set(id, { text, etag: `e${id}-${tick + 1}`, at: when ?? Date.parse(at(3)) + tick, old }); },
    remove: id => store.delete(id),
    key: rel => `sections/inbox/${rel}`,
    bucket: {
      async list() { calls.list += 1; return { objects: [...store].map(([id, file]) => ({ key: `sections/inbox/chat/${id}.jsonl`, etag: file.etag, lastModified: new Date(file.at).toISOString() })).concat([{ key: 'sections/inbox/chat/queue/x.json', etag: 'q', lastModified: at(4) }, { key: 'sections/inbox/chat/state.json', etag: 's', lastModified: at(4) }]), prefixes: [] }; },
    },
    async fresh(rel) { const id = rel.replace(/^chat\//, '').replace(/\.jsonl$/, ''); calls.get.push(id); const file = store.get(id); return file ? { text: file.text, etag: file.etag } : null; },
  };
}
const build = (s, extra = {}) => createChatIndex({ bucket: s.bucket, key: s.key, fresh: s.fresh, pool: async (size, items, fn) => Promise.all(items.map(fn)), ...extra });

const A = '20261101-aaaaaa';
const B = '20261102-bbbbbb';
const C = '20261103-cccccc';

test('every word must be in one message, case-insensitively, with a snippet around the first word', async () => {
  const s = stub({ [A]: jsonl([{ role: 'user', text: 'Please plan the Launch Party for Friday', at: at(1) }, { role: 'assistant', text: 'Plan: balloons on Friday, cake after launch.', at: at(1) }, { role: 'user', text: 'launch only here', at: at(1) }]) });
  const index = build(s);
  const { hits } = await index.search({ q: 'launch FRIDAY' });
  assert.deepEqual(hits.map(hit => hit.line), [1, 0], 'Newest message first; the third has only one of the words.');
  assert.equal(hits[0].chat, A);
  assert.equal(hits[0].title, 'Please plan the Launch Party for Friday');
  assert.match(hits[0].snippet, /launch/i);
  assert.ok(hits[0].snippet.length <= 90);
  assert.equal(hits[0].archived, false);
  assert.deepEqual((await index.search({ q: 'launch zebra' })).hits, []);
});

test('context lines, tool text and pictures are not matched', async () => {
  const picture = `![chart](data:image/png;base64,${'QUJD'.repeat(200)})`;
  const s = stub({ [A]: jsonl([
    { role: 'context', text: 'secretcontext about an ask', about: { kind: 'ask', id: 'x', title: 'An ask' } },
    { role: 'assistant', text: `Here is the chart ${picture} done`, tools: [{ name: 'run', output: 'tooloutputword' }], at: at(1) },
    { role: 'user', text: 'hello', at: at(1) },
  ]) });
  const index = build(s);
  assert.deepEqual((await index.search({ q: 'secretcontext' })).hits, []);
  assert.deepEqual((await index.search({ q: 'tooloutputword' })).hits, []);
  assert.deepEqual((await index.search({ q: 'QUJDQUJD' })).hits, []);
  const [hit] = (await index.search({ q: 'chart done' })).hits;
  assert.equal(hit.line, 1, 'The line is its index in the stored lines, the context line included.');
  assert.equal(hit.title, 'Help: An ask');
  assert.ok(!hit.snippet.includes('base64'));
});

test('a message is cut at 4000 characters, at most 3 hits per chat, newest chat first, limit applies', async () => {
  const many = Array.from({ length: 6 }, (_, n) => ({ role: 'user', text: `needle ${n}`, at: at(1) }));
  const s = stub({ [A]: jsonl(many), [B]: jsonl([{ role: 'user', text: `needle ${'x'.repeat(4000)} tailword`, at: at(1) }]) });
  s.set(C, jsonl([{ role: 'user', text: 'needle in newest', at: at(1) }]), Date.parse(at(5)));
  const index = build(s);
  const { hits } = await index.search({ q: 'needle', limit: 50 });
  assert.deepEqual(hits.map(hit => hit.chat), [C, B, A, A, A]);
  assert.deepEqual(hits.filter(hit => hit.chat === A).map(hit => hit.line), [5, 4, 3]);
  assert.deepEqual((await index.search({ q: 'tailword' })).hits, [], 'Past 4000 characters is not indexed.');
  assert.equal((await index.search({ q: 'needle', limit: 2 })).hits.length, 2);
});

test('a search reads only the transcripts that changed', async () => {
  const s = stub({ [A]: jsonl([{ role: 'user', text: 'alpha one', at: at(1) }]), [B]: jsonl([{ role: 'user', text: 'alpha two', at: at(1) }]) });
  const index = build(s);
  await index.search({ q: 'alpha' });
  assert.deepEqual(s.calls.get.sort(), [A, B], 'Cold: each transcript once.');
  s.calls.get.length = 0;
  await index.search({ q: 'alpha' });
  assert.deepEqual(s.calls.get, [], 'Warm: none.');
  s.set(B, jsonl([{ role: 'user', text: 'alpha two', at: at(1) }, { role: 'assistant', text: 'alpha reply', at: at(1) }]));
  const { hits } = await index.search({ q: 'alpha' });
  assert.deepEqual(s.calls.get, [B], 'One append reads one file.');
  assert.equal(hits.filter(hit => hit.chat === B).length, 2);
  s.remove(A);
  assert.ok((await index.search({ q: 'alpha' })).hits.every(hit => hit.chat !== A), 'A removed chat leaves the index.');
  assert.equal(s.calls.list, 4, 'One listing per search.');
});

test('a second search joins the load in flight', async () => {
  const s = stub({ [A]: jsonl([{ role: 'user', text: 'alpha', at: at(1) }]), [B]: jsonl([{ role: 'user', text: 'alpha', at: at(1) }]) });
  const index = build(s);
  const [one, two] = await Promise.all([index.search({ q: 'alpha' }), index.search({ q: 'alpha' })]);
  assert.equal(one.hits.length, 2);
  assert.equal(two.hits.length, 2);
  assert.deepEqual(s.calls.get.sort(), [A, B], 'Each file once, though two searches ran.');
});

test('a slow first load answers with what it has and warming, and the load goes on', async () => {
  const s = stub({ [A]: jsonl([{ role: 'user', text: 'alpha', at: at(1) }]), [B]: jsonl([{ role: 'user', text: 'alpha', at: at(1) }]) });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const slow = async rel => { await gate; return s.fresh(rel); };
  const index = createChatIndex({ bucket: s.bucket, key: s.key, fresh: slow, pool: async (size, items, fn) => Promise.all(items.map(fn)), warmMs: 20 });
  const first = await index.search({ q: 'alpha' });
  assert.equal(first.warming, true);
  assert.deepEqual(first.hits, []);
  release();
  const second = await index.search({ q: 'alpha' });
  assert.equal(second.warming, undefined);
  assert.equal(second.hits.length, 2);
  assert.deepEqual(s.calls.get.sort(), [A, B], 'The load that timed out was not started again.');
});

test('past the size cap the oldest chats are dropped and the answer says partial', async () => {
  const big = jsonl([{ role: 'user', text: `needle ${'y'.repeat(900)}`, at: at(1) }]);
  const s = stub({ [A]: big, [B]: big });
  s.set(C, big, Date.parse(at(5)));
  const index = build(s, { maxBytes: 5000 });
  const answer = await index.search({ q: 'needle' });
  assert.equal(answer.partial, true);
  assert.equal(answer.hits[0].chat, C);
  assert.ok(answer.hits.length < 3);
  assert.ok(index.stats().bytes <= 5000);
  s.calls.get.length = 0;
  await index.search({ q: 'needle' });
  assert.deepEqual(s.calls.get, [], 'Dropped chats are not read over and over.');
});

test('state: a trashed chat is left out, an archived one is marked, a rename wins', async () => {
  const s = stub({ [A]: jsonl([{ role: 'user', text: 'alpha one', at: at(1) }]), [B]: jsonl([{ role: 'user', text: 'alpha two', at: at(1) }]), [C]: jsonl([{ role: 'user', text: 'alpha three', at: at(1) }]) });
  const state = { chats: { [A]: { trashed: at(3) }, [B]: { archived: at(3), title: 'Renamed' } } };
  const index = build(s, { readState: async () => state });
  const { hits } = await index.search({ q: 'alpha' });
  assert.deepEqual(hits.map(hit => [hit.chat, hit.archived, hit.title]), [[C, false, 'alpha three'], [B, true, 'Renamed']]);
  delete state.chats[A].trashed;
  assert.equal((await index.search({ q: 'alpha' })).hits.length, 3, 'Restore brings it back with no re-read.');
});

test('searchWords and snippetOf', () => {
  assert.deepEqual(searchWords('  Hello   WORLD '), ['hello', 'world']);
  assert.equal(snippetOf('short text', 'text'), 'short text');
  const long = `${'a '.repeat(100)}target ${'b '.repeat(100)}`.trim();
  const snippet = snippetOf(long, 'target');
  assert.ok(snippet.includes('target'));
  assert.ok(snippet.startsWith('…') && snippet.endsWith('…'));
  assert.ok(snippet.length <= 84);
});

// The route, over the stand-in S3.
async function fixture({ requireRemoteUser = true } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'buw-chat-index-'));
  const fake = await startFakeS3();
  const upstream = await startFakeHermes({ key: 'k1' });
  const bucket = createBucket({ bucket: fake.bucket, endpoint: fake.endpoint, credentials: fake.credentials, region: 'us-east-1' });
  fake.seed('sections/inbox/workspace.json', '{"name":"Inbox","hidden":true,"entities":[]}\n', 'application/json');
  fake.seed('state.json', '{"version":1,"cards":{}}', 'application/json');
  const server = createSiteApi({ bucket, templateDir: path.join(root, 'none'), stateFile: path.join(root, 'c.json'), sectionsTtl: 0, requireRemoteUser, allowedOrigins: ['https://site.example'], hub: createHub({ bucket, enabled: true, env: { HERMES_URL: upstream.url, HERMES_API_KEY: 'k1', HUB_CHAT_RUNS: '0' } }) });
  await listenOnGoodPort(server, '127.0.0.1');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const owner = { 'Remote-User': 'owner', Origin: 'https://site.example' };
  const call = (method, route, headers = owner) => fetch(`${origin}/api${route}`, { method, headers });
  const close = async () => { server.closeAllConnections?.(); server.close(); await upstream.close(); await fake.close(); };
  return { fake, call, close };
}

test('GET /hub/chat/search finds words, checks q, needs sign-in and writes nothing', async () => {
  const { fake, call, close } = await fixture();
  try {
    fake.seed(`sections/inbox/chat/${A}.jsonl`, jsonl([{ role: 'user', text: 'Where is the harvest festival plan?', at: at(1), persona: 'planner' }, { role: 'assistant', text: 'The harvest festival plan is in Library.', at: at(1) }]), 'application/x-ndjson');
    const before = fake.objects.size;
    const writes = () => fake.log.filter(entry => entry.method !== 'GET' && entry.method !== 'HEAD').length;
    const wrote = writes();
    const answer = await call('GET', '/hub/chat/search?q=harvest%20plan&limit=10');
    assert.equal(answer.status, 200);
    const body = await answer.json();
    assert.deepEqual(body.hits.map(hit => [hit.chat, hit.line, hit.archived]), [[A, 1, false], [A, 0, false]]);
    assert.equal(body.hits[0].title, 'Where is the harvest festival plan?');
    assert.equal(body.warming, undefined);
    assert.equal(fake.objects.size, before, 'No object is written by a search.');
    assert.equal(writes(), wrote, 'And nothing is put or deleted.');
    assert.equal((await call('GET', '/hub/chat/search?q=a')).status, 400);
    assert.equal((await call('GET', `/hub/chat/search?q=${'a'.repeat(201)}`)).status, 400);
    assert.equal((await call('GET', '/hub/chat/search')).status, 400);
    assert.equal((await call('GET', '/hub/chat/search?q=harvest', { Origin: 'https://site.example' })).status, 401);
    assert.equal((await call('GET', `/hub/chat/${A}`)).status, 200, 'The generic route still answers.');
  } finally { await close(); }
});
