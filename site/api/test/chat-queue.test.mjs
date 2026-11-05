// The chat queue: messages sent while a reply runs wait in `chat/queue/<id>.json` and the Hub delivers them, against a fake Hermes over the stand-in S3.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { QUEUE_LIMITS, addItem, cancelItem, emptyQueue, holdFor, readQueue, takeItems, viewOf } from '../chat-queue.mjs';
import { createSiteApi } from '../server.mjs';
import { createBucket } from '../s3.mjs';
import { createHub } from '../hub.mjs';
import { startFakeS3 } from './fake-s3.mjs';
import { startFakeHermes } from './fake-hermes.mjs';
import { solidPng } from './png.mjs';
import { listenOnGoodPort } from '../../../server/listen.mjs';

const ENV = { HUB_CHAT_RUNS: '1', HUB_CHAT_QUEUE_SWEEP_MS: '0', HUB_CHAT_QUEUE_POLL_MS: '20' };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

/** A site API over a fake bucket and a fake Hermes. `serve()` makes another API on the same bucket and Hermes: a restarted service. */
async function fixture({ hermes = {}, refuseStarts = null } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'buw-queue-'));
  const fake = await startFakeS3();
  const upstream = await startFakeHermes({ key: 'k1', ...hermes });
  const bucket = createBucket({ bucket: fake.bucket, endpoint: fake.endpoint, credentials: fake.credentials, region: 'us-east-1' });
  fake.seed('sections/inbox/workspace.json', '{"name":"Inbox","hidden":true,"entities":[]}\n', 'application/json');
  fake.seed('state.json', '{"version":1,"cards":{}}', 'application/json');
  const owner = { 'Remote-User': 'owner', Origin: 'https://site.example' };
  const servers = [];
  // Switches on Hermes's side of the wire: on (429 on every start), delay (ms before a start is sent), lose (Hermes takes the start, the answer is lost), ignoreStop (a stop is not passed on).
  const refuse = { on: false, delay: 0, lose: false, ignoreStop: false };
  const fetchImpl = async (url, init) => {
    const starts = init?.method === 'POST' && /\/v1\/runs$/.test(String(url));
    if (starts && refuse.delay) await wait(refuse.delay);
    if (starts && refuse.on) return new Response('{"error":{"message":"busy"}}', { status: 429, headers: { 'content-type': 'application/json' } });
    if (init?.method === 'POST' && refuse.ignoreStop && /\/v1\/runs\/[^/]+\/stop$/.test(String(url))) return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    const answer = await fetch(url, init);
    if (starts && refuse.lose) throw new TypeError('the answer was lost');
    return answer;
  };
  const serve = async () => {
    const hub = createHub({ bucket, enabled: true, env: { HERMES_URL: upstream.url, HERMES_API_KEY: 'k1', ...ENV }, fetchImpl });
    const server = createSiteApi({ bucket, templateDir: path.join(root, 'none'), stateFile: path.join(root, `c${servers.length}.json`), sectionsTtl: 0, requireRemoteUser: true, allowedOrigins: ['https://site.example'], hub });
    await listenOnGoodPort(server, '127.0.0.1');
    const origin = `http://127.0.0.1:${server.address().port}`;
    const call = (method, route, data, headers = owner) => fetch(`${origin}/api${route}`, { method, headers: { ...(data === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, body: data === undefined ? undefined : JSON.stringify(data) });
    servers.push(server);
    return { hub, server, origin, call };
  };
  const first = await serve();
  const close = async () => { for (const server of servers) { server.closeAllConnections?.(); server.close(); } await upstream.close(); await fake.close(); };
  return { ...first, serve, fake, upstream, owner, refuse, close };
}

/** Opens a turn and reads up to `started`. The page never reads on: the Hub carries the turn without it. */
async function startTurn(origin, owner, body) {
  const controller = new AbortController();
  const answer = await fetch(`${origin}/api/hub/chat`, { method: 'POST', headers: { ...owner, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal });
  assert.equal(answer.status, 200);
  const reader = answer.body.getReader();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) throw new Error('The stream ended before it started.');
    buffer += new TextDecoder().decode(value);
    const hit = /event: started\ndata: (.+)\n\n/.exec(buffer);
    if (hit) return { ...JSON.parse(hit[1]), controller };
  }
}

const lines = (fake, conversation) => fake.text(`sections/inbox/chat/${conversation}.jsonl`).trim().split('\n').map(line => JSON.parse(line));
const queueFile = (fake, conversation) => JSON.parse(fake.text(`sections/inbox/chat/queue/${conversation}.json`));
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
const read = async (call, id) => (await call('GET', `/hub/chat/${id}`)).json();
const queue = (call, id, text, extra = {}) => call('POST', `/hub/chat/${id}/queue`, { text, ...extra });

