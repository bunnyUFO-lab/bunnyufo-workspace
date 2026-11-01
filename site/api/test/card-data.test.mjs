// workspace/_shared/card-data.js talking to the real app-side bridge handler (src/lib/card-bridge.mjs), which
// calls the real site API over the stand-in S3. The browser is faked (document, localStorage, a parent window
// that passes each postMessage to the handler); the bridge, the routes and the store are not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createSiteApi } from '../server.mjs';
import { createBucket } from '../s3.mjs';
import { startFakeS3 } from './fake-s3.mjs';
import { attachCardBridge, createBridgeHandler, isBridgeRequest } from '../../../src/lib/card-bridge.mjs';
import { listenOnGoodPort } from '../../../server/listen.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const source = await readFile(path.join(repo, 'workspace/_shared/card-data.js'), 'utf8');
const APP = 'https://app.example.localhost';
const KEY = 'sections/games/card-responses/sounds/listen-v2.json';
const SIGNED_OUT = 'Sign in to the Workspace to save this card.';
const NO_BRIDGE = 'Open this card inside the Workspace, signed in, to save it.';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), 'buw-card-data-'));
  const fake = await startFakeS3();
  const bucket = createBucket({ bucket: fake.bucket, endpoint: fake.endpoint, credentials: fake.credentials, region: 'us-east-1' });
  const entity = (id, folder) => ({ id, folder, title: id, steps: [{ name: 'Answers', path: 'answers.md' }] });
  fake.seed('sections/games/workspace.json', JSON.stringify({ name: 'Games', entities: [entity('sounds', '2026_sounds'), entity('other', '2026_other')] }), 'application/json');
  fake.seed('sections/games/2026_sounds/answers.md', 'first', 'text/markdown');
  fake.seed('state.json', '{"version":1,"cards":{}}', 'application/json');
  const server = createSiteApi({ bucket, stateFile: path.join(root, 'state.json'), sectionsTtl: 0, requireRemoteUser: true, allowedOrigins: [APP] });
  await listenOnGoodPort(server, '127.0.0.1');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const requests = [];

  /** What the app's api() does: JSON from the app origin, an Error with .status and .answer on a refusal. */
  const call = async (route, data) => {
    requests.push({ route, data });
    const response = await fetch(`${origin}/api${route}`, {
      method: data === undefined ? 'GET' : 'POST',
      headers: { Origin: APP, 'Remote-User': 'me', ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    const body = await response.json();
    if (!response.ok) throw Object.assign(new Error(body.error), { status: response.status, answer: body });
    return body;
  };
  const handlerFor = (extra = {}) => createBridgeHandler({ card: { workspace: 'games', id: 'sounds' }, enabled: true, call, ...extra });

  /**
   * A fresh browser page: its own localStorage. `parent` says what the window above it does:
   *   'app'   the bridge answers (the default), 'none' the page is its own top window, 'silent' nobody answers.
   */
  function page({ parent = 'app', storage = new Map(), pathname = '/w/games/2026_sounds/index.html', handler = handlerFor(), tamper } = {}) {
    const window = Object.assign(new EventTarget(), { prompt: () => { throw new Error('window.prompt must not be called'); } });
    const posts = [];
    const deliver = (data, from, at = APP) => window.dispatchEvent(Object.assign(new Event('message'), { data, source: from, origin: at }));
    const up = {
      postMessage(message, target) {
        posts.push({ message, target });
        if (parent !== 'app') return;
        if (target !== '*' && target !== APP) return;   // a browser drops a message whose target origin is not the window's
        void handler.handle(message).then(async reply => {
          if (tamper) await tamper(reply, message, deliver, up);
          if (reply) deliver(reply, up);
        });
      },
    };
    window.parent = parent === 'none' ? window : up;
    const localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)), removeItem: key => storage.delete(key) };
    const document = {
      documentElement: { getAttribute: name => ({ 'data-buw-card': 'not-my-card', 'data-buw-section': 'not-my-section' })[name] ?? null },
      addEventListener() {}, body: { append() {} }, createElement: () => ({ click() {}, remove() {} }),
    };
    const context = { window, document, location: { pathname }, localStorage, fetch: async () => { throw new TypeError('a card page makes no requests'); }, URL, Blob, TypeError, Error, Event, JSON, Object, Math, Date, Promise, setTimeout, clearTimeout, encodeURIComponent, decodeURIComponent };
    vm.runInNewContext(source, context);
    return { BuwCardData: window.BuwCardData, storage, posts, deliver, up, window };
  }
  return { fake, page, requests, handlerFor, call, close: async () => { server.close(); await fake.close(); } };
}
const open = (page, extra = {}) => page.BuwCardData.open({ doc: 'listen-v2', ...extra });

