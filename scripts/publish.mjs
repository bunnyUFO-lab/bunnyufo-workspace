// Publish workspace cards: upload what changed to the workspace's place in the cards bucket. No
// commit, no push, no runner — the site serves the bucket, so a card is live when the upload ends.
//   npm run publish [-- --dry-run] [-- --content <folder|id>]
//                    [-- --card <id|folder>]... [-- --path <file|folder>]...
//   npm run publish -- --all        every registered workspace, in one go
//   npm run publish -- --pull       the other way: fetch what the bucket has and this folder lacks
//   npm run publish -- --allow-deletes   publish even when more than 5 files would be deleted from the bucket
//
// Cards are written across several workspaces in a day, so publishing the active workspace only is
// how the site ends up behind the app. --all walks the whole registry, and --card names a card in
// any workspace: it publishes the workspace that holds it, not whichever one is active.
// Never uploads the starter examples, and refuses likely secrets and huge files. Several agents may
// be working in one workspace at once, so it only ever touches its own scope (the cards you name,
// else every registered card folder, the card list and _shared) and leaves everything else alone.
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RESERVED_IDS, defaultRegistryFile, findCard, listWorkspaces, resolveWorkspace, samePath } from '../server/workspaces.mjs';
import { bucketFromUrl } from '../site/api/s3.mjs';
import { defaultScope, mergeCardList, syncDown, syncUp } from './shared/s3-sync.mjs';

const appRepo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Where a workspace publishes: its registry entry's bucket, or BUW_S3_BUCKET for one that has none. */
export function bucketFor(workspace, { env = process.env, ...options } = {}) {
  const url = workspace.bucket || (env.BUW_S3_BUCKET ? `s3://${env.BUW_S3_BUCKET}/${env.BUW_S3_PREFIX || 'sections'}/${workspace.id}` : null);
  const found = url ? bucketFromUrl(url, options) : null;
  if (found && !/^sections\/[^/]+/.test(found.prefix ?? '')) {
    throw new Error(`Refusing to publish to s3://${found.bucket}/${found.prefix ?? ''}: workspaces publish under sections/<id>.`);
  }
  const last = (found?.prefix ?? '').replace(/\/+$/, '').split('/').pop();
  if (found && RESERVED_IDS.has(last)) {
    throw new Error(`Refusing to publish to s3://${found.bucket}/${found.prefix}: "${last}" is written by agents and the Hub through the card API; it is never a local workspace.`);
  }
  if (!found) throw new Error(`${workspace.name} has no bucket: register one with npm run workspace set ${workspace.id} --bucket s3://<bucket>/sections/${workspace.id}`);
  return found;
}

/** The folders of cards the bucket's list names, by id. */
async function remoteFolders(client, prefix, ids) {
  const remote = await client.getJson(`${prefix}/workspace.json`);
  return (remote?.value?.entities ?? []).filter(entity => ids.includes(entity?.id) && entity.folder).map(entity => entity.folder);
}

