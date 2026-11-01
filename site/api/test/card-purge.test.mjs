// Emptying the Trash: the one place anything is deleted from the bucket. Every test says exactly
// which keys were deleted, and that nothing else was.
import baseTest from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createBucket } from '../s3.mjs';
import { startFakeS3 } from './fake-s3.mjs';
import { bucketStore, cardWriter, folderStore } from '../card-writes.mjs';
import { parseDay, purgeOn, safeFile, safeFolder } from '../card-purge.mjs';
import { createSiteApi } from '../server.mjs';
import { listenOnGoodPort } from '../../../server/listen.mjs';

// Every test has a time limit: a stuck socket or server fails the test instead of hanging the run.
const test = (name, fn) => baseTest(name, { timeout: 30_000 }, fn);

const NOW = new Date('2026-11-30T09:00:00Z');
const entity = (id, folder, extra = {}) => ({ id, folder, title: id, category: 'x', created: '2026-09-01', updated: '2026-09-01', steps: [{ name: 'Overview', path: 'index.md' }], ...extra });
const gone = (id, folder, at = '2026-09-01') => ({ kind: 'deleted', at, entity: entity(id, folder) });

async function world(list, { now = NOW } = {}) {
  const fake = await startFakeS3();
  const bucket = createBucket({ bucket: fake.bucket, endpoint: fake.endpoint, credentials: fake.credentials, region: 'us-east-1' });
  fake.seed('sections/one/workspace.json', `${JSON.stringify(list, null, 2)}\n`, 'application/json');
  const store = bucketStore(bucket, 'sections/one');
  const writer = cardWriter(store, { section: 'one', now: () => now });
  const files = (...keys) => keys.forEach(key => fake.seed(`sections/one/${key}`, `body of ${key}`));
  const deleted = () => fake.log.filter(entry => entry.method === 'DELETE').map(entry => entry.key).sort();
  const puts = () => fake.log.filter(entry => entry.method === 'PUT' && entry.key === 'sections/one/workspace.json').length;
  return { fake, bucket, store, writer, files, deleted, puts, list: () => fake.json('sections/one/workspace.json'), close: () => fake.close() };
}

test('dates are parsed strictly and the purge date is 31 days on; a bad date is null, never a throw', () => {
  assert.equal(purgeOn('2026-10-01'), '2026-11-01');
  assert.equal(purgeOn('2026-12-15'), '2027-01-15');
  for (const bad of ['2026-13-45', '2026-02-31', '9999-12-31x', '', undefined, null, 20260101, '+010000-01-01', '2026-1-1']) {
    assert.equal(parseDay(bad), null, String(bad));
    assert.equal(purgeOn(bad), null, String(bad));
  }
  assert.equal(purgeOn('9999-12-31'), null, 'No purge date past year 9999; the clock refuses a future deletion anyway.');
});