test('saves, reloads in a new browser, merges and deletes items', async () => {
  const { fake, page, close } = await setup();
  try {
    const a = await open(page());
    assert.equal(a.mode, 'server');
    assert.equal(a.section, 'games');
    assert.equal(a.card, 'sounds');
    a.set('sfx-1', { sentence: 'a dog barks' });
    a.set('sfx-2', { sentence: 'rain' });
    await a.flush();
    assert.equal(a.status, 'saved');
    const stored = fake.json(KEY);
    assert.equal(stored.version, 1);
    assert.equal(stored.card, 'sounds');
    assert.equal(stored.section, 'games');
    assert.deepEqual(Object.keys(stored.items).sort(), ['sfx-1', 'sfx-2']);

    const b = await open(page()); // another browser: empty localStorage
    assert.deepEqual(b.get('sfx-1'), { sentence: 'a dog barks' });
    b.set('sfx-3', { sentence: 'wind' });
    b.set('sfx-2', null);
    await b.flush();
    a.set('sfx-4', { sentence: 'door' });
    await a.flush();
    assert.deepEqual(Object.keys(fake.json(KEY).items).sort(), ['sfx-1', 'sfx-3', 'sfx-4'], 'a page keeps the other items and honours the delete');
    assert.equal(a.document().items['sfx-1'].data.sentence, 'a dog barks');
    assert.deepEqual(a.get('sfx-3'), { sentence: 'wind' }, 'the server copy of items this page did not touch is adopted');
  } finally { await close(); }
});

test('the card on the page cannot pick another card: the hello names it', async () => {
  const { fake, page, close } = await setup();
  try {
    const store = await open(page(), { card: 'other', section: 'elsewhere' });
    assert.equal(store.card, 'sounds');
    assert.equal(store.section, 'games');
    store.set('a', { x: 1 });
    await store.flush();
    assert.deepEqual(Object.keys(fake.json(KEY).items), ['a']);
    assert.equal(fake.json('sections/games/card-responses/other/listen-v2.json'), null);
  } finally { await close(); }
});

test('with no parent window it is local at once, says so, and makes no request', async () => {
  const { page, requests, close } = await setup();
  try {
    const mine = page({ parent: 'none' });
    const started = Date.now();
    const store = await open(mine);
    assert.ok(Date.now() - started < 500, 'no waiting for a parent that is not there');
    assert.equal(store.mode, 'local');
    assert.equal(store.message, NO_BRIDGE);
    assert.equal(store.needsSignIn, false);
    store.set('a', { x: 1 });
    assert.deepEqual(store.all(), { a: { x: 1 } });
    assert.equal(await store.signIn(), 'local');
    assert.equal(store.message, NO_BRIDGE);
    assert.equal(requests.length, 0);
    assert.equal(mine.posts.length, 0, 'not even a hello');
    assert.equal(await mine.BuwCardData.bridge.ready, null);
    await assert.rejects(mine.BuwCardData.bridge.call('markdown.get', { path: 'answers.md' }), error => error.status === 0 && error.message === NO_BRIDGE);
  } finally { await close(); }
});

test('a parent that never answers: local after about 1.5 s, the hello resent with target *', async () => {
  const { page, requests, close } = await setup();
  try {
    const mine = page({ parent: 'silent' });
    const started = Date.now();
    const store = await open(mine);
    const took = Date.now() - started;
    assert.ok(took >= 1400 && took < 2500, `took ${took} ms`);
    assert.equal(store.mode, 'local');
    assert.equal(store.message, NO_BRIDGE);
    assert.ok(mine.posts.length >= 4 && mine.posts.length <= 7, `${mine.posts.length} hellos`);
    for (const { message, target } of mine.posts) { assert.equal(message.op, 'hello'); assert.equal(target, '*'); assert.deepEqual(Object.keys(message).sort(), ['id', 'op', 'type', 'v']); }
    assert.equal(requests.length, 0);
  } finally { await close(); }
});