/** The scope of one publish, from the cards and paths named, else the whole workspace. */
async function scopeOf(root, cards, paths) {
  const named = [...cards, ...paths].map(name => String(name).split(path.sep).join('/').replace(/^\.\//, '').replace(/\/+$/, '')).filter(Boolean);
  if (!named.length) return { scope: await defaultScope(root), named };
  const { entities } = JSON.parse(await readFile(path.join(root, 'workspace.json'), 'utf8'));
  const folders = named.map(name => (entities || []).find(entity => entity?.id === name)?.folder ?? name);
  // Naming a card also carries the card list, or the site would not know the card is there.
  return { scope: { folders, files: ['workspace.json'], prefixes: [] }, named };
}

/**
 * Which workspace a `--card` belongs to. Cards are written across several workspaces in a day and
 * the active one is rarely the one being named, so a card id picks its own workspace rather than
 * failing against whichever workspace happened to be active. An explicit --content still wins, and
 * a name no workspace claims (a bare folder) falls back to the active one.
 */
async function workspaceForCards({ cards, registryFile, env }) {
  const found = [];
  for (const card of cards) {
    const hit = await findCard({ appRepo, registryFile, id: String(card), env });
    if (hit) found.push({ card, workspace: hit.workspace });
  }
  if (!found.length) return null;
  const [first, ...rest] = found;
  const elsewhere = rest.filter(item => !samePath(item.workspace.root, first.workspace.root));
  if (elsewhere.length) {
    const where = [first, ...elsewhere].map(item => `${item.card} is in ${item.workspace.name}`).join(', ');
    throw new Error(`Those cards live in different workspaces (${where}); publish one workspace at a time.`);
  }
  return first.workspace;
}

export async function publish({ content, message, cards = [], paths = [], dryRun = false, pull = false, force = false, allowDeletes = false, registryFile = defaultRegistryFile(), bucketOptions = {}, env = process.env, log = console.log } = {}) {
  const workspace = (!content && cards.length ? await workspaceForCards({ cards, registryFile, env }) : null)
    ?? await resolveWorkspace({ appRepo, content, registryFile, env });
  if (workspace.builtin) throw new Error('The active workspace is the app\'s starter examples; publish a registered workspace instead (npm run workspace).');
  const root = await realpath(workspace.root);
  if (samePath(root, appRepo)) throw new Error('Refusing to publish the app repo.');
  if (message) log('(-m is accepted for compatibility; an upload has no commit message.)');

  const { client, prefix } = bucketFor(workspace, { env, ...bucketOptions });
  // Cards made or changed on the published site join this folder's list first, both ways: a
  // publish must not drop them, and a pull is how they arrive.
  const list = await mergeCardList({ root, bucket: client, prefix, dryRun, log });
  const { scope, named } = await scopeOf(root, cards, paths);
  // A dry run left the list alone, so the folders of the cards it would bring in are added here.
  if (dryRun && list.added.length && !named.length) {
    for (const folder of await remoteFolders(client, prefix, list.added)) if (!scope.folders.includes(folder)) scope.folders.push(folder);
  }
  const where = `s3://${client.bucket}/${prefix}`;

  if (pull) {
    // What to fetch is what the *bucket's* card list names: a card started on the phone is not in
    // the local list yet, and the local list is one of the files being fetched.
    if (!named.length) {
      const remote = await client.getJson(`${prefix}/workspace.json`).catch(() => null);
      for (const entity of remote?.value?.entities ?? []) if (entity?.folder && !scope.folders.includes(entity.folder)) scope.folders.push(entity.folder);
    }
    const result = await syncDown({ root, bucket: client, prefix, scope, dryRun, force, log });
    log(`${workspace.name} (${root}) <- ${where}\n  ${result.written.length} file(s) ${dryRun ? 'to fetch' : 'fetched'}, ${result.unchanged} unchanged${result.differs.length ? `\n  left alone, different here: ${result.differs.join(', ')}  (publish them, or --force to take the bucket's)` : ''}`);
    return { published: false, pulled: !dryRun && result.written.length > 0, workspace, ...result };
  }

  const result = await syncUp({ root, bucket: client, prefix, scope, dryRun, force, allowDeletes, listEtag: list.etag, log });
  const total = result.uploads.length + result.downloads.length + result.deletes.length;
  if (!total) {
    if (named.length) throw new Error(`Nothing published: nothing changed in ${named.join(', ')}.`);
    log(`Nothing to publish in ${workspace.name}: ${result.unchanged} file(s) already match ${where}.`);
    return { published: false, workspace, ...result };
  }
  const subject = `${result.uploads.length} file(s) ${dryRun ? 'to upload' : 'uploaded'}${result.downloads.length ? `, ${result.downloads.length} ${dryRun ? 'to bring down from the site' : 'brought down from the site'}` : ''}${result.deletes.length ? `, ${result.deletes.length} ${dryRun ? 'to delete' : 'deleted'}` : ''}`;
  log(`${workspace.name} (${root}) -> ${where}\n  ${subject}, ${result.unchanged} unchanged`);
  if (dryRun) { log('Dry run: nothing uploaded.'); return { published: false, workspace, subject, ...result }; }
  log(`Published.${workspace.site ? ` It is live now: ${workspace.site}` : ''}`);
  return { published: true, workspace, subject, ...result };
}

/**
 * Publish every registered workspace. One workspace failing is not a reason to leave the rest
 * behind, so each is attempted and the trouble is collected for the summary; the exit code at the
 * end is what tells you something needs a hand.
 */
export async function publishAll({ message, dryRun = false, pull = false, allowDeletes = false, registryFile = defaultRegistryFile(), bucketOptions = {}, log = console.log } = {}) {
  const workspaces = (await listWorkspaces({ appRepo, registryFile }))
    .filter(workspace => !workspace.builtin && workspace.exists !== false);
  if (!workspaces.length) { log('No workspaces are registered (npm run workspace add).'); return { results: [], failed: [] }; }

  const results = [];
  for (const workspace of workspaces) {
    log(`\n--- ${workspace.name}`);
    try {
      const result = await publish({ content: workspace.root, message, dryRun, pull, allowDeletes, registryFile, bucketOptions, log });
      results.push({ workspace, ...result });
    } catch (error) {
      log(`  ${error.message}`);
      results.push({ workspace, published: false, error });
    }
  }

  // A dry run never sets `published`; it reports what it would do by returning a subject.
  const line = result => (result.error ? 'needs a hand' : result.published ? 'published' : result.pulled ? 'pulled' : result.subject ? 'would publish' : 'already up to date');
  log(`\n${dryRun ? 'Dry run' : pull ? 'Pull' : 'Publish'} summary`);
  for (const result of results) log(`  ${result.workspace.name}: ${line(result)}`);
  const failed = results.filter(result => result.error);
  if (failed.length) log(`\n${failed.length} workspace(s) did not publish; their messages are above.`);
  return { results, failed };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const value = name => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
  try {
    const every = name => args.reduce((found, arg, index) => (arg === name && args[index + 1] ? [...found, args[index + 1]] : found), []);
    const message = value('-m') || value('--message');
    const dryRun = args.includes('--dry-run');
    const pull = args.includes('--pull');
    const force = args.includes('--force');
    const allowDeletes = args.includes('--allow-deletes');
    if (args.includes('--all')) {
      if (value('--content') || every('--card').length || every('--path').length) throw new Error('--all publishes whole workspaces; drop --content, --card and --path.');
      const { failed } = await publishAll({ message, dryRun, pull, allowDeletes });
      if (failed.length) process.exit(1);
    } else {
      await publish({ content: value('--content'), message, dryRun, pull, force, allowDeletes, cards: every('--card'), paths: every('--path') });
    }
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
