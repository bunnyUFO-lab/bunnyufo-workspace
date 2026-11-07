// The one-time purpose backfill, against the stand-in S3. Every id and section below is made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createBucket } from '../site/api/s3.mjs';
import { startFakeS3 } from '../site/api/test/fake-s3.mjs';
import { applySection, chooseBucket, classify, listMarkdown, parseArgs, plan, run, survey } from './backfill-card-purpose.mjs';

const NOW = new Date('2026-11-07T12:00:00Z');
const OLD = '2026-10-20';
const entry = (id, extra = {}) => ({
  id, folder: id, title: `Title of ${id}`, description: 'A card.', category: 'test', type: 'standalone',
  created: OLD, updated: OLD, status: 'active', steps: [{ name: 'Page', path: 'index.md' }], ...extra,
});
const stripped = list => ({ ...list, entities: list.entities.map(({ purpose, ...rest }) => rest) });

async function world(sections, state = { version: 1, cards: {} }) {
  const fake = await startFakeS3();
  const bucket = createBucket({ bucket: fake.bucket, endpoint: fake.endpoint, credentials: fake.credentials, region: 'us-east-1' });
  for (const [id, entities] of Object.entries(sections)) {
    fake.seed(`sections/${id}/workspace.json`, `${JSON.stringify({ name: id, entities }, null, 2)}\n`, 'application/json');
  }
  if (state) fake.seed('state.json', JSON.stringify(state), 'application/json');
  const writes = () => fake.log.filter(item => item.method === 'PUT').map(item => item.key);
  return { fake, bucket, writes, list: id => fake.json(`sections/${id}/workspace.json`), close: () => fake.close() };
}

const FIXTURE = () => ({
  'agent-plans': [entry('plan-one'), entry('plan-guide', { steps: [{ name: 'The guide', path: 'a.md' }] }), entry('howto-card', { steps: [{ name: 'How-to', path: 'a.md' }] })],
  'assistant': [entry('brief-a'), entry('spend-2026-10-01'), entry('notes-2026-10-02', { steps: [{ name: 'Research notes', path: 'a.md' }] }), entry('plain')],
  'studio-box': [entry('thing-qa'), entry('thing-qa-wizard'), entry('sprint-qa-fixes-and-more'), entry('other')],
  'dev-copy': [entry('brief-dev')],
  'inbox-dev': [entry('brief-inbox')],
});

test('classify: the four rules in order, and what they miss', () => {
  assert.equal(classify('x', entry('brief-anything')), 'id starts with brief-');
  assert.equal(classify('agent-plans', entry('some-plan')), 'plan card in agent-plans');
  assert.equal(classify('agent-plans', entry('some-plan', { steps: [{ name: 'Setup how-to' }] })), null, 'a guide tab keeps a plan card');
  assert.equal(classify('agent-plans', entry('some-plan', { steps: [{ name: 'GUIDE' }] })), null);
  assert.equal(classify('agent-plans', entry('brief-x', { steps: [{ name: 'Guide' }] })), 'id starts with brief-', 'rule 1 comes first');
  for (const id of ['qa', 'thing-qa', 'thing-qa-wizard', 'thing-qa-9']) assert.equal(classify('x', entry(id)), 'QA report', id);
  for (const id of ['sprint-qa-fixes-and-more', 'qatar', 'thing-qa-two-words', 'aqa']) assert.equal(classify('x', entry(id)), null, id);
  assert.equal(classify('assistant', entry('digest-2026-09-14')), 'dated card in assistant');
  assert.equal(classify('assistant', entry('digest-2026-09-14', { steps: [{ name: 'Research' }] })), null);
  assert.equal(classify('assistant', entry('no-date-here')), null);
  assert.equal(classify('other', entry('digest-2026-09-14')), null, 'only in assistant');
  assert.equal(classify('x', entry('plain')), null);
});

test('plan: pinned, sample and already-marked cards are skipped; a hand-archived card is not', () => {
  const entities = [entry('brief-a'), entry('brief-pinned', { pinned: true }), entry('brief-sample', { sample: true }), entry('brief-set', { purpose: 'reference' }),
    entry('brief-state', {}), entry('brief-unpinned', { pinned: true }), entry('brief-gone', { status: 'archived' })];
  const state = { 'x/brief-state': { purpose: 'reference' }, 'x/brief-unpinned': { pinned: false } };
  assert.deepEqual(plan('x', entities, state, NOW).map(item => item.card.id), ['brief-a', 'brief-unpinned', 'brief-gone']);
  assert.deepEqual(plan('x', [entry('brief-p')], { 'x/brief-p': { pinned: true } }, NOW), [], 'pinned in state');
});