test('a hello answered 401 (signed out) is local at once with that error as the message', async () => {
  const { page, requests, close } = await setup();
  try {
    const mine = page({ handler: createBridgeHandler({ card: { workspace: 'games', id: 'sounds' }, enabled: false, call: async () => { throw new Error('not called'); } }) });
    const started = Date.now();
    const store = await open(mine);
    assert.ok(Date.now() - started < 500);
    assert.equal(store.mode, 'local');
    assert.equal(store.message, SIGNED_OUT);
    store.set('a', { x: 1 });
    assert.equal(store.get('a').x, 1);
    assert.equal(requests.length, 0);
    await assert.rejects(mine.BuwCardData.bridge.call('markdown.get', { path: 'answers.md' }), error => error.status === 401 && error.message === SIGNED_OUT);
  } finally { await close(); }
});

test('signIn never prompts and never writes a passphrase, and a stored one is removed on load', async () => {
  const { page, close } = await setup();
  try {
    const storage = new Map([['buw.cardApiPassphrase', 'left over']]);
    const mine = page({ storage });
    assert.equal(storage.has('buw.cardApiPassphrase'), false, 'removed as the script loads');
    const store = await open(mine);
    assert.equal(await store.signIn('pass word'), 'server');   // an old page may still pass one: it is ignored
    assert.equal(storage.has('buw.cardApiPassphrase'), false);
    assert.equal([...storage.values()].some(value => value.includes('pass word')), false);
    const old = await mine.BuwCardData.open({ doc: 'other-doc', api: 'https://api.test', passphrase: 'pass word' });
    assert.equal(old.mode, 'server');
  } finally { await close(); }
});

test('every post after the hello goes to the app origin; replies from another origin or window are ignored', async () => {
  const { fake, page, close } = await setup();
  try {
    const stranger = { postMessage() {} };
    // Before each real reply, a forged one arrives for the same id: from another origin, from another window, and from the parent with another v.
    const tamper = async (reply, message, deliver, up) => {
      if (message.op === 'hello' || !reply?.ok) return;
      const forged = { ...reply, result: { doc: { items: { evil: { updated: 'x', data: 'forged' } } }, etag: 'forged' } };
      deliver(forged, up, 'https://evil.example.localhost');
      deliver(forged, stranger, APP);
      deliver({ ...forged, v: 2 }, up, APP);
    };
    const mine = page({ tamper });
    const store = await open(mine);
    assert.equal(store.mode, 'server');
    store.set('good', { x: 1 });
    await store.flush();
    assert.equal(store.get('evil'), undefined);
    assert.deepEqual(Object.keys(fake.json(KEY).items), ['good']);
    const after = mine.posts.filter(entry => entry.message.op !== 'hello');
    assert.ok(after.length >= 2);
    for (const { target } of after) assert.equal(target, APP);
    assert.equal(mine.posts[0].target, '*');
  } finally { await close(); }
});

test('a hello answered from the wrong window or with a broken reply does not give a bridge', async () => {
  const { page, close } = await setup();
  try {
    const stranger = { postMessage() {} };
    const mine = page({ parent: 'silent' });
    const started = open(mine);
    await sleep(100);
    const id = mine.posts[0].message.id;
    const ok = { type: 'buw:bridge', v: 1, id, ok: true, result: { section: 'games', card: 'sounds', ops: [] } };
    mine.deliver(ok, stranger, APP);
    mine.deliver({ ...ok, id: 'another' }, mine.up, APP);
    mine.deliver({ ...ok, type: 'other' }, mine.up, APP);
    const store = await started;
    assert.equal(store.mode, 'local');
  } finally { await close(); }
});

test('bridge.call round-trips a Markdown answer, and a stale base rejects with 409 and the current file', async () => {
  const { fake, page, close } = await setup();
  try {
    const mine = page();
    assert.deepEqual((await mine.BuwCardData.bridge.ready).ops, ['responses.get', 'responses.set', 'markdown.get', 'markdown.save']);
    const got = await mine.BuwCardData.bridge.call('markdown.get', { path: 'answers.md' });
    assert.equal(got.text, 'first');
    const saved = await mine.BuwCardData.bridge.call('markdown.save', { path: 'answers.md', text: 'second', base: got.etag });
    assert.equal(saved.text, 'second');
    assert.equal(fake.text('sections/games/2026_sounds/answers.md'), 'second');
    await assert.rejects(
      mine.BuwCardData.bridge.call('markdown.save', { path: 'answers.md', text: 'third', base: got.etag }),
      error => error.status === 409 && error.current.text === 'second' && error.current.etag === saved.etag,
    );
    await assert.rejects(mine.BuwCardData.bridge.call('markdown.save', { path: 'nope.md', text: 'x', base: null }), error => error.status === 404);
  } finally { await close(); }
});

