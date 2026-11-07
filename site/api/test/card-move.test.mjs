// Moving a card between workspaces: on the bucket (fake S3) and on folders, with the card's
// viewer data, its state, the failures a move has to survive, and the promise that nothing is deleted.
import baseTest from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createBucket } from '../s3.mjs';
import { startFakeS3 } from './fake-s3.mjs';
import { bucketStore, cardRoute, cardWriter, folderStore } from '../card-writes.mjs';
import { MAX_BYTES, MAX_FILES, memoryMoveLog, moveCard as moveCardWithBudget, moveProgress } from '../card-move.mjs';
import { createBucketCardStore, createCardStore } from '../card-state.mjs';

// Every test has a time limit: a stuck socket or server fails the test instead of hanging the run.
// The limit is generous (a PC running other suites is 20 times slower than an idle one) and the
// run is cut short when a test that timed out left a server or timer open, which would otherwise
// keep the process alive for ever.
const TEST_MS = Number(process.env.BUW_TEST_TIMEOUT_MS) || 120_000;
const test = (name, fn) => baseTest(name, { timeout: TEST_MS }, fn);
baseTest.after(() => {
  setTimeout(() => {
    console.error('card-move tests: a server or timer was left open after the last test; stopping.');
    process.exit(process.exitCode || 1);
  }, 10_000).unref();
});

const now = () => new Date('2026-10-30T10:00:00Z');
// A move stops after its time budget (15 s by default) and answers pending. A test that is not about the budget must not
// depend on how fast the PC is: it gets a budget no run reaches. The tests of the budget pass their own `budgetMs` and `clock`.
const moveCard = args => moveCardWithBudget({ budgetMs: 60 * 60_000, ...args });
const entity = (id, extra = {}) => ({ id, folder: `2026-10-29_${id}`, title: id, category: 'ideas', created: '2026-10-29', updated: '2026-10-29', steps: [{ name: 'Overview', path: 'index.md' }, { name: 'Page', path: 'page.html' }], ...extra });