test('plan: what marking does today', () => {
  const effect = extra => plan('x', [entry('brief-a', extra)], {}, NOW)[0].effect;
  assert.equal(effect({}), 'goes to the Archive now');
  assert.equal(effect({ created: '2026-11-05', updated: '2026-11-05' }), 'goes to the Archive on 2026-11-13');
  assert.equal(effect({ status: 'archived' }), 'none: archived by hand');
  assert.equal(effect({ status: 'done' }), 'none: done and old, already in the Archive');
});

test('a dry run reads the real lists, writes nothing and counts by section', async () => {
  const w = await world(FIXTURE());
  const lines = [];
  try {
    const { sections, applied } = await run({ bucket: w.bucket, now: NOW, log: line => lines.push(line) });
    assert.deepEqual(applied, []);
    assert.deepEqual(w.writes(), [], 'the fake S3 logs no PUT');
    assert.deepEqual(sections.map(item => [item.id, item.found.length]), [['agent-plans', 1], ['assistant', 2], ['studio-box', 2]]);
    assert.ok(lines.some(line => /assistant: 2 of 4 cards would be marked/.test(line)));
    assert.ok(lines.some(line => /total: 5 of 11 cards/.test(line)), 'dev-, inbox sections are not looked at');
    assert.ok(lines.some(line => /dry run: nothing was written/.test(line)));
  } finally { await w.close(); }
});

