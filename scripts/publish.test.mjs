import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bucketFor, exitCodeFor, publish, publishAll } from './publish.mjs';
import { defaultScope, mergeCardList, safeKey, syncDown, syncUp } from './shared/s3-sync.mjs';
import { startFakeS3 } from '../site/api/test/fake-s3.mjs';
import { createHash } from 'node:crypto';
import { createCardApi, parseTokens } from '../site/card-api/handler.mjs';
import { createCardWrites } from '../site/api/hub-card-writes.mjs';
import { inboxKey } from '../site/api/hub.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** A workspace folder like a real one — card list, a card, Jekyll scaffolding — registered against a fake bucket. */
async function workspace(fake, { id = 'my-workspace' } = {}) {
  await mkdir(path.join(root, '.cache'), { recursive: true });
  const base = await mkdtemp(path.join(root, '.cache', 'publish-test-'));
  const site = path.join(base, id);
  await mkdir(path.join(site, 'hub'), { recursive: true });
  await mkdir(path.join(site, '_shared'), { recursive: true });
  await writeFile(path.join(site, 'workspace.json'), JSON.stringify({ name: 'Mine', entities: [{ id: 'hub', title: 'Hub', category: 'game', folder: 'hub', updated: '2026-10-07', steps: [{ name: 'Overview', path: 'index.md' }], status: 'active' }] }, null, 2));
  await writeFile(path.join(site, '_config.yml'), 'title: Test\n');
  await writeFile(path.join(site, 'Gemfile'), 'source "https://rubygems.org"\n');
  await writeFile(path.join(site, '_shared', 'report.css'), 'body{}\n');
  await writeFile(path.join(site, 'hub', 'index.md'), '# Hub\n');
  const registryFile = path.join(base, 'workspaces.json');
  const entry = { id, name: 'Mine', path: site.split(path.sep).join('/'), bucket: `s3://${fake.bucket}/sections/${id}` };
  await writeFile(registryFile, JSON.stringify({ version: 1, active: id, workspaces: [entry] }, null, 2));
  const bucketOptions = { endpoint: fake.endpoint, credentials: fake.credentials, region: 'us-east-1' };
  return { base, site, registryFile, entry, bucketOptions };
}

test('publish uploads the cards, the card list and _shared, never the Jekyll scaffolding', async () => {
  const fake = await startFakeS3();
  try {
    const { site, registryFile, bucketOptions } = await workspace(fake);
    const lines = [];
    const dry = await publish({ content: site, registryFile, bucketOptions, dryRun: true, log: line => lines.push(line) });
    assert.equal(dry.published, false);
    assert.equal(fake.objects.size, 0, 'A dry run uploads nothing.');
    assert.match(lines.join('\n'), /3 file\(s\) to upload/);

    const result = await publish({ content: site, registryFile, bucketOptions, log: line => lines.push(line) });
    assert.equal(result.published, true);
    assert.deepEqual([...fake.objects.keys()].sort(), ['sections/my-workspace/_shared/report.css', 'sections/my-workspace/hub/index.md', 'sections/my-workspace/workspace.json']);
    assert.equal(fake.objects.get('sections/my-workspace/hub/index.md').contentType, 'text/markdown; charset=utf-8');
    assert.equal(fake.text('sections/my-workspace/hub/index.md'), '# Hub\n');

    const again = await publish({ content: site, registryFile, bucketOptions, log: () => {} });
    assert.equal(again.published, false, 'Nothing new to publish.');
    assert.equal(again.unchanged, 3);
  } finally { await fake.close(); }
});

test('.cards-base.json is never published, at the root or inside a card folder', async () => {
  const fake = await startFakeS3();
  try {
    const { site, registryFile, bucketOptions } = await workspace(fake);
    await writeFile(path.join(site, '.cards-base.json'), '{}');
    await mkdir(path.join(site, 'hub', 'media'), { recursive: true });
    await writeFile(path.join(site, 'hub', '.cards-base.json'), '{}');
    await writeFile(path.join(site, 'hub', 'media', '.cards-base.json'), '{}');
    await publish({ content: site, registryFile, bucketOptions, log: () => {} });
    assert.deepEqual([...fake.objects.keys()].filter(key => key.includes('cards-base')), []);
    assert.ok(fake.objects.has('sections/my-workspace/hub/index.md'));
  } finally { await fake.close(); }
});

test('publish refuses the starter examples, a workspace without a bucket and likely secrets', async () => {
  const fake = await startFakeS3();
  try {
    const { site, registryFile, bucketOptions, base, entry } = await workspace(fake);
    await assert.rejects(publish({ content: 'template', registryFile, bucketOptions, log: () => {} }), /starter examples/);
    await writeFile(path.join(site, 'hub', 'secret-token.json'), '{}');
    await assert.rejects(publish({ content: site, registryFile, bucketOptions, log: () => {} }), /secret-token\.json: looks like a secret/);
    await rm(path.join(site, 'hub', 'secret-token.json'));
    const bare = path.join(base, 'registry-no-bucket.json');
    await writeFile(bare, JSON.stringify({ version: 1, active: entry.id, workspaces: [{ ...entry, bucket: undefined }] }));
    await assert.rejects(publish({ content: site, registryFile: bare, bucketOptions, env: {}, log: () => {} }), /has no bucket/);
  } finally { await fake.close(); }
});

test('a bucket under sections/inbox or sections/assistant is never published to', () => {
  for (const id of ['inbox', 'assistant']) {
    assert.throws(() => bucketFor({ id: 'x', bucket: `s3://b/sections/${id}` }), /never a local workspace/);
    assert.throws(() => bucketFor({ id: 'x', bucket: `s3://b/sections/${id}/` }), /never a local workspace/);
  }
  assert.throws(() => bucketFor({ id: 'inbox' }, { env: { BUW_S3_BUCKET: 'b' } }), /never a local workspace/);
  assert.equal(bucketFor({ id: 'x', bucket: 's3://b/sections/x' }).prefix, 'sections/x');
});

test('publish touches only what it owns: a named card, never a stray file or another card', async () => {
  const fake = await startFakeS3();
  try {
    const { site, registryFile, bucketOptions } = await workspace(fake);
    await writeFile(path.join(site, 'hub', 'stale.md'), 'about to be removed\n');
    await publish({ content: site, registryFile, bucketOptions, log: () => {} });
    // Removed here after it was published: the next publish removes it from the bucket too.
    await rm(path.join(site, 'hub', 'stale.md'));

    await mkdir(path.join(site, 'notes'), { recursive: true });
    await writeFile(path.join(site, 'notes', 'index.md'), '# Notes\n');
    const registry = JSON.parse(await readFile(path.join(site, 'workspace.json'), 'utf8'));
    registry.entities.push({ id: 'notes', title: 'Notes', category: 'game', folder: 'notes', updated: '2026-10-08', steps: [{ name: 'Overview', path: 'index.md' }], status: 'active' });
    await writeFile(path.join(site, 'workspace.json'), JSON.stringify(registry, null, 2));
    await writeFile(path.join(site, 'hub', 'index.md'), '# Hub, edited\n');
    await writeFile(path.join(site, 'hub', 'old.png'), 'png');
    await writeFile(path.join(site, 'scratch.txt'), 'not part of any card\n');
    fake.seed('sections/my-workspace/elsewhere/keep.md', 'another agent is mid-publish');

    const result = await publish({ content: site, registryFile, bucketOptions, cards: ['hub'], log: () => {} });
    assert.equal(result.published, true);
    assert.deepEqual(result.uploads.sort(), ['hub/index.md', 'hub/old.png', 'workspace.json']);
    assert.deepEqual(result.deletes, ['hub/stale.md'], 'A file removed from the card is removed from the bucket.');
    assert.equal(fake.text('sections/my-workspace/hub/index.md'), '# Hub, edited\n');
    assert.equal(fake.text('sections/my-workspace/elsewhere/keep.md'), 'another agent is mid-publish', 'Objects outside the scope are left alone.');
    assert.equal(fake.text('sections/my-workspace/scratch.txt'), null, 'a file outside every card is never swept in');
    assert.equal(fake.text('sections/my-workspace/notes/index.md'), null, "another session's card is left for its own publish");
    assert.equal(JSON.parse(fake.text('sections/my-workspace/workspace.json')).entities.length, 2, 'The card list goes with the named card.');
  } finally { await fake.close(); }
});

test('card responses in the bucket survive every kind of publish, and a local card-responses folder is never uploaded', async () => {
  const fake = await startFakeS3();
  try {
    const { site, registryFile, bucketOptions } = await workspace(fake);
    const key = 'sections/my-workspace/card-responses/hub/listen-v2.json';
    fake.seed(key, '{"version":1,"items":{}}', 'application/json');
    await publish({ content: site, registryFile, bucketOptions, log: () => {} });
    assert.equal(fake.text(key), '{"version":1,"items":{}}', 'a whole-workspace publish keeps the responses');
    await writeFile(path.join(site, 'hub', 'index.md'), '# Hub, edited\n');
    const named = await publish({ content: site, registryFile, bucketOptions, cards: ['hub'], log: () => {} });
    assert.deepEqual(named.deletes, []);
    assert.equal(fake.text(key), '{"version":1,"items":{}}', 'a named-card publish keeps them too');

    // Even a card folder (or a local copy) with that name cannot be uploaded, deleted or pulled.
    await mkdir(path.join(site, 'card-responses', 'hub'), { recursive: true });
    await writeFile(path.join(site, 'card-responses', 'hub', 'listen-v2.json'), '{"stale":true}');
    await writeFile(path.join(site, 'card-responses', 'hub', 'other.json'), '{}');
    const registry = JSON.parse(await readFile(path.join(site, 'workspace.json'), 'utf8'));
    registry.entities.push({ id: 'card-responses', title: 'Clash', category: 'game', folder: 'card-responses', updated: '2026-10-08', steps: [], status: 'active' });
    await writeFile(path.join(site, 'workspace.json'), JSON.stringify(registry, null, 2));
    const clash = await publish({ content: site, registryFile, bucketOptions, log: () => {} });
    assert.ok(!clash.uploads.some(file => file.startsWith('card-responses/')));
    assert.equal(fake.text(key), '{"version":1,"items":{}}');
    assert.equal(fake.text('sections/my-workspace/card-responses/hub/other.json'), null);
    const pulled = await publish({ content: site, registryFile, bucketOptions, pull: true, force: true, log: () => {} });
    assert.ok(!(pulled.written ?? []).some(file => file.startsWith('card-responses/')));
    assert.equal(await readFile(path.join(site, 'card-responses', 'hub', 'listen-v2.json'), 'utf8'), '{"stale":true}', 'pull leaves the folder alone');
  } finally { await fake.close(); }
});

