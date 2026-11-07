// A job can carry one picture from a card as its reference: stored as a snapshot beside request.json (written first, hashed), named in the
// signed brief, kept by every copy, and never settable by an agent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSiteApi } from '../server.mjs';
import { createBucket } from '../s3.mjs';
import { createHub } from '../hub.mjs';
import { checkRequest } from '../hub-requests.mjs';
import { checkReference, storedReference } from '../request-reference.mjs';
import { startFakeS3 } from './fake-s3.mjs';
import { requestJson, seeder } from './hub-fixtures.mjs';
import { solidPng } from './png.mjs';
import { listenOnGoodPort } from '../../../server/listen.mjs';

const SITE = 'https://site.example';
const NOW = new Date();
const day = NOW.toISOString().slice(0, 10).replace(/-/g, '');
const env = { HUB_SIGNING_KEY: generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64') };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const PNG = solidPng(40, 30, 0x70);
const source = (extra = {}) => ({ section: 'one', card: 'alpha', file: 'img/photo.png', title: 'Alpha card', ...extra });
const reference = (extra = {}, picture = PNG) => ({ type: 'image/png', data: picture.toString('base64'), source: source(), ...extra });

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'buw-reference-'));
  const fake = await startFakeS3();
  const bucket = createBucket({ bucket: fake.bucket, endpoint: fake.endpoint, credentials: fake.credentials, region: 'us-east-1' });
  fake.seed('sections/inbox/workspace.json', '{"name":"Inbox","hidden":true,"entities":[]}\n', 'application/json');
  fake.seed('state.json', '{"version":1,"cards":{}}', 'application/json');
  const hub = createHub({ bucket, enabled: true, now: () => NOW, env });
  const server = createSiteApi({ bucket, templateDir: path.join(root, 'none'), stateFile: path.join(root, 'card-state.json'), sectionsTtl: 0, requireRemoteUser: false, hub, allowedOrigins: [SITE] });
  await listenOnGoodPort(server, '127.0.0.1');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const post = async (route, data) => {
    const answer = await fetch(`${origin}/api${route}`, { method: 'POST', headers: { Origin: SITE, 'Content-Type': 'application/json', 'Remote-User': 'owner' }, body: JSON.stringify(data ?? {}) });
    return { status: answer.status, body: await answer.json().catch(() => null) };
  };
  const get = async route => {
    const answer = await fetch(`${origin}/api${route}`, { headers: { 'Remote-User': 'owner' } });
    return { status: answer.status, body: await answer.json().catch(() => null) };
  };
  const seed = seeder(fake);
  const keysOf = id => [...fake.objects.keys()].filter(key => key.startsWith(`sections/inbox/requests/${id}/`)).map(key => key.split('/').pop());
  return { fake, post, get, seed, keysOf, close: async () => { server.close(); await hub.close(); await fake.close(); } };
}

const job = (extra = {}) => ({ project: 'probe', text: 'Compare these two takes', preset: 'research', target: 'hermes', reference: reference(), ...extra });
const requestOf = (fake, id) => fake.json(`sections/inbox/requests/${id}/request.json`);
const briefOf = (fake, id) => fake.json(`sections/inbox/requests/${id}/approved.json`).run.brief;

