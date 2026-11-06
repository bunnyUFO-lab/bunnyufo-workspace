// Chat state: pin, rename, archive, Trash and unread, kept in `chat/state.json`. Nothing is ever deleted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { applyPatch, checkPatch, countPlaces, emptyState, orderView, pageOf, readState, withPatch } from '../chat-state.mjs';
import { createSiteApi } from '../server.mjs';
import { createBucket } from '../s3.mjs';
import { createHub } from '../hub.mjs';
import { startFakeS3 } from './fake-s3.mjs';
import { startFakeHermes } from './fake-hermes.mjs';
import { listenOnGoodPort } from '../../../server/listen.mjs';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const ENV = { HUB_CHAT_RUNS: '1', HUB_CHAT_QUEUE_SWEEP_MS: '0', HUB_CHAT_QUEUE_POLL_MS: '20' };
const ROOT = 'sections/inbox/chat';
const idAt = n => `20261101-${String(n).padStart(6, '0').replace(/0/g, 'a').slice(-6)}`;   // 20261101-aaaaa1 ...
const userLine = text => JSON.stringify({ role: 'user', text, at: '2026-11-01T10:00:00.000Z', by: 'owner' });
const replyLine = text => JSON.stringify({ role: 'assistant', text, at: '2026-11-01T10:00:05.000Z' });
const transcript = (...texts) => `${texts.flatMap(text => [userLine(text), replyLine(`Re: ${text}`)]).join('\n')}\n`;

