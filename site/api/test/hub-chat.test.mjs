// The Hub's chat routes, against a fake Hermes, over the stand-in S3.
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
import { checklistJson, designAskJson, eventJson, requestJson, seeder } from './hub-fixtures.mjs';
import { jpeg, solidPng, textPng } from './png.mjs';

async function fixture({ hermes = {}, env = {}, requireRemoteUser = true } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'buw-chat-'));
  const fake = await startFakeS3();
  const upstream = await startFakeHermes({ key: 'k1', ...hermes });
  const bucket = createBucket({ bucket: fake.bucket, endpoint: fake.endpoint, credentials: fake.credentials, region: 'us-east-1' });
  fake.seed('sections/inbox/workspace.json', '{"name":"Inbox","hidden":true,"entities":[]}\n', 'application/json');
  fake.seed('state.json', '{"version":1,"cards":{}}', 'application/json');
  // The completions tests below run with the run path off (the kill switch); the run tests turn it on.
  const hubEnv = { HERMES_URL: upstream.url, HERMES_API_KEY: 'k1', HUB_CHAT_RUNS: '0', ...env };
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
    assert.equal(caps.chat, false);
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
    assert.deepEqual([anonymous.hub, anonymous.chat], [true, false]);
    assert.equal((await broken.call('POST', '/hub/chat', { text: '' })).status, 400);
    assert.equal((await broken.call('POST', '/hub/chat', { text: 'x'.repeat(70 * 1024) })).status, 400, 'Long text is refused by length.');
    assert.equal((await broken.call('POST', '/hub/chat', { text: 'x'.repeat(7.5 * 1024 * 1024) })).status, 413);
  } finally { await broken.close(); }
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
    for (const type of ['toString', '__proto__', 'constructor', 'hasOwnProperty']) {
      assert.equal((await call('POST', '/hub/chat', { text: 'x', images: [{ type, data: b64(jpeg(5, 5)) }] })).status, 415, `${type} is not an image type.`);
    }
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

// --- Chat on Hermes runs -------------------------------------------------------------------------------------------

const RUNS = { HUB_CHAT_RUNS: '1' };

/** POST /hub/chat and hand each event to `onEvent` as it arrives; resolves with all of them. */
async function chatLive(call, data, onEvent) {
  const answer = await call('POST', '/hub/chat', data);
  if (!(answer.headers.get('content-type') ?? '').startsWith('text/event-stream')) return { status: answer.status, body: await answer.json() };
  const events = [];
  const reader = answer.body.getReader();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += new TextDecoder().decode(value);
    let cut;
    while ((cut = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      const event = /^event: (.+)$/m.exec(block)?.[1];
      const payload = /^data: (.+)$/m.exec(block)?.[1];
      if (!event) continue;
      const entry = { event, data: JSON.parse(payload) };
      events.push(entry);
      await onEvent?.(entry);
    }
  }
  return { status: answer.status, events };
}

test('runs on: a turn streams deltas and a tool line, never names a provider, and saves the run and its tools', async () => {
  const { fake, upstream, call, close } = await fixture({ env: RUNS, hermes: { runScript: ['Looking ', { tool: 'search_files', preview: 'cards/' }, 'it up. ', 'Done.'] } });
  try {
    const first = await chatLive(call, { text: 'Find the deckbuilder notes' });
    assert.equal(first.status, 200);
    assert.deepEqual(first.events.filter(item => item.event === 'delta').map(item => item.data.text).join(''), 'Looking it up. Done.');
    const tools = first.events.filter(item => item.event === 'tool');
    assert.deepEqual(tools.map(item => [item.data.name, item.data.state]), [['search_files', 'running'], ['search_files', 'done']]);
    assert.equal(tools[0].data.summary, 'cards/');
    const done = first.events.at(-1);
    assert.equal(done.event, 'done');
    assert.equal(upstream.requests.length, 0, 'nothing went to completions');
    assert.deepEqual(upstream.runs[0].body, { input: 'Find the deckbuilder notes' });
    const saved = lines(fake, done.data.conversation);
    assert.equal(saved[1].text, 'Looking it up. Done.');
    assert.equal(saved[1].run, upstream.runs[0].id);
    assert.deepEqual(saved[1].tools, ['search_files']);
    const second = await chatLive(call, { text: 'And the second?', conversation: done.data.conversation });
    assert.equal(second.events.at(-1).event, 'done');
    assert.deepEqual(upstream.runs[1].body, { input: 'And the second?', conversation_history: [{ role: 'user', content: 'Find the deckbuilder notes' }, { role: 'assistant', content: 'Looking it up. Done.' }] });
    assert.ok(!('provider' in upstream.runs[1].body) && !('model' in upstream.runs[1].body));
  } finally { await close(); }
});

