// Emptying the Trash: the one place anything is deleted from the bucket. Every test says exactly
// which keys were deleted, and that nothing else was.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createBucket } from '../s3.mjs';
import { startFakeS3 } from './fake-s3.mjs';
import { bucketStore, cardWriter, folderStore } from '../card-writes.mjs';
import { purgeOn, safeFolder } from '../card-purge.mjs';
import { createSiteApi } from '../server.mjs';

const NOW = new Date('2026-11-30T09:00:00Z');
const entity = (id, folder, extra = {}) => ({ id, folder, title: id, category: 'x', created: '2026-09-01', updated: '2026-09-01', steps: [{ name: 'Overview', path: 'index.md' }], ...extra });

async function world(list) {
  const fake = await startFakeS3();
  const bucket = createBucket({ bucket: fake.bucket, endpoint: fake.endpoint, credentials: fake.credentials, region: 'us-east-1' });
  fake.seed('sections/one/workspace.json', `${JSON.stringify(list, null, 2)}\n`, 'application/json');
  const writer = cardWriter(bucketStore(bucket, 'sections/one'), { section: 'one', now: () => NOW });
  const files = (...keys) => keys.forEach(key => fake.seed(`sections/one/${key}`, `body of ${key}`));
  const deleted = () => fake.log.filter(entry => entry.method === 'DELETE').map(entry => entry.key).sort();
  return { fake, bucket, writer, files, deleted, list: () => fake.json('sections/one/workspace.json'), close: () => fake.close() };
}

test('the purge date is 31 days after the deletion: the first day it is more than 30 days old', () => {
  assert.equal(purgeOn('2026-10-01'), '2026-11-01');
  assert.equal(purgeOn('2026-12-15'), '2027-01-15');
});

test('only the folder of a card deleted over 30 days ago goes; everything else stays and the record is dropped', async () => {
  const old = entity('old', '2026-09-01_old', { steps: [{ name: 'A', path: 'index.md' }, { name: 'B', path: 'img/b.png' }] });
  const w = await world({
    name: 'One',
    entities: [entity('live', '2026-09-01_live'), entity('sibling', '2026-09-01_old-2')],
    retired: {
      old: { kind: 'deleted', at: '2026-10-29', entity: old },                                        // 32 days: goes
      fresh: { kind: 'deleted', at: '2026-11-01', entity: entity('fresh', '2026-10-01_fresh') },     // 29 days: stays
      edge: { kind: 'deleted', at: '2026-10-30', entity: entity('edge', '2026-09-02_edge') },        // 31 days: goes
      gone: { kind: 'moved', to: 'two', folder: '2026-09-01_gone', at: '2026-08-01' },               // moved: never
    },
  });
  try {
    w.files('2026-09-01_old/index.md', '2026-09-01_old/img/b.png', '2026-09-01_old/notes/deep/c.txt', '2026-09-02_edge/index.md',
      '2026-09-01_old-2/index.md', '2026-09-01_live/index.md', '2026-09-01_gone/index.md', '2026-10-01_fresh/index.md',
      'card-responses/old/notes.json', '_shared/report.css', 'state.json');
    const before = new Set(w.fake.objects.keys());
    const answer = await w.writer.purgeTrash();
    assert.deepEqual(answer.cards.sort(), ['edge', 'old']);
    assert.equal(answer.files, 4);
    assert.deepEqual(w.deleted(), [
      'sections/one/2026-09-01_old/img/b.png', 'sections/one/2026-09-01_old/index.md', 'sections/one/2026-09-01_old/notes/deep/c.txt',
      'sections/one/2026-09-02_edge/index.md',
    ], 'exactly the files of the two expired cards');
    assert.deepEqual([...before].filter(key => !w.fake.objects.has(key)).sort(), w.deleted().map(key => key));
    assert.ok(w.fake.objects.has('sections/one/2026-09-01_old-2/index.md'), 'A folder that merely starts with the same name stays.');
    assert.ok(w.fake.objects.has('sections/one/card-responses/old/notes.json'), 'Viewer data stays.');
    assert.ok(w.fake.objects.has('sections/one/2026-09-01_gone/index.md'), 'A moved card\'s files stay.');
    assert.ok(w.fake.objects.has('sections/one/2026-10-01_fresh/index.md'));
    const list = w.list();
    assert.deepEqual(Object.keys(list.retired).sort(), ['fresh', 'gone']);
    assert.deepEqual(list.entities.map(item => item.id), ['live', 'sibling']);
    // Run again: nothing more to do, nothing more deleted.
    const again = await w.writer.purgeTrash();
    assert.deepEqual([again.cards, again.files], [[], 0]);
    assert.equal(w.deleted().length, 4);
  } finally { await w.close(); }
});

