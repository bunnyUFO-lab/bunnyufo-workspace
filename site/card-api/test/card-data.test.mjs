// workspace/_shared/card-data.js against the real card API handler and the stand-in S3: the browser
// is faked (document, localStorage, fetch), the file routes are not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createBucket } from '../../api/s3.mjs';
import { startFakeS3 } from '../../api/test/fake-s3.mjs';
import { createCardApi, parseTokens } from '../handler.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const source = await readFile(path.join(repo, 'workspace/_shared/card-data.js'), 'utf8');
const sha = text => createHash('sha256').update(text).digest('hex');
const KEY = 'sections/games/card-responses/sounds/listen-v2.json';

async function setup() {
  const fake = await startFakeS3();
  const bucket = createBucket({ bucket: fake.bucket, endpoint: fake.endpoint, credentials: fake.credentials, region: 'us-east-1' });
  fake.seed('sections/games/workspace.json', JSON.stringify({ name: 'Games', entities: [{ id: 'sounds', folder: '2026_sounds', title: 'Sounds', steps: [] }] }), 'application/json');
  fake.seed('sections/games/2026_sounds/index.md', '# Sounds', 'text/markdown');
  const api = createCardApi({ bucket, tokens: parseTokens(`owner=${sha('pass word')}`) });
  let down = false;

  /** A fresh browser page: its own localStorage, same API. */
  function page({ attributes = { 'data-buw-card': 'sounds' }, pathname = '/w/games/2026_sounds/index.html', storage = new Map(), capabilities = null } = {}) {
    const window = Object.assign(new EventTarget(), { prompt: () => 'pass word' });
    const localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)), removeItem: key => storage.delete(key) };
    const fetch = async (url, init = {}) => {
      if (down) throw new TypeError('Failed to fetch');
      if (url === '/api/capabilities') return capabilities ? new Response(JSON.stringify(capabilities), { status: 200 }) : new Response('{}', { status: 404 });
      if (!String(url).startsWith('https://api.test')) return new Response(JSON.stringify({ error: 'no' }), { status: 404 });
      const route = new URL(url).pathname;
      const response = await api({ requestContext: { http: { method: init.method ?? 'GET' } }, rawPath: route, headers: init.headers ?? {}, body: init.body });
      return new Response(response.isBase64Encoded ? Buffer.from(response.body, 'base64') : response.body, { status: response.statusCode, headers: response.headers });
    };
    const document = {
      documentElement: { getAttribute: name => attributes[name] ?? null },
      addEventListener() {},
      body: { append() {} },
      createElement: () => ({ click() {}, remove() {} }),
    };
    const context = { window, document, location: { pathname }, localStorage, fetch, URL, Blob, TypeError, setTimeout: (fn, ms) => setTimeout(fn, ms).unref(), clearTimeout, encodeURIComponent, decodeURIComponent };
    vm.runInNewContext(source, context);
    return { BuwCardData: window.BuwCardData, storage };
  }
  return { fake, page, setDown: value => { down = value; } };
}
const open = (page, extra = {}) => page.BuwCardData.open({ doc: 'listen-v2', api: 'https://api.test', ...extra });

test('without a passphrase it stays local, then signIn connects and pushes what was waiting', async () => {
  const { fake, page } = await setup();
  try {
    const first = page();
    const store = await open(first);
    assert.equal(store.mode, 'local');
    assert.equal(store.needsSignIn, true);
    store.set('sfx-1', { ratings: { dog: 'good' } });
    assert.equal(fake.text(KEY), null);
    assert.equal(await store.signIn('pass word'), 'server');
    assert.deepEqual(JSON.parse(fake.text(KEY)).items['sfx-1'].data, { ratings: { dog: 'good' } });
    assert.equal(first.storage.get('buw.cardApiPassphrase'), 'pass word');
  } finally { await fake.close(); }
});