test('runs on: an approval mid-turn arrives as an event, is answered through the route, and the turn completes', async () => {
  const { fake, upstream, call, close } = await fixture({ env: RUNS, hermes: { askApproval: true, runScript: ['Writing. ', 'Finished.'] } });
  try {
    let answered = null;
    const result = await chatLive(call, { text: 'Update the agent file' }, async ({ event, data }) => {
      if (event !== 'approval') return;
      assert.match(data.id, /^\d{8}-hermes-/);
      assert.ok(data.command);
      answered = await call('POST', `/hub/hermes-approvals/${data.id}/answer`, { choice: 'once' });
    });
    assert.equal(answered.status, 201);
    assert.deepEqual(upstream.approvals.map(item => item.choice), ['once']);
    const names = result.events.map(item => item.event);
    assert.ok(names.indexOf('approval') < names.indexOf('approval-settled') && names.indexOf('approval-settled') < names.indexOf('done'));
    const stored = [...fake.objects.keys()].find(name => /hermes-approvals\/[^/]+\/approval\.json$/.test(name));
    assert.equal(JSON.parse(fake.text(stored)).chat, result.events.at(-1).data.conversation);
  } finally { await close(); }
});

test('runs on: a turn with a picture stays on completions, and a failed run ends the turn with an error', async () => {
  const { upstream, call, close } = await fixture({ env: RUNS });
  try {
    const result = await chat(call, { text: 'look', images: [picture(solidPng(8, 8), 'image/png')] });
    assert.equal(result.events.at(-1).event, 'done');
    assert.equal(upstream.requests.length, 1);
    assert.equal(upstream.runs.length, 0);
  } finally { await close(); }
  const failing = await fixture({ env: RUNS, hermes: { failWith: '429 usage limit reached' } });
  try {
    const result = await chat(failing.call, { text: 'hello' });
    assert.equal(result.events.at(-1).event, 'error');
    assert.match(result.events.at(-1).data.error, /429/);
  } finally { await failing.close(); }
  const busy = await fixture({ env: RUNS, hermes: { busy: true } });
  try {
    const result = await chat(busy.call, { text: 'hello' });
    assert.equal(result.status, 502);
  } finally { await busy.close(); }
});

test('runs on: a long quiet tool does not end the turn', async () => {
  const quiet = await fixture({ env: { ...RUNS, HUB_CHAT_IDLE_MS: '250' }, hermes: { keepaliveMs: 50, runScript: ['Start. ', { tool: 'build' }, { wait: 900 }, 'Built.'] } });
  try {
    const result = await chat(quiet.call, { text: 'build it' });
    assert.equal(result.events.at(-1).event, 'done', JSON.stringify(result.events.at(-1)));
    assert.match(result.events.filter(item => item.event === 'delta').map(item => item.data.text).join(''), /Built\./);
    assert.deepEqual(quiet.upstream.stops, []);
  } finally { await quiet.close(); }
});

test('runs on: a dropped event stream stops the run', async () => {
  const dropped = await fixture({ env: RUNS, hermes: { dropStreamAfter: 1, runScript: ['One. ', { hold: true }] } });
  try {
    const result = await chat(dropped.call, { text: 'go' });
    assert.equal(result.events.at(-1).event, 'error');
    assert.equal(dropped.upstream.stops.length, 1, 'The run was told to stop.');
  } finally { await dropped.close(); }
});