test('nothing expired: no request but the list is ever sent as a delete', async () => {
  const w = await world({ entities: [entity('live', 'live')], retired: { fresh: { kind: 'deleted', at: '2026-11-20', entity: entity('fresh', 'fresh') } } });
  try {
    w.files('fresh/index.md', 'live/index.md');
    const answer = await w.writer.purgeTrash();
    assert.deepEqual([answer.cards, answer.tabs, answer.files], [[], [], 0]);
    assert.deepEqual(w.deleted(), []);
  } finally { await w.close(); }
});

test('a folder another card, a moved record or a newer Trash entry still uses is kept', async () => {
  const w = await world({
    entities: [entity('twin', 'shared-live')],
    retired: {
      a: { kind: 'deleted', at: '2026-09-01', entity: entity('a', 'shared-live') },
      b: { kind: 'deleted', at: '2026-09-01', entity: entity('b', 'shared-moved') },
      c: { kind: 'deleted', at: '2026-09-01', entity: entity('c', 'shared-fresh') },
      d: { kind: 'deleted', at: '2026-11-25', entity: entity('d', 'shared-fresh') },
      m: { kind: 'moved', to: 'two', folder: 'shared-moved', at: '2026-09-01' },
    },
  });
  try {
    w.files('shared-live/index.md', 'shared-moved/index.md', 'shared-fresh/index.md');
    const answer = await w.writer.purgeTrash();
    assert.deepEqual(answer.cards, []);
    assert.equal(answer.skipped.length, 3);
    assert.deepEqual(w.deleted(), []);
    assert.deepEqual(Object.keys(w.list().retired).sort(), ['d', 'm'], 'The records are gone, the files are not.');
  } finally { await w.close(); }
});

test('an unsafe or reserved folder is never deleted under', async () => {
  for (const folder of ['', '..', '../one', 'a/../../b', '/abs', 'card-responses', 'card-responses/x', '_shared', 'workspace.json', 'a\\b', undefined]) {
    assert.equal(safeFolder(folder), null, `${folder}`);
  }
  assert.equal(safeFolder('2026-09-01_deck'), '2026-09-01_deck');
  const w = await world({
    entities: [],
    retired: {
      x: { kind: 'deleted', at: '2026-09-01', entity: entity('x', '..') },
      y: { kind: 'deleted', at: '2026-09-01', entity: entity('y', 'card-responses') },
      z: { kind: 'deleted', at: '2026-09-01', entity: entity('z', '_shared') },
      n: { kind: 'deleted', at: '2026-09-01', entity: { id: 'n', title: 'no folder' } },
    },
  });
  try {
    w.files('card-responses/y/notes.json', '_shared/report.css', 'elsewhere/index.md');
    const answer = await w.writer.purgeTrash();
    assert.equal(answer.skipped.length, 4);
    assert.deepEqual(w.deleted(), []);
  } finally { await w.close(); }
});

test('a tab removed over 30 days ago loses its own file only; a fresh one, a tab back in use and the card stay', async () => {
  const w = await world({
    entities: [entity('deck', 'deck', {
      steps: [{ name: 'Overview', path: 'index.md' }, { name: 'Back', path: 'back.md' }],
      removedTabs: [
        { name: 'Old', path: 'old.md', at: '2026-09-01', index: 1 },
        { name: 'Sketch', path: 'sketch.excalidraw', at: '2026-09-01', index: 2 },
        { name: 'Fresh', path: 'fresh.md', at: '2026-11-25', index: 1 },
        { name: 'Back', path: 'back.md', at: '2026-09-01', index: 1 },
        { name: 'Evil', path: '../other/secret.md', at: '2026-09-01', index: 1 },
      ],
    })],
  });
  try {
    w.files('deck/index.md', 'deck/old.md', 'deck/sketch.excalidraw', 'deck/sketch.png', 'deck/fresh.md', 'deck/back.md', 'other/secret.md');
    const answer = await w.writer.purgeTrash();
    assert.deepEqual(answer.tabs.map(tab => tab.path).sort(), ['old.md', 'sketch.excalidraw']);
    assert.deepEqual(w.deleted(), ['sections/one/deck/old.md', 'sections/one/deck/sketch.excalidraw', 'sections/one/deck/sketch.png']);
    assert.ok(w.fake.objects.has('sections/one/other/secret.md'), 'A path that leaves the folder is ignored.');
    assert.deepEqual(w.list().entities[0].removedTabs.map(tab => tab.name), ['Fresh']);
    assert.equal(w.list().entities[0].steps.length, 2);
  } finally { await w.close(); }
});