/** Two workspaces in the fake bucket, `one` holding card "deck" with files and viewer data. */
async function bucketWorld() {
  const fake = await startFakeS3();
  const bucket = createBucket({ bucket: fake.bucket, endpoint: fake.endpoint, credentials: fake.credentials, region: 'us-east-1' });
  const seedList = (id, name, entities) => fake.seed(`sections/${id}/workspace.json`, `${JSON.stringify({ name, entities }, null, 2)}\n`, 'application/json');
  seedList('one', 'Assistant', [entity('deck', { purpose: 'report' }), entity('other')]);
  seedList('two', 'Game Ideas', []);
  fake.seed('sections/one/2026-10-29_deck/index.md', '# Deck\n', 'text/markdown');
  fake.seed('sections/one/2026-10-29_deck/page.html', '<h1>deck</h1>', 'text/html');
  fake.seed('sections/one/2026-10-29_deck/img/a.png', Buffer.from([1, 2, 3]), 'image/png');
  fake.seed('sections/one/card-responses/deck/notes.json', '{"items":{}}', 'application/json');
  fake.seed('sections/one/2026-10-29_other/index.md', '# Other\n', 'text/markdown');
  fake.seed('state.json', JSON.stringify({ version: 1, cards: { 'one/deck': { pinned: true, tags: ['x'], purpose: 'reference' }, 'one/other': { pinned: true } } }), 'application/json');
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
    assert.deepEqual(cards['two/deck'], { pinned: true, tags: ['x'], purpose: 'reference' }, 'the owner’s purpose moves with the card');
    assert.equal(moved.purpose, 'report', 'and so does the entry’s');
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

test('files left in the target by an earlier attempt are reused or overwritten; files the source lacks make it a 409', async () => {
  const w = await bucketWorld();
  try {
    w.fake.seed('sections/two/2026-10-29_deck/index.md', '# Deck\n', 'text/markdown');
    const first = await moveCard({ from: w.one, to: w.two, id: 'deck', now });
    assert.equal(first.files, 3, 'The identical file was not copied again.');
  } finally { await w.close(); }
  const x = await bucketWorld();
  try {
    x.fake.seed('sections/two/2026-10-29_deck/stranger.txt', 'someone else', 'text/plain');
    await assert.rejects(moveCard({ from: x.one, to: x.two, id: 'deck', now }), { status: 409, message: /already has files/ });
    assert.equal(x.fake.text('sections/two/2026-10-29_deck/stranger.txt'), 'someone else', 'Their file was not touched.');
    assert.equal(x.list('one').entities.length, 2);
  } finally { await x.close(); }
});

test('a move stopped half way is finished even when the source changed since', async () => {
  const w = await bucketWorld();
  try {
    // The first attempt copied two files, then the source changed: a page rewritten, viewer data added.
    w.fake.seed('sections/two/2026-10-29_deck/index.md', '# Old deck\n', 'text/markdown');
    w.fake.seed('sections/two/card-responses/deck/notes.json', '{"items":{"old":1}}', 'application/json');
    const done = await moveCard({ from: w.one, to: w.two, id: 'deck', now });
    assert.equal(w.fake.text('sections/two/2026-10-29_deck/index.md'), '# Deck\n');
    assert.equal(w.fake.text('sections/two/card-responses/deck/notes.json'), '{"items":{}}');
    assert.equal(done.files, 4);
    assert.deepEqual(w.list('two').entities.map(item => item.id), ['deck']);
  } finally { await w.close(); }
});

test('a move never erases a Trash record: not in the target, not in the source', async () => {
  const w = await bucketWorld();
  try {
    await w.two.adoptCard({ entity: entity('deck', { folder: 'old', title: 'Trashed deck' }) });
    await w.two.deleteCard({ id: 'deck' });
    await assert.rejects(moveCard({ from: w.one, to: w.two, id: 'deck', now }), { status: 409, message: /Trash/ });
    assert.equal(w.list('two').retired.deck.kind, 'deleted', 'The Trash record is still there.');
    assert.equal(w.list('one').entities.length, 2, 'Nothing moved.');
    assert.ok(![...w.fake.objects.keys()].some(key => key.startsWith('sections/two/2026-10-29_')), 'Nothing was copied.');
    await assert.rejects(w.two.adoptCard({ entity: entity('deck', { folder: 'again' }) }), { status: 409 });
    // And the source side: an old-data card with a Trash record under its id cannot be recorded as moved.
    const stored = w.list('one');
    stored.retired = { other: { kind: 'deleted', at: '2026-10-01', entity: entity('other') } };
    w.fake.seed('sections/one/workspace.json', JSON.stringify(stored), 'application/json');
    await assert.rejects(w.one.retireMoved({ id: 'other', to: 'two', folder: '2026-10-29_other' }), { status: 409 });
    assert.equal(w.list('one').retired.other.kind, 'deleted');
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

// ---- Big cards: more than 300 files, in slices, resumable, with a progress record. ----

const MANY = 600;
const seedMany = (w, count = MANY) => { for (let n = 0; n < count; n += 1) w.fake.seed(`sections/one/2026-10-29_deck/many/${String(n).padStart(4, '0')}.txt`, `file ${n}`, 'text/plain'); };
/** Count copies (and the most running at once) on a target store; `each(n)` runs after the nth one lands. */
function watchCopies(store, each) {
  const original = store.copyFrom.bind(store);
  const seen = { calls: 0, running: 0, peak: 0 };
  store.copyFrom = async (source, file) => {
    seen.running += 1; seen.peak = Math.max(seen.peak, seen.running);
    try { seen.calls += 1; const result = await original(source, file); await each?.(seen.calls); return result; } finally { seen.running -= 1; }
  };
  return seen;
}

test('a card of 600 small files moves in one request, copied inside S3, a few at a time', async () => {
  const w = await bucketWorld();
  try {
    seedMany(w);
    const seen = watchCopies(w.two.store);
    const moves = bucketStore(w.bucket, 'state-moves');
    const answer = await moveCard({ from: w.one, to: w.two, id: 'deck', state: w.state, moves, now });
    assert.equal(answer.pending, undefined);
    assert.equal(answer.files, MANY + 4);
    assert.ok(seen.peak > 1 && seen.peak <= 8, `copies ran together but bounded (peak ${seen.peak})`);
    for (let n = 0; n < MANY; n += 1) assert.equal(w.fake.text(`sections/two/2026-10-29_deck/many/${String(n).padStart(4, '0')}.txt`), `file ${n}`);
    assert.equal(w.fake.log.filter(entry => entry.method === 'PUT' && entry.headers['x-amz-copy-source']).length, MANY + 4);
    assert.ok(!w.fake.log.some(entry => entry.method === 'DELETE'), 'Nothing was deleted.');
    assert.equal(w.list('one').retired.deck.to, 'two');
    const progress = await moveProgress({ moves, workspace: 'one', id: 'deck' });
    assert.deepEqual([progress.phase, progress.to, progress.done, progress.total], ['done', 'two', MANY + 4, MANY + 4]);
    assert.equal(progress.doneBytes, progress.bytes);
  } finally { await w.close(); }
});

test('a move that runs out of time answers pending with progress, and asking again finishes it without copying twice', async () => {
  const w = await bucketWorld();
  try {
    seedMany(w);
    let t = 0;
    const seen = watchCopies(w.two.store, () => { t += 10; });
    const moves = bucketStore(w.bucket, 'state-moves');
    const slices = [];
    let answer;
    do {
      answer = await moveCard({ from: w.one, to: w.two, id: 'deck', state: w.state, moves, now, clock: () => t, budgetMs: 1000 });
      slices.push(answer);
      if (answer.pending) {
        assert.deepEqual(w.list('two').entities, [], 'The card is not in the target until every file is there.');
        assert.deepEqual(w.list('one').entities.map(item => item.id).sort(), ['deck', 'other'], 'The source keeps the card.');
      }
    } while (answer.pending && slices.length < 20);
    assert.ok(slices.length >= 4, `several slices (${slices.length})`);
    const dones = slices.filter(item => item.pending).map(item => item.progress.done);
    assert.deepEqual(dones, [...dones].sort((a, b) => a - b), 'progress only goes up');
    assert.ok(dones.every(done => done < MANY + 4) && slices[0].progress.total === MANY + 4);
    assert.equal(seen.calls, MANY + 4, 'every file was copied exactly once across the slices');
    assert.equal(answer.files, MANY + 4);
    assert.deepEqual(w.list('two').entities.map(item => item.id), ['deck']);
  } finally { await w.close(); }
});

test('the progress of a paused move is read through the route, and the route finishes it', async () => {
  const w = await bucketWorld();
  try {
    seedMany(w, 40);
    const moves = bucketStore(w.bucket, 'state-moves');
    const writers = new Map([['one', w.one], ['two', w.two]]);
    const route = { writerFor: async id => writers.get(id), state: w.state, moves };
    // The route has no clock knob: a move whose first file takes longer than the budget stops at once.
    let t = 0;
    watchCopies(w.two.store, () => { t += 1000; });
    const first = await moveCard({ from: w.one, to: w.two, id: 'deck', moves, now, clock: () => t, budgetMs: 5000 });
    assert.equal(first.pending, true);
    const read = await cardRoute({ method: 'GET', route: '/cards/move/progress', query: new URLSearchParams({ workspace: 'one', id: 'deck' }), data: {}, ...route });
    assert.equal(read.status, 200);
    assert.equal(read.body.progress.phase, 'paused');
    assert.equal(read.body.progress.total, 44);
    assert.ok(read.body.progress.done > 0 && read.body.progress.done < 44);
    const none = await cardRoute({ method: 'GET', route: '/cards/move/progress', query: new URLSearchParams({ workspace: 'one', id: 'other' }), data: {}, ...route });
    assert.equal(none.body.progress, null);
    const done = await cardRoute({ method: 'POST', route: '/cards/move', query: new URLSearchParams(), data: { workspace: 'one', id: 'deck', to: 'two' }, ...route });
    assert.equal(done.status, 200);
    assert.equal(done.body.pending, undefined);
  } finally { await w.close(); }
});

test('a move that stopped mid-way resumes from what is in the target', async () => {
  const w = await bucketWorld();
  try {
    seedMany(w);
    const moves = bucketStore(w.bucket, 'state-moves');
    const first = watchCopies(w.two.store, calls => { if (calls === 250) throw new Error('the server stopped'); });
    await assert.rejects(moveCard({ from: w.one, to: w.two, id: 'deck', moves, now }), /stopped/);
    assert.ok(first.calls >= 250 && first.calls < MANY, `stopped part way (${first.calls})`);
    assert.deepEqual(w.list('two').entities, []);
    assert.equal(w.list('one').entities.length, 2, 'the card is still in the source');
    const record = await moveProgress({ moves, workspace: 'one', id: 'deck' });
    assert.equal(record.phase, 'paused');
    assert.equal(record.total, MANY + 4);
    // A fresh process: new store objects over the same bucket, a new run.
    const again = cardWriter(bucketStore(w.bucket, 'sections/two'), { section: 'two', now });
    const second = watchCopies(again.store);
    const answer = await moveCard({ from: cardWriter(bucketStore(w.bucket, 'sections/one'), { section: 'one', now }), to: again, id: 'deck', moves, now });
    assert.equal(answer.pending, undefined);
    assert.ok(MANY + 4 - second.calls >= 200, `the files already there were not copied again (${second.calls} copied)`);
    assert.equal(w.fake.text('sections/two/2026-10-29_deck/many/0599.txt'), 'file 599');
    assert.deepEqual(w.list('two').entities.map(item => item.id), ['deck']);
  } finally { await w.close(); }
});

test('a live lease held by another run is respected; once it has run out the move is taken over', async () => {
  const w = await bucketWorld();
  try {
    seedMany(w, 30);
    const moves = bucketStore(w.bucket, 'state-moves');
    // A run that died left its record "copying", last seen at t = 1000.
    await moves.write('one--deck.json', JSON.stringify({ id: 'deck', from: 'one', to: 'two', folder: '2026-10-29_deck', run: 'dead', phase: 'copying', lease: 1000, startedAt: 1000, total: 34, bytes: 100, done: 5, doneBytes: 10, copied: 5 }));
    const seen = watchCopies(w.two.store);
    const busy = await moveCard({ from: w.one, to: w.two, id: 'deck', moves, now, clock: () => 30_000 });
    assert.deepEqual([busy.pending, busy.busy, busy.progress.done, seen.calls], [true, true, 5, 0]);
    const taken = await moveCard({ from: w.one, to: w.two, id: 'deck', moves, now, clock: () => 70_000 });
    assert.equal(taken.pending, undefined);
    assert.equal(seen.calls, 34);
    assert.equal(w.list('two').entities.length, 1);
  } finally { await w.close(); }
});

test('two callers at once: one copies and the other waits', async () => {
  const w = await bucketWorld();
  try {
    seedMany(w, 60);
    const moves = bucketStore(w.bucket, 'state-moves');
    const seen = watchCopies(w.two.store);
    const answers = await Promise.all([
      moveCard({ from: w.one, to: w.two, id: 'deck', moves, now }),
      moveCard({ from: w.one, to: w.two, id: 'deck', moves, now }),
    ]);
    assert.equal(answers.filter(item => item.pending).length, 1, 'exactly one waited');
    assert.equal(seen.calls, 64, 'no file was copied twice');
    assert.equal(w.list('two').entities.length, 1);
  } finally { await w.close(); }
});

test('a file written to the source while a big card is copying reaches the target', async () => {
  const w = await bucketWorld();
  try {
    seedMany(w, 400);
    watchCopies(w.two.store, calls => { if (calls === 150) w.fake.seed('sections/one/2026-10-29_deck/many/0005.txt', 'rewritten while moving', 'text/plain'); });
    await moveCard({ from: w.one, to: w.two, id: 'deck', moves: bucketStore(w.bucket, 'state-moves'), now });
    assert.equal(w.fake.text('sections/two/2026-10-29_deck/many/0005.txt'), 'rewritten while moving');
    assert.equal(w.fake.text('sections/one/2026-10-29_deck/many/0005.txt'), 'rewritten while moving');
  } finally { await w.close(); }
});

test('the limits: more than the file cap or the byte cap is a 413 and copies nothing', async () => {
  assert.equal(MAX_FILES, 5000);
  assert.equal(MAX_BYTES, 2 * 1024 ** 3);
  const w = await bucketWorld();
  try {
    seedMany(w, MAX_FILES - 3);
    await assert.rejects(moveCard({ from: w.one, to: w.two, id: 'deck', moves: memoryMoveLog(), now }), { status: 413, message: /5000 files or 2 GB/ });
    assert.equal(w.list('two').entities.length, 0);
    assert.ok(!w.fake.log.some(entry => entry.method === 'PUT' && entry.headers['x-amz-copy-source']), 'nothing was copied');
  } finally { await w.close(); }
  const big = await bucketWorld();
  try {
    const list = big.one.store.list.bind(big.one.store);
    big.one.store.list = async prefix => (await list(prefix)).map((item, index) => (index === 0 ? { ...item, size: MAX_BYTES + 1 } : item));
    await assert.rejects(moveCard({ from: big.one, to: big.two, id: 'deck', moves: memoryMoveLog(), now }), { status: 413 });
  } finally { await big.close(); }
});

test('a small move writes its progress record and ends it as done', async () => {
  const w = await bucketWorld();
  try {
    await moveCard({ from: w.one, to: w.two, id: 'deck', moves: bucketStore(w.bucket, 'state-moves'), now });
    const record = w.fake.json('state-moves/one--deck.json');
    assert.deepEqual([record.phase, record.lease, record.done, record.total], ['done', 0, 4, 4]);
  } finally { await w.close(); }
});

// ---- Between slices, and a holder that lost the move. ----

/** Run a sliced move until its first pending answer; returns the clock and the moves log. */
async function firstSlice(w, count) {
  seedMany(w, count);
  let t = 0;
  watchCopies(w.two.store, () => { t += 10; });
  const moves = bucketStore(w.bucket, 'state-moves');
  const first = await moveCard({ from: w.one, to: w.two, id: 'deck', moves, now, clock: () => t, budgetMs: 500 });
  assert.equal(first.pending, true);
  return { moves, clock: () => t };
}
const inTarget = w => [...w.fake.objects.keys()].filter(key => key.startsWith('sections/two/2026-10-29_deck/many/'));

test('a file deleted from the source between slices does not block the move, and does not reach the target', async () => {
  const w = await bucketWorld();
  try {
    const { moves, clock } = await firstSlice(w, 300);
    const copiedKey = inTarget(w)[0];
    const lateKey = [...w.fake.objects.keys()].filter(key => key.startsWith('sections/one/2026-10-29_deck/many/')).map(key => key.replace('sections/one/', 'sections/two/')).find(key => !w.fake.objects.has(key));
    assert.ok(copiedKey && lateKey);
    w.fake.objects.delete(copiedKey.replace('sections/two/', 'sections/one/'));
    w.fake.objects.delete(lateKey.replace('sections/two/', 'sections/one/'));
    let answer;
    for (let n = 0; n < 20 && (!answer || answer.pending); n += 1) answer = await moveCard({ from: w.one, to: w.two, id: 'deck', moves, now, clock, budgetMs: 500 });
    assert.equal(answer.pending, undefined);
    assert.equal(w.fake.objects.has(copiedKey), false, 'a file the source dropped after it was copied is gone from the target');
    assert.equal(w.fake.objects.has(lateKey), false);
    assert.equal(inTarget(w).length, 298);
    assert.deepEqual(w.list('two').entities.map(item => item.id), ['deck']);
  } finally { await w.close(); }
});

test('a file that is not this move\'s and has no source counterpart is still a 409 when no move is unfinished', async () => {
  const w = await bucketWorld();
  try {
    seedMany(w, 5);
    w.fake.seed('sections/two/2026-10-29_deck/stranger.txt', 'not ours', 'text/plain');
    await assert.rejects(moveCard({ from: w.one, to: w.two, id: 'deck', moves: bucketStore(w.bucket, 'state-moves'), now }), { status: 409 });
    assert.equal(w.fake.text('sections/two/2026-10-29_deck/stranger.txt'), 'not ours');
  } finally { await w.close(); }
});

test('a file changed in the source between slices is copied again', async () => {
  const w = await bucketWorld();
  try {
    const { moves, clock } = await firstSlice(w, 300);
    const copiedKey = inTarget(w)[0];
    w.fake.seed(copiedKey.replace('sections/two/', 'sections/one/'), 'changed between slices', 'text/plain');
    let answer;
    for (let n = 0; n < 20 && (!answer || answer.pending); n += 1) answer = await moveCard({ from: w.one, to: w.two, id: 'deck', moves, now, clock, budgetMs: 500 });
    assert.equal(answer.pending, undefined);
    assert.equal(w.fake.text(copiedKey), 'changed between slices');
    assert.equal(inTarget(w).length, 300);
  } finally { await w.close(); }
});

test('a stalled holder that wakes after a takeover cannot switch the card over, and its next ask succeeds', async () => {
  const w = await bucketWorld();
  try {
    seedMany(w, 40);
    const moves = bucketStore(w.bucket, 'state-moves');
    let t = 0;
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    let stalled = false;
    watchCopies(w.two.store, async () => { stalled = true; await gate; });
    // Holder A stops in every copy it has running (the hook holds every one until released; B copies through its own writer); its timer never fires (renewMs is huge), so its lease goes stale.
    const a = moveCard({ from: w.one, to: w.two, id: 'deck', moves, now, clock: () => t, renewMs: 2 ** 30, run: 'A' });
    while (!stalled) await new Promise(resolve => setTimeout(resolve, 5));
    t = 200_000;
    const b = await moveCard({ from: w.one, to: cardWriter(bucketStore(w.bucket, 'sections/two'), { section: 'two', now }), id: 'deck', moves, now, clock: () => t, renewMs: 2 ** 30, run: 'B' });
    assert.equal(b.pending, undefined, 'B took over and finished');
    release();
    const woke = await a;
    assert.deepEqual([woke.pending, woke.busy], [true, true], 'A answers busy, not an error');
    assert.deepEqual(w.list('two').entities.map(item => item.id), ['deck'], 'the card was adopted once');
    const again = await moveCard({ from: w.one, to: w.two, id: 'deck', moves, now, clock: () => t, run: 'A' });
    assert.equal(again.pending, undefined);
    assert.equal(again.card.id, 'deck');
  } finally { await w.close(); }
});

test('the lease is renewed on a timer while a slow copy runs', async () => {
  const w = await bucketWorld();
  try {
    seedMany(w, 3);
    const moves = bucketStore(w.bucket, 'state-moves');
    let t = 0;
    let seenLease = 0;
    watchCopies(w.two.store, async () => {
      t = 50_000;
      // Wait for the timer's write to land (the condition), however busy the PC is, instead of a fixed pause.
      for (const end = Date.now() + 30_000; Date.now() < end;) {
        seenLease = Math.max(seenLease, w.fake.json('state-moves/one--deck.json').lease);
        if (seenLease === 50_000) break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    });
    await moveCard({ from: w.one, to: w.two, id: 'deck', moves, now, clock: () => t, renewMs: 10 });
    assert.equal(seenLease, 50_000, 'the lease moved forward while the copy was still running');
  } finally { await w.close(); }
});

test('on folders a file the source dropped between slices does not stay in the target folder', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'buw-move-'));
  const make = async (name, entities) => {
    const dir = path.join(root, name);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'workspace.json'), JSON.stringify({ name, entities }));
    return dir;
  };
  const a = await make('a', [entity('deck')]);
  const b = await make('b', []);
  await mkdir(path.join(a, '2026-10-29_deck', 'many'), { recursive: true });
  for (let n = 0; n < 60; n += 1) await writeFile(path.join(a, '2026-10-29_deck', 'many', `${String(n).padStart(2, '0')}.txt`), `file ${n}`);
  const from = cardWriter(folderStore(a), { section: 'a', now });
  const to = cardWriter(folderStore(b), { section: 'b', now });
  const moves = memoryMoveLog();
  let t = 0;
  const original = to.store.copyFrom.bind(to.store);
  to.store.copyFrom = async (...args) => { const result = await original(...args); t += 10; return result; };
  const first = await moveCard({ from, to, id: 'deck', moves, now, clock: () => t, budgetMs: 100, concurrency: 1 });
  assert.equal(first.pending, true);
  const copied = (await readdir(path.join(b, '2026-10-29_deck', 'many'))).sort();
  assert.ok(copied.length > 0 && copied.length < 60);
  await rm(path.join(a, '2026-10-29_deck', 'many', copied[0]));
  let answer;
  for (let n = 0; n < 30 && (!answer || answer.pending); n += 1) answer = await moveCard({ from, to, id: 'deck', moves, now, clock: () => t, budgetMs: 100, concurrency: 1 });
  assert.equal(answer.pending, undefined);
  const after = await readdir(path.join(b, '2026-10-29_deck', 'many'));
  assert.equal(after.length, 59);
  assert.ok(!after.includes(copied[0]), 'the dropped file is gone from the target folder');
  // The folder store still never empties the Trash.
  assert.equal(to.store.purges, undefined);
});
