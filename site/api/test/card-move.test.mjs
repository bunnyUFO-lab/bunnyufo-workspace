// Moving a card between workspaces: on the bucket (fake S3) and on folders, with the card's
// viewer data, its state, the failures a move has to survive, and the promise that nothing is deleted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createBucket } from '../s3.mjs';
import { startFakeS3 } from './fake-s3.mjs';
import { bucketStore, cardWriter, folderStore } from '../card-writes.mjs';
import { moveCard } from '../card-move.mjs';
import { createBucketCardStore, createCardStore } from '../card-state.mjs';

const now = () => new Date('2026-10-30T10:00:00Z');
const entity = (id, extra = {}) => ({ id, folder: `2026-10-29_${id}`, title: id, category: 'ideas', created: '2026-10-29', updated: '2026-10-29', steps: [{ name: 'Overview', path: 'index.md' }, { name: 'Page', path: 'page.html' }], ...extra });

/** Two workspaces in the fake bucket, `one` holding card "deck" with files and viewer data. */
async function bucketWorld() {
  const fake = await startFakeS3();
  const bucket = createBucket({ bucket: fake.bucket, endpoint: fake.endpoint, credentials: fake.credentials, region: 'us-east-1' });
  const seedList = (id, name, entities) => fake.seed(`sections/${id}/workspace.json`, `${JSON.stringify({ name, entities }, null, 2)}\n`, 'application/json');
  seedList('one', 'Assistant', [entity('deck'), entity('other')]);
  seedList('two', 'Game Ideas', []);
  fake.seed('sections/one/2026-10-29_deck/index.md', '# Deck\n', 'text/markdown');
  fake.seed('sections/one/2026-10-29_deck/page.html', '<h1>deck</h1>', 'text/html');
  fake.seed('sections/one/2026-10-29_deck/img/a.png', Buffer.from([1, 2, 3]), 'image/png');
  fake.seed('sections/one/card-responses/deck/notes.json', '{"items":{}}', 'application/json');
  fake.seed('sections/one/2026-10-29_other/index.md', '# Other\n', 'text/markdown');
  fake.seed('state.json', JSON.stringify({ version: 1, cards: { 'one/deck': { pinned: true, tags: ['x'] }, 'one/other': { pinned: true } } }), 'application/json');
  const writerOf = id => cardWriter(bucketStore(bucket, `sections/${id}`), { section: id, now });
  const state = createBucketCardStore(bucket, { ttl: 0 });
  const list = id => fake.json(`sections/${id}/workspace.json`);
  return { fake, bucket, one: writerOf('one'), two: writerOf('two'), writerOf, state, list, close: () => fake.close() };
}

test('on the bucket a move copies the files and viewer data, adds the card, retires the old entry and re-keys its state', async () => {
  const w = await bucketWorld();
  try {
    const answer = await moveCard({ from: w.one, to: w.two, id: 'deck', category: 'Brief', state: w.state, now });
    assert.deepEqual([answer.from, answer.to, answer.files], ['one', 'two', 4]);
    assert.equal(answer.warning, undefined);
    for (const file of ['2026-10-29_deck/index.md', '2026-10-29_deck/page.html', '2026-10-29_deck/img/a.png', 'card-responses/deck/notes.json']) {
      assert.deepEqual(w.fake.objects.get(`sections/two/${file}`).body, w.fake.objects.get(`sections/one/${file}`).body, file);
      assert.ok(w.fake.objects.get(`sections/one/${file}`), 'The source copy stays.');
    }
    assert.equal(w.fake.objects.get('sections/two/2026-10-29_deck/img/a.png').contentType, 'image/png');
    const moved = w.list('two').entities[0];
    assert.deepEqual([moved.id, moved.folder, moved.category, moved.updated], ['deck', '2026-10-29_deck', 'brief', '2026-10-30']);
    assert.deepEqual(moved.steps, entity('deck').steps);
    assert.deepEqual(w.list('one').entities.map(item => item.id), ['other']);
    assert.deepEqual(w.list('one').retired.deck, { kind: 'moved', to: 'two', folder: '2026-10-29_deck', at: '2026-10-30' });
    const cards = w.fake.json('state.json').cards;
    assert.deepEqual(cards['two/deck'], { pinned: true, tags: ['x'] });
    assert.equal(cards['one/deck'], undefined);
    assert.ok(cards['one/other'], 'Other cards keep their state.');
    assert.ok(!w.fake.log.some(entry => entry.method === 'DELETE'), 'Nothing was deleted.');
    assert.ok(w.fake.log.some(entry => entry.method === 'PUT' && entry.headers['x-amz-copy-source']), 'The bytes were copied inside S3.');
  } finally { await w.close(); }
});