test('only the folder of a card deleted over 30 days ago goes; everything else stays; the record becomes a tombstone', async () => {
  const w = await world({
    name: 'One',
    entities: [entity('live', '2026-09-01_live'), entity('sibling', '2026-09-01_old-2')],
    retired: {
      old: gone('old', '2026-09-01_old', '2026-10-29'),                         // 32 days: goes
      fresh: gone('fresh', '2026-10-01_fresh', '2026-11-01'),                   // 29 days: stays
      edge: gone('edge', '2026-09-02_edge', '2026-10-30'),                      // 31 days: goes
      moved: { kind: 'moved', to: 'two', folder: '2026-09-01_gone', at: '2026-08-01' }, // never
    },
  });
  try {
    w.files('2026-09-01_old/index.md', '2026-09-01_old/img/b.png', '2026-09-01_old/notes/deep/c.txt', '2026-09-02_edge/index.md',
      '2026-09-01_old-2/index.md', '2026-09-01_live/index.md', '2026-09-01_gone/index.md', '2026-10-01_fresh/index.md',
      '_shared/report.css', 'state.json');
    const before = new Set(w.fake.objects.keys());
    const answer = await w.writer.purgeTrash();
    assert.deepEqual(answer.cards.sort(), ['edge', 'old']);
    assert.equal(answer.files, 4);
    assert.deepEqual(w.deleted(), [
      'sections/one/2026-09-01_old/img/b.png', 'sections/one/2026-09-01_old/index.md', 'sections/one/2026-09-01_old/notes/deep/c.txt',
      'sections/one/2026-09-02_edge/index.md',
    ], 'exactly the files of the two expired cards');
    assert.deepEqual([...before].filter(key => !w.fake.objects.has(key)).sort(), w.deleted());
    for (const kept of ['2026-09-01_old-2/index.md', '2026-09-01_gone/index.md', '2026-10-01_fresh/index.md', '2026-09-01_live/index.md']) {
      assert.ok(w.fake.objects.has(`sections/one/${kept}`), kept);
    }
    const list = w.list();
    assert.deepEqual(Object.keys(list.retired).sort(), ['edge', 'fresh', 'moved', 'old']);
    assert.deepEqual(list.retired.old, { kind: 'purged', at: '2026-11-30', folder: '2026-09-01_old' }, 'a tombstone with no entity and nothing pending');
    assert.equal(list.retired.fresh.kind, 'deleted');
    assert.deepEqual(list.entities.map(item => item.id), ['live', 'sibling']);
    const again = await w.writer.purgeTrash();
    assert.deepEqual([again.cards, again.files], [[], 0]);
    assert.equal(w.deleted().length, 4);
  } finally { await w.close(); }
});

test('the id of a purged card stays taken, and the tombstone cannot be restored', async () => {
  const w = await world({ entities: [], retired: { 'old-deck': gone('old-deck', 'old-deck-folder') } });
  try {
    w.files('old-deck-folder/index.md', 'card-responses/old-deck/notes.json');
    await w.writer.purgeTrash();
    const fresh = await w.writer.createCard({ title: 'Old deck' });
    assert.equal(fresh.id, 'old-deck-2', 'A new card does not inherit the purged card\'s viewer data, pins or links.');
    await assert.rejects(w.writer.restoreCard({ id: 'old-deck' }), { status: 404 });
    await assert.rejects(w.writer.adoptCard({ entity: entity('old-deck', 'x') }), { status: 409 });
    assert.ok(!w.fake.objects.has('sections/one/card-responses/old-deck/notes.json'), 'The purge took the viewer data with the card (owner answer 0e06).');
  } finally { await w.close(); }
});

test('nothing expired: the card list is not even rewritten', async () => {
  const w = await world({ entities: [entity('live', 'live')], retired: { fresh: gone('fresh', 'fresh', '2026-11-20') } });
  try {
    w.files('fresh/index.md', 'live/index.md');
    const answer = await w.writer.purgeTrash();
    assert.deepEqual([answer.cards, answer.tabs, answer.files], [[], [], 0]);
    assert.deepEqual(w.deleted(), []);
    assert.equal(w.puts(), 0, 'no PUT of workspace.json');
  } finally { await w.close(); }
});