test('the pure parts: limits, cancel, joining, holds', () => {
  let q = emptyQueue();
  for (let at = 0; at < QUEUE_LIMITS.items; at += 1) q = addItem(q, { id: `q${at}`, text: `m${at}`, at: 't', by: 'owner', model: at === 4 ? 'sonnet' : undefined }).queue;
  assert.equal(addItem(q, { id: 'x', text: 'one more', at: 't' }).error, 'items', 'Five at most.');
  assert.equal(addItem(emptyQueue(), { id: 'x', text: 'a'.repeat(QUEUE_LIMITS.chars + 1), at: 't' }).error, 'chars');
  const two = addItem(addItem(emptyQueue(), { id: 'a', text: 'a'.repeat(8000), at: 't' }).queue, { id: 'b', text: 'b'.repeat(8000), at: 't' }).queue;
  assert.equal(addItem(two, { id: 'c', text: 'c', at: 't' }).error, 'chars', '16000 characters in all.');
  const taken = takeItems({ ...q, held: { reason: 'stopped', at: 't' } });
  assert.equal(taken.text, 'm0\n\nm1\n\nm2\n\nm3\n\nm4', 'Joined by a blank line.');
  assert.equal(taken.model, 'sonnet', 'The last message names the model.');
  assert.equal(taken.queue.held, null, 'Taking clears the hold.');
  assert.deepEqual(taken.ids, ['q0', 'q1', 'q2', 'q3', 'q4']);
  assert.equal(cancelItem(q, 'nope'), null);
  assert.equal(cancelItem(q, 'q0').items.length, 4);
  assert.equal(cancelItem({ ...addItem(emptyQueue(), { id: 'a', text: 'x', at: 't' }).queue, held: { reason: 'failed', at: 't' } }, 'a').held, null, 'Nothing left to hold.');
  assert.equal(holdFor('The run was stopped.'), 'stopped');
  assert.equal(holdFor('Hermes could not finish.'), 'failed');
  assert.equal(holdFor('boom', true), 'stopped');
  assert.deepEqual(readQueue('junk'), emptyQueue());
  assert.deepEqual(viewOf(readQueue({ items: [{ id: 'a', text: 'x', at: 't', by: 'owner' }, { nope: 1 }], held: { reason: 'weird' } })), { queued: [{ id: 'a', text: 'x', at: 't' }], held: null });
});

test('a message queued during a reply is delivered when the reply ends, with that reply in its history', async () => {
  const { fake, upstream, call, origin, owner, close } = await fixture({ hermes: { runScripts: [['First reply.', { hold: true }], ['Second reply.']] } });
  try {
    const turn = await startTurn(origin, owner, { text: 'first' });
    const queued = await queue(call, turn.conversation, 'Also check the forest level.');
    assert.equal(queued.status, 201);
    const answer = await queued.json();
    assert.equal(answer.queued.length, 1);
    assert.equal(answer.held, null);
    assert.equal(upstream.runs.length, 1, 'Nothing starts while the reply runs.');
    const running = await read(call, turn.conversation);
    assert.equal(running.running, true);
    assert.equal(running.queued[0].text, 'Also check the forest level.');
    upstream.release(turn.run, 'First reply.');
    await until(() => lines(fake, turn.conversation).length >= 4, 'the second reply');
    const saved = lines(fake, turn.conversation);
    assert.deepEqual(saved.map(line => [line.role, line.text]), [['user', 'first'], ['assistant', 'First reply.'], ['user', 'Also check the forest level.'], ['assistant', 'Second reply.']]);
    assert.equal(saved[2].queued.length, 1, 'The user line says which queued messages it joined.');
    assert.equal(saved[2].by, 'owner');
    const second = upstream.runs[1];
    assert.equal(second.body.input, 'Also check the forest level.');
    assert.deepEqual(second.body.conversation_history.map(line => line.content), ['first', 'First reply.'], 'The first reply is in its history.');
    const after = await until(async () => { const read2 = await read(call, turn.conversation); return read2.running ? null : read2; }, 'the end');
    assert.deepEqual(after.queued, []);
    assert.equal(after.held, null);
    assert.equal(queueFile(fake, turn.conversation).turn, null, 'The turn is cleared when it ends.');
  } finally { await close(); }
});