test('the handler fixes the card: workspace, id, section and card in a request are dropped', async () => {
  const { fake, call, close } = await setup();
  try {
    const seen = [];
    const { handle } = createBridgeHandler({ card: { workspace: 'games', id: 'sounds' }, enabled: true, call: async (route, data) => { seen.push({ route, data }); return call(route, data); } });
    const aimed = { workspace: 'one', section: 'one', card: 'other', cardId: 'other' };
    const set = (id, item, extra) => handle({ type: 'buw:bridge', v: 1, id, op: 'responses.set', doc: 'listen-v2', set: { [item]: { updated: 'now', data: 1 } }, ...extra });
    assert.equal((await set('a1', 'a', aimed)).ok, true);
    assert.equal((await handle({ type: 'buw:bridge', v: 1, id: 'a3', op: 'responses.get', doc: 'listen-v2', ...aimed })).ok, true);
    assert.equal((await handle({ type: 'buw:bridge', v: 1, id: 'a4', op: 'markdown.get', path: 'answers.md', ...aimed })).ok, true);
    assert.equal((await handle({ type: 'buw:bridge', v: 1, id: 'a5', op: 'markdown.save', path: 'answers.md', text: 'x', base: null, ...aimed })).status, 409, 'it reached the bridged card, whose answers.md exists');
    assert.equal(seen.length, 4);
    for (const entry of seen) {
      const target = entry.data ?? Object.fromEntries(new URLSearchParams(entry.route.split('?')[1]));
      assert.equal(target.workspace, 'games');
      assert.equal(target.id, 'sounds');
      assert.deepEqual(Object.keys(target).filter(key => ['section', 'card', 'cardId'].includes(key)), []);
    }
    assert.deepEqual(Object.keys(fake.json(KEY).items), ['a']);
    assert.equal(fake.json('sections/games/card-responses/other/listen-v2.json'), null);
    assert.equal(fake.json('sections/one/card-responses/sounds/listen-v2.json'), null);
    assert.equal(fake.json('sections/one/card-responses/other/listen-v2.json'), null);
  } finally { await close(); }
});

test('the handler: the 11th write in a second gets 429, and a disabled app answers every op 401', async () => {
  const { call, close } = await setup();
  try {
    let clock = 1000;
    const handler = createBridgeHandler({ card: { workspace: 'games', id: 'sounds' }, enabled: true, call, now: () => clock });
    const save = n => handler.handle({ type: 'buw:bridge', v: 1, id: `w${n}`, op: 'responses.set', doc: 'listen-v2', set: { [`i${n}`]: { updated: 'now', data: n } } });
    for (let n = 0; n < 10; n += 1) assert.equal((await save(n)).ok, true, `write ${n + 1}`);
    const refused = await save(10);
    assert.deepEqual([refused.ok, refused.status, refused.error], [false, 429, 'Too many saves; wait a moment.']);
    const read = await handler.handle({ type: 'buw:bridge', v: 1, id: 'r', op: 'responses.get', doc: 'listen-v2' });
    assert.equal(read.ok, true, 'reads are not limited');
    clock += 1000;
    assert.equal((await save(11)).ok, true, 'the window rolls');

    const off = createBridgeHandler({ card: { workspace: 'games', id: 'sounds' }, enabled: false, call: async () => { throw new Error('not called'); } });
    for (const op of ['hello', 'responses.get', 'responses.set', 'markdown.get', 'markdown.save', 'nonsense']) {
      const answer = await off.handle({ type: 'buw:bridge', v: 1, id: 'x', op });
      assert.deepEqual([answer.ok, answer.status, answer.error], [false, 401, SIGNED_OUT], op);
      assert.equal(answer.id, 'x');
    }
    let on = false;
    const live = createBridgeHandler({ card: { workspace: 'games', id: 'sounds' }, enabled: () => on, call });
    assert.equal((await live.handle({ type: 'buw:bridge', v: 1, id: 'z', op: 'hello' })).status, 401);
    on = true;
    assert.equal((await live.handle({ type: 'buw:bridge', v: 1, id: 'z', op: 'hello' })).ok, true, 'enabled is read at each message');
  } finally { await close(); }
});