test('a nested folder, or any folder that overlaps a live, moved or fresh-Trash one, deletes nothing', async () => {
  for (const folder of ['', '..', '../one', 'a/../../b', '/abs', 'card-responses', 'card-responses/x', '_shared', 'workspace.json', 'a\\b', 'a/b', undefined]) {
    assert.equal(safeFolder(folder), null, String(folder));
  }
  assert.equal(safeFolder('2026-09-01_deck'), '2026-09-01_deck');
  const w = await world({
    entities: [entity('a', 'a', { steps: [{ name: 'Keep', path: 'b/keep.md' }] }), entity('live2', 'p/q')],
    retired: {
      nested: gone('nested', 'a/b'),                           // inside live card a's folder
      parent: gone('parent', 'p'),                             // a folder above live card live2's
      moved: { kind: 'moved', to: 'two', folder: 'm', at: '2026-01-01' },
      samemoved: gone('samemoved', 'm'),
      fresh: gone('fresh', 'f', '2026-11-25'),
      samefresh: gone('samefresh', 'f'),
      dots: gone('dots', '..'),
      resp: gone('resp', 'card-responses'),
      nofolder: { kind: 'deleted', at: '2026-09-01', entity: { id: 'nofolder', title: 'x' } },
    },
  });
  try {
    w.files('a/b/keep.md', 'a/index.md', 'p/q/index.md', 'm/index.md', 'f/index.md', 'card-responses/resp/notes.json', 'elsewhere/index.md');
    const answer = await w.writer.purgeTrash();
    assert.equal(answer.cards.length, 0);
    assert.equal(answer.skipped.length, 7);
    assert.deepEqual(w.deleted(), []);
    assert.ok(Object.values(w.list().retired).filter(record => record.kind === 'purged').every(record => !record.pending), 'Nothing is left pending that was refused.');
  } finally { await w.close(); }
});

test('the clock: a future date, an invalid date and tomorrow never delete; an invalid one does not stop a valid one', async () => {
  const w = await world({
    entities: [],
    retired: {
      far: gone('far', 'far', '9999-12-31'),
      tomorrow: gone('tomorrow', 'tomorrow', '2026-12-01'),
      badmonth: gone('badmonth', 'badmonth', '2026-13-45'),
      feb31: gone('feb31', 'feb31', '2026-02-31'),
      stamp: gone('stamp', 'stamp', '2026-01-01T00:00:00Z'),
      num: { kind: 'deleted', at: 20260101, entity: entity('num', 'num') },
      valid: gone('valid', 'valid', '2026-09-01'),
    },
  });
  try {
    w.files('far/i.md', 'tomorrow/i.md', 'badmonth/i.md', 'feb31/i.md', 'stamp/i.md', 'num/i.md', 'valid/i.md');
    const answer = await w.writer.purgeTrash();
    assert.deepEqual(answer.cards, ['valid']);
    assert.deepEqual(w.deleted(), ['sections/one/valid/i.md']);
    assert.equal(w.list().retired.far.kind, 'deleted');
  } finally { await w.close(); }
});

test('removed tabs expire in a workspace with no deleted cards, and only their own files go', async () => {
  const w = await world({
    entities: [entity('deck', 'deck', {
      steps: [{ name: 'Overview', path: 'index.md' }, { name: 'Back', path: 'back.md' }, { name: 'Dot', path: './keep.md' }, { name: 'Pic', path: 's.png' }],
      removedTabs: [
        { name: 'Old', path: 'old.md', at: '2026-09-01', index: 1 },
        { name: 'Sketch', path: 'sketch.excalidraw', at: '2026-09-01', index: 2 },
        { name: 'Fresh', path: 'fresh.md', at: '2026-11-25', index: 1 },
        { name: 'Back', path: 'back.md', at: '2026-09-01', index: 1 },
        { name: 'Keep', path: 'keep.md', at: '2026-09-01', index: 1 },
        { name: 'S', path: 's.excalidraw', at: '2026-09-01', index: 1 },
        { name: 'Evil', path: '../other/secret.md', at: '2026-09-01', index: 1 },
        { name: 'Future', path: 'future.md', at: '9999-01-01', index: 1 },
      ],
    }), entity('twin', 'deck2', { steps: [{ name: 'T', path: 'x.md' }] })],
  });
  try {
    w.files('deck/index.md', 'deck/old.md', 'deck/sketch.excalidraw', 'deck/sketch.png', 'deck/fresh.md', 'deck/back.md', 'deck/keep.md',
      'deck/s.excalidraw', 'deck/s.png', 'deck/future.md', 'other/secret.md');
    const answer = await w.writer.purgeTrash();
    assert.deepEqual(w.deleted(), ['sections/one/deck/old.md', 'sections/one/deck/s.excalidraw', 'sections/one/deck/sketch.excalidraw', 'sections/one/deck/sketch.png'],
      'old.md, the sketch with its picture, and s.excalidraw (its picture s.png is a live tab and stays)');
    assert.ok(w.fake.objects.has('sections/one/deck/keep.md'), '"./keep.md" protects "keep.md"');
    assert.ok(w.fake.objects.has('sections/one/deck/s.png'));
    assert.ok(w.fake.objects.has('sections/one/other/secret.md'));
    assert.deepEqual(w.list().entities[0].removedTabs.map(tab => tab.name), ['Fresh', 'Future'], 'every claimed tab is dropped once its files are dealt with');
    assert.equal(answer.tabs.length, 5);
  } finally { await w.close(); }
});