test('two queued messages make one run, with the texts joined, and one user line', async () => {
  const { fake, upstream, call, origin, owner, close } = await fixture({ hermes: { runScripts: [[{ hold: true }], ['Both read.']] } });
  try {
    const turn = await startTurn(origin, owner, { text: 'first' });
    await queue(call, turn.conversation, 'One thing.');
    await queue(call, turn.conversation, 'Another thing.', { model: 'sonnet' });
    upstream.release(turn.run, 'Ok.');
    await until(() => lines(fake, turn.conversation).length >= 4, 'the joined turn');
    assert.equal(upstream.runs.length, 2, 'One run for both.');
    assert.equal(upstream.runs[1].body.input, 'One thing.\n\nAnother thing.');
    assert.equal(upstream.runs[1].body.provider, 'anthropic', 'The last message names the model.');
    const saved = lines(fake, turn.conversation);
    assert.equal(saved.filter(line => line.role === 'user').length, 2, 'One user line for the two messages.');
    assert.equal(saved[2].text, 'One thing.\n\nAnother thing.');
    assert.equal(saved[2].queued.length, 2);
    assert.equal(saved[2].model, 'sonnet');
    assert.notEqual(saved[2].role, saved[1].role, 'No two user lines in a row.');
  } finally { await close(); }
});

test('cancel removes one message; a second cancel, or one after delivery, is a 409, and the etag settles cancel against delivery', async () => {
  const { fake, upstream, call, origin, owner, close } = await fixture({ hermes: { runScripts: [[{ hold: true }], ['Done.']] } });
  try {
    const turn = await startTurn(origin, owner, { text: 'first' });
    const one = (await (await queue(call, turn.conversation, 'Keep this.')).json()).queued[0];
    const two = (await (await queue(call, turn.conversation, 'Drop this.')).json()).queued[1];
    const cancelled = await call('POST', `/hub/chat/${turn.conversation}/queue/${two.id}/cancel`, {});
    assert.equal(cancelled.status, 200);
    assert.deepEqual((await cancelled.json()).queued.map(item => item.text), ['Keep this.']);
    const again = await call('POST', `/hub/chat/${turn.conversation}/queue/${two.id}/cancel`, {});
    assert.equal(again.status, 409);
    assert.match((await again.json()).error, /has been sent/);
    // Delivery and a cancel at the same moment: one wins, and the loser is told.
    upstream.release(turn.run, 'Ok.');
    const late = await call('POST', `/hub/chat/${turn.conversation}/queue/${one.id}/cancel`, {});
    await until(() => upstream.runs.length >= 1 && queueFile(fake, turn.conversation).items.length === 0, 'the queue to settle');
    if (late.status === 200) {
      await wait(150);
      assert.equal(upstream.runs.length, 1, 'A cancelled message is never sent.');
    } else {
      assert.equal(late.status, 409);
      await until(() => upstream.runs.length === 2, 'the delivery');
      assert.equal(upstream.runs[1].body.input, 'Keep this.');
    }
  } finally { await close(); }
});

test('Stop holds the queue, nothing goes out by itself, and Send now delivers', async () => {
  const { fake, upstream, call, origin, owner, close } = await fixture({ hermes: { runScripts: [[{ hold: true }], ['Sent after the stop.']] } });
  try {
    const turn = await startTurn(origin, owner, { text: 'first' });
    await queue(call, turn.conversation, 'Wait for me.');
    assert.equal((await call('POST', '/hub/chat/stop', { run: turn.run })).status, 200);
    const held = await until(async () => { const answer = await read(call, turn.conversation); return answer.held ? answer : null; }, 'the hold');
    assert.equal(held.held.reason, 'stopped');
    assert.equal(held.queued.length, 1, 'The message stays.');
    await wait(150);
    assert.equal(upstream.runs.length, 1, 'Nothing goes out by itself.');
    assert.ok(!(await read(call, turn.conversation)).running);
    const sent = await call('POST', `/hub/chat/${turn.conversation}/queue/send`, {});
    assert.equal(sent.status, 200);
    await until(() => lines(fake, turn.conversation).some(line => line.text === 'Sent after the stop.'), 'the delivery');
    const after = await until(async () => { const answer = await read(call, turn.conversation); return answer.running ? null : answer; }, 'the end');
    assert.deepEqual(after.queued, []);
    assert.equal(after.held, null);
  } finally { await close(); }
});

test('a failed reply holds the queue too, with the reason failed', async () => {
  const { upstream, call, origin, owner, close } = await fixture({ hermes: { runScripts: [[{ until: 'go' }, { fail: 'quota is over' }], ['never']] } });
  try {
    const turn = await startTurn(origin, owner, { text: 'first' });
    await queue(call, turn.conversation, 'After the failure.');
    upstream.go('go');
    const held = await until(async () => { const answer = await read(call, turn.conversation); return answer.held ? answer : null; }, 'the hold');
    assert.equal(held.held.reason, 'failed');
    assert.equal(held.queued.length, 1);
    await wait(100);
    assert.equal(upstream.runs.length, 1);
  } finally { await close(); }
});