async function fixture({ chats = 3, scripts = [['Reply one.'], ['Reply two.']] } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'buw-chat-state-'));
  const fake = await startFakeS3();
  const upstream = await startFakeHermes({ key: 'k1', runScripts: scripts });
  const bucket = createBucket({ bucket: fake.bucket, endpoint: fake.endpoint, credentials: fake.credentials, region: 'us-east-1' });
  fake.seed('sections/inbox/workspace.json', '{"name":"Inbox","hidden":true,"entities":[]}\n', 'application/json');
  fake.seed('state.json', '{"version":1,"cards":{}}', 'application/json');
  const ids = [];
  for (let n = 1; n <= chats; n += 1) {
    const id = idAt(n);
    ids.push(id);
    fake.seed(`${ROOT}/${id}.jsonl`, transcript(`Question ${n}`), 'application/x-ndjson', {}, new Date(Date.UTC(2026, 10, 1, 10, n)));
  }
  const servers = [];
  const serve = async ({ requireRemoteUser = true } = {}) => {
    const hub = createHub({ bucket, enabled: true, env: { HERMES_URL: upstream.url, HERMES_API_KEY: 'k1', ...ENV } });
    const server = createSiteApi({ bucket, templateDir: path.join(root, 'none'), stateFile: path.join(root, `c${servers.length}.json`), sectionsTtl: 0, requireRemoteUser, allowedOrigins: ['https://site.example'], hub });
    await listenOnGoodPort(server, '127.0.0.1');
    const origin = `http://127.0.0.1:${server.address().port}`;
    const owner = { 'Remote-User': 'owner', Origin: 'https://site.example' };
    const call = (method, route, data, headers = owner) => fetch(`${origin}/api${route}`, { method, headers: { ...(data === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, body: data === undefined ? undefined : JSON.stringify(data) });
    servers.push(server);
    return { hub, call, origin, owner };
  };
  const first = await serve();
  const close = async () => { for (const server of servers) { server.closeAllConnections?.(); server.close(); } await upstream.close(); await fake.close(); };
  return { ...first, serve, fake, upstream, ids, close };
}

const list = async (call, query = '') => (await call('GET', `/hub/chat${query}`)).json();
const state = (call, id, body) => call('POST', `/hub/chat/${id}/state`, body);
const titles = answer => answer.conversations.map(row => row.id);
async function until(check, what = 'it') {
  const began = Date.now();
  for (;;) {
    let value;
    try { value = await check(); } catch { value = null; }
    if (value) return value;
    if (Date.now() - began > 6000) throw new Error(`Timed out waiting for ${what}.`);
    await wait(20);
  }
}

test('the pure parts: a patch, pin and archive clearing each other, Trash keeping the marks, ordering', () => {
  assert.deepEqual(readState('junk'), emptyState());
  assert.deepEqual(readState({ v: 1, chats: { a: { title: '  Hi  ', pinned: 'nope', archived: '2026-11-01T00:00:00Z', unread: 'yes', extra: 1 }, b: 7, c: {} } }), { v: 1, chats: { a: { title: 'Hi', archived: '2026-11-01T00:00:00Z' } } });
  assert.match(checkPatch([]).error, /Send/);
  assert.match(checkPatch({}).error, /at least one/);
  assert.match(checkPatch({ pinned: 'yes' }).error, /true or false/);
  assert.match(checkPatch({ deleted: true }).error, /not a chat state/);
  assert.match(checkPatch({ title: 'x'.repeat(121) }).error, /at most 120/);
  assert.match(checkPatch({ title: 5 }).error, /text/);
  assert.deepEqual(checkPatch({ title: '  A   new  name ', pinned: true, unread: false, archived: null }).patch, { title: 'A new name', pinned: true, unread: false, archived: false });
  assert.deepEqual(checkPatch({ title: '   ' }).patch, { title: null }, 'A blank name clears the rename.');
  assert.deepEqual(checkPatch({ title: 'x'.repeat(120) }).patch.title.length, 120);
  const at = '2026-11-05T00:00:00.000Z';
  const pinned = applyPatch({ archived: '2026-11-01T00:00:00.000Z' }, { pinned: true }, at);
  assert.deepEqual(pinned, { pinned: at }, 'Pinning leaves Archive.');
  assert.deepEqual(applyPatch(pinned, { archived: true }, '2026-11-06T00:00:00.000Z'), { archived: '2026-11-06T00:00:00.000Z' }, 'Archiving drops the pin.');
  const trashed = applyPatch({ pinned: at, title: 'Keep' }, { trashed: true }, '2026-11-07T00:00:00.000Z');
  assert.deepEqual(trashed, { pinned: at, title: 'Keep', trashed: '2026-11-07T00:00:00.000Z' }, 'Trash keeps the other marks.');
  assert.deepEqual(applyPatch(trashed, { trashed: false }, at), { pinned: at, title: 'Keep' }, 'Restore puts it back where it was.');
  assert.equal(applyPatch({ pinned: at }, { pinned: true }, '2030-01-01T00:00:00.000Z').pinned, at, 'A second pin keeps the first time.');
  assert.deepEqual(withPatch({ v: 1, chats: { a: { unread: true } } }, 'a', { unread: false }, at), { v: 1, chats: {} }, 'An empty entry is dropped.');
  const chats = [1, 2, 3, 4, 5].map(n => ({ id: `c${n}`, at: n }));
  const marks = { v: 1, chats: { c1: { pinned: '2026-11-02T00:00:00Z' }, c2: { archived: '2026-11-02T00:00:00Z' }, c3: { trashed: '2026-11-02T00:00:00Z', pinned: '2026-11-03T00:00:00Z' } } };
  assert.deepEqual(orderView(chats, marks, 'active').map(chat => chat.id), ['c1', 'c5', 'c4'], 'The old pin leads.');
  assert.deepEqual(orderView(chats, marks, 'all').map(chat => chat.id), ['c1', 'c5', 'c4', 'c2'], 'All is Active and Archived, never Trash.');
  assert.deepEqual(orderView(chats, marks, 'archived').map(chat => chat.id), ['c2']);
  assert.deepEqual(orderView(chats, marks, 'trash').map(chat => chat.id), ['c3']);
  assert.deepEqual(countPlaces(['c1', 'c2', 'c3', 'c4'], marks), { active: 2, archived: 1, trashed: 1 });
  assert.deepEqual(pageOf(new URLSearchParams('offset=-1&limit=9999')), { offset: 0, limit: 100 });
  assert.deepEqual(pageOf(new URLSearchParams('offset=30&limit=0')), { offset: 30, limit: 1 });
  assert.deepEqual(pageOf(new URLSearchParams('')), { offset: 0, limit: 30 });
});

test('every state round trips through the list: rename, pin, unread, archive, Trash and back', async () => {
  const { call, ids, fake, close } = await fixture();
  try {
    const [a, b, c] = ids;
    let answer = await list(call);
    assert.deepEqual(titles(answer), [c, b, a], 'Newest first.');
    assert.deepEqual(answer.counts, { active: 3, archived: 0, trashed: 0 });
    assert.equal(answer.conversations[0].title, 'Question 3');
    assert.deepEqual([answer.conversations[0].pinned, answer.conversations[0].archived, answer.conversations[0].trashed, answer.conversations[0].unread], [null, null, null, false]);
    assert.equal(answer.more, false);
    assert.ok(answer.models && answer.personas && answer.chain && 'pauses' in answer, 'The old fields stay.');

    const renamed = await state(call, a, { title: '  My   plan ' });
    assert.equal(renamed.status, 200);
    assert.equal((await renamed.json()).state.title, 'My plan');
    answer = await list(call);
    assert.equal(answer.conversations.find(row => row.id === a).title, 'My plan', 'A rename wins over the derived title.');
    assert.equal(answer.conversations.find(row => row.id === a).renamed, true);
    assert.equal(answer.conversations.find(row => row.id === b).renamed, false);
    await state(call, a, { title: null });
    assert.equal((await list(call)).conversations.find(row => row.id === a).title, 'Question 1', 'Null clears the rename.');

    await state(call, a, { pinned: true });
    answer = await list(call);
    assert.deepEqual(titles(answer), [a, c, b], 'A pin leads.');
    assert.ok(answer.conversations[0].pinned);

    await state(call, b, { unread: true });
    assert.equal((await list(call)).conversations.find(row => row.id === b).unread, true);
    await state(call, b, { unread: false });
    assert.equal((await list(call)).conversations.find(row => row.id === b).unread, false);

    await state(call, a, { archived: true });
    answer = await list(call);
    assert.deepEqual(titles(answer), [c, b], 'Archiving takes the pin off and out of the list.');
    assert.deepEqual(answer.counts, { active: 2, archived: 1, trashed: 0 });
    assert.deepEqual(titles(await list(call, '?view=archived')), [a]);
    assert.deepEqual(titles(await list(call, '?view=all')), [c, b, a], 'All is for Search.');
    await state(call, a, { archived: false });
    assert.deepEqual(titles(await list(call)), [c, b, a]);

    const bytes = fake.text(`${ROOT}/${b}.jsonl`);
    await state(call, b, { trashed: true });
    assert.deepEqual(titles(await list(call)), [c, a]);
    assert.deepEqual(titles(await list(call, '?view=all')), [c, a], 'Trash is not in All.');
    const trash = await list(call, '?view=trash');
    assert.deepEqual(titles(trash), [b]);
    assert.ok(trash.conversations[0].trashed);
    assert.deepEqual(trash.counts, { active: 2, archived: 0, trashed: 1 });
    assert.equal(fake.text(`${ROOT}/${b}.jsonl`), bytes, 'The transcript is the same bytes in Trash.');
    await state(call, b, { trashed: false });
    assert.deepEqual(titles(await list(call)), [c, b, a], 'Restore shows it again.');
    const opened = await (await call('GET', `/hub/chat/${b}`)).json();
    assert.equal(opened.messages.length, 2, 'Its messages are intact.');
    assert.deepEqual(opened.state, { title: null, pinned: null, archived: null, trashed: null, unread: false });

    const file = JSON.parse(fake.text(`${ROOT}/state.json`));
    assert.equal(file.v, 1);
    assert.deepEqual(Object.keys(file.chats), [], 'Cleared marks leave no entries.');
  } finally { await close(); }
});

test('after Trash the transcript bytes are unchanged and no route deletes anything', async () => {
  const { call, ids, fake, close } = await fixture();
  try {
    const before = Object.fromEntries(ids.map(id => [id, fake.text(`${ROOT}/${id}.jsonl`)]));
    for (const id of ids) await state(call, id, { trashed: true });
    for (const id of ids) assert.equal(fake.text(`${ROOT}/${id}.jsonl`), before[id], id);
    const routes = [`/hub/chat/${ids[0]}`, `/hub/chat/${ids[0]}/state`, '/hub/chat', `/hub/chat/${ids[0]}/queue`, `/hub/chat/${ids[0]}/images/x.png`, '/hub/chat/state'];
    for (const route of routes) {
      for (const method of ['DELETE', 'PUT', 'PATCH']) assert.ok((await call(method, route, {})).status >= 400, `${method} ${route}`);
    }
    assert.equal(fake.log.filter(entry => entry.method === 'DELETE').length, 0, 'The store never saw a delete.');
    for (const id of ids) assert.equal(fake.text(`${ROOT}/${id}.jsonl`), before[id], `${id} after the delete tries`);
    assert.equal((await list(call, '?view=trash')).conversations.length, 3, 'All three wait in Trash.');
  } finally { await close(); }
});

test('state.json is not a chat: list() and the last chat time ignore it, and bad ids and missing chats are 404', async () => {
  const { call, ids, fake, close } = await fixture();
  try {
    fake.seed(`${ROOT}/state.json`, JSON.stringify({ v: 1, chats: { [ids[0]]: { title: 'Named' } } }), 'application/json', {}, new Date(Date.UTC(2030, 0, 1)));
    const answer = await list(call);
    assert.equal(answer.conversations.length, 3, 'The state file is no conversation.');
    assert.equal(answer.conversations.find(row => row.id === ids[0]).title, 'Named', 'A hand-written file reads the same way.');
    const team = await (await call('GET', '/hub/team')).json();
    const lastChat = JSON.stringify(team);
    assert.ok(!lastChat.includes('2030-01-01'), 'Last chat did not move to the state file.');
    for (const bad of ['nope', 'state', '20261101-AAAAAA', '..']) assert.equal((await state(call, bad, { pinned: true })).status, 404, bad);
    assert.equal((await state(call, '20261102-bbbbbb', { pinned: true })).status, 404, 'No state for a chat with no file.');
    assert.equal(fake.text(`${ROOT}/state.json`).includes('20261102-bbbbbb'), false);
    assert.equal((await state(call, ids[0], {})).status, 400);
    assert.equal((await state(call, ids[0], { title: 'x'.repeat(121) })).status, 400);
    assert.equal((await state(call, ids[0], { purge: true })).status, 400, 'There is no purge.');
    assert.equal((await call("POST", `/hub/chat/${ids[0]}/state`, undefined)).status, 415, "A body is JSON.");
  } finally { await close(); }
});

test('a lost race retries, and a broken state file is never written over', async () => {
  const { call, ids, fake, close } = await fixture();
  try {
    await state(call, ids[0], { title: 'First' });
    let lost = 1;
    fake.fail = (key, method) => (method === 'PUT' && key.endsWith('chat/state.json') && lost-- > 0 ? 412 : null);
    const raced = await state(call, ids[1], { pinned: true });
    assert.equal(raced.status, 200, 'One lost race is read again and written.');
    fake.fail = null;
    const file = JSON.parse(fake.text(`${ROOT}/state.json`));
    assert.equal(file.chats[ids[0]].title, 'First');
    assert.ok(file.chats[ids[1]].pinned);
    lost = 9;
    fake.fail = (key, method) => (method === 'PUT' && key.endsWith('chat/state.json') && lost-- > 0 ? 412 : null);
    assert.equal((await state(call, ids[2], { unread: true })).status, 409, 'After two retries it says so.');
    fake.fail = null;
    // Two at once, in one process: both land.
    await Promise.all([state(call, ids[0], { unread: true }), state(call, ids[2], { archived: true })]);
    const both = JSON.parse(fake.text(`${ROOT}/state.json`));
    assert.equal(both.chats[ids[0]].unread, true);
    assert.ok(both.chats[ids[2]].archived);
    fake.seed(`${ROOT}/state.json`, '{not json', 'application/json');
    assert.equal((await state(call, ids[0], { pinned: true })).status, 502, 'A file that cannot be read is left alone.');
    assert.equal(fake.text(`${ROOT}/state.json`), '{not json');
    assert.equal((await list(call)).conversations.length, 3, 'The list still reads, with no marks.');
  } finally { await close(); }
});

test('a pin older than 30 chats is on page one, and the pages carry on from there', async () => {
  const { call, ids, close } = await fixture({ chats: 36 });
  try {
    const oldest = ids[0];
    await state(call, oldest, { pinned: true });
    const one = await list(call);
    assert.equal(one.conversations.length, 30);
    assert.equal(one.conversations[0].id, oldest, 'The oldest chat leads, pinned.');
    assert.equal(one.more, true);
    assert.equal(one.total, 36);
    const two = await list(call, '?offset=30');
    assert.equal(two.conversations.length, 6);
    assert.equal(two.more, false);
    assert.equal(new Set([...titles(one), ...titles(two)]).size, 36, 'Every chat once.');
    assert.equal((await list(call, '?limit=5')).conversations.length, 5);
    assert.equal((await list(call, '?view=bogus')).conversations.length, 30, 'An unknown view is the active one.');
  } finally { await close(); }
});

test('the list reads each page title at most once, and titles for the page only', async () => {
  const { call, ids, fake, close } = await fixture({ chats: 40 });
  try {
    await list(call);
    const reads = () => fake.log.filter(entry => entry.method === 'GET' && /chat\/\d{8}-[a-z0-9]{6}\.jsonl$/.test(entry.key)).length;
    assert.equal(reads(), 30, 'Only the first page is read.');
    await list(call);
    assert.equal(reads(), 30, 'The etag cache answers the second time.');
    assert.ok(ids.length === 40);
  } finally { await close(); }
});

test('Trash refuses a send and a queued message, an archived chat sends and un-archives', async () => {
  const { call, ids, fake, upstream, close } = await fixture();
  try {
    const [a, b] = ids;
    await state(call, a, { trashed: true });
    const sent = await call('POST', '/hub/chat', { conversation: a, text: 'hello?' });
    assert.equal(sent.status, 409);
    assert.equal((await sent.json()).error, 'This chat is in the Trash. Restore it to send.');
    const queued = await call('POST', `/hub/chat/${a}/queue`, { text: 'later' });
    assert.equal(queued.status, 409);
    assert.equal((await queued.json()).error, 'This chat is in the Trash. Restore it to send.');
    assert.equal(upstream.runs.length, 0, 'Hermes was not asked.');
    assert.equal(fake.text(`${ROOT}/queue/${a}.json`), null, 'Nothing was queued.');
    assert.equal(fake.text(`${ROOT}/${a}.jsonl`).split('\n').filter(Boolean).length, 2, 'The transcript did not grow.');
    const open = await call('GET', `/hub/chat/${a}`);
    assert.equal(open.status, 200, 'A trashed chat still reads.');
    assert.ok((await open.json()).state.trashed);

    await state(call, b, { archived: true });
    const turn = await call('POST', '/hub/chat', { conversation: b, text: 'Back again.' });
    assert.equal(turn.status, 200);
    await turn.text();
    const row = (await list(call)).conversations.find(item => item.id === b);
    assert.ok(row, 'The chat is in the main list again.');
    assert.equal(row.archived, null);
    assert.equal(fake.text(`${ROOT}/${b}.jsonl`).split('\n').filter(Boolean).length, 4);

    await state(call, a, { trashed: false });
    const after = await call('POST', '/hub/chat', { conversation: a, text: 'Restored.' });
    assert.equal(after.status, 200, 'Restore lets it send.');
    await after.text();
  } finally { await close(); }
});

test('Trash stops its own running reply, holds the queue, and nothing queued goes out; sweep skips it; restore does not release the hold', async () => {
  const { call, ids, fake, upstream, origin, owner, hub, close } = await fixture({ chats: 1, scripts: [['Reply one.', { hold: true }], ['Reply two.']] });
  try {
    const [id] = ids;
    const controller = new AbortController();
    const started = await fetch(`${origin}/api/hub/chat`, { method: 'POST', headers: { ...owner, 'Content-Type': 'application/json' }, body: JSON.stringify({ conversation: id, text: 'long one' }), signal: controller.signal });
    const reader = started.body.getReader();
    let buffer = '';
    let run;
    while (!run) { const { value, done } = await reader.read(); if (done) throw new Error('ended'); buffer += new TextDecoder().decode(value); run = /"run":"([^"]+)"/.exec(buffer)?.[1]; }
    assert.equal((await call('POST', `/hub/chat/${id}/queue`, { text: 'waiting message' })).status, 201);
    const trashed = await state(call, id, { trashed: true });
    assert.equal(trashed.status, 200);
    await until(() => upstream.runs.find(item => item.id === run)?.stopped, 'the run to be stopped');
    await until(async () => (await (await call('GET', `/hub/chat/${id}`)).json()).running !== true, 'the turn to end');
    controller.abort();
    const queue = JSON.parse(fake.text(`${ROOT}/queue/${id}.json`));
    assert.equal(queue.held.reason, 'stopped', 'The queue is held.');
    assert.equal(queue.items.length, 1);
    await hub.chat.sweep();
    await wait(100);
    assert.equal(upstream.runs.length, 1, 'The sweep started nothing from a trashed chat.');
    await state(call, id, { trashed: false });
    await hub.chat.sweep();
    await call('GET', `/hub/chat/${id}`);
    await wait(100);
    assert.equal(upstream.runs.length, 1, 'Restore does not release the hold; the owner sends.');
    const view = await (await call('GET', `/hub/chat/${id}`)).json();
    assert.equal(view.held.reason, 'stopped');
    assert.equal(view.queued.length, 1);
  } finally { await close(); }
});