test('publish says so when a named card has no changes', async () => {
  const fake = await startFakeS3();
  try {
    const { site, registryFile, bucketOptions } = await workspace(fake);
    await publish({ content: site, registryFile, bucketOptions, log: () => {} });
    await assert.rejects(publish({ content: site, registryFile, bucketOptions, cards: ['hub'], log: () => {} }), /nothing changed in hub/);
  } finally { await fake.close(); }
});

test('pull fetches what the bucket has and this folder lacks, and leaves a differing file alone', async () => {
  const fake = await startFakeS3();
  try {
    const { site, registryFile, bucketOptions } = await workspace(fake);
    await publish({ content: site, registryFile, bucketOptions, log: () => {} });
    // Made on the phone: a card list with a new card, and its page.
    const list = JSON.parse(fake.text('sections/my-workspace/workspace.json'));
    list.entities.push({ id: 'phone', title: 'From the phone', category: 'game', folder: 'phone', updated: '2026-10-11', steps: [{ name: 'Page', path: 'index.md' }], status: 'active' });
    fake.seed('sections/my-workspace/workspace.json', JSON.stringify(list), 'application/json');
    fake.seed('sections/my-workspace/phone/index.md', '# From the phone\n');
    // And edited here meanwhile: the local list differs from both.
    await writeFile(path.join(site, 'hub', 'index.md'), '# Hub, edited here\n');

    const lines = [];
    const result = await publish({ content: site, registryFile, bucketOptions, pull: true, log: line => lines.push(line) });
    assert.equal(result.pulled, true);
    assert.deepEqual(result.written, ['phone/index.md'], 'The new card comes down.');
    assert.equal(await readFile(path.join(site, 'phone', 'index.md'), 'utf8'), '# From the phone\n');
    assert.deepEqual(result.differs.sort(), ['hub/index.md', 'workspace.json'], 'The list differs on both sides, so it is reported, not overwritten.');
    assert.equal(await readFile(path.join(site, 'hub', 'index.md'), 'utf8'), '# Hub, edited here\n', 'A local edit is never overwritten without --force.');
    assert.match(lines.join('\n'), /left alone, different here: hub\/index.md/);
    // The pulled list names 'phone', so a scope read after the pull includes the new card.
    const forced = await publish({ content: site, registryFile, bucketOptions, pull: true, force: true, log: () => {} });
    assert.deepEqual(forced.written.sort(), ['hub/index.md', 'workspace.json']);
    assert.equal(await readFile(path.join(site, 'hub', 'index.md'), 'utf8'), '# Hub\n');
  } finally { await fake.close(); }
});

test('a named card picks the workspace that holds it, not the active one', async () => {
  const fake = await startFakeS3();
  try {
    const active = await workspace(fake, { id: 'active' });
    const other = await workspace(fake, { id: 'other' });
    // The card being published lives in the workspace nobody has selected.
    await rename(path.join(other.site, 'hub'), path.join(other.site, 'notes'));
    await writeFile(path.join(other.site, 'workspace.json'), JSON.stringify({ name: 'Other', entities: [{ id: 'notes', title: 'Notes', category: 'game', folder: 'notes', updated: '2026-10-11', steps: [{ name: 'Overview', path: 'index.md' }], status: 'active' }] }, null, 2));
    const registryFile = active.registryFile;
    await writeFile(registryFile, JSON.stringify({ version: 1, active: 'active', workspaces: [active.entry, other.entry] }, null, 2));
    const options = { registryFile, bucketOptions: active.bucketOptions, env: {}, log: () => {} };

    const result = await publish({ ...options, cards: ['notes'] });
    assert.equal(result.published, true);
    assert.equal(result.workspace.id, 'other', 'the card chose its own workspace');
    assert.deepEqual([...fake.objects.keys()].sort(), ['sections/other/notes/index.md', 'sections/other/workspace.json']);

    // A card in the active workspace still publishes from there, and --content still wins.
    await publish({ ...options, cards: ['hub'] });
    assert.equal(fake.text('sections/active/hub/index.md'), '# Hub\n');

    // One name no workspace claims falls back to the active one, and says nothing changed there.
    await assert.rejects(publish({ ...options, cards: ['nobody'] }), /nothing changed in nobody/);

    await writeFile(path.join(active.site, 'hub', 'index.md'), '# Hub again\n');
    await writeFile(path.join(other.site, 'notes', 'index.md'), '# Notes again\n');
    await assert.rejects(publish({ ...options, cards: ['hub', 'notes'] }), /different workspaces/);
  } finally { await fake.close(); }
});

test('publish --all walks every registered workspace, and one failure does not stop the rest', async () => {
  const fake = await startFakeS3();
  try {
    const first = await workspace(fake, { id: 'first' });
    const second = await workspace(fake, { id: 'second' });
    // Registered, but pointing at no bucket: the one workspace that cannot publish.
    const broken = await workspace(fake, { id: 'broken' });
    const registryFile = first.registryFile;
    await writeFile(registryFile, JSON.stringify({
      version: 1, active: 'first', workspaces: [first.entry, { ...broken.entry, bucket: undefined }, second.entry],
    }, null, 2));
    const bucketOptions = first.bucketOptions;

    const lines = [];
    const dry = await publishAll({ registryFile, bucketOptions, dryRun: true, log: line => lines.push(line) });
    assert.equal(dry.results.length, 3, 'every registered workspace is visited, the active one included');
    assert.equal(fake.objects.size, 0, 'a dry run uploads nothing');
    assert.match(lines.join('\n'), /Mine: would publish/);
    lines.length = 0;

    const { results, failed } = await publishAll({ registryFile, bucketOptions, log: line => lines.push(line) });
    assert.deepEqual(results.map(r => r.published), [true, false, true], 'the workspace after the broken one still publishes');
    assert.equal(failed.length, 1);
    assert.match(failed[0].error.message, /has no bucket/);
    assert.equal(fake.text('sections/first/hub/index.md'), '# Hub\n');
    assert.equal(fake.text('sections/second/hub/index.md'), '# Hub\n');
    assert.match(lines.join('\n'), /needs a hand/);
  } finally { await fake.close(); }
});

test('a card made and a section edited on the site come down with the next publish instead of being written over', async () => {
  const fake = await startFakeS3();
  try {
    const { site, registryFile, bucketOptions } = await workspace(fake);
    await publish({ content: site, registryFile, bucketOptions, log: () => {} });

    // On the site: a new card, and the hub's page edited.
    const list = fake.json('sections/my-workspace/workspace.json');
    list.entities.push({ id: 'phone', title: 'Phone', folder: '2026-10-23_phone', steps: [{ name: 'Overview', path: 'index.md' }] });
    fake.seed('sections/my-workspace/workspace.json', JSON.stringify(list, null, 2), 'application/json');
    fake.seed('sections/my-workspace/2026-10-23_phone/index.md', '# Phone\n', 'text/markdown');
    fake.seed('sections/my-workspace/hub/index.md', '# Hub, from the phone\n', 'text/markdown');
    // Here, meanwhile: a card of this folder's own.
    await mkdir(path.join(site, 'desk'), { recursive: true });
    await writeFile(path.join(site, 'desk', 'index.md'), '# Desk\n');
    const local = JSON.parse(await readFile(path.join(site, 'workspace.json'), 'utf8'));
    local.entities.push({ id: 'desk', title: 'Desk', folder: 'desk', steps: [{ name: 'Overview', path: 'index.md' }] });
    await writeFile(path.join(site, 'workspace.json'), JSON.stringify(local, null, 2));

    const result = await publish({ content: site, registryFile, bucketOptions, log: () => {} });
    assert.deepEqual(result.downloads.sort(), ['2026-10-23_phone/index.md', 'hub/index.md']);
    assert.equal(await readFile(path.join(site, 'hub', 'index.md'), 'utf8'), '# Hub, from the phone\n', 'The site\'s edit came down.');
    assert.equal(fake.text('sections/my-workspace/hub/index.md'), '# Hub, from the phone\n', 'and was not written over.');
    const ids = list => list.entities.map(item => item.id).sort();
    assert.deepEqual(ids(fake.json('sections/my-workspace/workspace.json')), ['desk', 'hub', 'phone'], 'Both new cards are in the published list.');
    assert.deepEqual(ids(JSON.parse(await readFile(path.join(site, 'workspace.json'), 'utf8'))), ['desk', 'hub', 'phone']);
    assert.equal(fake.text('sections/my-workspace/desk/index.md'), '# Desk\n');
  } finally { await fake.close(); }
});

test('a page changed both here and on the site is left alone and reported, until --force', async () => {
  const fake = await startFakeS3();
  try {
    const { site, registryFile, bucketOptions } = await workspace(fake);
    await publish({ content: site, registryFile, bucketOptions, log: () => {} });
    fake.seed('sections/my-workspace/hub/index.md', '# Hub, phone\n', 'text/markdown');
    await writeFile(path.join(site, 'hub', 'index.md'), '# Hub, desk\n');
    const lines = [];
    const result = await publish({ content: site, registryFile, bucketOptions, log: line => lines.push(line) });
    assert.deepEqual(result.conflicts, ['hub/index.md']);
    assert.equal(fake.text('sections/my-workspace/hub/index.md'), '# Hub, phone\n');
    assert.equal(await readFile(path.join(site, 'hub', 'index.md'), 'utf8'), '# Hub, desk\n');
    assert.match(lines.join('\n'), /changed here and on the site/);
    await publish({ content: site, registryFile, bucketOptions, force: true, log: () => {} });
    assert.equal(fake.text('sections/my-workspace/hub/index.md'), '# Hub, desk\n');
  } finally { await fake.close(); }
});

/** Publish, then remove `count` of the hub's extra files from disk, as a lost checkout would. */
async function publishThenLose(fake, count) {
  const { site, registryFile, bucketOptions } = await workspace(fake);
  const names = Array.from({ length: 6 }, (_, index) => `page-${index + 1}.md`);
  for (const name of names) await writeFile(path.join(site, 'hub', name), `# ${name}\n`);
  await publish({ content: site, registryFile, bucketOptions, log: () => {} });
  const lost = names.slice(0, count);
  for (const name of lost) await rm(path.join(site, 'hub', name));
  return { site, registryFile, bucketOptions, lost: lost.map(name => `sections/my-workspace/hub/${name}`) };
}