test('a persona chat keeps its persona when the queue delivers', async () => {
  const { fake, upstream, call, origin, owner, close } = await fixture({ hermes: { runScripts: [[{ hold: true }], ['As the researcher.']] } });
  try {
    const turn = await startTurn(origin, owner, { text: 'first', persona: 'market-researcher' });
    await queue(call, turn.conversation, 'More.');
    upstream.release(turn.run, 'Ok.');
    await until(() => lines(fake, turn.conversation).length >= 4, 'the delivery');
    assert.deepEqual(lines(fake, turn.conversation).map(line => line.persona), Array(4).fill('market-researcher'));
    assert.match(upstream.runs[1].body.conversation_history[0].content, /./, 'The persona text goes first.');
    assert.ok(upstream.runs[1].body.conversation_history.length >= 3);
  } finally { await close(); }
});

test('a 429 on start keeps the messages, and three tries hold them', async () => {
  const { fake, upstream, hub, call, origin, owner, refuse, close } = await fixture({ refuseStarts: true, hermes: { runScripts: [[{ hold: true }]] } });
  try {
    const turn = await startTurn(origin, owner, { text: 'first' });
    await queue(call, turn.conversation, 'Try me.');
    refuse.on = true;
    upstream.release(turn.run, 'Ok.');
    await until(() => queueFile(fake, turn.conversation).tries === 1, 'the first failed try');
    let file = queueFile(fake, turn.conversation);
    assert.equal(file.items.length, 1, 'The message is back in the queue.');
    assert.equal(file.held, null);
    assert.ok(!(await read(call, turn.conversation)).running);
    await hub.chat.sweep();
    await until(() => queueFile(fake, turn.conversation).tries === 2, 'the second failed try');
    await hub.chat.sweep();
    file = await until(() => { const next = queueFile(fake, turn.conversation); return next.held ? next : null; }, 'the hold after three tries');
    assert.equal(file.held.reason, 'failed');
    assert.equal(file.items[0].text, 'Try me.');
    assert.equal(upstream.runs.length, 1, 'Hermes never took it.');
    refuse.on = false;
    await hub.chat.sweep();
    await wait(100);
    assert.equal(upstream.runs.length, 1, 'A held queue is not swept.');
  } finally { await close(); }
});

test('the limits: five messages and 16000 characters in a chat, and refused shapes', async () => {
  const { call, origin, owner, close } = await fixture({ hermes: { runScripts: [[{ hold: true }]] } });
  try {
    const turn = await startTurn(origin, owner, { text: 'first' });
    for (let at = 0; at < QUEUE_LIMITS.items; at += 1) assert.equal((await queue(call, turn.conversation, `m${at}`)).status, 201);
    const over = await queue(call, turn.conversation, 'one more');
    assert.equal(over.status, 409);
    assert.match((await over.json()).error, /5 messages/);
    assert.equal((await queue(call, turn.conversation, '')).status, 400);
    assert.equal((await queue(call, turn.conversation, 'x'.repeat(8001))).status, 400);
    assert.equal((await queue(call, turn.conversation, 'x', { images: [{ type: 'image/png', data: 'AAAA' }] })).status, 400, 'Pictures stay out of the queue.');
    assert.equal((await queue(call, turn.conversation, 'x', { model: 'gpt-nonsense' })).status, 400);
    assert.equal((await queue(call, '20260101-zzzzzz', 'x')).status, 404, 'No such conversation.');
    assert.equal((await queue(call, 'not-an-id', 'x')).status, 404);
    assert.equal((await call('POST', `/hub/chat/${turn.conversation}/queue`, { text: 'x' }, { Origin: 'https://site.example' })).status, 401, 'Signed-in users only.');
  } finally { await close(); }
});

test('the characters limit names itself', async () => {
  const { call, origin, owner, close } = await fixture({ hermes: { runScripts: [[{ hold: true }]] } });
  try {
    const turn = await startTurn(origin, owner, { text: 'first' });
    assert.equal((await queue(call, turn.conversation, 'a'.repeat(8000))).status, 201);
    assert.equal((await queue(call, turn.conversation, 'b'.repeat(8000))).status, 201);
    const over = await queue(call, turn.conversation, 'c');
    assert.equal(over.status, 409);
    assert.match((await over.json()).error, /16000/);
  } finally { await close(); }
});

test('with nothing running and nothing held, a queued message goes at once', async () => {
  const { fake, upstream, call, origin, owner, close } = await fixture({ hermes: { runScripts: [['Hi.'], ['Answered at once.']] } });
  try {
    const turn = await startTurn(origin, owner, { text: 'first' });
    await until(() => lines(fake, turn.conversation).length >= 2, 'the first reply');
    await until(async () => !(await read(call, turn.conversation)).running, 'the end');
    const answer = await queue(call, turn.conversation, 'Straight away.');
    assert.equal(answer.status, 201);
    await until(() => lines(fake, turn.conversation).length >= 4, 'the second reply');
    assert.equal(upstream.runs[1].body.input, 'Straight away.');
  } finally { await close(); }
});