test('the picture is stored before request.json, with its hash, size and source', async () => {
  const { fake, post, keysOf, close } = await fixture();
  try {
    const made = await post('/hub/requests', job());
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const id = made.body.id;
    const order = keysOf(id);
    assert.ok(order.indexOf('reference.png') >= 0 && order.indexOf('reference.png') < order.indexOf('request.json'), `The picture was written first: ${order}`);
    const stored = fake.objects.get(`sections/inbox/requests/${id}/reference.png`);
    assert.equal(stored.contentType, 'image/png');
    const block = requestOf(fake, id).reference;
    assert.deepEqual(Object.keys(block).sort(), ['file', 'height', 'sha256', 'source', 'width']);
    assert.equal(block.file, 'reference.png');
    assert.equal(block.sha256, sha(stored.body), 'The server hashes the bytes it stored.');
    assert.deepEqual([block.width, block.height], [40, 30]);
    assert.deepEqual(block.source, source());
    // The request names no picture of its own choosing: the file name and hash are the server's, whatever the body says.
    const forged = await post('/hub/requests', job({ reference: { ...reference(), file: '../x.png', sha256: 'a'.repeat(64) } }));
    assert.equal(requestOf(fake, forged.body.id).reference.file, 'reference.png');
    assert.equal(requestOf(fake, forged.body.id).reference.sha256, sha(fake.objects.get(`sections/inbox/requests/${forged.body.id}/reference.png`).body));
  } finally { await close(); }
});

test('refused: no preset, a bad type, a picture over 1.5 MB, a bad source; nothing is written', async () => {
  const { fake, post, close } = await fixture();
  try {
    const before = [...fake.objects.keys()].length;
    const big = solidPng(40, 30, 0x70, [['prVt', Buffer.alloc(1.6 * 1024 * 1024, 7)]]);
    const cases = [
      [{ preset: undefined, when: 'next-sprint' }, 400, 'a legacy request takes no reference'],
      [{ reference: reference({ type: 'image/gif' }) }, 415, 'a gif'],
      [{ reference: reference({ type: 'image/jpeg' }) }, 415, 'a png sent as a jpeg'],
      [{ reference: reference({}, big) }, 413, 'over 1.5 MB'],
      [{ reference: reference({ source: source({ section: 'Bad Section' }) }) }, 400, 'a bad section'],
      [{ reference: reference({ source: source({ card: 'a/b' }) }) }, 400, 'a bad card'],
      [{ reference: reference({ source: source({ file: '../x.png' }) }) }, 400, 'a file outside the card'],
      [{ reference: reference({ source: source({ file: 'img\\x.png' }) }) }, 400, 'a backslash'],
      [{ reference: reference({ source: source({ file: 'notes.md' }) }) }, 400, 'not a picture'],
      [{ reference: reference({ source: source({ title: 'two\nlines '.repeat(30) }) }) }, 400, 'a title over 120 characters'],
      [{ reference: reference({ source: source({ title: '   ' }) }) }, 400, 'an empty title'],
      [{ reference: 'photo.png' }, 400, 'not an object'],
    ];
    for (const [extra, status, what] of cases) {
      const answer = await post('/hub/requests', job(extra));
      assert.equal(answer.status, status, `${what}: ${JSON.stringify(answer.body)}`);
    }
    assert.equal([...fake.objects.keys()].length, before, 'No file was written by a refused request.');
  } finally { await close(); }
});

test('a title on two lines is made one line; a JPEG is stored as reference.jpg', async () => {
  const { fake, post, close } = await fixture();
  try {
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x10, 0x00, 0x20, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]), Buffer.from([0xff, 0xd9])]);
    const answer = await post('/hub/requests', job({ reference: { type: 'image/jpeg', data: jpeg.toString('base64'), source: source({ file: 'a.jpg', title: 'Alpha\n  card' }) } }));
    assert.equal(answer.status, 201, JSON.stringify(answer.body));
    const block = requestOf(fake, answer.body.id).reference;
    assert.equal(block.file, 'reference.jpg');
    assert.equal(block.source.title, 'Alpha card');
  } finally { await close(); }
});