test('saves, reloads in a new browser, merges and deletes items', async () => {
  const { fake, page } = await setup();
  try {
    const a = await open(page(), { passphrase: 'pass word' });
    assert.equal(a.mode, 'server');
    a.set('sfx-1', { sentence: 'a dog barks' });
    a.set('sfx-2', { sentence: 'rain' });
    await a.flush();
    assert.equal(a.status, 'saved');
    const stored = JSON.parse(fake.text(KEY));
    assert.equal(stored.version, 1);
    assert.equal(stored.card, 'sounds');
    assert.deepEqual(Object.keys(stored.items).sort(), ['sfx-1', 'sfx-2']);

    const b = await open(page(), { passphrase: 'pass word' }); // another browser: empty localStorage
    assert.deepEqual(b.get('sfx-1'), { sentence: 'a dog barks' });
    b.set('sfx-3', { sentence: 'wind' });
    b.set('sfx-2', null);
    await b.flush();
    a.set('sfx-4', { sentence: 'door' });
    await a.flush();
    assert.deepEqual(Object.keys(JSON.parse(fake.text(KEY)).items).sort(), ['sfx-1', 'sfx-3', 'sfx-4'], 'a page keeps the other items and honours the delete');
    assert.equal(a.document().items['sfx-1'].data.sentence, 'a dog barks');
  } finally { await fake.close(); }
});

test('an unreachable API keeps changes in the browser; a wrong passphrase says sign in again', async () => {
  const { fake, page, setDown } = await setup();
  try {
    const mine = page();
    const store = await open(mine, { passphrase: 'pass word' });
    setDown(true);
    store.set('sfx-1', { sentence: 'offline' });
    await store.flush();
    assert.equal(store.status, 'offline');
    assert.equal(fake.text(KEY), null);
    setDown(false);
    const again = await open(page({ storage: mine.storage }), { passphrase: 'pass word' });
    assert.equal(again.mode, 'server');
    assert.deepEqual(JSON.parse(fake.text(KEY)).items['sfx-1'].data, { sentence: 'offline' }, 'the next open pushes the unsaved item');

    const wrong = await open(page(), { passphrase: 'nope' });
    assert.equal(wrong.mode, 'local');
    assert.equal(wrong.status, 'error');
    assert.match(wrong.message, /Sign in again/);
  } finally { await fake.close(); }
});

test('a page outside /w stays local', async () => {
  const { fake, page } = await setup();
  try {
    const loose = await open(page({ attributes: {}, pathname: '/preview.html' }), { passphrase: 'pass word' });
    assert.equal(loose.mode, 'local');
    loose.set('a', { x: 1 });
    assert.equal(JSON.stringify(loose.all()), '{"a":{"x":1}}');
  } finally { await fake.close(); }
});

test('the card API takes the card-responses key and refuses a leading underscore', async () => {
  const { fake } = await setup();
  try {
    const bucket = createBucket({ bucket: fake.bucket, endpoint: fake.endpoint, credentials: fake.credentials, region: 'us-east-1' });
    const api = createCardApi({ bucket, tokens: parseTokens(`owner=${sha('p')}`) });
    const call = (method, rawPath, body) => api({ requestContext: { http: { method } }, rawPath, headers: { authorization: 'Bearer p' }, body });
    assert.equal((await call('PUT', '/sections/games/files/card-responses/sounds/t.json', '{}')).statusCode, 200);
    assert.equal((await call('GET', '/sections/games/files/card-responses/sounds/t.json')).statusCode, 200);
    assert.equal((await call('DELETE', '/sections/games/files/card-responses/sounds/t.json')).statusCode, 200);
    assert.equal((await call('PUT', '/sections/games/files/_responses/sounds/t.json', '{}')).statusCode, 400);
  } finally { await fake.close(); }
});

test('with no api given it asks /api/capabilities, and with none it stays local without a sign-in', async () => {
  const { fake, page } = await setup();
  try {
    const none = await page().BuwCardData.open({ doc: 'listen-v2' });
    assert.equal(none.mode, 'local');
    assert.equal(none.needsSignIn, false, 'No card API, so there is nothing to sign in to.');
    const named = await page({ capabilities: { cardApi: 'https://api.test' }, storage: new Map([['buw.cardApiPassphrase', 'pass word']]) }).BuwCardData.open({ doc: 'listen-v2' });
    assert.equal(named.mode, 'server');
  } finally {
    await fake.close();
  }
});