/** A run started straight on the fake Hermes, as a service that has since died left it. */
const orphanRun = async upstream => (await (await fetch(`${upstream.url}/v1/runs`, { method: 'POST', headers: { authorization: 'Bearer k1', 'content-type': 'application/json' }, body: JSON.stringify({ input: 'orphan' }) })).json()).run_id;
const seedQueue = (fake, id, value) => fake.seed(`sections/inbox/chat/queue/${id}.json`, JSON.stringify({ v: 1, items: [], held: null, turn: null, ...value }), 'application/json');

test('restart: a second service finishes a run that ended while nobody listened, saves it and delivers the queue', async () => {
  const { fake, upstream, serve, close } = await fixture({ hermes: { runScripts: [[{ hold: true }], ['Delivered after the restart.']] } });
  try {
    const run = await orphanRun(upstream);
    const id = '20261104-abcd01';
    const at = new Date().toISOString();
    seedQueue(fake, id, { items: [{ id: 'qkept', text: 'Waiting across a restart.', at, by: 'owner' }], turn: { key: `${id}-t-dead01`, run, text: 'first', at, by: 'owner', queued: [], pumped: false, tries: 0 } });
    upstream.release(run, 'The reply finished while nobody listened.');
    const second = await serve();
    await second.hub.chat.sweep();
    await until(() => fake.text(`sections/inbox/chat/${id}.jsonl`) && lines(fake, id).length >= 4, 'the reply and the delivery');
    const saved = lines(fake, id);
    assert.deepEqual(saved.map(line => [line.role, line.text]), [['user', 'first'], ['assistant', 'The reply finished while nobody listened.'], ['user', 'Waiting across a restart.'], ['assistant', 'Delivered after the restart.']]);
    assert.equal(saved[2].queued[0], 'qkept');
    assert.equal(upstream.runs.length, 2);
    await until(() => queueFile(fake, id).turn === null, 'the turn to clear');
    assert.equal(queueFile(fake, id).items.length, 0);
  } finally { await close(); }
});

test('restart: a run still going is read on and saved, and a saved reply is not saved twice', async () => {
  const { fake, upstream, serve, close } = await fixture({ hermes: { runScript: [{ hold: true }] } });
  try {
    const run = await orphanRun(upstream);
    const id = '20261104-abcd02';
    const at = new Date().toISOString();
    seedQueue(fake, id, { turn: { key: `${id}-t-dead02`, run, text: 'question', at, by: 'owner', queued: [], pumped: false, tries: 0 } });
    const second = await serve();
    await second.hub.chat.sweep();
    await until(async () => (await (await second.call('GET', `/hub/chat/${id}`)).json()).running, 'the new service to carry the run');
    assert.equal((await (await second.call('GET', `/hub/chat/${id}`)).json()).asking.text, 'question');
    upstream.release(run, 'It was done.');
    await until(() => fake.text(`sections/inbox/chat/${id}.jsonl`) && lines(fake, id).length >= 2, 'the reply');
    const saved = lines(fake, id);
    assert.deepEqual(saved.map(line => [line.role, line.text]), [['user', 'question'], ['assistant', 'It was done.']], 'The plain turn that was running is saved.');
    await until(() => queueFile(fake, id).turn === null, 'the turn to clear');
    // A turn already saved (the service stopped between the save and the clear): only the turn goes.
    seedQueue(fake, id, { turn: { key: `${id}-t-dead03`, run, text: 'question', at: saved[0].at, by: 'owner', queued: [], pumped: false, tries: 0 } });
    await second.hub.chat.sweep();
    await until(() => queueFile(fake, id).turn === null, 'the saved turn to clear');
    assert.equal(lines(fake, id).length, 2, 'Nothing is saved twice.');
  } finally { await close(); }
});


test('restart: a run Hermes forgot comes back as a held message with its words', async () => {
  const { fake, upstream, serve, close } = await fixture({ hermes: { runScript: [{ hold: true }] } });
  try {
    const started = await (await fetch(`${upstream.url}/v1/runs`, { method: 'POST', headers: { authorization: 'Bearer k1', 'content-type': 'application/json' }, body: JSON.stringify({ input: 'lost words' }) })).json();
    const id = '20261104-lost01';
    fake.seed(`sections/inbox/chat/queue/${id}.json`, JSON.stringify({ v: 1, items: [], held: null, turn: { key: `${id}-t-dead04`, run: started.run_id, text: 'lost words', at: new Date().toISOString(), by: 'owner', queued: [], pumped: false, tries: 0 } }), 'application/json');
    upstream.forget(started.run_id);
    const second = await serve();
    await second.hub.chat.sweep();
    const file = await until(() => { const next = queueFile(fake, id); return next.held ? next : null; }, 'the hold');
    assert.equal(file.held.reason, 'lost');
    assert.equal(file.turn, null);
    assert.deepEqual(file.items.map(item => item.text), ['lost words'], 'The words stay on screen.');
  } finally { await close(); }
});