test('on folders a move copies files and responses, and the card keeps its folder and id', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'buw-move-'));
  const make = async (name, entities) => {
    const dir = path.join(root, name);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'workspace.json'), JSON.stringify({ name, entities }));
    return dir;
  };
  const a = await make('a', [entity('deck')]);
  const b = await make('b', []);
  await mkdir(path.join(a, '2026-10-29_deck', 'img'), { recursive: true });
  await mkdir(path.join(a, 'card-responses', 'deck'), { recursive: true });
  await writeFile(path.join(a, '2026-10-29_deck', 'index.md'), '# Deck\n');
  await writeFile(path.join(a, '2026-10-29_deck', 'img', 'a.png'), Buffer.from([9, 8, 7]));
  await writeFile(path.join(a, 'card-responses', 'deck', 'notes.json'), '{}');
  const state = createCardStore(path.join(root, 'state.json'));
  await state.setPinned('a', 'deck', true, 0);
  const from = cardWriter(folderStore(a), { section: 'a', now });
  const to = cardWriter(folderStore(b), { section: 'b', now });
  const answer = await moveCard({ from, to, id: 'deck', state, now });
  assert.equal(answer.files, 3);
  assert.equal(await readFile(path.join(b, '2026-10-29_deck', 'index.md'), 'utf8'), '# Deck\n');
  assert.deepEqual([...await readFile(path.join(b, '2026-10-29_deck', 'img', 'a.png'))], [9, 8, 7]);
  assert.equal(await readFile(path.join(b, 'card-responses', 'deck', 'notes.json'), 'utf8'), '{}');
  assert.equal(await readFile(path.join(a, '2026-10-29_deck', 'index.md'), 'utf8'), '# Deck\n', 'The source files stay.');
  assert.deepEqual(JSON.parse(await readFile(path.join(a, 'workspace.json'), 'utf8')).entities, []);
  assert.equal(JSON.parse(await readFile(path.join(b, 'workspace.json'), 'utf8')).entities[0].category, 'ideas', 'No category asked for: kept.');
  assert.equal((await state.get('b', 'deck')).pinned, true);
  assert.equal(await state.get('a', 'deck'), null);
});

test('an id or folder already in the target is a 409 and nothing is copied', async () => {
  const w = await bucketWorld();
  try {
    await w.two.adoptCard({ entity: entity('deck', { folder: 'elsewhere', title: 'Their deck' }) });
    await assert.rejects(moveCard({ from: w.one, to: w.two, id: 'deck', now }), { status: 409, message: /Game Ideas already has a card called "Their deck"/ });
    await w.two.adoptCard({ entity: entity('different', { folder: '2026-10-29_other' }) });
    await assert.rejects(moveCard({ from: w.one, to: w.two, id: 'other', now }), { status: 409 });
    assert.ok(![...w.fake.objects.keys()].some(key => key.startsWith('sections/two/2026-10-29_')), 'Nothing was copied.');
    assert.equal(w.list('one').entities.length, 2);
    await assert.rejects(moveCard({ from: w.one, to: w.two, id: 'nope', now }), { status: 404 });
    await assert.rejects(moveCard({ from: w.one, to: w.one, id: 'deck', now }), { status: 400 });
  } finally { await w.close(); }
});

test('a source file written during the copy is copied again', async () => {
  const w = await bucketWorld();
  try {
    const store = w.two.store;
    const original = store.copyFrom.bind(store);
    let touched = false;
    store.copyFrom = async (source, file) => {
      const result = await original(source, file);
      if (!touched && file.endsWith('page.html')) {
        touched = true;
        w.fake.seed('sections/one/2026-10-29_deck/page.html', '<h1>newer</h1>', 'text/html');
      }
      return result;
    };
    await moveCard({ from: w.one, to: w.two, id: 'deck', now });
    assert.equal(w.fake.text('sections/two/2026-10-29_deck/page.html'), '<h1>newer</h1>');
  } finally { await w.close(); }
});

test('a source that never stops changing is a 409 after three rounds', async () => {
  const w = await bucketWorld();
  try {
    const store = w.two.store;
    const original = store.copyFrom.bind(store);
    let n = 0;
    store.copyFrom = async (source, file) => {
      const result = await original(source, file);
      if (file.endsWith('page.html')) { n += 1; w.fake.seed('sections/one/2026-10-29_deck/page.html', `<h1>${n}</h1>`, 'text/html'); }
      return result;
    };
    await assert.rejects(moveCard({ from: w.one, to: w.two, id: 'deck', now }), { status: 409, message: /changed while it was moving/ });
    assert.equal(w.list('two').entities.length, 0, 'The card was not added.');
    assert.equal(w.list('one').entities.length, 2);
  } finally { await w.close(); }
});