test('runs on: an approval card counts its time from when Hermes asked and offers only once or deny', async () => {
  const { call, close } = await fixture({ env: RUNS, hermes: { askApproval: true, approvalAgeMs: 200_000, approvalChoices: ['once', 'session', 'always', 'deny'], runScript: ['Writing. ', 'Done.'] } });
  try {
    let card = null;
    await chatLive(call, { text: 'write it' }, async ({ event, data }) => {
      if (event !== 'approval') return;
      card = data;
      await call('POST', `/hub/hermes-approvals/${data.id}/answer`, { choice: 'deny' });
    });
    assert.deepEqual(card.choices, ['once', 'deny']);
    const left = (new Date(card.expiresAt).getTime() - Date.now()) / 1000;
    assert.ok(left > 80 && left < 110, `about 100 s left, got ${left}`);
  } finally { await close(); }
});

test('runs on: a failed run leaves no URL or token in the error, and saved tool names are clipped and capped', async () => {
  const failing = await fixture({ env: RUNS, hermes: { failWith: 'Provider said no at https://api.provider.example/v1/x with Bearer sk-abc123' } });
  try {
    const result = await chat(failing.call, { text: 'hi' });
    const error = result.events.at(-1);
    assert.equal(error.event, 'error');
    assert.doesNotMatch(error.data.error, /https?:|Bearer|sk-abc/);
  } finally { await failing.close(); }
  const many = await fixture({ env: RUNS, hermes: { runScript: [...Array.from({ length: 25 }, (_, index) => ({ tool: `${index}-${'t'.repeat(120)}` })), 'ok'] } });
  try {
    const result = await chat(many.call, { text: 'tools' });
    const saved = lines(many.fake, result.events.at(-1).data.conversation)[1];
    assert.equal(saved.tools.length, 20);
    assert.ok(saved.tools.every(name => name.length <= 80));
  } finally { await many.close(); }
});

// --- Get help: a chat opened from a Needs-you item ---

const TODAY = new Date().toISOString().slice(0, 10).replace(/-/g, '');
const EVIDENCE = 'evidence-02-20261029T120600000Z-abcd.png';

function stepsList(fake, name = 'help-a111') {
  const list = checklistJson({ id: `${TODAY}-probe-${name}`, now: new Date(), title: 'Finish the bot setup' });
  const seed = seeder(fake);
  seed.checklist(list);
  seed.put(`checklists/${list.id}/${EVIDENCE}`, solidPng(24, 18), 'image/png');
  return { list, seed };
}