test('/live replays a running turn, follows it to its end, and says idle when nothing runs', async () => {
  const { upstream, call, origin, owner, close } = await fixture({ hermes: { runScripts: [['Working. ', { hold: true }]] } });
  try {
    const turn = await startTurn(origin, owner, { text: 'first' });
    await until(async () => (await read(call, turn.conversation)).running, 'the turn');
    const answer = await call('GET', `/hub/chat/${turn.conversation}/live`);
    assert.match(answer.headers.get('content-type'), /text\/event-stream/);
    const reader = answer.body.getReader();
    let buffer = '';
    const readUntil = async pattern => { while (!pattern.test(buffer)) { const { done, value } = await reader.read(); if (done) return false; buffer += new TextDecoder().decode(value); } return true; };
    assert.ok(await readUntil(/event: delta\ndata: \{"text":"Working\. "\}/), 'The earlier deltas are replayed.');
    upstream.release(turn.run, 'Working. Finished.');
    assert.ok(await readUntil(/event: done/), 'It follows to the end.');
    for (;;) { const { done } = await reader.read(); if (done) break; }
    const idle = await call('GET', `/hub/chat/${turn.conversation}/live`);
    assert.match(await idle.text(), /event: idle/);
  } finally { await close(); }
});

test('a stop for a run nobody carries is still a 404', async () => {
  const { call, close } = await fixture();
  try {
    assert.equal((await call('POST', '/hub/chat/stop', { run: 'run_nope' })).status, 404);
    assert.equal((await call('POST', '/hub/chat/stop', { run: '' })).status, 404);
  } finally { await close(); }
});

test('a picture turn counts as busy (it has no run), so a message sent meanwhile waits; it is held when the page leaves', async () => {
  const { call, origin, owner, close } = await fixture({ hermes: { hold: true } });
  try {
    const controller = new AbortController();
    const answer = await fetch(`${origin}/api/hub/chat`, { method: 'POST', headers: { ...owner, 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'look', images: [{ type: 'image/png', data: solidPng(8, 8).toString('base64') }] }), signal: controller.signal });
    const reader = answer.body.getReader();
    let buffer = '';
    while (!/event: started\ndata: (.+)\n\n/.test(buffer)) buffer += new TextDecoder().decode((await reader.read()).value);
    const started = JSON.parse(/event: started\ndata: (.+)\n\n/.exec(buffer)[1]);
    assert.equal(started.run, null);
    const busy = await read(call, started.conversation);
    assert.equal(busy.running, true, 'A picture turn is registered.');
    assert.equal(busy.run, null);
    assert.equal((await queue(call, started.conversation, 'Text meanwhile.')).status, 201);
    controller.abort();   // a picture turn dies with its page
    const held = await until(async () => { const next = await read(call, started.conversation); return next.held ? next : null; }, 'the hold');
    assert.equal(held.held.reason, 'failed');
    assert.equal(held.queued[0].text, 'Text meanwhile.', 'Nothing was lost.');
  } finally { await close(); }
});

// --- Review 3.1 -------------------------------------------------------------------------------------------------------

test('review 2: a message queued while a turn is still being accepted by Hermes waits, and does not start a second run', async () => {
  const { fake, upstream, call, origin, owner, refuse, close } = await fixture({ hermes: { runScripts: [['Hi.'], [{ hold: true }], ['Then the third.']] } });
  try {
    const first = await startTurn(origin, owner, { text: 'first' });
    await until(() => fake.text(`sections/inbox/chat/${first.conversation}.jsonl`) && lines(fake, first.conversation).length >= 2, 'the first reply');
    await until(async () => !(await read(call, first.conversation)).running, 'the end');
    refuse.delay = 400;   // Hermes takes 400 ms to accept the next start
    const slow = fetch(`${origin}/api/hub/chat`, { method: 'POST', headers: { ...owner, 'Content-Type': 'application/json' }, body: JSON.stringify({ conversation: first.conversation, text: 'second' }) });
    await wait(100);
    assert.equal((await queue(call, first.conversation, 'queued during the start')).status, 201);
    await wait(700);
    const answer = await slow;
    assert.equal(answer.status, 200);
    assert.equal(upstream.runs.length, 2, 'Only the second turn runs; the queued message waits for it.');
    assert.equal(upstream.runs[1].body.input, 'second');
    upstream.release(upstream.runs[1].id, 'Second done.');
    await until(() => lines(fake, first.conversation).length >= 6, 'the queued turn');
    assert.deepEqual(lines(fake, first.conversation).map(line => line.text).slice(2), ['second', 'Second done.', 'queued during the start', 'Then the third.']);
    await answer.body?.cancel().catch(() => {});
  } finally { await close(); }
});