test('a restore that wins the race keeps the files: the record is claimed before anything is deleted', async () => {
  const w = await world({ entities: [], retired: { old: { kind: 'deleted', at: '2026-09-01', entity: entity('old', 'old') } } });
  try {
    w.files('old/index.md');
    const restored = await w.writer.restoreCard({ id: 'old' });
    assert.equal(restored.card.id, 'old');
    const answer = await w.writer.purgeTrash();
    assert.deepEqual([answer.cards, answer.files], [[], 0]);
    assert.deepEqual(w.deleted(), []);
    assert.ok(w.fake.objects.has('sections/one/old/index.md'));
  } finally { await w.close(); }
});

test('the local folder store never deletes: the Trash is only emptied on the site', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'buw-purge-'));
  await writeFile(path.join(root, 'workspace.json'), JSON.stringify({ entities: [], retired: { old: { kind: 'deleted', at: '2026-09-01', entity: entity('old', 'old') } } }));
  const writer = cardWriter(folderStore(root), { now: () => NOW });
  await assert.rejects(writer.purgeTrash(), { status: 501 });
});

test('the route is a gated write: Origin, Remote-User and the development copy', async () => {
  const fake = await startFakeS3();
  const bucket = createBucket({ bucket: fake.bucket, endpoint: fake.endpoint, credentials: fake.credentials, region: 'us-east-1' });
  const old = { kind: 'deleted', at: '2020-01-01', entity: entity('old', 'old') };
  for (const id of ['one', 'dev-sandbox']) {
    fake.seed(`sections/${id}/workspace.json`, JSON.stringify({ entities: [], retired: { old } }), 'application/json');
    fake.seed(`sections/${id}/old/index.md`, 'x');
  }
  fake.seed('state.json', '{"version":1,"cards":{}}', 'application/json');
  const root = await mkdtemp(path.join(tmpdir(), 'buw-purge-api-'));
  const serve = async options => {
    const server = createSiteApi({ bucket, templateDir: path.join(root, 'none'), stateFile: path.join(root, 'state.json'), sectionsTtl: 0, ...options });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return { server, url: `http://127.0.0.1:${server.address().port}/api/cards/trash/purge` };
  };
  const post = (url, workspace, headers = {}) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ workspace }) });
  const gated = await serve({ requireRemoteUser: true, allowedOrigins: ['https://site.example'] });
  const dev = await serve({ dev: { writable: id => id.startsWith('dev-') }, stateKey: 'dev-state.json' });
  try {
    assert.equal((await post(gated.url, 'one')).status, 401, 'no Remote-User');
    assert.equal((await post(gated.url, 'one', { 'Remote-User': 'owner' })).status, 403, 'no Origin');
    assert.equal((await post(dev.url, 'one')).status, 403, 'the development copy never purges a real workspace');
    assert.deepEqual(fake.log.filter(entry => entry.method === 'DELETE'), [], 'Nothing was deleted by a refused call.');
    const done = await post(dev.url, 'dev-sandbox');
    assert.equal(done.status, 200);
    assert.deepEqual(fake.log.filter(entry => entry.method === 'DELETE').map(entry => entry.key), ['sections/dev-sandbox/old/index.md']);
    assert.ok(fake.objects.has('sections/one/old/index.md'), 'The real workspace is untouched.');
    const ok = await post(gated.url, 'one', { 'Remote-User': 'owner', Origin: 'https://site.example' });
    assert.equal(ok.status, 200);
    assert.deepEqual(fake.log.filter(entry => entry.method === 'DELETE').map(entry => entry.key), ['sections/dev-sandbox/old/index.md', 'sections/one/old/index.md']);
  } finally { gated.server.close(); dev.server.close(); await fake.close(); }
});
