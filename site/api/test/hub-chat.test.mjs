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
import { jpeg, solidPng, textPng } from './png.mjs';

async function fixture({ hermes = {}, env = {}, requireRemoteUser = true } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'buw-chat-'));
  const fake = await startFakeS3();
  const upstream = await startFakeHermes({ key: 'k1', ...hermes });
  const bucket = createBucket({ bucket: fake.bucket, endpoint: fake.endpoint, credentials: fake.credentials, region: 'us-east-1' });
  fake.seed('sections/inbox/workspace.json', '{"name":"Inbox","hidden":true,"entities":[]}\n', 'application/json');
  fake.seed('state.json', '{"version":1,"cards":{}}', 'application/json');
  const hubEnv = { HERMES_URL: upstream.url, HERMES_API_KEY: 'k1', STT_URL: `${upstream.url}/v1/audio/transcriptions`, STT_API_KEY: 'k1', ...env };
  const server = createSiteApi({ bucket, templateDir: path.join(root, 'none'), stateFile: path.join(root, 'c.json'), sectionsTtl: 0, requireRemoteUser, allowedOrigins: ['https://site.example'], hub: createHub({ bucket, enabled: true, env: hubEnv }) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const owner = { 'Remote-User': 'owner', Origin: 'https://site.example' };
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
    assert.equal((await broken.call('POST', '/hub/chat', { text: 'x'.repeat(70 * 1024) })).status, 400, 'Long text is refused by length.');
    assert.equal((await broken.call('POST', '/hub/chat', { text: 'x'.repeat(7.5 * 1024 * 1024) })).status, 413);
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

const b64 = buffer => buffer.toString('base64');
const picture = (buffer, type) => ({ type, data: b64(buffer) });
const objectsUnder = (fake, conversation) => [...fake.objects.keys()].filter(name => name.startsWith(`sections/inbox/chat/${conversation}/`));

test('pictures: both reach Hermes as data URLs without metadata, are stored, saved on the line and sent back in done', async () => {
  const { fake, upstream, call, close } = await fixture();
  try {
    const png = textPng(40, 30);
    const jpg = jpeg(64, 48);
    const result = await chat(call, { text: 'What is this?', images: [picture(png, 'image/png'), picture(jpg, 'image/jpeg')] });
    assert.equal(result.status, 200);
    const done = result.events.at(-1);
    const content = upstream.requests[0].messages.at(-1).content;
    assert.deepEqual(content.map(part => part.type), ['text', 'image_url', 'image_url']);
    assert.match(content[1].image_url.url, /^data:image\/png;base64,/);
    assert.match(content[2].image_url.url, /^data:image\/jpeg;base64,/);
    const sentJpeg = Buffer.from(content[2].image_url.url.split(',')[1], 'base64');
    const sentPng = Buffer.from(content[1].image_url.url.split(',')[1], 'base64');
    assert.ok(!sentJpeg.includes('Exif') && !sentJpeg.includes('GPS'));
    assert.ok(!sentPng.includes('tEXt'));
    const stored = objectsUnder(fake, done.data.conversation);
    assert.equal(stored.length, 2);
    for (const name of stored) assert.match(name.split('/').pop(), /^[a-z0-9]{10}\.(jpg|png)$/);
    const savedJpeg = fake.objects.get(stored.find(name => name.endsWith('.jpg'))).body;
    const savedPng = fake.objects.get(stored.find(name => name.endsWith('.png'))).body;
    assert.ok(!savedJpeg.includes('Exif') && !savedJpeg.includes('GPS') && !savedPng.includes('tEXt'));
    assert.deepEqual(savedPng.subarray(16, 24), png.subarray(16, 24), 'Same size.');
    assert.equal(savedJpeg.readUInt16BE(savedJpeg.indexOf(Buffer.from([0xff, 0xc0])) + 7), 64);
    const line = lines(fake, done.data.conversation)[0];
    assert.deepEqual(line.images.map(image => [image.type, image.width, image.height]), [['image/png', 40, 30], ['image/jpeg', 64, 48]]);
    assert.deepEqual(done.data.user, line);
  } finally { await close(); }
});

test('pictures are served with the chat gate, nosniff and the right type; odd names are 404', async () => {
  const { fake, call, close } = await fixture();
  try {
    const result = await chat(call, { text: 'look', images: [picture(solidPng(8, 8), 'image/png')] });
    const id = result.events.at(-1).data.conversation;
    const file = result.events.at(-1).data.user.images[0].file;
    const got = await call('GET', `/hub/chat/${id}/images/${file}`);
    assert.equal(got.status, 200);
    assert.equal(got.headers.get('content-type'), 'image/png');
    assert.equal(got.headers.get('x-content-type-options'), 'nosniff');
    assert.match(got.headers.get('cache-control'), /immutable/);
    assert.deepEqual(Buffer.from(await got.arrayBuffer()), fake.objects.get(`sections/inbox/chat/${id}/${file}`).body);
    assert.equal((await call('GET', `/hub/chat/${id}/images/${file}`, undefined, {})).status, 401);
    assert.equal((await call('GET', `/hub/chat/${id}/images/aaaaaaaaaa.png`)).status, 404);
    assert.equal((await call('GET', `/hub/chat/${id}/images/..%2Fx.png`)).status, 404);
    assert.equal((await call('GET', `/hub/chat/${id}/images/%2e%2e`)).status, 404);
    assert.equal((await call('GET', `/hub/chat/${id}/images/${file.replace('.png', '.gif')}`)).status, 404);
    assert.equal((await call('GET', `/hub/chat/nope/images/${file}`)).status, 404);
  } finally { await close(); }
});

test('picture limits: count, size, total, type and dimensions; a picture alone is a message titled Picture', async () => {
  const { call, close } = await fixture();
  try {
    const small = picture(solidPng(4, 4), 'image/png');
    assert.equal((await call('POST', '/hub/chat', { text: 'x', images: [small, small, small, small, small] })).status, 400);
    assert.equal((await call('POST', '/hub/chat', { text: 'x', images: [picture(textPng(10, 10, { pad: 1.6 * 1024 * 1024 }), 'image/png')] })).status, 413);
    const big = picture(textPng(10, 10, { pad: 1.4 * 1024 * 1024 }), 'image/png');
    assert.equal((await call('POST', '/hub/chat', { text: 'x', images: [big, big, big, big] })).status, 413);
    assert.equal((await call('POST', '/hub/chat', { text: 'x', images: [{ type: 'image/gif', data: b64(Buffer.from('GIF89a......')) }] })).status, 415);
    assert.equal((await call('POST', '/hub/chat', { text: 'x', images: [{ type: 'image/png', data: b64(jpeg(5, 5)) }] })).status, 415, 'Bytes must match the type.');
    assert.equal((await call('POST', '/hub/chat', { text: 'x', images: [picture(jpeg(3000, 10), 'image/jpeg')] })).status, 400);
    assert.equal((await call('POST', '/hub/chat', { text: 'x', images: [picture(solidPng(10, 2049), 'image/png')] })).status, 400);
    assert.equal((await call('POST', '/hub/chat', { text: '', images: [] })).status, 400);
    const only = await chat(call, { text: '', images: [small] });
    assert.equal(only.status, 200);
    const listed = await (await call('GET', '/hub/chat')).json();
    assert.equal(listed.conversations[0].title, 'Picture');
  } finally { await close(); }
});

test('the next turn sends the earlier picture back; over the 6 MB budget the oldest become a note', async () => {
  const { upstream, call, close } = await fixture();
  try {
    const first = await chat(call, { text: 'one', images: [picture(solidPng(6, 6), 'image/png')] });
    const id = first.events.at(-1).data.conversation;
    await chat(call, { conversation: id, text: 'two' });
    const content = upstream.requests[1].messages[0].content;
    assert.deepEqual(content.map(part => part.type), ['text', 'image_url']);
    assert.match(content[1].image_url.url, /^data:image\/png;base64,/);

    const heavy = picture(textPng(10, 10, { pad: 1.4 * 1024 * 1024 }), 'image/png');
    const other = await chat(call, { text: 'a', images: [heavy] });
    const big = other.events.at(-1).data.conversation;
    for (const word of ['b', 'c', 'd', 'e']) await chat(call, { conversation: big, text: word, images: [heavy] });
    const parts = upstream.requests.at(-1).messages.flatMap(message => (Array.isArray(message.content) ? message.content : []));
    const sent = parts.filter(part => part.type === 'image_url').length;
    const notes = parts.filter(part => part.type === 'text' && part.text === '[An earlier picture is not included.]').length;
    assert.equal(sent, 4, 'The current picture and three earlier ones fit in 6 MB.');
    assert.equal(notes, 1, 'The oldest becomes a note.');
    assert.equal(upstream.requests.at(-1).messages[0].content.some(part => part.text === '[An earlier picture is not included.]'), true);
  } finally { await close(); }
});

test('when Hermes refuses the pictures the answer is 422 and nothing is written', async () => {
  const { fake, call, close } = await fixture({ hermes: { refuseImages: true } });
  try {
    const answer = await chat(call, { text: 'see', images: [picture(solidPng(5, 5), 'image/png')] });
    assert.equal(answer.status, 422);
    assert.equal(answer.body.error, 'Hermes could not take the picture: This model does not accept images.');
    assert.deepEqual([...fake.objects.keys()].filter(name => name.includes('/chat/')), []);
    assert.equal((await chat(call, { text: 'plain' })).status, 200, 'Text-only turns still work.');
  } finally { await close(); }
});