test('a queued message does not go out when a chat is trashed while another user\'s reply ends', async () => {
  const { call, ids, fake, upstream, origin, close } = await fixture({ chats: 1, scripts: [['Reply one.', { hold: true }], ['Reply two.']] });
  try {
    const [id] = ids;
    const other = { 'Remote-User': 'someone-else', Origin: 'https://site.example', 'Content-Type': 'application/json' };
    const controller = new AbortController();
    const started = await fetch(`${origin}/api/hub/chat`, { method: 'POST', headers: other, body: JSON.stringify({ conversation: id, text: 'theirs' }), signal: controller.signal });
    const reader = started.body.getReader();
    let buffer = '';
    let run;
    while (!run) { const { value, done } = await reader.read(); if (done) throw new Error('ended'); buffer += new TextDecoder().decode(value); run = /"run":"([^"]+)"/.exec(buffer)?.[1]; }
    await call('POST', `/hub/chat/${id}/queue`, { text: 'must not go out' });
    await state(call, id, { trashed: true });
    assert.equal(upstream.runs.find(item => item.id === run).stopped, false, 'Only the user who started a reply may stop it.');
    upstream.release(run, 'Their reply.');
    await until(async () => (await (await call('GET', `/hub/chat/${id}`)).json()).running !== true, 'the turn to end');
    controller.abort();
    await wait(150);
    assert.equal(upstream.runs.length, 1, 'No second run.');
    assert.equal(JSON.parse(fake.text(`${ROOT}/queue/${id}.json`)).held.reason, 'stopped');
    assert.match(fake.text(`${ROOT}/${id}.jsonl`), /Their reply\./, 'The reply that was running is still saved.');
  } finally { await close(); }
});

test('signed out is a 401 under requireRemoteUser, and the state route needs the same sign-in as the rest', async () => {
  const { call, ids, fake, close } = await fixture();
  try {
    const guest = { Origin: 'https://site.example' };
    assert.equal((await state.bind(null, (m, r, d) => call(m, r, d, guest))(ids[0], { pinned: true })).status, 401);
    assert.equal((await call('GET', '/hub/chat', undefined, guest)).status, 401);
    assert.equal(fake.text(`${ROOT}/state.json`), null, 'Nothing was written.');
    const foreign = await call('POST', `/hub/chat/${ids[0]}/state`, { pinned: true }, { 'Remote-User': 'owner', Origin: 'https://evil.example', 'Content-Type': 'application/json' });
    assert.ok(foreign.status >= 400, 'A foreign origin is refused by the server\'s own check.');
    assert.equal(fake.text(`${ROOT}/state.json`), null);
  } finally { await close(); }
});