test('the handler: unknown op 400, bad fields 400, errors keep status and current, other messages are ignored', async () => {
  const { call, close } = await setup();
  try {
    const handler = createBridgeHandler({ card: { workspace: 'games', id: 'sounds' }, enabled: true, call });
    const ask = fields => handler.handle({ type: 'buw:bridge', v: 1, id: 'q', ...fields });
    assert.deepEqual(await ask({ op: 'file.get', path: 'x' }), { type: 'buw:bridge', v: 1, id: 'q', ok: false, status: 400, error: 'Unknown operation.' });
    assert.equal((await ask({ op: 'responses.get' })).status, 400);
    assert.equal((await ask({ op: 'responses.set', doc: 'd', set: [] })).status, 400);
    assert.equal((await ask({ op: 'markdown.save', path: 'answers.md' })).status, 400);
    assert.equal((await ask({ op: 'markdown.save', path: 'answers.md', text: 'x', base: 5 })).status, 400);
    const stale = await ask({ op: 'markdown.save', path: 'answers.md', text: 'x', base: 'stale' });
    assert.equal(stale.status, 409);
    assert.equal(stale.current.text, 'first');
    const down = createBridgeHandler({ card: { workspace: 'games', id: 'sounds' }, enabled: true, call: async () => { throw new TypeError('Failed to fetch'); } });
    const network = await down.handle({ type: 'buw:bridge', v: 1, id: 'n', op: 'responses.get', doc: 'd' });
    assert.deepEqual([network.ok, network.status], [false, 0]);

    for (const junk of [null, 'text', 7, {}, { type: 'buw:bridge' }, { type: 'buw:bridge', v: 2, id: 'a', op: 'hello' }, { type: 'buw:bridge', v: 1, id: 'x'.repeat(33), op: 'hello' }, { type: 'buw:bridge', v: 1, id: '', op: 'hello' }, { type: 'buw:bridge', v: 1, id: 5, op: 'hello' }, { type: 'buw:theme', v: 1, id: 'a', op: 'hello' }]) {
      assert.equal(isBridgeRequest(junk), false);
      assert.equal(await handler.handle(junk), null);
    }
  } finally { await close(); }
});

test('attach: only the bridged frame, from its own origin, is answered, and the reply goes to that origin and never *', async () => {
  const { call, close } = await setup();
  try {
    const listeners = new Set();
    const win = { addEventListener: (type, fn) => { if (type === 'message') listeners.add(fn); }, removeEventListener: (type, fn) => { if (type === 'message') listeners.delete(fn); } };
    const sent = [];
    const contentWindow = { postMessage: (message, target) => sent.push({ message, target }) };
    const otherWindow = { postMessage: (message, target) => sent.push({ message, target, other: true }) };
    const frame = { contentWindow };
    const CONTENT = 'https://cards.example.localhost';
    const detach = attachCardBridge(frame, { workspace: 'games', id: 'sounds' }, { origin: CONTENT, enabled: true, call, win });
    const fire = event => { for (const fn of [...listeners]) fn(event); };
    const hello = { type: 'buw:bridge', v: 1, id: 'h1', op: 'hello' };

    fire({ data: hello, source: otherWindow, origin: CONTENT });        // another window, even from the right origin
    fire({ data: hello, source: contentWindow, origin: 'https://evil.example.localhost' });   // the frame, from a wrong origin
    fire({ data: hello, source: contentWindow, origin: APP });          // the app's own origin is not the card's
    fire({ data: hello, source: null, origin: CONTENT });
    fire({ data: { type: 'buw:bridge', v: 1, id: 'h2', op: 'responses.get', doc: 'listen-v2', workspace: 'one' }, source: otherWindow, origin: CONTENT });
    await sleep(100);
    assert.equal(sent.length, 0, 'nothing answered');

    fire({ data: { ...hello, id: 'ok1' }, source: contentWindow, origin: CONTENT });
    await sleep(100);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].target, CONTENT);
    assert.notEqual(sent[0].target, '*');
    assert.equal(sent[0].message.ok, true);
    assert.deepEqual(sent[0].message.result.card, 'sounds');

    // The frame went somewhere else while a call was out: the reply goes to the window that asked, with the card's
    // origin as its target (a browser drops it if that window has moved to another origin), never to the new window.
    fire({ data: { type: 'buw:bridge', v: 1, id: 'slow', op: 'responses.get', doc: 'listen-v2' }, source: contentWindow, origin: CONTENT });
    frame.contentWindow = otherWindow;
    await sleep(200);
    assert.equal(sent.length, 2);
    assert.equal(sent[1].other, undefined);
    assert.equal(sent[1].target, CONTENT);
    frame.contentWindow = contentWindow;

    detach();
    assert.equal(listeners.size, 0);
    fire({ data: { ...hello, id: 'late' }, source: contentWindow, origin: CONTENT });
    await sleep(50);
    assert.equal(sent.length, 2, 'detached');
  } finally { await close(); }
});