test('a tab file that another live or fresh-Trash card in the same folder uses is kept', async () => {
  const w = await world({
    entities: [
      entity('a', 'shared', { removedTabs: [{ name: 'X', path: 'x.md', at: '2026-09-01', index: 1 }] }),
      entity('b', 'shared', { steps: [{ name: 'X', path: 'x.md' }] }),
    ],
    retired: { t: { kind: 'deleted', at: '2026-11-25', entity: entity('t', 'shared2', { steps: [{ name: 'Y', path: 'y.md' }] }) } },
  });
  try {
    w.files('shared/x.md');
    await w.writer.purgeTrash();
    assert.deepEqual(w.deleted(), []);
  } finally { await w.close(); }
});

test('two removed tabs on one path: the expired one does not take the newer file', async () => {
  const w = await world({
    entities: [entity('a', 'deck', { removedTabs: [
      { name: 'Old', path: 'x.md', at: '2026-09-01', index: 1 },
      { name: 'New', path: 'x.md', at: '2026-11-25', index: 2 },
      { name: 'OldDraw', path: 'd.excalidraw', at: '2026-09-01', index: 3 },
      { name: 'NewDraw', path: './d.excalidraw', at: '2026-11-25', index: 4 },
    ] })],
  });
  try {
    w.files('deck/x.md', 'deck/d.excalidraw', 'deck/d.png');
    await w.writer.purgeTrash();
    assert.deepEqual(w.deleted(), [], 'a not-yet-expired entry still references both files');
    assert.deepEqual(w.list().entities[0].removedTabs.map(tab => tab.name), ['New', 'NewDraw']);
  } finally { await w.close(); }
});

test('safeFile normalizes and refuses paths that leave the folder', () => {
  assert.equal(safeFile('./keep.md'), 'keep.md');
  assert.equal(safeFile('a/./b.md'), 'a/b.md');
  for (const bad of ['../x', 'a/../../x', '/abs', 'a\\b', '', '.', '..', undefined]) assert.equal(safeFile(bad), null, String(bad));
});

test('the purge also removes the viewer data of the card, after its own files, and only that card', async () => {
  const w = await world({ name: 'One', entities: [entity('live', 'live')], retired: { old: gone('old', 'old'), fresh: gone('fresh', 'fresh', '2026-11-25') } });
  try {
    w.files('old/index.md', 'live/index.md', 'fresh/index.md',
      'card-responses/old/notes.json', 'card-responses/old/pins.json', 'card-responses/old/deep/x.json',
      'card-responses/old-2/notes.json', 'card-responses/live/notes.json', 'card-responses/fresh/notes.json', 'card-responses/oldx.json');
    const answer = await w.writer.purgeTrash();
    assert.deepEqual(answer.cards, ['old']);
    assert.equal(answer.files, 4);
    assert.deepEqual(w.deleted(), [
      'sections/one/card-responses/old/deep/x.json', 'sections/one/card-responses/old/notes.json', 'sections/one/card-responses/old/pins.json', 'sections/one/old/index.md',
    ], 'the files of the card and everything under card-responses/old/, nothing else');
    const order = w.fake.log.filter(entry => entry.method === 'DELETE').map(entry => entry.key);
    assert.equal(order[0], 'sections/one/old/index.md', 'Its own files go first.');
    for (const kept of ['card-responses/old-2/notes.json', 'card-responses/live/notes.json', 'card-responses/fresh/notes.json', 'card-responses/oldx.json', 'live/index.md', 'fresh/index.md']) {
      assert.ok(w.fake.objects.has(`sections/one/${kept}`), `${kept} stays`);
    }
    assert.equal((await w.writer.purgeTrash()).files, 0, 'A second run has nothing left to delete.');
  } finally { await w.close(); }
});

