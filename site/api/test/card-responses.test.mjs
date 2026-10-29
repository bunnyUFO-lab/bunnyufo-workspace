// /api/cards/responses: what a card's viewers saved, read and written through the site API.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSiteApi } from '../server.mjs';
import { createBucket } from '../s3.mjs';
import { startFakeS3 } from './fake-s3.mjs';

const card = id => ({ id, folder: id, title: id, created: '2026-01-01', updated: '2026-01-01', status: 'active', steps: [{ name: 'Page', path: 'index.html' }] });
const APP = 'https://site.example';

async function fixture({ secured = false, dev } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'buw-responses-'));
  const fake = await startFakeS3();
  const bucket = createBucket({ bucket: fake.bucket, endpoint: fake.endpoint, credentials: fake.credentials, region: 'us-east-1' });
  for (const id of ['one', 'dev-one']) fake.seed(`sections/${id}/workspace.json`, JSON.stringify({ entities: [card('alpha')] }), 'application/json');
  fake.seed('state.json', '{"version":1,"cards":{}}', 'application/json');
  const server = createSiteApi({ bucket, stateFile: path.join(root, 'state.json'), sectionsTtl: 0, dev, ...(secured ? { requireRemoteUser: true, allowedOrigins: [APP] } : {}) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const get = (workspace, id, doc) => fetch(`${origin}/api/cards/responses?workspace=${workspace}&id=${id}&doc=${doc}`);
  const post = (data, headers = {}) => fetch(`${origin}/api/cards/responses`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(secured ? { Origin: APP, 'Remote-User': 'me' } : {}), ...headers }, body: JSON.stringify(data),
  });
  const entry = data => ({ updated: '2026-10-28T10:00:00.000Z', data });
  return { fake, get, post, entry, close: async () => { server.close(); await fake.close(); } };
}
const KEY = 'sections/one/card-responses/alpha/ratings.json';

test('a doc that was never saved reads as null', async () => {
  const { get, close } = await fixture();
  try {
    const response = await get('one', 'alpha', 'ratings');
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { doc: null, etag: null });
  } finally { await close(); }
});

test('a set is stored at the card API key in the documented shape, and read back', async () => {
  const { fake, get, post, entry, close } = await fixture();
  try {
    const saved = await post({ workspace: 'one', id: 'alpha', doc: 'ratings', set: { r1: entry({ stars: 4 }), r2: entry({ stars: 1 }) } });
    assert.equal(saved.status, 200);
    const stored = fake.json(KEY);
    assert.deepEqual(Object.keys(stored).sort(), ['card', 'doc', 'items', 'section', 'updated', 'version']);
    assert.equal(stored.version, 1);
    assert.equal(stored.section, 'one');
    assert.equal(stored.card, 'alpha');
    assert.equal(stored.doc, 'ratings');
    assert.deepEqual(stored.items.r1.data, { stars: 4 });
    const read = await (await get('one', 'alpha', 'ratings')).json();
    assert.deepEqual(read.doc.items, stored.items);
    assert.ok(read.etag);
    assert.equal((await saved.json()).etag, read.etag);
  } finally { await close(); }
});

test('null deletes an item and leaves the others', async () => {
  const { fake, post, entry, close } = await fixture();
  try {
    await post({ workspace: 'one', id: 'alpha', doc: 'ratings', set: { r1: entry(1), r2: entry(2) } });
    assert.equal((await post({ workspace: 'one', id: 'alpha', doc: 'ratings', set: { r1: null } })).status, 200);
    assert.deepEqual(Object.keys(fake.json(KEY).items), ['r2']);
  } finally { await close(); }
});

test('two sets at once on different items both land', async () => {
  const { fake, post, entry, close } = await fixture();
  try {
    await post({ workspace: 'one', id: 'alpha', doc: 'ratings', set: { seed: entry(0) } });
    const answers = await Promise.all(['a', 'b', 'c'].map(item => post({ workspace: 'one', id: 'alpha', doc: 'ratings', set: { [item]: entry(item) } })));
    assert.deepEqual(answers.map(response => response.status), [200, 200, 200]);
    assert.deepEqual(Object.keys(fake.json(KEY).items).sort(), ['a', 'b', 'c', 'seed']);
  } finally { await close(); }
});

test('what it refuses', async () => {
  const { get, post, entry, close } = await fixture();
  try {
    const set = { r1: entry(1) };
    const status = async body => (await post({ workspace: 'one', id: 'alpha', doc: 'ratings', set, ...body })).status;
    assert.equal(await status({ id: 'nope' }), 404, 'unknown card');
    assert.equal(await status({ workspace: 'nowhere' }), 404, 'unknown section');
    assert.equal((await get('one', 'nope', 'ratings')).status, 404);
    assert.equal(await status({ doc: '../x' }), 400, 'bad doc id');
    assert.equal(await status({ doc: 'Ratings' }), 400, 'doc ids are lowercase');
    assert.equal(await status({ set: { 'Bad Id': entry(1) } }), 400, 'bad item id');
    assert.equal(await status({ set: {} }), 400, 'empty set');
    assert.equal(await status({ set: Object.fromEntries(Array.from({ length: 201 }, (_, n) => [`i${n}`, entry(n)])) }), 400, '201 items');
    assert.equal(await status({ set: { r1: { updated: 'now' } } }), 400, 'no data key');
    assert.equal(await status({ set: { r1: { data: 1 } } }), 400, 'no updated');
    assert.equal(await status({ set: { r1: { data: 1, updated: 'x'.repeat(41) } } }), 400, 'updated too long');
    assert.equal((await get('one', 'alpha', 'Bad')).status, 400);
  } finally { await close(); }
});

test('a doc over 4 MB is refused with 413 and nothing is written', async () => {
  const { fake, post, entry, close } = await fixture();
  try {
    const big = 'x'.repeat(900 * 1024);
    for (let n = 0; n < 4; n += 1) assert.equal((await post({ workspace: 'one', id: 'alpha', doc: 'ratings', set: { [`big${n}`]: entry(big) } })).status, 200);
    assert.equal((await post({ workspace: 'one', id: 'alpha', doc: 'ratings', set: { big4: entry(big), big5: entry(big) } })).status, 413);
    assert.deepEqual(Object.keys(fake.json(KEY).items).sort(), ['big0', 'big1', 'big2', 'big3']);
  } finally { await close(); }
});

test('the Origin check still guards the write: the app origin passes, the content origin does not', async () => {
  const { fake, post, entry, close } = await fixture({ secured: true });
  try {
    const body = { workspace: 'one', id: 'alpha', doc: 'ratings', set: { r1: entry(1) } };
    assert.equal((await post(body)).status, 200);
    assert.equal((await post(body, { Origin: 'https://cards.site.example' })).status, 403);
    assert.equal((await post(body, { 'Remote-User': '' })).status, 401);
    assert.deepEqual(Object.keys(fake.json(KEY).items), ['r1']);
  } finally { await close(); }
});

test('the development copy writes responses only for dev- sections', async () => {
  const { fake, post, entry, close } = await fixture({ dev: { writable: id => id.startsWith('dev-') } });
  try {
    const body = workspace => ({ workspace, id: 'alpha', doc: 'ratings', set: { r1: entry(1) } });
    assert.equal((await post(body('one'))).status, 403);
    assert.equal((await post(body('dev-one'))).status, 200);
    assert.equal(fake.json(KEY), null);
    assert.deepEqual(Object.keys(fake.json('sections/dev-one/card-responses/alpha/ratings.json').items), ['r1']);
  } finally { await close(); }
});