test('a failure after the card was added is finished by moving again', async () => {
  const w = await bucketWorld();
  try {
    const store = w.one.store;
    const write = store.write.bind(store);
    let failed = false;
    store.write = async (file, body, options) => {
      if (!failed && file === 'workspace.json') { failed = true; throw Object.assign(new Error('boom'), { status: 500 }); }
      return write(file, body, options);
    };
    await assert.rejects(moveCard({ from: w.one, to: w.two, id: 'deck', state: w.state, now }), error => error.step === 6 && /press Move again/.test(error.message));
    assert.equal(w.list('two').entities.length, 1, 'It is in both lists until the retry.');
    assert.equal(w.list('one').entities.length, 2);
    const again = await moveCard({ from: w.one, to: w.two, id: 'deck', state: w.state, now });
    assert.equal(again.files, 0, 'Nothing is copied twice.');
    assert.equal(w.list('two').entities.length, 1);
    assert.deepEqual(w.list('one').entities.map(item => item.id), ['other']);
    assert.equal(w.list('one').retired.deck.kind, 'moved');
    assert.ok(w.fake.json('state.json').cards['two/deck']);
    // And once more after everything is done: only the state step runs.
    const third = await moveCard({ from: w.one, to: w.two, id: 'deck', state: w.state, now });
    assert.equal(third.files, 0);
    assert.ok(!w.fake.log.some(entry => entry.method === 'DELETE'));
  } finally { await w.close(); }
});

test('a state failure is a warning, not a failed move', async () => {
  const w = await bucketWorld();
  try {
    const answer = await moveCard({ from: w.one, to: w.two, id: 'deck', state: { rekey: async () => { throw new Error('state is down'); } }, now });
    assert.match(answer.warning, /pins and tags were not carried over/);
    assert.deepEqual(w.list('two').entities.map(item => item.id), ['deck']);
  } finally { await w.close(); }
});

test('moving back into the old workspace works, and leaves the other copy in place', async () => {
  const w = await bucketWorld();
  try {
    await moveCard({ from: w.one, to: w.two, id: 'deck', state: w.state, now });
    w.fake.seed('sections/two/2026-10-29_deck/page.html', '<h1>edited there</h1>', 'text/html');
    const back = await moveCard({ from: w.two, to: w.one, id: 'deck', state: w.state, now });
    assert.ok(back.files >= 1);
    assert.deepEqual(w.list('one').entities.map(item => item.id).sort(), ['deck', 'other']);
    assert.equal(w.list('one').retired, undefined, 'The old record is dropped.');
    assert.equal(w.list('two').retired.deck.to, 'one');
    assert.equal(w.fake.text('sections/one/2026-10-29_deck/page.html'), '<h1>edited there</h1>', 'The newer copy wins.');
    assert.ok(w.fake.json('state.json').cards['one/deck'].pinned);
    assert.ok(!w.fake.log.some(entry => entry.method === 'DELETE'));
  } finally { await w.close(); }
});

test('files left in the target by an earlier attempt are reused; foreign files there are a 409', async () => {
  const w = await bucketWorld();
  try {
    w.fake.seed('sections/two/2026-10-29_deck/index.md', '# Deck\n', 'text/markdown');
    const first = await moveCard({ from: w.one, to: w.two, id: 'deck', now });
    assert.equal(first.files, 3, 'The identical file was not copied again.');
  } finally { await w.close(); }
  const x = await bucketWorld();
  try {
    x.fake.seed('sections/two/2026-10-29_deck/index.md', 'someone else', 'text/markdown');
    await assert.rejects(moveCard({ from: x.one, to: x.two, id: 'deck', now }), { status: 409, message: /already has files/ });
    assert.equal(x.fake.text('sections/two/2026-10-29_deck/index.md'), 'someone else', 'Their file was not overwritten.');
  } finally { await x.close(); }
});

test('a card of more than 300 files is refused with a 413', async () => {
  const w = await bucketWorld();
  try {
    for (let n = 0; n < 301; n += 1) w.fake.seed(`sections/one/2026-10-29_deck/many/${n}.txt`, 'x');
    await assert.rejects(moveCard({ from: w.one, to: w.two, id: 'deck', now }), { status: 413 });
    assert.equal(w.list('two').entities.length, 0);
  } finally { await w.close(); }
});

test('rekey moves an entry, keeps a newer one already at the new key, and does nothing for a missing one', async () => {
  const w = await bucketWorld();
  try {
    w.fake.seed('state.json', JSON.stringify({ version: 1, cards: { 'a/x': { pinned: true, tags: ['old'] }, 'b/x': { tags: ['new'] }, 'a/y': { pinned: true } } }), 'application/json');
    await w.state.rekey('a/x', 'b/x');
    await w.state.rekey('a/none', 'b/none');
    assert.deepEqual(w.fake.json('state.json').cards, { 'b/x': { pinned: true, tags: ['new'] }, 'a/y': { pinned: true } });
  } finally { await w.close(); }
});

test('a folder store refuses to copy from a bucket store', async () => {
  const w = await bucketWorld();
  try {
    const root = await mkdtemp(path.join(tmpdir(), 'buw-move-mixed-'));
    await writeFile(path.join(root, 'workspace.json'), '{"entities":[]}');
    const folder = cardWriter(folderStore(root), { section: 'local', now });
    await assert.rejects(moveCard({ from: w.one, to: folder, id: 'deck', now }), { status: 501 });
  } finally { await w.close(); }
});