test('a purge that stops while deleting viewer data is finished by the next run', async () => {
  const w = await world({ entities: [], retired: { old: gone('old', 'old') } });
  try {
    w.files('old/index.md', 'card-responses/old/a.json', 'card-responses/old/b.json', 'card-responses/other/a.json');
    const remove = w.store.remove.bind(w.store);
    let calls = 0;
    w.store.remove = async file => {
      calls += 1;
      if (calls === 3) throw new Error('S3 said no');
      return remove(file);
    };
    await assert.rejects(w.writer.purgeTrash(), /S3 said no/);
    assert.equal(w.list().retired.old.pending, true, 'Still pending: the next run knows.');
    assert.ok(w.fake.objects.has('sections/one/card-responses/old/b.json'), 'The data not yet deleted is still there.');
    const second = await w.writer.purgeTrash();
    assert.deepEqual(second.cards, ['old']);
    assert.equal(w.list().retired.old.pending, undefined);
    assert.deepEqual([...w.fake.objects.keys()].filter(key => key.includes('card-responses/old/') || key.includes('/old/')), []);
    assert.ok(w.fake.objects.has('sections/one/card-responses/other/a.json'), 'The data of another card is never touched.');
  } finally { await w.close(); }
});

test('viewer data of a purged id stays when a live card has the same id', async () => {
  const w = await world({ entities: [entity('old', 'new-folder')], retired: { old: { kind: 'purged', at: '2026-11-01', folder: 'old-folder', pending: true } } });
  try {
    w.files('old-folder/index.md', 'new-folder/index.md', 'card-responses/old/notes.json');
    const answer = await w.writer.purgeTrash();
    assert.deepEqual(w.deleted(), ['sections/one/old-folder/index.md'], 'Only the old folder goes.');
    assert.ok(w.fake.objects.has('sections/one/card-responses/old/notes.json'), 'The live card keeps the data of its viewers.');
    assert.ok(answer.skipped.some(item => item.id === 'old' && /viewer data stays/.test(item.why)), 'The skip is recorded.');
    assert.equal(w.list().retired.old.pending, undefined);
  } finally { await w.close(); }
});

test('the claim is written before the first delete, restore after it is refused, and a restore before it wins', async () => {
  const w = await world({ entities: [], retired: { old: gone('old', 'old'), other: gone('other', 'other', '2026-11-25') } });
  try {
    w.files('old/index.md', 'old/b.md', 'other/index.md');
    const remove = w.store.remove.bind(w.store);
    const list = w.store.list.bind(w.store);
    const seen = [];
    let restoreError;
    w.store.list = async prefix => {
      // Between the claim and the delete someone presses Restore: it must be refused.
      restoreError = await w.writer.restoreCard({ id: 'old' }).then(() => null, error => error);
      return list(prefix);
    };
    w.store.remove = async file => {
      const held = w.list().retired.old;
      seen.push([file, held.kind, held.pending]);
      return remove(file);
    };
    await w.writer.purgeTrash();
    assert.equal(restoreError?.status, 404, 'Restore after the claim is refused');
    assert.deepEqual(seen, [['old/b.md', 'purged', true], ['old/index.md', 'purged', true]], 'workspace.json already held the claim at every delete');
    assert.equal(w.list().retired.old.pending, undefined);
    assert.equal((await w.writer.restoreCard({ id: 'other' })).card.id, 'other', 'A card that is not expired restores as before.');
  } finally { await w.close(); }
  const x = await world({ entities: [], retired: { old: gone('old', 'old') } });
  try {
    x.files('old/index.md');
    await x.writer.restoreCard({ id: 'old' });
    const answer = await x.writer.purgeTrash();
    assert.deepEqual([answer.cards, answer.files, x.deleted()], [[], 0, []], 'A restore that comes first keeps everything.');
  } finally { await x.close(); }
});