test('review 3: a start whose answer was lost is retried under the same key, so Hermes starts one run', async () => {
  const { fake, upstream, hub, call, origin, owner, refuse, close } = await fixture({ hermes: { runScripts: [[{ hold: true }], ['Sent once.']] } });
  try {
    const turn = await startTurn(origin, owner, { text: 'first' });
    await queue(call, turn.conversation, 'Do not send me twice.');
    refuse.lose = true;
    upstream.release(turn.run, 'Ok.');
    const stuck = await until(() => { const file = queueFile(fake, turn.conversation); return file.turn && file.turn.run === null && file.turn.tries === 1 ? file : null; }, 'the unknown start to be kept');
    assert.equal(stuck.items.length, 0, 'The turn keeps the words; they are not put back as new ones.');
    refuse.lose = false;
    await hub.chat.sweep();
    await until(() => lines(fake, turn.conversation).some(line => line.text === 'Sent once.'), 'the retry');
    assert.equal(upstream.runs.length, 2, 'One run for the message.');
    assert.equal(new Set(upstream.runs.map(run => run.key)).size, 2, 'Each turn has its own key; the retry reused the second one.');
    assert.equal(lines(fake, turn.conversation).filter(line => line.text === 'Do not send me twice.').length, 1);
  } finally { await close(); }
});

test('review 3: an unknown start three times in a row is held as failed, with the words back', async () => {
  const { fake, upstream, hub, call, origin, owner, refuse, close } = await fixture({ hermes: { runScripts: [[{ hold: true }], ['x']] } });
  try {
    const turn = await startTurn(origin, owner, { text: 'first' });
    await queue(call, turn.conversation, 'Never accepted.');
    refuse.lose = true;
    upstream.release(turn.run, 'Ok.');
    await until(() => queueFile(fake, turn.conversation).turn?.tries === 1, 'try 1');
    await hub.chat.sweep();
    await until(() => queueFile(fake, turn.conversation).turn?.tries === 2, 'try 2');
    await hub.chat.sweep();
    const file = await until(() => { const next = queueFile(fake, turn.conversation); return next.held ? next : null; }, 'the hold');
    assert.equal(file.held.reason, 'failed');
    assert.deepEqual(file.items.map(item => item.text), ['Never accepted.']);
    assert.equal(file.turn, null);
  } finally { await close(); }
});

test('review 4: a Stop that Hermes did not act on, because the run was ending, still holds the queue', async () => {
  const { fake, upstream, call, origin, owner, refuse, close } = await fixture({ hermes: { runScripts: [[{ hold: true }], ['Must not go.']] } });
  try {
    const turn = await startTurn(origin, owner, { text: 'first' });
    await queue(call, turn.conversation, 'Wait.');
    refuse.ignoreStop = true;   // the stop reaches the Hub, and the run completes anyway
    assert.equal((await call('POST', '/hub/chat/stop', { run: turn.run })).status, 200);
    upstream.release(turn.run, 'It finished.');
    const held = await until(async () => { const answer = await read(call, turn.conversation); return answer.held ? answer : null; }, 'the hold');
    assert.equal(held.held.reason, 'stopped');
    await wait(150);
    assert.equal(upstream.runs.length, 1, 'Nothing goes out after a Stop.');
    assert.deepEqual(held.queued.map(item => item.text), ['Wait.']);
    assert.ok(fake.text(`sections/inbox/chat/${turn.conversation}.jsonl`).includes('It finished.'));
  } finally { await close(); }
});

test('review 4: a reply that has ended cannot be stopped, even before its lines are all saved', async () => {
  const { upstream, call, origin, owner, close } = await fixture({ hermes: { runScripts: [[{ hold: true }]] } });
  try {
    const turn = await startTurn(origin, owner, { text: 'first' });
    upstream.release(turn.run, 'Done.');
    await until(async () => (await call('POST', '/hub/chat/stop', { run: turn.run })).status === 404, 'a 404 for a finished turn');
    assert.deepEqual(upstream.stops, [], 'Hermes was never asked to stop a finished run.');
  } finally { await close(); }
});

const hoursAgo = hours => new Date(Date.now() - hours * 3600_000).toISOString();

test('review 5: messages that waited more than an hour are held as old, not delivered, at the sweep after a restart', async () => {
  const { fake, upstream, serve, close } = await fixture({ hermes: { runScripts: [[{ hold: true }], ['Must not go.']] } });
  try {
    const run = await orphanRun(upstream);
    const id = '20261104-old001';
    seedQueue(fake, id, { items: [{ id: 'qold', text: 'Written days ago.', at: hoursAgo(50), by: 'owner' }], turn: { key: `${id}-t-dead05`, run, text: 'first', at: hoursAgo(50), by: 'owner', queued: [], pumped: false, tries: 0 } });
    upstream.release(run, 'The reply finished.');
    const second = await serve();
    await second.hub.chat.sweep();
    const file = await until(() => { const next = queueFile(fake, id); return next.held ? next : null; }, 'the hold');
    assert.equal(file.held.reason, 'old');
    assert.equal(file.items[0].why, 'old', 'The row says why itself.');
    await wait(150);
    assert.equal(upstream.runs.length, 1, 'Nothing was sent.');
    // Send now is the owner's choice and delivers it.
    assert.equal((await second.call('POST', `/hub/chat/${id}/queue/send`, {})).status, 200);
    await until(() => upstream.runs.length === 2, 'Send now');
  } finally { await close(); }
});