test('--out writes the list by section with reason, status, date and effect', async () => {
  const w = await world(FIXTURE());
  const dir = await mkdtemp(path.join(os.tmpdir(), 'purpose-list-'));
  try {
    const out = path.join(dir, 'list.md');
    await run({ bucket: w.bucket, now: NOW, out, log: () => {} });
    const text = await readFile(out, 'utf8');
    assert.match(text, /## assistant \(2 of 4\)/);
    assert.ok(text.includes('| brief-a | Title of brief-a | id starts with brief- | active | 2026-10-20 | goes to the Archive now |'), text);
    assert.doesNotMatch(text, /dev-copy|inbox-dev|plain/);
    assert.equal(text, listMarkdown(await survey(w.bucket, NOW), NOW));
    assert.deepEqual(w.writes(), []);
  } finally { await w.close(); await rm(dir, { recursive: true, force: true }); }
});

test('--apply adds only purpose, keeps everything else, never writes state.json, and a second run marks nothing', async () => {
  const state = { version: 1, cards: { 'assistant/plain': { pinned: true }, 'assistant/brief-a': { tags: ['mine'] } } };
  const w = await world(FIXTURE(), state);
  const before = Object.fromEntries(['agent-plans', 'assistant', 'studio-box', 'dev-copy', 'inbox-dev'].map(id => [id, w.list(id)]));
  const stateBefore = w.fake.objects.get('state.json').body.toString();
  const lines = [];
  try {
    const { applied } = await run({ bucket: w.bucket, apply: true, now: NOW, log: line => lines.push(line) });
    assert.deepEqual(applied.map(item => [item.id, item.marked.length]), [['agent-plans', 1], ['assistant', 2], ['studio-box', 2]]);
    for (const item of applied) assert.ok(item.versionId, `${item.id} has a new version id`);
    assert.ok(lines.some(line => /agent-plans: marked 1, new version /.test(line)));
    assert.deepEqual(w.writes().sort(), ['sections/agent-plans/workspace.json', 'sections/assistant/workspace.json', 'sections/studio-box/workspace.json']);
    assert.ok(!w.writes().includes('state.json'), 'state.json is never written');
    assert.ok(!w.writes().some(key => /sections\/(dev-copy|inbox-dev)\//.test(key)), 'dev- and inbox sections are not touched');
    assert.equal(w.fake.objects.get('state.json').body.toString(), stateBefore);
    for (const id of ['agent-plans', 'assistant', 'studio-box']) assert.deepEqual(stripped(w.list(id)), stripped(before[id]), `${id}: nothing but purpose changed`);
    for (const id of ['dev-copy', 'inbox-dev']) assert.deepEqual(w.list(id), before[id]);
    const marked = Object.fromEntries(Object.keys(before).flatMap(id => w.list(id).entities.filter(item => item.purpose).map(item => [item.id, item.purpose])));
    assert.deepEqual(marked, { 'plan-one': 'report', 'brief-a': 'report', 'spend-2026-10-01': 'report', 'thing-qa': 'report', 'thing-qa-wizard': 'report' });
    assert.equal(w.list('assistant').entities.find(item => item.id === 'brief-a').updated, OLD, 'updated is not touched');

    const putsBefore = w.writes().length;
    const again = await run({ bucket: w.bucket, apply: true, now: NOW, log: () => {} });
    assert.deepEqual(again.applied, []);
    assert.equal(w.writes().length, putsBefore, 'a second run writes nothing');
    assert.ok(again.sections.every(section => section.found.length === 0));
  } finally { await w.close(); }
});

test('a lost race is read again and decided again; a card pinned meanwhile is skipped', async () => {
  const w = await world({ 'assistant': [entry('brief-a'), entry('brief-b'), entry('plain')] });
  try {
    const original = w.bucket.put.bind(w.bucket);
    let raced = 0;
    w.bucket.put = async (key, body, options) => {
      if (key === 'sections/assistant/workspace.json' && raced < 2) {
        raced += 1;
        // Another writer lands first: a new card the second time, and a pin on brief-b the first.
        const current = await w.bucket.getJson(key);
        const next = { ...current.value, entities: [...current.value.entities.map(item => (item.id === 'brief-b' && raced === 1 ? { ...item, pinned: true } : item)), ...(raced === 2 ? [entry('brief-c')] : [])] };
        await original(key, `${JSON.stringify(next, null, 2)}\n`, { contentType: 'application/json', ifMatch: current.etag });
      }
      return original(key, body, options);
    };
    const result = await applySection(w.bucket, 'assistant', NOW);
    assert.equal(raced, 2, 'it lost twice, then won');
    assert.deepEqual(result.marked.sort(), ['brief-a', 'brief-c'], 'brief-b was pinned meanwhile and is skipped');
    const list = w.list('assistant');
    assert.deepEqual(list.entities.map(item => [item.id, item.purpose, item.pinned]), [['brief-a', 'report', undefined], ['brief-b', undefined, true], ['plain', undefined, undefined], ['brief-c', 'report', undefined]]);
  } finally { await w.close(); }
});

test('five lost races in a row stop with the error, and a section with nothing to mark is not written', async () => {
  const w = await world({ 'assistant': [entry('brief-a')], 'quiet-box': [entry('plain')] });
  try {
    w.bucket.put = async () => { throw Object.assign(new Error('precondition'), { status: 412 }); };
    let reads = 0;
    const get = w.bucket.getJson.bind(w.bucket);
    w.bucket.getJson = async key => { if (key === 'sections/assistant/workspace.json') reads += 1; return get(key); };
    await assert.rejects(applySection(w.bucket, 'assistant', NOW), { status: 412 });
    assert.equal(reads, 5);
    assert.deepEqual(await applySection(w.bucket, 'quiet-box', NOW), { marked: [], versionId: null });
  } finally { await w.close(); }
});

test('a hand-archived card is marked too, and the state is read fresh each time', async () => {
  const w = await world({ 'assistant': [entry('brief-a')] }, { version: 1, cards: { 'assistant/brief-a': { status: 'archived' } } });
  try {
    assert.equal((await run({ bucket: w.bucket, apply: true, now: NOW, log: () => {} })).applied[0].marked[0], 'brief-a');
    assert.equal(w.list('assistant').entities[0].purpose, 'report');
    assert.equal(w.list('assistant').entities[0].status, 'active', 'the entry’s status is untouched; state holds the archive');
  } finally { await w.close(); }
});

test('the bucket comes from BUW_S3_BUCKET, else the registry, and the options are strict', async () => {
  const credentials = { accessKeyId: 'a', secretAccessKey: 'b' };
  const env = name => ({ BUW_S3_BUCKET: name });
  assert.ok(await chooseBucket({ env: env('some-bucket'), bucketOptions: { credentials, endpoint: 'http://127.0.0.1:1' } }));
  await assert.rejects(chooseBucket({ env: {}, registryFile: path.join(os.tmpdir(), 'no-such-registry.json'), bucketOptions: { credentials } }), /No bucket/);
  assert.deepEqual(parseArgs([]), { apply: false, out: null });
  assert.deepEqual(parseArgs(['--apply', '--out', 'x.md']), { apply: true, out: 'x.md' });
  assert.throws(() => parseArgs(['--now']), /Unknown option/);
  assert.throws(() => parseArgs(['--out']), /needs a file/);
});

test('the list shows the status as the Library sees it, with the state laid over the entry', () => {
  const found = plan('x', [entry('brief-a')], { 'x/brief-a': { status: 'archived' } }, NOW);
  assert.equal(found[0].status, 'archived');
  assert.equal(found[0].effect, 'none: archived by hand');
  assert.ok(listMarkdown([{ id: 'x', cards: 1, found }], NOW).includes('| id starts with brief- | archived |'));
});