test('a help chat stores the server-built context first, copies its pictures, and sends it as message 0 on every turn', async () => {
  const { fake, upstream, call, close } = await fixture();
  try {
    const { list } = stepsList(fake);
    const first = await chat(call, { text: 'Step 02 failed', about: { kind: 'checklist', id: list.id, step: '02', text: 'FORGED BY THE BROWSER', title: 'Forged' } });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const name = first.events.at(-1).data.conversation;
    const saved = lines(fake, name);
    assert.deepEqual(saved.map(line => line.role), ['context', 'user', 'assistant']);
    assert.deepEqual(saved[0].about, { kind: 'checklist', id: list.id, step: '02', title: 'Finish the bot setup' });
    assert.match(saved[0].text, /<<agent>>/);
    assert.doesNotMatch(saved[0].text, /FORGED/);
    assert.equal(saved[0].images.length, 1);
    assert.ok(fake.objects.has(`sections/inbox/chat/${name}/${saved[0].images[0].file}`), 'The picture is copied into the conversation.');
    const body = upstream.requests[0];
    assert.equal(body.messages.length, 2);
    assert.equal(body.messages[0].role, 'user');
    assert.equal(body.messages[0].content[0].type, 'text');
    assert.match(body.messages[0].content[0].text, /Focus: step 02/);
    assert.equal(body.messages[0].content[1].type, 'image_url');
    assert.equal(body.messages[1].content, 'Step 02 failed');
    assert.equal(body.model, 'hermes-agent');
    assert.ok(!('provider' in body), 'The Hub names no provider.');

    await chat(call, { conversation: name, text: 'Tried it' });
    await chat(call, { conversation: name, text: 'Still stuck' });
    for (const request of upstream.requests.slice(1)) {
      assert.match(request.messages[0].content[0].text, /^\[Hub: the owner opened this chat/);
      assert.equal(request.messages[0].content[1].type, 'image_url', 'The picture goes back from the stored copy.');
    }
    assert.equal(upstream.requests[2].messages.length, 6);
    const listed = await (await call('GET', '/hub/chat')).json();
    assert.equal(listed.conversations[0].title, 'Help: Finish the bot setup');
    assert.deepEqual(listed.conversations[0].about, { kind: 'checklist', id: list.id, step: '02', title: 'Finish the bot setup' });
    assert.equal(listed.conversations[0].count, 7);
  } finally { await close(); }
});

test('the context stays first after 25 more lines', async () => {
  const { fake, upstream, call, close } = await fixture();
  try {
    const { list } = stepsList(fake);
    const first = await chat(call, { text: 'Hello', about: { kind: 'checklist', id: list.id } });
    const name = first.events.at(-1).data.conversation;
    const stored = lines(fake, name);
    for (let n = 0; n < 25; n += 1) stored.push({ role: n % 2 ? 'assistant' : 'user', text: `old ${n}`, at: new Date().toISOString() });
    fake.seed(`sections/inbox/chat/${name}.jsonl`, `${stored.map(line => JSON.stringify(line)).join('\n')}\n`, 'application/x-ndjson');
    await chat(call, { conversation: name, text: 'Latest' });
    const sent = upstream.requests.at(-1).messages;
    assert.equal(sent.length, 1 + 20 + 1);
    assert.match(Array.isArray(sent[0].content) ? sent[0].content[0].text : sent[0].content, /^\[Hub: the owner opened this chat/);
    assert.equal(sent.at(-1).content, 'Latest');
  } finally { await close(); }
});

test('about is refused with a conversation, for an unknown kind, and for an item that is gone; the preview shows what Hermes will see', async () => {
  const { fake, upstream, call, close } = await fixture();
  try {
    const { list } = stepsList(fake);
    const plain = await chat(call, { text: 'Hi' });
    const name = plain.events.at(-1).data.conversation;
    assert.equal((await chat(call, { conversation: name, text: 'x', about: { kind: 'checklist', id: list.id } })).status, 400);
    assert.equal((await chat(call, { text: 'x', about: { kind: 'secrets', id: list.id } })).status, 400);
    assert.equal((await chat(call, { text: 'x', about: { kind: 'checklist', id: `${TODAY}-probe-gone-zzzz` } })).status, 404);
    assert.equal((await chat(call, { text: 'x', about: { kind: 'checklist', id: list.id, step: 'three' } })).status, 400);
    assert.equal(upstream.requests.length, 1, 'None of the refusals reached Hermes.');

    const preview = await call('GET', `/hub/chat/about/checklist/02/${encodeURIComponent(list.id)}`);
    assert.equal(preview.status, 200);
    const shown = await preview.json();
    assert.equal(shown.title, 'Finish the bot setup');
    assert.match(shown.text, /Focus: step 02/);
    assert.deepEqual(shown.pictures.map(picture => picture.path), [`checklists/${list.id}/${EVIDENCE}`]);
    assert.equal((await call('GET', `/hub/chat/about/checklist/-/${encodeURIComponent(`${TODAY}-probe-gone-zzzz`)}`)).status, 404);
    assert.equal((await call('GET', '/hub/chat/about/nope/-/x')).status, 400);
    assert.equal((await call('GET', `/hub/chat/about/checklist/-/${encodeURIComponent(list.id)}`, undefined, {})).status, 401, 'The preview needs a signed-in user.');
  } finally { await close(); }
});

test('help works for a design Ask and a blocked session, and a cross-origin POST is still refused', async () => {
  const { fake, upstream, call, close } = await fixture();
  try {
    const ask = designAskJson({ id: `${TODAY}-probe-help-d111`, now: new Date() });
    seeder(fake).ask(ask);
    const asked = await chat(call, { text: 'What is d2?', about: { kind: 'ask', id: ask.id } });
    assert.equal(asked.status, 200, JSON.stringify(asked.body));
    assert.match(upstream.requests[0].messages[0].content[0].text, /Item: Design review/);
    assert.equal(upstream.requests[0].messages[0].content[1].type, 'image_url');

    seeder(fake).event(eventJson({ kind: 'blocked', session: 'sess-help', title: 'Blocked: needs a login', summary: 'The deploy asks for a login.' }));
    const blocked = await chat(call, { text: 'Help', about: { kind: 'blocked', id: 'sess-help' } });
    assert.equal(blocked.status, 200, JSON.stringify(blocked.body));
    assert.match(upstream.requests[1].messages[0].content, /Blocked session: The deploy asks for a login\./);

    const crossed = await call('POST', '/hub/chat', { text: 'x', about: { kind: 'ask', id: ask.id } }, { 'Remote-User': 'owner', Origin: 'https://evil.example' });
    assert.equal(crossed.status, 403);
    assert.equal(upstream.requests.length, 2);
  } finally { await close(); }
});

test('on a help chat\'s first turn the owner\'s pictures come first and the item\'s yield to the limit', async () => {
  const { fake, upstream, call, close } = await fixture();
  try {
    const { list } = stepsList(fake);
    const pictures = Array.from({ length: 4 }, () => ({ type: 'image/png', data: solidPng(16, 16).toString('base64') }));
    const sent = await chat(call, { text: 'See these', images: pictures, about: { kind: 'checklist', id: list.id, step: '02' } });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    const content = upstream.requests[0].messages[0].content;
    assert.equal(typeof content === 'string' ? 0 : content.filter(part => part.type === 'image_url').length, 0, 'No room left for the item\'s picture.');
    assert.match(typeof content === 'string' ? content : content[0].text, /not included in this turn/);
    assert.equal(upstream.requests[0].messages.at(-1).content.filter(part => part.type === 'image_url').length, 4);
  } finally { await close(); }
});

// --- Get help on top of Chat on runs ---

test('runs on: a help chat without pictures goes through runs with the pinned context as the first history entry, on every turn', async () => {
  const { fake, upstream, call, close } = await fixture({ env: RUNS, hermes: { runScript: ['Try ', { tool: 'search_files' }, 'again.'] } });
  try {
    seeder(fake).event(eventJson({ kind: 'blocked', session: 'sess-runs', title: 'Blocked: needs a login', summary: 'The deploy asks for a login.' }));
    const first = await chatLive(call, { text: 'Help', about: { kind: 'blocked', id: 'sess-runs' } });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(upstream.requests.length, 0, 'nothing went to completions');
    const run = upstream.runs[0].body;
    assert.equal(run.input, 'Help');
    assert.equal(run.conversation_history.length, 1);
    assert.equal(run.conversation_history[0].role, 'user');
    assert.match(run.conversation_history[0].content, /^\[Hub: the owner opened this chat/);
    assert.match(run.conversation_history[0].content, /Blocked session: The deploy asks for a login\./);
    assert.ok(first.events.some(item => item.event === 'tool'), 'tool lines still stream');
    const done = first.events.at(-1);
    assert.equal(done.event, 'done');
    assert.equal(done.data.context.role, 'context');
    const saved = lines(fake, done.data.conversation);
    assert.deepEqual(saved.map(line => line.role), ['context', 'user', 'assistant']);
    assert.equal(saved[2].run, upstream.runs[0].id);

    const second = await chatLive(call, { text: 'Still stuck', conversation: done.data.conversation });
    assert.equal(second.events.at(-1).event, 'done');
    const history = upstream.runs[1].body.conversation_history;
    assert.deepEqual(history.map(line => line.role), ['user', 'user', 'assistant']);
    assert.match(history[0].content, /^\[Hub: the owner opened this chat/);
    assert.equal(history[1].content, 'Help');
  } finally { await close(); }
});

test('runs on: a help chat whose context carries a picture stays on completions, with the picture', async () => {
  const { fake, upstream, call, close } = await fixture({ env: RUNS });
  try {
    const { list } = stepsList(fake, 'help-r111');
    const first = await chat(call, { text: 'Step 02 failed', about: { kind: 'checklist', id: list.id, step: '02' } });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const name = first.events.at(-1).data.conversation;
    await chat(call, { conversation: name, text: 'Again' });
    assert.equal(upstream.runs.length, 0);
    assert.equal(upstream.requests.length, 2);
    assert.equal(upstream.requests[1].messages[0].content[1].type, 'image_url', 'The stored picture goes back on later turns.');
  } finally { await close(); }
});

test('runs on: a plain chat whose first turn had a picture sends its later text turns to runs', async () => {
  const { upstream, call, close } = await fixture({ env: RUNS });
  try {
    const first = await chat(call, { text: 'look', images: [picture(solidPng(8, 8), 'image/png')] });
    assert.equal(upstream.requests.length, 1, 'the picture turn went to completions');
    const second = await chatLive(call, { text: 'and now text', conversation: first.events.at(-1).data.conversation });
    assert.equal(second.events.at(-1).event, 'done');
    assert.equal(upstream.requests.length, 1, 'the text turn did not go to completions');
    assert.equal(upstream.runs.length, 1);
  } finally { await close(); }
});

// --- A browser that goes away mid-turn (ws-otk) --------------------------------------------------------------------

/** Starts a run turn, reads until the `started` event, and hands back what it said and the open stream. */
async function startTurn(origin, owner, text, waitFor = /started/) {
  const controller = new AbortController();
  const answer = await fetch(`${origin}/api/hub/chat`, { method: 'POST', headers: { ...owner, 'Content-Type': 'application/json' }, body: JSON.stringify({ text }), signal: controller.signal });
  const reader = answer.body.getReader();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) throw new Error('The stream ended before it started.');
    buffer += new TextDecoder().decode(value);
    const hit = /event: started\ndata: (.+)\n\n/.exec(buffer);
    if (hit && waitFor.test(buffer)) return { ...JSON.parse(hit[1]), controller };
  }
}

const savedLines = async (fake, conversation, count) => {
  const started = Date.now();
  while (Date.now() - started < 3000) {
    try { const found = lines(fake, conversation); if (found.length >= count) return found; } catch { /* not saved yet */ }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('The conversation was not saved.');
};

test('runs on: a browser that drops mid-turn does not stop the run, and the reply is saved when Hermes finishes', async () => {
  const { fake, upstream, origin, owner, close } = await fixture({ env: RUNS, hermes: { runScript: ['Working. ', { hold: true }] } });
  try {
    const turn = await startTurn(origin, owner, 'a long one', /Working/);
    turn.controller.abort();
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.deepEqual(upstream.stops, [], 'Hermes was not told to stop.');
    upstream.release(turn.run, 'Working. Finished.');
    const saved = await savedLines(fake, turn.conversation, 2);
    assert.equal(saved[0].text, 'a long one');
    assert.equal(saved[1].role, 'assistant');
    assert.match(saved[1].text, /^Working\./);
    assert.ok(!saved[1].text.includes('[interrupted]'));
    assert.equal(saved[1].run, turn.run);
    assert.deepEqual(upstream.stops, []);
  } finally { await close(); }
});

test('runs on: Stop ends the run through its own route, which needs a signed-in user and a run this relay is carrying', async () => {
  const { fake, upstream, call, origin, owner, close } = await fixture({ env: RUNS, hermes: { runScript: ['Working. ', { hold: true }] } });
  try {
    const turn = await startTurn(origin, owner, 'stop me', /Working/);
    assert.equal((await call('POST', '/hub/chat/stop', { run: turn.run }, { Origin: 'https://site.example' })).status, 401, 'No user, no stop.');
    assert.equal((await call('POST', '/hub/chat/stop', { run: turn.run }, { 'Remote-User': 'owner', Origin: 'https://evil.example' })).status, 403, 'A foreign Origin is refused.');
    assert.equal((await call('POST', '/hub/chat/stop', { run: 'run_not_mine' })).status, 404);
    assert.deepEqual(upstream.stops, []);
    assert.equal((await call('POST', '/hub/chat/stop', { run: turn.run })).status, 200);
    turn.controller.abort();
    const saved = await savedLines(fake, turn.conversation, 2);
    assert.deepEqual(upstream.stops, [turn.run]);
    assert.match(saved[1].text, /\[interrupted\]$/);
    assert.equal((await call('POST', '/hub/chat/stop', { run: turn.run })).status, 404, 'A finished turn cannot be stopped again.');
  } finally { await close(); }
});