test('a publish that would delete more than five files stops before writing anything', async () => {
  const fake = await startFakeS3();
  try {
    const { site, registryFile, bucketOptions, lost } = await publishThenLose(fake, 6);
    await writeFile(path.join(site, 'hub', 'index.md'), '# Hub, edited\n');
    await assert.rejects(publish({ content: site, registryFile, bucketOptions, log: () => {} }), /Nothing published: 6 files would be deleted .*--allow-deletes/s);
    for (const key of lost) assert.notEqual(fake.text(key), null, `${key} is still in the bucket`);
    assert.equal(fake.text('sections/my-workspace/hub/index.md'), '# Hub\n', 'not even the upload went through');
  } finally { await fake.close(); }
});

test('--allow-deletes lets the same publish through', async () => {
  const fake = await startFakeS3();
  try {
    const { site, registryFile, bucketOptions, lost } = await publishThenLose(fake, 6);
    const result = await publish({ content: site, registryFile, bucketOptions, allowDeletes: true, log: () => {} });
    assert.equal(result.deletes.length, 6);
    for (const key of lost) assert.equal(fake.text(key), null);
  } finally { await fake.close(); }
});

test('five deletes are within the limit', async () => {
  const fake = await startFakeS3();
  try {
    const { site, registryFile, bucketOptions, lost } = await publishThenLose(fake, 5);
    const result = await publish({ content: site, registryFile, bucketOptions, log: () => {} });
    assert.equal(result.deletes.length, 5);
    for (const key of lost) assert.equal(fake.text(key), null);
  } finally { await fake.close(); }
});

test('a dry run with six deletes warns and does not throw', async () => {
  const fake = await startFakeS3();
  try {
    const { site, registryFile, bucketOptions, lost } = await publishThenLose(fake, 6);
    const lines = [];
    const result = await publish({ content: site, registryFile, bucketOptions, dryRun: true, log: line => lines.push(line) });
    assert.equal(result.deletes.length, 6);
    assert.match(lines.join('\n'), /6 files would be deleted/);
    for (const key of lost) assert.notEqual(fake.text(key), null);
  } finally { await fake.close(); }
});

test('a workspace whose bucket is not under sections/<id> is refused', async () => {
  const fake = await startFakeS3();
  try {
    const { base, entry, site, bucketOptions } = await workspace(fake);
    for (const bucket of [`s3://${fake.bucket}/hub/my-workspace`, `s3://${fake.bucket}/sections`, `s3://${fake.bucket}`]) {
      const registryFile = path.join(base, 'odd.json');
      await writeFile(registryFile, JSON.stringify({ version: 1, active: entry.id, workspaces: [{ ...entry, bucket }] }));
      await assert.rejects(publish({ content: site, registryFile, bucketOptions, log: () => {} }), /Refusing to publish to s3:\/\/.*workspaces publish under sections\/<id>/);
    }
    assert.equal(fake.objects.size, 0);
  } finally { await fake.close(); }
});

const LIST = 'sections/my-workspace/workspace.json';
const step = (name, file) => ({ name, path: file });
const localList = async site => JSON.parse(await readFile(path.join(site, 'workspace.json'), 'utf8'));
const putLocal = (site, list) => writeFile(path.join(site, 'workspace.json'), JSON.stringify(list, null, 2));

/** A workspace with the hub plus cards `a` and `b`, published once. */
async function withCards(fake) {
  const made = await workspace(fake);
  for (const id of ['a', 'b']) {
    await mkdir(path.join(made.site, id), { recursive: true });
    await writeFile(path.join(made.site, id, 'index.md'), `# ${id}\n`);
  }
  const list = await localList(made.site);
  list.entities.push(
    { id: 'a', title: 'A', folder: 'a', steps: [step('Overview', 'index.md')] },
    { id: 'b', title: 'B', folder: 'b', steps: [step('Overview', 'index.md')] });
  await putLocal(made.site, list);
  await publish({ content: made.site, registryFile: made.registryFile, bucketOptions: made.bucketOptions, log: () => {} });
  return made;
}

test('a card moved or deleted on the site stays out of a publish, though its local copy changed', async () => {
  const fake = await startFakeS3();
  try {
    const { site, registryFile, bucketOptions } = await withCards(fake);
    // On the site: `a` moved to another workspace, `b` put in the Trash.
    const remote = fake.json(LIST);
    const [a, b] = ['a', 'b'].map(id => remote.entities.find(item => item.id === id));
    remote.entities = remote.entities.filter(item => item.id === 'hub');
    remote.retired = { a: { kind: 'moved', to: 'game-ideas', folder: 'a', at: '2026-10-30' }, b: { kind: 'deleted', at: '2026-10-30', entity: b } };
    fake.seed(LIST, JSON.stringify(remote, null, 2), 'application/json');
    // Here, meanwhile: both cards changed.
    const local = await localList(site);
    for (const card of local.entities) if (card.id !== 'hub') card.title = `${card.title}, edited`;
    await putLocal(site, local);
    await writeFile(path.join(site, 'a', 'index.md'), '# a, edited\n');
    assert.ok(a);

    const lines = [];
    await publish({ content: site, registryFile, bucketOptions, log: line => lines.push(line) });
    const published = fake.json(LIST);
    assert.deepEqual(published.entities.map(item => item.id), ['hub'], 'Neither card came back.');
    assert.equal(published.retired.a.kind, 'moved');
    assert.equal(published.retired.b.kind, 'deleted', 'The Trash record survived the upload.');
    assert.deepEqual((await localList(site)).entities.map(item => item.id), ['hub']);
    assert.match(lines.join('\n'), /retired: a \(moved to game-ideas\); its local folder is no longer published/);
    assert.match(lines.join('\n'), /retired: b \(in the Trash\)/);
    // No local file is deleted, and the changed page was not uploaded over the site's copy.
    assert.equal(await readFile(path.join(site, 'a', 'index.md'), 'utf8'), '# a, edited\n');
    assert.equal(await readFile(path.join(site, 'b', 'index.md'), 'utf8'), '# b\n');
    assert.equal(fake.text('sections/my-workspace/a/index.md'), '# a\n');
  } finally { await fake.close(); }
});

test('a tab removed on the site stays removed, and a tab added here still goes up', async () => {
  const fake = await startFakeS3();
  try {
    const { site, registryFile, bucketOptions } = await workspace(fake);
    const local = await localList(site);
    local.entities[0].steps = [step('Overview', 'index.md'), step('Notes', 'notes.md'), step('Refs', 'refs.md')];
    await putLocal(site, local);
    await writeFile(path.join(site, 'hub', 'notes.md'), '# Notes\n');
    await writeFile(path.join(site, 'hub', 'refs.md'), '# Refs\n');
    await publish({ content: site, registryFile, bucketOptions, log: () => {} });

    // On the site: Notes deleted (the file stays). Here: a new tab, Plan.
    const remote = fake.json(LIST);
    remote.entities[0].steps = remote.entities[0].steps.filter(item => item.path !== 'notes.md');
    remote.entities[0].removedTabs = [{ name: 'Notes', path: 'notes.md', at: '2026-10-30', index: 1 }];
    fake.seed(LIST, JSON.stringify(remote, null, 2), 'application/json');
    const edited = await localList(site);
    edited.entities[0].steps.push(step('Plan', 'plan.md'));
    await putLocal(site, edited);
    await writeFile(path.join(site, 'hub', 'plan.md'), '# Plan\n');

    await publish({ content: site, registryFile, bucketOptions, log: () => {} });
    const names = list => list.entities[0].steps.map(item => item.name);
    assert.deepEqual(names(fake.json(LIST)), ['Overview', 'Refs', 'Plan']);
    assert.deepEqual(names(await localList(site)), ['Overview', 'Refs', 'Plan']);
    assert.equal(fake.json(LIST).entities[0].removedTabs[0].path, 'notes.md');
    assert.equal(await readFile(path.join(site, 'hub', 'notes.md'), 'utf8'), '# Notes\n', 'The tab\'s file stays on disk.');
  } finally { await fake.close(); }
});

test('a tab order set on the site is kept when this folder\'s tabs are untouched, even if its title changed', async () => {
  const fake = await startFakeS3();
  try {
    const { site, registryFile, bucketOptions } = await workspace(fake);
    const local = await localList(site);
    local.entities[0].steps = [step('Overview', 'index.md'), step('Notes', 'notes.md'), step('Refs', 'refs.md')];
    await putLocal(site, local);
    await writeFile(path.join(site, 'hub', 'notes.md'), '# Notes\n');
    await writeFile(path.join(site, 'hub', 'refs.md'), '# Refs\n');
    await publish({ content: site, registryFile, bucketOptions, log: () => {} });

    const remote = fake.json(LIST);
    remote.entities[0].steps = [remote.entities[0].steps[2], remote.entities[0].steps[0], remote.entities[0].steps[1]];
    fake.seed(LIST, JSON.stringify(remote, null, 2), 'application/json');
    const edited = await localList(site);
    edited.entities[0].title = 'Hub, renamed here';
    await putLocal(site, edited);

    await publish({ content: site, registryFile, bucketOptions, log: () => {} });
    const published = fake.json(LIST).entities[0];
    assert.deepEqual(published.steps.map(item => item.name), ['Refs', 'Overview', 'Notes']);
    assert.equal(published.title, 'Hub, renamed here');
    assert.deepEqual((await localList(site)).entities[0].steps.map(item => item.name), ['Refs', 'Overview', 'Notes']);
  } finally { await fake.close(); }
});

test('a card deleted in the local app keeps its Trash record, and one restored there stays restored', async () => {
  const fake = await startFakeS3();
  try {
    const { site, registryFile, bucketOptions } = await withCards(fake);
    const publishIt = () => publish({ content: site, registryFile, bucketOptions, log: () => {} });
    // The local app puts `a` in the Trash.
    const local = await localList(site);
    const a = local.entities.find(item => item.id === 'a');
    local.entities = local.entities.filter(item => item.id !== 'a');
    local.retired = { a: { kind: 'deleted', at: '2026-10-30', entity: a } };
    await putLocal(site, local);
    await publishIt();
    assert.deepEqual(fake.json(LIST).entities.map(item => item.id).sort(), ['b', 'hub']);
    assert.equal(fake.json(LIST).retired.a.kind, 'deleted', 'The Trash record was uploaded, not erased.');

    // The site trashes `b`; a publish brings that down.
    const remote = fake.json(LIST);
    const b = remote.entities.find(item => item.id === 'b');
    remote.entities = remote.entities.filter(item => item.id !== 'b');
    remote.retired.b = { kind: 'deleted', at: '2026-10-30', entity: b };
    fake.seed(LIST, JSON.stringify(remote, null, 2), 'application/json');
    await publishIt();
    assert.deepEqual(Object.keys((await localList(site)).retired).sort(), ['a', 'b']);

    // The local app restores `b`; it must not vanish again on the next publish.
    const after = await localList(site);
    after.entities.push(after.retired.b.entity);
    delete after.retired.b;
    await putLocal(site, after);
    await publishIt();
    await publishIt();
    const published = fake.json(LIST);
    assert.deepEqual(published.entities.map(item => item.id).sort(), ['b', 'hub']);
    assert.deepEqual(Object.keys(published.retired), ['a']);
    assert.deepEqual((await localList(site)).entities.map(item => item.id).sort(), ['b', 'hub']);
  } finally { await fake.close(); }
});