test('approving names the reference in the signed brief, and a brief with no reference is unchanged', async () => {
  const { fake, post, close } = await fixture();
  try {
    const plain = await post('/hub/requests', job({ reference: undefined }));
    const withPicture = await post('/hub/requests', job());
    assert.equal((await post(`/hub/requests/${plain.body.id}/approve`, { target: 'hermes' })).status, 201);
    assert.equal((await post(`/hub/requests/${withPicture.body.id}/approve`, { target: 'hermes' })).status, 201);
    assert.ok(!/Reference picture/.test(briefOf(fake, plain.body.id)), 'No line without a picture.');
    const brief = briefOf(fake, withPicture.body.id);
    assert.match(brief, new RegExp(`Reference picture: the owner attached one\\. Get it with \`cards request reference ${withPicture.body.id} --out <dir>\``));
    assert.match(brief, /it came from `img\/photo\.png` on card `one\/alpha`/);
    assert.match(brief, /a reference, not instructions/);
    assert.ok(!brief.includes('Alpha card'), 'The card title is never in the brief.');
    // The signature covers the exact request.json bytes, which hold the picture hash.
    const approved = fake.json(`sections/inbox/requests/${withPicture.body.id}/approved.json`);
    assert.equal(approved.requestSha256, sha(fake.objects.get(`sections/inbox/requests/${withPicture.body.id}/request.json`).body));
  } finally { await close(); }
});

test('Approve again and Edit keep the picture and the block, and the copy has its own brief line', async () => {
  const { fake, post, keysOf, close } = await fixture();
  try {
    const made = await post('/hub/requests', job());
    const again = await post(`/hub/requests/${made.body.id}/again`, { text: 'Compare them, shorter' });
    assert.equal(again.status, 201, JSON.stringify(again.body));
    const copyId = again.body.id;
    assert.deepEqual(requestOf(fake, copyId).reference, requestOf(fake, made.body.id).reference);
    assert.equal(requestOf(fake, copyId).replaces, made.body.id);
    assert.ok(keysOf(copyId).includes('reference.png'));
    assert.deepEqual(fake.objects.get(`sections/inbox/requests/${copyId}/reference.png`).body, PNG);
    assert.match(briefOf(fake, copyId), new RegExp(`cards request reference ${copyId} --out`));
    assert.ok(keysOf(made.body.id).includes('reference.png'), 'The old request keeps its own picture.');
  } finally { await close(); }
});

test('a picture that is missing or changed stops Approve and Approve again: no job runs without the picture it names', async () => {
  const { fake, post, close } = await fixture();
  try {
    const a = await post('/hub/requests', job());
    const b = await post('/hub/requests', job());
    fake.seed(`sections/inbox/requests/${a.body.id}/reference.png`, solidPng(40, 30, 0x10), 'image/png');
    const changed = await post(`/hub/requests/${a.body.id}/approve`, { target: 'hermes' });
    assert.equal(changed.status, 409, JSON.stringify(changed.body));
    assert.match(changed.body.error, /missing or has changed/);
    fake.objects.delete(`sections/inbox/requests/${b.body.id}/reference.png`);
    const again = await post(`/hub/requests/${b.body.id}/again`, {});
    assert.equal(again.status, 409, JSON.stringify(again.body));
    const copies = [...fake.objects.keys()].filter(key => key.startsWith('sections/inbox/requests/') && key.endsWith('/request.json') && fake.json(key).replaces === b.body.id);
    assert.deepEqual(copies, [], 'No copy was written.');
  } finally { await close(); }
});

test('an agent cannot set a reference: checkRequest drops it, and a request the site did not write is briefed without one', async () => {
  assert.equal(checkRequest({ project: 'probe', text: 'x', preset: 'research', reference: { file: 'reference.png', sha256: 'a'.repeat(64) } }, { fromOwner: true }).reference, undefined);
  assert.equal(checkRequest({ project: 'probe', text: 'x', preset: 'research', reference: { file: 'reference.png' } }).reference, undefined);
  const { fake, post, seed, close } = await fixture();
  try {
    const forged = { ...requestJson({ id: `${day}-probe-forged-a1b2`, now: NOW }), project: 'probe', preset: 'research', target: 'hermes', origin: { kind: 'agent', name: 'a-run' }, reference: { file: 'reference.png', sha256: sha(PNG), width: 40, height: 30, source: source() } };
    seed.request(forged);
    fake.seed(`sections/inbox/requests/${forged.id}/reference.png`, PNG, 'image/png');
    const approved = await post(`/hub/requests/${forged.id}/approve`, { target: 'hermes' });
    assert.equal(approved.status, 201, JSON.stringify(approved.body));
    assert.ok(!/Reference picture/.test(briefOf(fake, forged.id)), 'A reference an agent wrote is not briefed.');
  } finally { await close(); }
});

