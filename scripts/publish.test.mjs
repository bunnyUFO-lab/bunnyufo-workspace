import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bucketFor, publish, publishAll } from './publish.mjs';
import { startFakeS3 } from '../site/api/test/fake-s3.mjs';

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