/** A workspace whose hub card has the tabs Overview, a and b, published once. */
async function withTabs(fake) {
  const made = await workspace(fake);
  const list = await localList(made.site);
  list.entities[0].steps = [step('Overview', 'index.md'), step('A', 'a.md'), step('B', 'b.md')];
  await putLocal(made.site, list);
  await writeFile(path.join(made.site, 'hub', 'a.md'), '# A\n');
  await writeFile(path.join(made.site, 'hub', 'b.md'), '# B\n');
  await publish({ content: made.site, registryFile: made.registryFile, bucketOptions: made.bucketOptions, log: () => {} });
  return made;
}
const removed = (file, index) => ({ name: file, path: file, at: '2026-10-30', index });

test('a tab deleted here stays deleted when the site changed the card too, and the Removed tabs lists combine', async () => {
  const fake = await startFakeS3();
  try {
    const { site, registryFile, bucketOptions } = await withTabs(fake);
    // Here: tab A deleted. On the site: the title changed and tab B deleted.
    const local = await localList(site);
    local.entities[0].steps = local.entities[0].steps.filter(item => item.path !== 'a.md');
    local.entities[0].removedTabs = [removed('a.md', 1)];
    await putLocal(site, local);
    const remote = fake.json(LIST);
    remote.entities[0].title = 'Hub, from the site';
    remote.entities[0].steps = remote.entities[0].steps.filter(item => item.path !== 'b.md');
    remote.entities[0].removedTabs = [removed('b.md', 2)];
    fake.seed(LIST, JSON.stringify(remote, null, 2), 'application/json');

    await publish({ content: site, registryFile, bucketOptions, log: () => {} });
    const card = fake.json(LIST).entities[0];
    assert.deepEqual(card.steps.map(item => item.path), ['index.md']);
    assert.deepEqual(card.removedTabs.map(item => item.path).sort(), ['a.md', 'b.md']);
    assert.equal(card.title, 'Hub, from the site');
    assert.equal(await readFile(path.join(site, 'hub', 'a.md'), 'utf8'), '# A\n', 'No file is deleted.');
  } finally { await fake.close(); }
});

test('a tab deleted here, with the site changing only the title, is not shown and removed at once', async () => {
  const fake = await startFakeS3();
  try {
    const { site, registryFile, bucketOptions } = await withTabs(fake);
    const local = await localList(site);
    local.entities[0].steps = local.entities[0].steps.filter(item => item.path !== 'b.md');
    local.entities[0].removedTabs = [removed('b.md', 2)];
    await putLocal(site, local);
    const remote = fake.json(LIST);
    remote.entities[0].title = 'Hub, from the site';
    fake.seed(LIST, JSON.stringify(remote, null, 2), 'application/json');
    await publish({ content: site, registryFile, bucketOptions, log: () => {} });
    const card = fake.json(LIST).entities[0];
    assert.deepEqual(card.steps.map(item => item.path), ['index.md', 'a.md']);
    assert.deepEqual(card.removedTabs.map(item => item.path), ['b.md']);
  } finally { await fake.close(); }
});

test('a site change to the card list during a publish is merged in, not overwritten', async () => {
  const fake = await startFakeS3();
  try {
    const { site, entry, bucketOptions } = await withCards(fake);
    const { client, prefix } = bucketFor(entry, { env: {}, ...bucketOptions });
    const local = await localList(site);
    local.entities.find(item => item.id === 'hub').title = 'Hub, edited here';
    await putLocal(site, local);
    const merge = await mergeCardList({ root: site, bucket: client, prefix });
    assert.ok(merge.etag);
    // The site deletes `a` after the merge, before the upload.
    const remote = fake.json(LIST);
    const a = remote.entities.find(item => item.id === 'a');
    remote.entities = remote.entities.filter(item => item.id !== 'a');
    remote.retired = { a: { kind: 'deleted', at: '2026-10-30', entity: a } };
    fake.seed(LIST, JSON.stringify(remote, null, 2), 'application/json');
    const lines = [];
    await syncUp({ root: site, bucket: client, prefix, scope: await defaultScope(site), listEtag: merge.etag, log: line => lines.push(line) });
    const published = fake.json(LIST);
    assert.deepEqual(published.entities.map(item => item.id).sort(), ['b', 'hub'], 'The delete was not undone.');
    assert.equal(published.retired.a.kind, 'deleted');
    assert.equal(published.entities.find(item => item.id === 'hub').title, 'Hub, edited here', 'and this folder\'s edit still went up.');
    assert.match(lines.join('\n'), /changed on the site meanwhile/);
  } finally { await fake.close(); }
});

test('a new local card that reuses a retired id stops the whole publish before anything is written', async () => {
  const fake = await startFakeS3();
  try {
    const { site, registryFile, bucketOptions } = await withCards(fake);
    const remote = fake.json(LIST);
    remote.entities = remote.entities.filter(item => item.id !== 'a');
    remote.retired = { a: { kind: 'moved', to: 'game-ideas', folder: 'a', at: '2026-10-30' } };
    fake.seed(LIST, JSON.stringify(remote, null, 2), 'application/json');
    // Pull the site's move down first, then make a new card with the same id here.
    await publish({ content: site, registryFile, bucketOptions, log: () => {} });
    const local = await localList(site);
    assert.ok(!local.entities.some(item => item.id === 'a'));
    local.entities.push({ id: 'a', title: 'A again', folder: 'a2', steps: [step('Overview', 'index.md')] });
    await mkdir(path.join(site, 'a2'), { recursive: true });
    await writeFile(path.join(site, 'a2', 'index.md'), '# a again\n');
    await putLocal(site, local);
    await writeFile(path.join(site, 'hub', 'index.md'), '# Hub, changed\n');
    const before = fake.text(LIST);
    await assert.rejects(publish({ content: site, registryFile, bucketOptions, log: () => {} }),
      /Nothing published: the card "a" made here reuses an id that was moved to game-ideas on the site\. Give it another id/);
    assert.equal(fake.text(LIST), before, 'The card list was not touched.');
    assert.equal(fake.text('sections/my-workspace/a2/index.md'), null, 'Nothing was uploaded.');
    assert.equal(fake.text('sections/my-workspace/hub/index.md'), '# Hub\n');
    assert.ok((await localList(site)).entities.some(item => item.id === 'a'), 'The local list is left as it is.');
  } finally { await fake.close(); }
});

test('a card deleted in the local app and edited on the site stays deleted, and Restore gets the latest version', async () => {
  const fake = await startFakeS3();
  try {
    const { site, registryFile, bucketOptions } = await withCards(fake);
    const local = await localList(site);
    const a = local.entities.find(item => item.id === 'a');
    local.entities = local.entities.filter(item => item.id !== 'a');
    local.retired = { a: { kind: 'deleted', at: '2026-10-30', entity: a } };
    await putLocal(site, local);
    const remote = fake.json(LIST);
    remote.entities.find(item => item.id === 'a').title = 'A, edited on the site';
    fake.seed(LIST, JSON.stringify(remote, null, 2), 'application/json');
    await publish({ content: site, registryFile, bucketOptions, log: () => {} });
    const published = fake.json(LIST);
    assert.deepEqual(published.entities.map(item => item.id).sort(), ['b', 'hub']);
    assert.equal(published.retired.a.entity.title, 'A, edited on the site');
  } finally { await fake.close(); }
});

test('each side deleting a different tab of a two-tab card leaves one tab, and the publish says so', async () => {
  const fake = await startFakeS3();
  try {
    const { site, registryFile, bucketOptions } = await workspace(fake);
    const list = await localList(site);
    list.entities[0].steps = [step('Overview', 'index.md'), step('A', 'a.md')];
    await putLocal(site, list);
    await writeFile(path.join(site, 'hub', 'a.md'), '# A\n');
    await publish({ content: site, registryFile, bucketOptions, log: () => {} });
    // Here: Overview deleted. On the site: A deleted.
    const local = await localList(site);
    local.entities[0].steps = [step('A', 'a.md')];
    local.entities[0].removedTabs = [removed('index.md', 0)];
    await putLocal(site, local);
    const remote = fake.json(LIST);
    remote.entities[0].steps = [step('Overview', 'index.md')];
    remote.entities[0].removedTabs = [removed('a.md', 1)];
    fake.seed(LIST, JSON.stringify(remote, null, 2), 'application/json');
    const lines = [];
    await publish({ content: site, registryFile, bucketOptions, log: line => lines.push(line) });
    const card = fake.json(LIST).entities[0];
    assert.deepEqual(card.steps.map(item => item.path), ['index.md']);
    assert.deepEqual((card.removedTabs ?? []).map(item => item.path), ['a.md']);
    assert.match(lines.join('\n'), /would have no tabs left/);
  } finally { await fake.close(); }
});

test('a rename or archive made on the site survives the next local publish', async () => {
  const fake = await startFakeS3();
  try {
    const { site, registryFile, bucketOptions } = await workspace(fake);
    await publish({ content: site, registryFile, bucketOptions, log: () => {} });
    // On the site: the workspace is renamed and archived (only `name` and `archived` change in its card list).
    const key = 'sections/my-workspace/workspace.json';
    const remote = JSON.parse(fake.text(key));
    fake.seed(key, `${JSON.stringify({ ...remote, name: 'Renamed on the site', archived: true }, null, 2)}\n`, 'application/json');
    // Here: a card is edited and published again, the local list still carrying the old name.
    await writeFile(path.join(site, 'hub', 'index.md'), '# Hub, edited\n');
    const local = JSON.parse(await readFile(path.join(site, 'workspace.json'), 'utf8'));
    local.entities[0].updated = '2026-10-20';
    await writeFile(path.join(site, 'workspace.json'), JSON.stringify(local, null, 2));
    await publish({ content: site, registryFile, bucketOptions, log: () => {} });
    const after = JSON.parse(fake.text(key));
    assert.equal(after.name, 'Renamed on the site', 'The site rename is not put back.');
    assert.equal(after.archived, true, 'Nor the archive.');
    assert.equal(after.entities[0].updated, '2026-10-20', 'The local edit still went up.');
    assert.equal(fake.text('sections/my-workspace/hub/index.md'), '# Hub, edited\n');
  } finally { await fake.close(); }
});