test('a purge that stops partway is finished by the next run', async () => {
  const w = await world({ entities: [entity('deck', 'deck', { removedTabs: [{ name: 'Old', path: 'old.md', at: '2026-09-01', index: 1 }] })], retired: { old: gone('old', 'old') } });
  try {
    w.files('old/a.md', 'old/b.md', 'old/c.md', 'deck/old.md');
    const remove = w.store.remove.bind(w.store);
    let calls = 0;
    w.store.remove = async file => {
      calls += 1;
      if (calls === 2) throw new Error('S3 said no');
      return remove(file);
    };
    await assert.rejects(w.writer.purgeTrash(), /S3 said no/);
    assert.equal(w.list().retired.old.pending, true, 'Still pending: the next run knows.');
    assert.equal(w.list().entities[0].removedTabs[0].pending, true);
    await assert.rejects(w.writer.restoreCard({ id: 'old' }), { status: 404 });
    await assert.rejects(w.writer.restoreSection({ id: 'deck', path: 'old.md' }), { status: 409 });
    const second = await w.writer.purgeTrash();
    assert.deepEqual(second.cards, ['old']);
    assert.deepEqual(w.deleted(), ['sections/one/deck/old.md', 'sections/one/old/a.md', 'sections/one/old/b.md', 'sections/one/old/c.md']);
    assert.equal(w.list().retired.old.pending, undefined);
    assert.equal(w.list().entities[0].removedTabs, undefined);
    assert.equal((await w.writer.purgeTrash()).files, 0);
  } finally { await w.close(); }
});

test('a pending tombstone whose folder is in use again is not deleted under', async () => {
  const w = await world({ entities: [entity('back', 'f')], retired: { x: { kind: 'purged', at: '2026-11-01', folder: 'f', pending: true } } });
  try {
    w.files('f/index.md');
    const answer = await w.writer.purgeTrash();
    assert.deepEqual([answer.cards, w.deleted()], [[], []]);
    assert.equal(w.list().retired.x.pending, undefined);
  } finally { await w.close(); }
});

test('the local folder store never deletes: the Trash is only emptied on the site', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'buw-purge-'));
  await writeFile(path.join(root, 'workspace.json'), JSON.stringify({ entities: [], retired: { old: gone('old', 'old') } }));
  const writer = cardWriter(folderStore(root), { now: () => NOW });
  await assert.rejects(writer.purgeTrash(), { status: 501 });
});

test('the route is a gated write: Origin, Remote-User and the development copy', async () => {
  const fake = await startFakeS3();
  const bucket = createBucket({ bucket: fake.bucket, endpoint: fake.endpoint, credentials: fake.credentials, region: 'us-east-1' });
  const old = gone('old', 'old', '2020-01-01');
  for (const id of ['one', 'dev-sandbox']) {
    fake.seed(`sections/${id}/workspace.json`, JSON.stringify({ entities: [], retired: { old } }), 'application/json');
    fake.seed(`sections/${id}/old/index.md`, 'x');
  }
  fake.seed('state.json', '{"version":1,"cards":{}}', 'application/json');
  const root = await mkdtemp(path.join(tmpdir(), 'buw-purge-api-'));
  const serve = async options => {
    const server = createSiteApi({ bucket, templateDir: path.join(root, 'none'), stateFile: path.join(root, 'state.json'), sectionsTtl: 0, ...options });
    await listenOnGoodPort(server, '127.0.0.1');
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
  } finally {
    for (const { server } of [gated, dev]) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await fake.close();
  }
});