test('review 5: opening a chat nudges the queue, and an old waiting message is held, not delivered', async () => {
  const { fake, upstream, call, close } = await fixture({ hermes: { runScript: ['Must not go.'] } });
  try {
    const id = '20261104-old002';
    fake.seed(`sections/inbox/chat/${id}.jsonl`, `${JSON.stringify({ role: 'user', text: 'earlier', at: hoursAgo(80) })}\n${JSON.stringify({ role: 'assistant', text: 'Reply.', at: hoursAgo(80) })}\n`, 'application/x-ndjson');
    seedQueue(fake, id, { items: [{ id: 'qold', text: 'Left over.', at: hoursAgo(80), by: 'owner' }] });
    const answer = await read(call, id);
    assert.equal(answer.queued.length, 1);
    const held = await until(async () => { const next = await read(call, id); return next.held ? next : null; }, 'the hold');
    assert.equal(held.held.reason, 'old');
    assert.equal(upstream.runs.length, 0);
  } finally { await close(); }
});

test('a message that waits with no saved chat behind it (a picture or help first turn lost to a restart) is held as lost', async () => {
  const { fake, upstream, hub, close } = await fixture();
  try {
    const id = '20261104-nofile';
    seedQueue(fake, id, { items: [{ id: 'q1', text: 'Into nothing.', at: new Date().toISOString(), by: 'owner' }] });
    await hub.chat.sweep();
    const file = await until(() => { const next = queueFile(fake, id); return next.held ? next : null; }, 'the hold');
    assert.equal(file.held.reason, 'lost');
    assert.equal(upstream.runs.length, 0);
  } finally { await close(); }
});

test('a message typed while a hold exists joins it, and each row says why itself', async () => {
  const { call, upstream, origin, owner, close } = await fixture({ hermes: { runScripts: [[{ hold: true }]] } });
  try {
    const turn = await startTurn(origin, owner, { text: 'first' });
    await queue(call, turn.conversation, 'Held one.');
    await call('POST', '/hub/chat/stop', { run: turn.run });
    await until(async () => (await read(call, turn.conversation)).held, 'the hold');
    const joined = await (await queue(call, turn.conversation, 'Typed later.')).json();
    assert.equal(joined.held.reason, 'stopped');
    assert.deepEqual(joined.queued.map(item => item.why), ['stopped', 'joined']);
    await wait(100);
    assert.equal(upstream.runs.length, 1, 'It did not go out by itself.');
  } finally { await close(); }
});

test('recovery does not save a turn twice when the owner has sent another since', async () => {
  const { fake, upstream, serve, close } = await fixture({ hermes: { runScript: [{ hold: true }] } });
  try {
    const run = await orphanRun(upstream);
    upstream.release(run, 'Late.');
    const id = '20261104-twice1';
    const at = new Date().toISOString();
    fake.seed(`sections/inbox/chat/${id}.jsonl`, [{ role: 'user', text: 'question', at }, { role: 'assistant', text: 'Late.', at }, { role: 'user', text: 'a newer one', at: new Date(Date.now() + 5).toISOString() }, { role: 'assistant', text: 'ok', at }].map(line => JSON.stringify(line)).join('\n') + '\n', 'application/x-ndjson');
    seedQueue(fake, id, { turn: { key: `${id}-t-dead06`, run, text: 'question', at, by: 'owner', queued: [], pumped: false, tries: 0 } });
    const second = await serve();
    await second.hub.chat.sweep();
    await until(() => queueFile(fake, id).turn === null, 'the turn to clear');
    assert.equal(lines(fake, id).filter(line => line.text === 'question').length, 1, 'Not appended again.');
  } finally { await close(); }
});

test('a long reply keeps its start: the run output wins over the events when it is longer', async () => {
  const { fake, call, origin, owner, close } = await fixture({ hermes: { runScript: ['the tail only.'], endWith: 'The whole reply, with the part the buffer lost, and the tail only.' } });
  try {
    const turn = await startTurn(origin, owner, { text: 'first' });
    await until(() => fake.text(`sections/inbox/chat/${turn.conversation}.jsonl`) && lines(fake, turn.conversation).length >= 2, 'the reply');
    assert.equal(lines(fake, turn.conversation)[1].text, 'The whole reply, with the part the buffer lost, and the tail only.');
    void call;
  } finally { await close(); }
});