// --- Safe publish: conditional writes, saved copies, conflict reports ---

const KEY = 'sections/my-workspace/';
/** Wrap a client so `act` runs right after the listing: someone else writes between the listing and the upload. */
const racing = (client, act) => ({ ...client, list: async (...args) => { const out = await client.list(...args); await act(); return out; } });
const exists = file => stat(file).then(() => true, () => false);
const noBuw = fake => assert.deepEqual([...fake.objects.keys()].filter(key => key.includes('.buw')), [], 'nothing under .buw is ever uploaded');
const putsOf = (fake, file) => fake.log.filter(entry => entry.method === 'PUT' && entry.key === `${KEY}${file}`);
const copyOf = site => file => path.join(site, '.buw', 'conflicts', ...file.split('/'));

/** A published workspace with a bucket client, ready for a direct syncUp. */
async function published(fake) {
  const setup = await workspace(fake);
  await publish({ content: setup.site, registryFile: setup.registryFile, bucketOptions: setup.bucketOptions, log: () => {} });
  const { client, prefix } = bucketFor(setup.entry, { env: {}, ...setup.bucketOptions });
  return { ...setup, client, prefix, scope: await defaultScope(setup.site) };
}

test('a file the agent changed after the listing is a conflict: its text stays, the copy is saved, and the rest goes up', async () => {
  const fake = await startFakeS3();
  try {
    const w = await published(fake);
    await writeFile(path.join(w.site, 'hub', 'index.md'), '# Hub, desk\n');
    await writeFile(path.join(w.site, '_shared', 'report.css'), 'body{color:red}\n');
    const client = racing(w.client, async () => fake.seed(`${KEY}hub/index.md`, '# Hub, agent\n', 'text/markdown'));
    const lines = [];
    const result = await syncUp({ root: w.site, bucket: client, prefix: w.prefix, scope: w.scope, log: line => lines.push(line) });
    assert.deepEqual(result.conflicts, ['hub/index.md']);
    assert.deepEqual(result.uploads, ['_shared/report.css']);
    assert.deepEqual(result.saved, ['hub/index.md']);
    assert.equal(fake.text(`${KEY}hub/index.md`), '# Hub, agent\n');
    assert.equal(fake.text(`${KEY}_shared/report.css`), 'body{color:red}\n');
    assert.equal(await readFile(copyOf(w.site)('hub/index.md'), 'utf8'), '# Hub, agent\n');
    assert.match(lines.join('\n'), /kept hub\/index\.md/);
    const again = await syncUp({ root: w.site, bucket: w.client, prefix: w.prefix, scope: w.scope, log: () => {} });
    assert.deepEqual(again.conflicts, ['hub/index.md'], 'the conflict is stable across runs');
    assert.equal(fake.text(`${KEY}hub/index.md`), '# Hub, agent\n');
    noBuw(fake);
  } finally { await fake.close(); }
});

test('a new file the agent made under the same name after the listing is a conflict too', async () => {
  const fake = await startFakeS3();
  try {
    const w = await published(fake);
    await writeFile(path.join(w.site, 'hub', 'new.md'), '# New, desk\n');
    const client = racing(w.client, async () => fake.seed(`${KEY}hub/new.md`, '# New, agent\n', 'text/markdown'));
    const result = await syncUp({ root: w.site, bucket: client, prefix: w.prefix, scope: w.scope, log: () => {} });
    assert.deepEqual(result.conflicts, ['hub/new.md']);
    assert.deepEqual(result.uploads, []);
    assert.equal(fake.text(`${KEY}hub/new.md`), '# New, agent\n');
    assert.equal(await readFile(copyOf(w.site)('hub/new.md'), 'utf8'), '# New, agent\n');
    const again = await syncUp({ root: w.site, bucket: w.client, prefix: w.prefix, scope: w.scope, log: () => {} });
    assert.deepEqual(again.conflicts, ['hub/new.md']);
    assert.equal(fake.text(`${KEY}hub/new.md`), '# New, agent\n');
    noBuw(fake);
  } finally { await fake.close(); }
});

test('uploads carry If-Match for a changed file and If-None-Match for a new one, and force carries neither', async () => {
  const fake = await startFakeS3();
  try {
    const w = await published(fake);
    await writeFile(path.join(w.site, 'hub', 'index.md'), '# Hub, edited\n');
    await writeFile(path.join(w.site, 'hub', 'new.md'), '# New\n');
    fake.log.length = 0;
    await publish({ content: w.site, registryFile: w.registryFile, bucketOptions: w.bucketOptions, log: () => {} });
    assert.ok(putsOf(fake, 'hub/index.md')[0].headers['if-match']);
    assert.equal(putsOf(fake, 'hub/new.md')[0].headers['if-none-match'], '*');
    assert.equal(putsOf(fake, 'hub/new.md')[0].headers['if-match'], undefined);

    fake.seed(`${KEY}hub/index.md`, '# Hub, agent\n', 'text/markdown');
    await writeFile(path.join(w.site, 'hub', 'index.md'), '# Hub, desk again\n');
    fake.log.length = 0;
    await publish({ content: w.site, registryFile: w.registryFile, bucketOptions: w.bucketOptions, force: true, log: () => {} });
    const [put] = putsOf(fake, 'hub/index.md');
    assert.equal(put.headers['if-match'], undefined);
    assert.equal(put.headers['if-none-match'], undefined);
    assert.equal(fake.text(`${KEY}hub/index.md`), '# Hub, desk again\n', 'force overwrites the agent\'s copy');
  } finally { await fake.close(); }
});

test('a lost race reported as 409 or 404 is a conflict; any other error still throws', async () => {
  const fake = await startFakeS3();
  try {
    for (const status of [409, 404]) {
      const w = await published(fake);
      await writeFile(path.join(w.site, 'hub', 'index.md'), `# Hub, desk ${status}\n`);
      const client = { ...w.client, put: async (key, ...rest) => { if (key.endsWith('hub/index.md')) throw Object.assign(new Error('lost'), { status }); return w.client.put(key, ...rest); } };
      const result = await syncUp({ root: w.site, bucket: client, prefix: w.prefix, scope: w.scope, log: () => {} });
      assert.deepEqual(result.conflicts, ['hub/index.md'], `status ${status}`);
      assert.deepEqual(result.uploads, []);
    }
    const w = await published(fake);
    await writeFile(path.join(w.site, 'hub', 'index.md'), '# Hub, desk 500\n');
    const client = { ...w.client, put: async () => { throw Object.assign(new Error('boom'), { status: 500 }); } };
    await assert.rejects(syncUp({ root: w.site, bucket: client, prefix: w.prefix, scope: w.scope, log: () => {} }), /boom/);
  } finally { await fake.close(); }
});

test('a card list seen as missing is uploaded with If-None-Match, and the retry merges the list that appeared', async () => {
  const fake = await startFakeS3();
  try {
    const w = await workspace(fake);
    const { client, prefix } = bucketFor(w.entry, { env: {}, ...w.bucketOptions });
    const merge = await mergeCardList({ root: w.site, bucket: client, prefix });
    assert.equal(merge.etag, null);
    // The agent starts a list after the merge saw none, with a card of its own.
    fake.seed(`${KEY}workspace.json`, JSON.stringify({ name: 'Mine', entities: [{ id: 'agent', title: 'Agent', folder: 'agent', steps: [{ name: 'Page', path: 'index.md' }] }] }), 'application/json');
    const lines = [];
    await syncUp({ root: w.site, bucket: client, prefix, scope: await defaultScope(w.site), listEtag: merge.etag, log: line => lines.push(line) });
    assert.deepEqual(fake.json(`${KEY}workspace.json`).entities.map(item => item.id).sort(), ['agent', 'hub'], 'both sides\' cards are in the list');
    const puts = putsOf(fake, 'workspace.json');
    assert.equal(puts[0].headers['if-none-match'], '*');
    assert.ok(puts.at(-1).headers['if-match'], 'the retry matches the merged list');
    assert.match(lines.join('\n'), /changed on the site meanwhile/);
  } finally { await fake.close(); }
});

test('a file the agent rewrote after the listing is not deleted, and comes down on the next publish', async () => {
  const fake = await startFakeS3();
  try {
    const w = await workspace(fake);
    await writeFile(path.join(w.site, 'hub', 'stale.md'), 'old\n');
    await publish({ content: w.site, registryFile: w.registryFile, bucketOptions: w.bucketOptions, log: () => {} });
    await rm(path.join(w.site, 'hub', 'stale.md'));
    const { client, prefix } = bucketFor(w.entry, { env: {}, ...w.bucketOptions });
    const scope = await defaultScope(w.site);
    fake.log.length = 0;
    const lines = [];
    const result = await syncUp({ root: w.site, bucket: racing(client, async () => fake.seed(`${KEY}hub/stale.md`, 'agent text\n')), prefix, scope, log: line => lines.push(line) });
    assert.deepEqual(result.deletes, []);
    assert.deepEqual(result.kept, ['hub/stale.md']);
    assert.equal(fake.text(`${KEY}hub/stale.md`), 'agent text\n');
    assert.ok(fake.log.find(entry => entry.method === 'DELETE' && entry.key === `${KEY}hub/stale.md`).headers['if-match']);
    assert.match(lines.join('\n'), /kept hub\/stale\.md: changed on the site during this publish/);
    const next = await publish({ content: w.site, registryFile: w.registryFile, bucketOptions: w.bucketOptions, log: () => {} });
    assert.deepEqual(next.downloads, ['hub/stale.md']);
    assert.equal(await readFile(path.join(w.site, 'hub', 'stale.md'), 'utf8'), 'agent text\n');

    // Already gone by the time of the delete: counted as deleted.
    await writeFile(path.join(w.site, 'hub', 'gone.md'), 'x\n');
    await publish({ content: w.site, registryFile: w.registryFile, bucketOptions: w.bucketOptions, log: () => {} });
    await rm(path.join(w.site, 'hub', 'gone.md'));
    const plain = await syncUp({ root: w.site, bucket: racing(client, async () => fake.objects.delete(`${KEY}hub/gone.md`)), prefix, scope, log: () => {} });
    assert.deepEqual(plain.deletes, ['hub/gone.md']);
  } finally { await fake.close(); }
});