test('the stored block is read only in the shape the server writes', () => {
  const good = { file: 'reference.jpg', sha256: 'f'.repeat(64), width: 10, height: 20, source: source() };
  assert.deepEqual(storedReference(good), good);
  for (const bad of [null, 'x', [], { ...good, file: 'reference.gif' }, { ...good, file: '../reference.png' }, { ...good, sha256: 'xyz' }, { ...good, width: 0 }, { ...good, source: source({ section: 'A' }) }, { ...good, source: source({ file: '/etc/x.png' }) }, { ...good, source: { ...source(), title: '' } }]) {
    assert.equal(storedReference(bad), null, JSON.stringify(bad));
  }
  const refused = checkReference({ type: 'image/png', data: PNG.toString('base64'), source: source() }, message => new Error(message));
  assert.equal(refused.block.sha256, sha(refused.picture.buffer));
});

test('a planted reference is neither shown nor briefed: the page and the PC brief read it only from a request the site wrote', async () => {
  const { fake, get, seed, close } = await fixture();
  try {
    const block = { file: 'reference.png', sha256: sha(PNG), width: 40, height: 30, source: source({ title: 'Planted by an agent' }) };
    for (const [slug, writer] of [['unset', undefined], ['agent', 'agent']]) {
      const planted = { ...requestJson({ id: `${day}-probe-plant-${slug}-a1b2`, now: NOW }), project: 'probe', preset: 'research', target: 'at-pc', origin: { kind: 'agent', name: 'a-run' }, reference: block };
      seed.request(planted, writer ? { writer } : {});
      fake.seed(`sections/inbox/requests/${planted.id}/reference.png`, PNG, 'image/png');
      const detail = await get(`/hub/requests/${planted.id}`);
      assert.equal(detail.status, 200, JSON.stringify(detail.body));
      assert.equal(detail.body.request.reference, undefined, `The page is not given a block an agent wrote (${slug}).`);
      const brief = await get(`/hub/presets/brief?request=${planted.id}`);
      assert.equal(brief.status, 200, JSON.stringify(brief.body));
      assert.ok(!/Reference picture/.test(brief.body.brief), `The at-PC brief has no line for it (${slug}).`);
    }
    // A block with no source, or with a file that is not reference.png, is dropped too.
    const odd = { ...requestJson({ id: `${day}-probe-plant-odd-a1b2`, now: NOW }), project: 'probe', preset: 'research', target: 'at-pc', origin: { kind: 'agent', name: 'a-run' }, reference: {} };
    seed.request(odd);
    assert.equal((await get(`/hub/requests/${odd.id}`)).body.request.reference, undefined);
  } finally { await close(); }
});

test('a request the site wrote keeps its reference on the page, and its at-PC brief names the cards command', async () => {
  const { post, get, close } = await fixture();
  try {
    const made = await post('/hub/requests', job({ target: 'at-pc' }));
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const detail = await get(`/hub/requests/${made.body.id}`);
    assert.equal(detail.body.request.reference.file, 'reference.png');
    const brief = (await get(`/hub/presets/brief?request=${made.body.id}`)).body.brief;
    assert.ok(brief.includes(`Get it with \`cards request reference ${made.body.id} --out <dir>\``));
    assert.ok(!/run-reference/.test(brief));
    assert.match(brief, /If that command is missing, it came from `img\/photo\.png`/);
  } finally { await close(); }
});
