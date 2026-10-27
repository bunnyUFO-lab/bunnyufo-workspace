// The Hub's chat and transcribe routes, against a fake Hermes, over the stand-in S3.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSiteApi } from '../server.mjs';
import { createBucket } from '../s3.mjs';
import { createHub } from '../hub.mjs';
import { startFakeS3 } from './fake-s3.mjs';
import { startFakeHermes } from './fake-hermes.mjs';
import { requestJson } from './hub-fixtures.mjs';

async function fixture({ hermes = {}, env = {}, requireRemoteUser = true } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'buw-chat-'));
  const fake = await startFakeS3();
  const upstream = await startFakeHermes({ key: 'k1', ...hermes });
  const bucket = createBucket({ bucket: fake.bucket, endpoint: fake.endpoint, credentials: fake.credentials, region: 'us-east-1' });
  fake.seed('sections/inbox/workspace.json', '{"name":"Inbox","hidden":true,"entities":[]}\n', 'application/json');
  fake.seed('state.json', '{"version":1,"cards":{}}', 'application/json');
  const hubEnv = { HERMES_URL: upstream.url, HERMES_API_KEY: 'k1', STT_URL: `${upstream.url}/v1/audio/transcriptions`, STT_API_KEY: 'k1', ...env };
  const server = createSiteApi({ bucket, templateDir: path.join(root, 'none'), stateFile: path.join(root, 'c.json'), sectionsTtl: 0, requireRemoteUser, hub: createHub({ bucket, enabled: true, env: hubEnv }) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const owner = { 'Remote-User': 'owner' };
  const call = (method, route, data, headers = owner) => fetch(`${origin}/api${route}`, { method, headers: { ...(data === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, body: data === undefined ? undefined : JSON.stringify(data) });
  const close = async () => { server.closeAllConnections?.(); server.close(); await upstream.close(); await fake.close(); };
  return { fake, upstream, call, origin, owner, close };
}

/** POST /hub/chat and read the event stream into [{ event, data }]. */
async function chat(call, data, headers) {
  const answer = await call('POST', '/hub/chat', data, headers);
  if (!(answer.headers.get('content-type') ?? '').startsWith('text/event-stream')) return { status: answer.status, body: await answer.json() };
  const events = [];
  for (const block of (await answer.text()).split('\n\n')) {
    const event = /^event: (.+)$/m.exec(block)?.[1];
    const payload = /^data: (.+)$/m.exec(block)?.[1];
    if (event) events.push({ event, data: JSON.parse(payload) });
  }
  return { status: answer.status, headers: answer.headers, events };
}

const lines = (fake, conversation) => fake.text(`sections/inbox/chat/${conversation}.jsonl`).trim().split('\n').map(line => JSON.parse(line));

test('a streamed reply is relayed delta by delta, saved, and the history goes back on the next turn', async () => {
  const { fake, upstream, call, close } = await fixture();
  try {
    const first = await chat(call, { text: 'What happened today?' });
    assert.equal(first.status, 200);
    assert.equal(first.headers.get('x-accel-buffering'), 'no');
    assert.match(first.headers.get('cache-control'), /no-transform/);
    assert.deepEqual(first.events.filter(item => item.event === 'delta').map(item => item.data.text), ['Hel', 'lo ', 'there']);
    const done = first.events.at(-1);
    assert.equal(done.event, 'done');
    const saved = lines(fake, done.data.conversation);
    assert.deepEqual(saved.map(line => [line.role, line.text]), [['user', 'What happened today?'], ['assistant', 'Hello there']]);
    assert.equal(upstream.requests[0].messages.length, 1, 'No system message from the Hub.');
    assert.equal(upstream.requests[0].model, 'hermes-agent');
    assert.equal(upstream.requests[0].stream, true);

    const second = await chat(call, { conversation: done.data.conversation, text: 'And yesterday?' });
    assert.equal(second.events.at(-1).data.conversation, done.data.conversation);
    assert.deepEqual(upstream.requests[1].messages.map(message => message.role), ['user', 'assistant', 'user']);
    assert.equal(lines(fake, done.data.conversation).length, 4);

    const listed = await (await call('GET', '/hub/chat')).json();
    assert.deepEqual(listed.conversations.map(item => [item.id, item.title, item.count]), [[done.data.conversation, 'What happened today?', 4]]);
    const read = await (await call('GET', `/hub/chat/${done.data.conversation}`)).json();
    assert.equal(read.messages.length, 4);
    assert.equal((await call('GET', '/hub/chat/20260101-zzzzzz')).status, 404);
  } finally { await close(); }
});

test('something Hermes files during the turn is announced and saved with the reply', async () => {
  let fake;
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const hermes = {
    onTurn: async () => {
      const mine = `${stamp}-probe-from-hermes-h111`;
      const theirs = `${stamp}-probe-from-owner-o111`;
      fake.seed(`sections/inbox/requests/${mine}/request.json`, JSON.stringify(requestJson({ id: mine, by: 'hermes-main', text: 'Hermes asked for this', now: new Date() })), 'application/json');
      fake.seed(`sections/inbox/requests/${theirs}/request.json`, JSON.stringify(requestJson({ id: theirs, by: 'owner', text: 'Not Hermes', now: new Date() })), 'application/json');
    },
  };
  const setup = await fixture({ hermes });
  fake = setup.fake;
  try {
    const result = await chat(setup.call, { text: 'File a request' });
    const created = result.events.find(item => item.event === 'created');
    assert.equal(created.data.items.length, 1);
    assert.deepEqual([created.data.items[0].kind, created.data.items[0].title], ['request', 'Hermes asked for this']);
    const saved = lines(fake, result.events.at(-1).data.conversation);
    assert.equal(saved[1].created[0].kind, 'request');
  } finally { await setup.close(); }
});

test('configuration: unset URL → chat false and 503; a failing Hermes → 502 with nothing saved; unsigned reads → 401', async () => {
  const off = await fixture({ env: { HERMES_URL: '' } });
  try {
    const caps = await (await off.call('GET', '/capabilities')).json();
    assert.deepEqual([caps.chat, caps.transcribe], [false, true]);
    assert.equal((await off.call('POST', '/hub/chat', { text: 'hi' })).status, 503);
    assert.equal((await off.call('GET', '/hub/chat')).status, 503);
  } finally { await off.close(); }
  const broken = await fixture({ hermes: { fail: true } });
  try {
    assert.equal((await (await broken.call('GET', '/capabilities')).json()).chat, true);
    const answer = await chat(broken.call, { text: 'hi' });
    assert.equal(answer.status, 502);
    assert.match(answer.body.error, /Hermes did not answer \(500\)/);
    assert.deepEqual([...broken.fake.objects.keys()].filter(name => name.includes('/chat/')), []);
    assert.equal((await broken.call('GET', '/hub/chat', undefined, {})).status, 401, 'Even reads need Remote-User.');
    assert.equal((await broken.call('POST', '/hub/chat', { text: 'x' }, {})).status, 401);
    const anonymous = await (await broken.call('GET', '/capabilities', undefined, {})).json();
    assert.deepEqual([anonymous.hub, anonymous.chat, anonymous.transcribe], [true, false, false]);
    assert.equal((await broken.call('POST', '/hub/chat', { text: '' })).status, 400);
    assert.equal((await broken.call('POST', '/hub/chat', { text: 'x'.repeat(70 * 1024) })).status, 413);
  } finally { await broken.close(); }
});

test('transcribe: type and size are checked, the text is trimmed, and without STT_URL it is off', async () => {
  const { upstream, origin, owner, close } = await fixture();
  const send = (type, body) => fetch(`${origin}/api/hub/transcribe`, { method: 'POST', headers: { ...owner, 'Content-Type': type }, body });
  try {
    assert.equal((await send('audio/webm', Buffer.alloc(2 * 1024 * 1024 + 1))).status, 413);
    assert.equal((await send('text/plain', 'hello')).status, 415);
    const ok = await send('audio/webm;codecs=opus', Buffer.from('fake-audio'));
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { text: 'hello from the fake mic' });
    assert.match(upstream.sttFiles[0].text, /name="file"; filename="speech\.webm"/);
    assert.match(upstream.sttFiles[0].text, /whisper-large-v3-turbo/);
    assert.equal((await send('audio/mp4', Buffer.from('m4a'))).status, 200);
  } finally { await close(); }
  const off = await fixture({ env: { STT_URL: '' } });
  try {
    assert.equal((await (await off.call('GET', '/capabilities')).json()).transcribe, false);
    assert.equal((await fetch(`${off.origin}/api/hub/transcribe`, { method: 'POST', headers: { ...off.owner, 'Content-Type': 'audio/webm' }, body: 'x' })).status, 503);
  } finally { await off.close(); }
});

test('a client that goes away mid-reply makes the relay hang up on Hermes within a second', async () => {
  const { upstream, origin, owner, close } = await fixture({ hermes: { hold: true } });
  try {
    const controller = new AbortController();
    const answer = await fetch(`${origin}/api/hub/chat`, { method: 'POST', headers: { ...owner, 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'long one' }), signal: controller.signal });
    const reader = answer.body.getReader();
    await reader.read();
    controller.abort();
    const started = Date.now();
    while (upstream.state.closedEarly === 0 && Date.now() - started < 1500) await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(upstream.state.closedEarly, 1);
    assert.ok(Date.now() - started < 1000);
  } finally { await close(); }
});

test('the chat routes write only under sections/inbox/chat/', async () => {
  const { fake, call, origin, owner, close } = await fixture();
  try {
    fake.log.length = 0;
    await chat(call, { text: 'one' });
    await fetch(`${origin}/api/hub/transcribe`, { method: 'POST', headers: { ...owner, 'Content-Type': 'audio/webm' }, body: 'x' });
    const writes = fake.log.filter(entry => entry.method === 'PUT' || entry.method === 'DELETE');
    assert.ok(writes.length >= 1);
    assert.deepEqual(writes.filter(entry => !entry.key.startsWith('sections/inbox/chat/')), []);
  } finally { await close(); }
});