test('with a record, a file it has no entry for that differs is a conflict even when the folder is newer', async () => {
  const fake = await startFakeS3();
  try {
    const w = await published(fake);
    await writeFile(path.join(w.site, 'hub', 'extra.md'), '# Extra, desk\n');
    const future = new Date(Date.now() + 3_600_000);
    await utimes(path.join(w.site, 'hub', 'extra.md'), future, future);
    fake.seed(`${KEY}hub/extra.md`, '# Extra, agent\n', 'text/markdown');
    const result = await publish({ content: w.site, registryFile: w.registryFile, bucketOptions: w.bucketOptions, log: () => {} });
    assert.deepEqual(result.conflicts, ['hub/extra.md']);
    assert.equal(fake.text(`${KEY}hub/extra.md`), '# Extra, agent\n');
  } finally { await fake.close(); }
});

test('with no record at all, the newer side wins a differing file and the older one is a conflict', async () => {
  const fake = await startFakeS3();
  try {
    for (const [offset, expected] of [[3_600_000, 'uploads'], [-86_400_000 * 365, 'conflicts']]) {
      const w = await workspace(fake, { id: `first-${expected}` });
      const key = `sections/first-${expected}/hub/index.md`;
      fake.seed(key, '# Hub, bucket\n', 'text/markdown');
      const when = new Date(Date.now() + offset);
      await utimes(path.join(w.site, 'hub', 'index.md'), when, when);
      const result = await publish({ content: w.site, registryFile: w.registryFile, bucketOptions: w.bucketOptions, log: () => {} });
      assert.deepEqual(result[expected].filter(file => file === 'hub/index.md'), ['hub/index.md']);
      assert.equal(fake.text(key), expected === 'uploads' ? '# Hub\n' : '# Hub, bucket\n');
    }
  } finally { await fake.close(); }
});

test('a named publish with only conflicts is not rejected, and names the copy and both ways to settle', async () => {
  const fake = await startFakeS3();
  try {
    const w = await published(fake);
    fake.seed(`${KEY}hub/index.md`, '# Hub, agent\n', 'text/markdown');
    await writeFile(path.join(w.site, 'hub', 'index.md'), '# Hub, desk\n');
    const lines = [];
    const result = await publish({ content: w.site, registryFile: w.registryFile, bucketOptions: w.bucketOptions, cards: ['hub'], log: line => lines.push(line) });
    const output = lines.join('\n');
    assert.equal(result.published, false);
    assert.deepEqual(result.conflicts, ['hub/index.md']);
    assert.match(output, /changed here and on the site, left alone/);
    assert.ok(output.includes(`${w.site.split(path.sep).join('/')}/.buw/conflicts/hub/index.md`));
    assert.match(output, /npm run publish -- --content my-workspace --path "hub\/index\.md" --force/);
    assert.match(output, /npm run publish -- --content my-workspace --path "hub\/index\.md" --pull --force/);
    assert.match(output, /Nothing published in Mine: 1 file\(s\) need settling/);
    assert.doesNotMatch(output, /nothing changed/);
  } finally { await fake.close(); }
});

test('a dry run with a conflict saves no copy and says a real publish will', async () => {
  const fake = await startFakeS3();
  try {
    const w = await published(fake);
    fake.seed(`${KEY}hub/index.md`, '# Hub, agent\n', 'text/markdown');
    await writeFile(path.join(w.site, 'hub', 'index.md'), '# Hub, desk\n');
    const lines = [];
    const result = await publish({ content: w.site, registryFile: w.registryFile, bucketOptions: w.bucketOptions, dryRun: true, log: line => lines.push(line) });
    assert.deepEqual(result.conflicts, ['hub/index.md']);
    assert.equal(await exists(path.join(w.site, '.buw', 'conflicts')), false);
    assert.match(lines.join('\n'), /a real publish saves the site's copy/);
    assert.doesNotMatch(lines.join('\n'), /the site's copy:/);
  } finally { await fake.close(); }
});

test('both resolutions settle one file, clear its copy, and leave another conflict and its copy alone', async () => {
  const fake = await startFakeS3();
  try {
    const w = await workspace(fake);
    await writeFile(path.join(w.site, 'hub', 'other.md'), '# Other\n');
    const options = { registryFile: w.registryFile, bucketOptions: w.bucketOptions, log: () => {} };
    await publish({ content: w.site, ...options });
    const make = async () => {
      for (const file of ['index.md', 'other.md']) {
        fake.seed(`${KEY}hub/${file}`, `# ${file}, agent\n`, 'text/markdown');
        await writeFile(path.join(w.site, 'hub', file), `# ${file}, desk\n`);
      }
    };
    await make();
    const first = await publish({ content: w.site, ...options });
    assert.deepEqual(first.conflicts, ['hub/index.md', 'hub/other.md']);
    assert.deepEqual(first.saved, ['hub/index.md', 'hub/other.md']);

    // Keep this folder's index.md.
    await publish({ content: 'my-workspace', paths: ['hub/index.md'], force: true, ...options });
    assert.equal(fake.text(`${KEY}hub/index.md`), '# index.md, desk\n');
    assert.equal(await exists(copyOf(w.site)('hub/index.md')), false);
    assert.equal(await exists(copyOf(w.site)('hub/other.md')), true, 'the other conflict keeps its copy');
    const afterOne = await publish({ content: w.site, ...options });
    assert.deepEqual(afterOne.conflicts, ['hub/other.md'], 'the settled file is not reported again');

    // Keep the site's other.md.
    await publish({ content: 'my-workspace', paths: ['hub/other.md'], pull: true, force: true, ...options });
    assert.equal(await readFile(path.join(w.site, 'hub', 'other.md'), 'utf8'), '# other.md, agent\n');
    assert.equal(await exists(copyOf(w.site)('hub/other.md')), false);
    const clean = await publish({ content: w.site, ...options });
    assert.deepEqual(clean.conflicts, []);
    noBuw(fake);
  } finally { await fake.close(); }
});

test('a named --pull --force keeps a local card that is not published yet', async () => {
  const fake = await startFakeS3();
  try {
    const w = await published(fake);
    const options = { registryFile: w.registryFile, bucketOptions: w.bucketOptions, log: () => {} };
    const local = JSON.parse(await readFile(path.join(w.site, 'workspace.json'), 'utf8'));
    local.entities.push({ id: 'desk', title: 'Desk', folder: 'desk', steps: [{ name: 'Page', path: 'index.md' }] });
    await writeFile(path.join(w.site, 'workspace.json'), JSON.stringify(local, null, 2));
    fake.seed(`${KEY}hub/index.md`, '# Hub, agent\n', 'text/markdown');
    await writeFile(path.join(w.site, 'hub', 'index.md'), '# Hub, desk\n');
    await publish({ content: w.site, paths: ['hub/index.md'], pull: true, force: true, ...options });
    assert.equal(await readFile(path.join(w.site, 'hub', 'index.md'), 'utf8'), '# Hub, agent\n');
    const after = JSON.parse(await readFile(path.join(w.site, 'workspace.json'), 'utf8'));
    assert.deepEqual(after.entities.map(item => item.id).sort(), ['desk', 'hub']);
    // The card is only lost one publish later if the pull recorded the unsynced list as synced.
    await publish({ content: w.site, ...options });
    const ids = list => list.entities.map(item => item.id).sort();
    assert.deepEqual(ids(JSON.parse(await readFile(path.join(w.site, 'workspace.json'), 'utf8'))), ['desk', 'hub']);
    assert.deepEqual(ids(fake.json(`${KEY}workspace.json`)), ['desk', 'hub']);
  } finally { await fake.close(); }
});

test('a plain --pull keeps a local card that is not published yet through the next publish', async () => {
  const fake = await startFakeS3();
  try {
    const w = await published(fake);
    const options = { registryFile: w.registryFile, bucketOptions: w.bucketOptions, log: () => {} };
    const local = JSON.parse(await readFile(path.join(w.site, 'workspace.json'), 'utf8'));
    local.entities.push({ id: 'desk', title: 'Desk', folder: 'desk', steps: [{ name: 'Page', path: 'index.md' }] });
    await writeFile(path.join(w.site, 'workspace.json'), JSON.stringify(local, null, 2));
    fake.seed(`${KEY}hub/extra.md`, '# Extra\n', 'text/markdown');
    await publish({ content: w.site, pull: true, ...options });
    assert.equal(await readFile(path.join(w.site, 'hub', 'extra.md'), 'utf8'), '# Extra\n');
    await publish({ content: w.site, ...options });
    const ids = list => list.entities.map(item => item.id).sort();
    assert.deepEqual(ids(JSON.parse(await readFile(path.join(w.site, 'workspace.json'), 'utf8'))), ['desk', 'hub']);
    assert.deepEqual(ids(fake.json(`${KEY}workspace.json`)), ['desk', 'hub']);
  } finally { await fake.close(); }
});

test('copying the saved file over the local one settles the conflict by hand', async () => {
  const fake = await startFakeS3();
  try {
    const w = await published(fake);
    const options = { content: w.site, registryFile: w.registryFile, bucketOptions: w.bucketOptions, log: () => {} };
    fake.seed(`${KEY}hub/index.md`, '# Hub, agent\n', 'text/markdown');
    await writeFile(path.join(w.site, 'hub', 'index.md'), '# Hub, desk\n');
    const conflicted = await publish(options);
    await writeFile(path.join(w.site, 'hub', 'index.md'), await readFile(copyOf(w.site)('hub/index.md')));
    const settled = await publish(options);
    assert.equal(settled.unchanged, conflicted.unchanged + 1);
    assert.deepEqual(settled.conflicts, []);
    assert.equal(await exists(copyOf(w.site)('hub/index.md')), false);
  } finally { await fake.close(); }
});

test('a publish naming another card keeps the first card\'s saved copy', async () => {
  const fake = await startFakeS3();
  try {
    const w = await workspace(fake);
    await mkdir(path.join(w.site, 'notes'), { recursive: true });
    await writeFile(path.join(w.site, 'notes', 'index.md'), '# Notes\n');
    const list = JSON.parse(await readFile(path.join(w.site, 'workspace.json'), 'utf8'));
    list.entities.push({ id: 'notes', title: 'Notes', folder: 'notes', steps: [{ name: 'Page', path: 'index.md' }] });
    await writeFile(path.join(w.site, 'workspace.json'), JSON.stringify(list, null, 2));
    const options = { registryFile: w.registryFile, bucketOptions: w.bucketOptions, log: () => {} };
    await publish({ content: w.site, ...options });
    fake.seed(`${KEY}hub/index.md`, '# Hub, agent\n', 'text/markdown');
    await writeFile(path.join(w.site, 'hub', 'index.md'), '# Hub, desk\n');
    await publish({ content: w.site, ...options });
    assert.equal(await exists(copyOf(w.site)('hub/index.md')), true);
    await writeFile(path.join(w.site, 'notes', 'index.md'), '# Notes, edited\n');
    const named = await publish({ content: w.site, cards: ['notes'], ...options });
    assert.equal(named.published, true);
    assert.equal(await exists(copyOf(w.site)('hub/index.md')), true, 'another card\'s copy is not cleared');
    noBuw(fake);
  } finally { await fake.close(); }
});

test('exit codes: 1 for a failure, 2 for a real publish that left conflicts, 0 otherwise', () => {
  assert.equal(exitCodeFor({ dryRun: false, conflicts: [], failed: [] }), 0);
  assert.equal(exitCodeFor({ dryRun: false, conflicts: ['a'], failed: [] }), 2);
  assert.equal(exitCodeFor({ dryRun: true, conflicts: ['a'], failed: [] }), 0);
  assert.equal(exitCodeFor({ dryRun: false, conflicts: ['a'], failed: [new Error('x')] }), 1);
  assert.equal(exitCodeFor({ dryRun: true, conflicts: [], failed: [new Error('x')] }), 1);
  assert.equal(exitCodeFor({ dryRun: false, conflicts: 2 }), 2);
  assert.equal(exitCodeFor(), 0);
});

test('publish --all reports workspaces with files to settle, and does not call them up to date', async () => {
  const fake = await startFakeS3();
  try {
    const w = await published(fake);
    fake.seed(`${KEY}hub/index.md`, '# Hub, agent\n', 'text/markdown');
    await writeFile(path.join(w.site, 'hub', 'index.md'), '# Hub, desk\n');
    const lines = [];
    const all = await publishAll({ registryFile: w.registryFile, bucketOptions: w.bucketOptions, log: line => lines.push(line) });
    assert.equal(all.conflicted.length, 1);
    assert.equal(all.failed.length, 0);
    assert.match(lines.join('\n'), /Mine: 1 to settle/);
    assert.doesNotMatch(lines.join('\n'), /already up to date/);
  } finally { await fake.close(); }
});

// A pull that leaves the card list unsettled must record the bucket's merged list as the shared base,
// or a later publish reads what the pull brought in as a local change and beats newer site edits.
for (const named of [true, false]) {
  for (const desk of [false, true]) {
    for (const pretty of [false, true]) {
      const label = `${named ? 'named --pull --force' : 'plain --pull'}, ${desk ? 'with' : 'no'} unpublished card, ${pretty ? 'pretty' : 'compact'} list`;
      const setup = async () => {
        const fake = await startFakeS3();
        const w = await published(fake);
        const options = { registryFile: w.registryFile, bucketOptions: w.bucketOptions, log: () => {} };
        const site = list => fake.seed(`${KEY}workspace.json`, pretty ? `${JSON.stringify(list, null, 2)}\n` : JSON.stringify(list), 'application/json');
        const edit = change => { const list = fake.json(`${KEY}workspace.json`); change(list); site(list); };
        const pull = () => publish({ content: w.site, ...(named ? { paths: ['hub/index.md'], force: true } : {}), pull: true, ...options });
        const again = () => publish({ content: w.site, ...options });
        const local = async () => JSON.parse(await readFile(path.join(w.site, 'workspace.json'), 'utf8'));
        if (desk) {
          const list = await local();
          list.entities.push({ id: 'desk', title: 'Desk', folder: 'desk', steps: [{ name: 'Page', path: 'index.md' }] });
          await writeFile(path.join(w.site, 'workspace.json'), JSON.stringify(list, null, 2));
        }
        const ids = list => list.entities.map(item => item.id).sort();
        const keepsDesk = async () => { if (desk) { assert.ok(ids(await local()).includes('desk')); assert.ok(ids(fake.json(`${KEY}workspace.json`)).includes('desk')); } };
        return { fake, site, edit, pull, again, local, ids, keepsDesk };
      };

      test(`a site title edited again after a pull is kept by the next publish (${label})`, async () => {
        const t = await setup();
        try {
          t.edit(list => { list.entities.find(item => item.id === 'hub').title = 'v1'; });
          await t.pull();
          t.edit(list => { list.entities.find(item => item.id === 'hub').title = 'v2'; });
          await t.again();
          assert.equal(t.fake.json(`${KEY}workspace.json`).entities.find(item => item.id === 'hub').title, 'v2');
          assert.equal((await t.local()).entities.find(item => item.id === 'hub').title, 'v2');
          await t.keepsDesk();
        } finally { await t.fake.close(); }
      });

      test(`a card added on the site, pulled, then removed there stays removed (${label})`, async () => {
        const t = await setup();
        try {
          t.edit(list => { list.entities.push({ id: 's', title: 'S', folder: 's', steps: [{ name: 'Page', path: 'index.md' }] }); });
          t.fake.seed(`${KEY}s/index.md`, '# S\n', 'text/markdown');
          await t.pull();
          t.edit(list => { list.entities = list.entities.filter(item => item.id !== 's'); });
          await t.again();
          assert.ok(!t.ids(t.fake.json(`${KEY}workspace.json`)).includes('s'), 'the removed card did not come back');
          assert.ok(!t.ids(await t.local()).includes('s'));
          await t.keepsDesk();
        } finally { await t.fake.close(); }
      });

      test(`a card added on the site, pulled, then put in the Trash there gives no false id clash (${label})`, async () => {
        const t = await setup();
        try {
          t.edit(list => { list.entities.push({ id: 's', title: 'S', folder: 's', steps: [{ name: 'Page', path: 'index.md' }] }); });
          t.fake.seed(`${KEY}s/index.md`, '# S\n', 'text/markdown');
          await t.pull();
          t.edit(list => {
            const card = list.entities.find(item => item.id === 's');
            list.entities = list.entities.filter(item => item.id !== 's');
            list.retired = { s: { kind: 'deleted', at: '2026-11-04', entity: card } };
          });
          await t.again();
          const after = t.fake.json(`${KEY}workspace.json`);
          assert.ok(!t.ids(after).includes('s'));
          assert.equal(after.retired.s.kind, 'deleted');
          await t.keepsDesk();
        } finally { await t.fake.close(); }
      });
    }
  }
}

// A merge rewrites the local card list, so it must also save the bucket's list as the base, or a later
// merge reads what it brought in as a local change and beats a newer site edit.
const titleOf = list => list.entities.find(item => item.id === 'hub').title;
const siteTitle = (fake, title) => { const list = fake.json(`${KEY}workspace.json`); list.entities.find(item => item.id === 'hub').title = title; fake.seed(`${KEY}workspace.json`, JSON.stringify(list), 'application/json'); };
const addDesk = async site => {
  const list = JSON.parse(await readFile(path.join(site, 'workspace.json'), 'utf8'));
  list.entities.push({ id: 'desk', title: 'Desk', folder: 'desk', steps: [{ name: 'Page', path: 'index.md' }] });
  await writeFile(path.join(site, 'workspace.json'), JSON.stringify(list, null, 2));
};

test('a site title changed again during the card list put is not replaced by the retry', async () => {
  const fake = await startFakeS3();
  try {
    const w = await published(fake);
    siteTitle(fake, 'v1');
    await addDesk(w.site);
    const merge = await mergeCardList({ root: w.site, bucket: w.client, prefix: w.prefix });
    let raced = false;
    const client = { ...w.client, put: async (key, ...rest) => {
      if (key === `${KEY}workspace.json` && !raced) { raced = true; siteTitle(fake, 'v2'); }
      return w.client.put(key, ...rest);
    } };
    await syncUp({ root: w.site, bucket: client, prefix: w.prefix, scope: w.scope, listEtag: merge.etag, log: () => {} });
    assert.ok(raced);
    const list = fake.json(`${KEY}workspace.json`);
    assert.equal(titleOf(list), 'v2');
    assert.ok(list.entities.some(item => item.id === 'desk'), 'the local card went up');
  } finally { await fake.close(); }
});

for (const desk of [false, true]) {
  test(`a publish that fails after its merge does not let the next one replace a later site edit (${desk ? 'with' : 'no'} unpublished card)`, async () => {
    const fake = await startFakeS3();
    try {
      const w = await published(fake);
      const options = { content: w.site, registryFile: w.registryFile, bucketOptions: w.bucketOptions, log: () => {} };
      if (desk) await addDesk(w.site);
      siteTitle(fake, 'v1');
      await writeFile(path.join(w.site, 'hub', 'secret-token.json'), '{}');
      await assert.rejects(publish(options), /looks like a secret/);
      await rm(path.join(w.site, 'hub', 'secret-token.json'));
      siteTitle(fake, 'v2');
      await publish(options);
      const list = fake.json(`${KEY}workspace.json`);
      assert.equal(titleOf(list), 'v2');
      assert.equal(titleOf(JSON.parse(await readFile(path.join(w.site, 'workspace.json'), 'utf8'))), 'v2');
      if (desk) assert.ok(list.entities.some(item => item.id === 'desk'), 'the unpublished card survived the interruption');
      // After a real publish the record holds what both sides now have.
      const record = Object.values(JSON.parse(await readFile(path.join(w.site, '.buw', 'sync.json'), 'utf8')))[0];
      assert.deepEqual(record.list, list);
    } finally { await fake.close(); }
  });
}

test('a dry run leaves sync.json and workspace.json byte-identical, even with site changes to merge', async () => {
  const fake = await startFakeS3();
  try {
    const w = await published(fake);
    await addDesk(w.site);
    siteTitle(fake, 'v1');
    const files = [path.join(w.site, '.buw', 'sync.json'), path.join(w.site, 'workspace.json')];
    const before = await Promise.all(files.map(file => readFile(file)));
    await publish({ content: w.site, registryFile: w.registryFile, bucketOptions: w.bucketOptions, dryRun: true, log: () => {} });
    const after = await Promise.all(files.map(file => readFile(file)));
    assert.deepEqual(after, before);
  } finally { await fake.close(); }
});

test('safeKey refuses what would leave the folder or break on Windows, and keeps ordinary names', () => {
  for (const key of ['hub/..\\evil.txt', 'hub/a:b.txt', 'hub/con.txt', 'hub/NUL', 'hub/com1.md', 'hub/x.', 'hub/x ', 'hub/../x', 'hub/./x', 'hub/a\u0001b', '', 'C:/x']) assert.equal(safeKey(key), false, JSON.stringify(key));
  for (const key of ['hub/index.md', 'hub/Notes (v2).md', 'hub/sub dir/a.b.txt', 'hub/ünï.md', 'hub/!weird,name#1.md', 'hub/console.md']) assert.equal(safeKey(key), true, key);
});

test('a key on the site that is not a safe path here is skipped, logged and never written or deleted, by syncDown and syncUp', async () => {
  const fake = await startFakeS3();
  try {
    const w = await published(fake);
    const evil = ['hub/..\\evil.txt', 'hub/a:b.txt', 'hub/con.txt', 'hub/trailing.'];
    for (const key of evil) fake.seed(`${KEY}${key}`, 'bad', 'text/plain');
    const before = [...fake.objects.keys()].sort();
    const lines = [];
    const down = await syncDown({ root: w.site, bucket: w.client, prefix: w.prefix, scope: w.scope, log: line => lines.push(line) });
    assert.deepEqual(down.written, []);
    const up = await syncUp({ root: w.site, bucket: w.client, prefix: w.prefix, scope: w.scope, log: line => lines.push(line) });
    assert.deepEqual(up.downloads, []);
    assert.deepEqual(up.deletes, []);
    for (const key of evil) assert.equal(lines.filter(line => line === `  left on the site: ${key} is not a safe path here`).length, 2, key);
    assert.deepEqual([...fake.objects.keys()].sort(), before, 'nothing was deleted or added on the site');
    assert.equal(fake.log.some(entry => entry.method === 'DELETE'), false);
    // Nothing landed in the workspace folder or next to it.
    assert.equal(await exists(path.join(w.site, 'evil.txt')), false);
    assert.equal(await exists(path.join(w.site, 'hub', '..\\evil.txt')), false);
    assert.equal(await exists(path.join(w.base, 'evil.txt')), false);
    assert.deepEqual((await readdir(path.join(w.site, 'hub'))).sort(), ['index.md']);
    // A dry run logs them too and still writes nothing.
    const dryLines = [];
    await syncDown({ root: w.site, bucket: w.client, prefix: w.prefix, scope: w.scope, dryRun: true, log: line => dryLines.push(line) });
    assert.equal(dryLines.filter(line => line.includes('not a safe path')).length, evil.length);
  } finally { await fake.close(); }
});

// ---- Revert survives a publish from the PC (ws brief 2.5). The agent writes through the real card API handler; the Hub's Revert
// runs over the same fake bucket; the PC then publishes. Nothing here touches a real bucket.
const WHO = { 'x-card-agent': 'Researcher', 'x-card-why': encodeURIComponent('Notes for the owner') };
const md5Of = text => createHash('md5').update(text).digest('hex');

/** The card API with a `@library` token over the fake, and the Hub's Revert over the same bucket. */
function agentWorld(fake, client) {
  const sha = text => createHash('sha256').update(text).digest('hex');
  let clock = 1_800_000_000_000;
  const api = createCardApi({ bucket: client, tokens: parseTokens(`lib=${sha('tok')}:read=*;write=inbox|assistant|@library`), today: () => '2026-11-05', now: () => { clock += 1000; return clock; } });
  const call = async (method, rawPath, body, headers) => {
    const response = await api({ requestContext: { http: { method } }, rawPath, headers: { Authorization: 'Bearer tok', ...headers }, body });
    assert.equal(response.statusCode, 200, response.body);
    return JSON.parse(response.body);
  };
  const fail = (message, status) => Object.assign(new Error(message), { status });
  const writes = createCardWrites({ bucket: client, key: rel => inboxKey(rel), fail, sections: async () => [], now: () => new Date(clock) });
  return {
    file: (file, text, headers) => call('PUT', `/sections/my-workspace/files/${file}`, text, { 'content-type': 'text/plain', ...WHO, ...headers }),
    entry: (id, entity, batch) => call('PUT', `/sections/my-workspace/cards/${id}`, JSON.stringify(entity), { ...WHO, 'x-card-batch': batch }),
    revert: (folder, batch) => writes.revert({ section: 'my-workspace', folder, batch }, 'owner'),
  };
}
const EDIT_AS = (text, batch) => ({ 'if-match': `"${md5Of(text)}"`, 'x-card-context': 'chat', 'x-card-batch': batch });

test('Revert, the PC never saw the edit: the bucket goes back to what the PC has, and the publish finds nothing to do', async () => {
  const fake = await startFakeS3();
  try {
    const w = await published(fake);
    const agent = agentWorld(fake, w.client);
    await agent.file('hub/index.md', '# Hub, agent\n', EDIT_AS('# Hub\n', 'edit0000001'));
    assert.equal(fake.text(`${KEY}hub/index.md`), '# Hub, agent\n');
    await agent.revert('hub', 'edit0000001');
    assert.equal(fake.text(`${KEY}hub/index.md`), '# Hub\n');
    const result = await syncUp({ root: w.site, bucket: w.client, prefix: w.prefix, scope: w.scope, log: () => {} });
    assert.deepEqual([result.uploads, result.downloads, result.conflicts, result.deletes], [[], [], [], []]);
    assert.ok(result.unchanged >= 1);
    assert.equal(await readFile(path.join(w.site, 'hub', 'index.md'), 'utf8'), '# Hub\n');
  } finally { await fake.close(); }
});

test('Revert, the PC pulled the edit: the old text comes down on the next publish', async () => {
  const fake = await startFakeS3();
  try {
    const w = await published(fake);
    const agent = agentWorld(fake, w.client);
    await agent.file('hub/index.md', '# Hub, agent\n', EDIT_AS('# Hub\n', 'edit0000001'));
    await syncUp({ root: w.site, bucket: w.client, prefix: w.prefix, scope: w.scope, log: () => {} });
    assert.equal(await readFile(path.join(w.site, 'hub', 'index.md'), 'utf8'), '# Hub, agent\n', 'the PC has the edit');
    await agent.revert('hub', 'edit0000001');
    const result = await syncUp({ root: w.site, bucket: w.client, prefix: w.prefix, scope: w.scope, log: () => {} });
    assert.deepEqual(result.downloads, ['hub/index.md']);
    assert.deepEqual(result.conflicts, []);
    assert.equal(await readFile(path.join(w.site, 'hub', 'index.md'), 'utf8'), '# Hub\n');
    assert.equal(fake.text(`${KEY}hub/index.md`), '# Hub\n');
  } finally { await fake.close(); }
});

test('Revert, the PC pulled the edit and changed it: a conflict with a saved copy, and nothing overwritten', async () => {
  const fake = await startFakeS3();
  try {
    const w = await published(fake);
    const agent = agentWorld(fake, w.client);
    await agent.file('hub/index.md', '# Hub, agent\n', EDIT_AS('# Hub\n', 'edit0000001'));
    await syncUp({ root: w.site, bucket: w.client, prefix: w.prefix, scope: w.scope, log: () => {} });
    await writeFile(path.join(w.site, 'hub', 'index.md'), '# Hub, desk\n');
    await agent.revert('hub', 'edit0000001');
    const result = await syncUp({ root: w.site, bucket: w.client, prefix: w.prefix, scope: w.scope, log: () => {} });
    assert.deepEqual(result.conflicts, ['hub/index.md']);
    assert.deepEqual(result.saved, ['hub/index.md']);
    assert.equal(await readFile(path.join(w.site, 'hub', 'index.md'), 'utf8'), '# Hub, desk\n', 'the desk text is kept');
    assert.equal(fake.text(`${KEY}hub/index.md`), '# Hub\n', 'the site keeps the reverted text');
    assert.equal(await readFile(copyOf(w.site)('hub/index.md'), 'utf8'), '# Hub\n');
  } finally { await fake.close(); }
});

test('Revert a new tab the PC pulled: the tab stays off the published list, and the local list loses it', async () => {
  const fake = await startFakeS3();
  try {
    const w = await published(fake);
    const agent = agentWorld(fake, w.client);
    const card = (await localList(w.site)).entities[0];
    await agent.file('hub/notes.md', '# Agent notes\n', { 'if-none-match': '*', 'x-card-batch': 'tab00000001' });
    await agent.entry('hub', { ...card, steps: [...card.steps, step('Agent notes', 'notes.md')] }, 'tab00000001');
    await publish({ content: w.site, registryFile: w.registryFile, bucketOptions: w.bucketOptions, log: () => {} });
    assert.deepEqual((await localList(w.site)).entities[0].steps.map(item => item.path), ['index.md', 'notes.md'], 'the PC has the tab');
    await agent.revert('hub', 'tab00000001');
    await publish({ content: w.site, registryFile: w.registryFile, bucketOptions: w.bucketOptions, log: () => {} });
    assert.deepEqual(fake.json(LIST).entities[0].steps.map(item => item.path), ['index.md']);
    assert.deepEqual(fake.json(LIST).entities[0].removedTabs.map(item => item.path), ['notes.md']);
    assert.deepEqual((await localList(w.site)).entities[0].steps.map(item => item.path), ['index.md']);
    assert.ok(fake.objects.has(`${KEY}hub/notes.md`), 'the file stays in the folder');
  } finally { await fake.close(); }
});

test('Revert a new card the PC pulled: the card stays in the Trash and a publish does not add it back', async () => {
  const fake = await startFakeS3();
  try {
    const w = await published(fake);
    const agent = agentWorld(fake, w.client);
    await agent.file('2026-11-05_agent/index.md', '# Agent card\n', { 'if-none-match': '*', 'x-card-batch': 'card0000001' });
    await agent.entry('agent-card', { id: 'agent-card', title: 'Agent card', folder: '2026-11-05_agent', steps: [step('Notes', 'index.md')] }, 'card0000001');
    await publish({ content: w.site, registryFile: w.registryFile, bucketOptions: w.bucketOptions, log: () => {} });
    assert.ok((await localList(w.site)).entities.some(item => item.id === 'agent-card'), 'the PC has the card');
    await agent.revert('2026-11-05_agent', 'card0000001');
    await publish({ content: w.site, registryFile: w.registryFile, bucketOptions: w.bucketOptions, log: () => {} });
    await publish({ content: w.site, registryFile: w.registryFile, bucketOptions: w.bucketOptions, log: () => {} });
    const list = fake.json(LIST);
    assert.deepEqual(list.entities.map(item => item.id), ['hub']);
    assert.equal(list.retired['agent-card'].kind, 'deleted');
    assert.ok(!(await localList(w.site)).entities.some(item => item.id === 'agent-card'), 'the local list drops it too');
  } finally { await fake.close(); }
});
