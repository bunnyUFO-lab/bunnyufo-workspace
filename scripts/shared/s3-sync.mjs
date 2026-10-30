// Mirror a workspace folder into its place in the cards bucket, and back.
//
// A workspace on disk is the working copy; the bucket is what the site serves. Publishing is the
// diff between the two: every file in scope whose md5 differs from the ETag the bucket lists is
// uploaded, and every object in scope with no file behind it any more is deleted. Nothing outside
// the scope — another card, a stray file, the Jekyll scaffolding — is touched, so several agents
// can publish their own cards from one folder without sweeping up each other's work.
//
// `pull` is the other direction, for a section started from a phone or edited on another machine.
//
// Both directions remember what the two sides held after the last sync (.buw/sync.json in the
// workspace), which is what tells "changed here" from "changed on the site": a card made or a
// section edited on the published site comes down on the next publish instead of being written
// over, a file changed on both sides is reported and left alone, and the card list is merged card
// by card. Without that record (a workspace's first sync) a publish keeps its old rule — this
// folder wins — unless the bucket's copy is the newer one, which it reports instead.
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { contentTypeOf } from '../../site/api/s3.mjs';

/** Folders never uploaded from anywhere in the tree. */
const SKIP_DIRS = new Set(['.git', '_site', '.jekyll-cache', 'node_modules', '.buw']);
/** The Just the Docs scaffolding at a workspace root: `npm run docs` wants it, the site does not. */
const SKIP_ROOT = new Set(['Gemfile', 'Gemfile.lock', '_config.yml', 'docker-compose.yml', 'index.md', '.gitignore', 'README.md', '_sass', 'categories']);
const SECRET = /(^|\/)(\.env(\..*)?|.*\.(pem|key|p12|pfx)|id_(rsa|ed25519)(\.pub)?|.*(secret|credential|password|token).*\.(json|txt|ya?ml))$/i;
export const MAX_BYTES = 50 * 1024 * 1024;

const md5 = buffer => createHash('md5').update(buffer).digest('hex');
const toPosix = value => value.split(path.sep).join('/');

/**
 * The files a publish owns. Named cards or paths win; otherwise every registered card folder,
 * the card list and the shared report assets.
 */
export async function defaultScope(root) {
  const registry = JSON.parse(await readFile(path.join(root, 'workspace.json'), 'utf8'));
  const folders = (registry.entities || []).filter(entity => entity?.folder).map(entity => entity.folder);
  return { folders: [...new Set([...folders, '_shared'])], files: ['workspace.json'], prefixes: [] };
}

/**
 * Where cards save what a viewer enters (workspace/_shared/card-data.js, through the app's card bridge).
 * Written by the browser, never by a folder on disk, so no publish may upload, delete or pull it,
 * even when a card folder or a named path would otherwise cover it.
 */
export const RESPONSES_DIR = 'card-responses';

export const inScope = (file, scope) =>
  file !== RESPONSES_DIR && !file.startsWith(`${RESPONSES_DIR}/`) && (
  scope.files.includes(file) ||
  scope.prefixes.some(prefix => file.startsWith(prefix)) ||
  scope.folders.some(folder => file === folder || file.startsWith(`${folder}/`)));

/** Every file under root worth considering, as posix paths relative to root. */
async function walk(root) {
  const found = [];
  const visit = async (dir, relative) => {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || (!relative && SKIP_ROOT.has(entry.name))) continue;
        await visit(path.join(dir, entry.name), rel);
      } else if (entry.isFile()) {
        if (!relative && SKIP_ROOT.has(entry.name)) continue;
        found.push(rel);
      }
    }
  };
  await visit(root, '');
  return found.sort();
}

/** What both sides held after the last sync, per bucket place: file → etag, and the card list. */
const BASE_FILE = path.join('.buw', 'sync.json');

async function loadBase(root, where) {
  try {
    const all = JSON.parse(await readFile(path.join(root, BASE_FILE), 'utf8'));
    const mine = all?.[where];
    return { files: { ...(mine?.files ?? {}) }, list: mine?.list ?? null };
  } catch {
    return { files: {}, list: null };
  }
}

async function saveBase(root, where, base) {
  const file = path.join(root, BASE_FILE);
  let all = {};
  try { all = JSON.parse(await readFile(file, 'utf8')) ?? {}; } catch { /* first sync */ }
  all[where] = { files: base.files, list: base.list };
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(all, null, 2)}\n`);
  await rename(temp, file);
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const placeOf = (bucket, prefix) => `${bucket.bucket}/${prefix ? `${prefix.replace(/\/+$/, '')}/` : ''}`;

/** One card changed on both sides: each field from the side that changed it, sections from both. */
function mergeCard(base, local, remote, notes = []) {
  const out = { ...local };
  for (const key of new Set([...Object.keys(local), ...Object.keys(remote)])) {
    if (key === 'steps') continue;
    if (base && same(local[key], base[key]) && !same(remote[key], base[key])) {
      if (key in remote) out[key] = remote[key]; else delete out[key];
    }
  }
  // Tabs, three ways. Untouched here since the last sync: the site's tabs and their order, as they
  // are. Otherwise this folder's order, minus a tab the site removed on purpose (unless it was
  // changed here since), plus a tab only the site has, unless it was removed here on purpose (it
  // is in the last sync and unchanged on the site). The same file on both: a tab only the other
  // side renamed takes its name, otherwise this folder's wins.
  const stepKey = step => `${step?.path}|${step?.url ?? ''}`;
  const wasStep = step => base?.steps?.find(item => stepKey(item) === stepKey(step));
  const theirSteps = Array.isArray(remote.steps) ? remote.steps : [];
  const onSite = new Set(theirSteps.map(stepKey));
  if (base && Array.isArray(base.steps) && same(local.steps, base.steps) && Array.isArray(remote.steps)) {
    out.steps = [...theirSteps];
    mergeRemovedTabs(out, local, remote);
    return out;
  }
  const steps = (Array.isArray(local.steps) ? local.steps : []).filter(step => {
    const was = wasStep(step);
    return onSite.has(stepKey(step)) || !was || !same(step, was);
  });
  for (const step of theirSteps) {
    const index = steps.findIndex(item => stepKey(item) === stepKey(step));
    if (index >= 0) {
      if (base && same(steps[index], wasStep(step))) steps[index] = step;
    } else if (!(wasStep(step) && same(step, wasStep(step)))) steps.push(step);
  }
  out.steps = steps;
  mergeRemovedTabs(out, local, remote);
  // Each side deleted a different tab of a card with two: it must keep one. The tab deleted here stays.
  if (!steps.length) {
    const back = (base?.steps ?? []).find(item => !(local.steps ?? []).some(own => stepKey(own) === stepKey(item))) ?? (base?.steps ?? [])[0];
    if (back) {
      out.steps = [back];
      mergeRemovedTabs(out, local, remote);
      notes.push(`  the card "${local.id}" would have no tabs left (each side deleted one); the tab "${back.name ?? back.path}" is kept`);
    }
  }
  return out;
}

/** Tabs deleted on either side: both lists together (newest record of a tab wins), at most 50, none that is back in the steps. */
function mergeRemovedTabs(out, local, remote) {
  if (!Array.isArray(local.removedTabs) && !Array.isArray(remote.removedTabs)) return;
  const key = tab => `${tab?.path}|${tab?.url ?? ''}`;
  const live = new Set(out.steps.map(key));
  const byKey = new Map();
  for (const tab of [...(Array.isArray(local.removedTabs) ? local.removedTabs : []), ...(Array.isArray(remote.removedTabs) ? remote.removedTabs : [])]) {
    if (!tab || live.has(key(tab))) continue;
    const have = byKey.get(key(tab));
    if (!have || String(tab.at ?? '') >= String(have.at ?? '')) { byKey.delete(key(tab)); byKey.set(key(tab), tab); }
  }
  const merged = [...byKey.values()].slice(-50);
  if (merged.length) out.removedTabs = merged; else delete out.removedTabs;
}

/**
 * Three-way merge of a card list. A card only one side changed takes that side; a card made on
 * one side is added; a card gone from one side and untouched on the other is gone. With no record
 * of the last sync, every card on either side is kept and this folder's version of a card wins.
 */
export function mergeCardLists(base, local, remote, notes = []) {
  const ids = list => new Map((Array.isArray(list?.entities) ? list.entities : []).filter(item => item?.id).map(item => [item.id, item]));
  const B = ids(base), L = ids(local), R = ids(remote);
  const merged = { ...local };
  for (const key of new Set([...Object.keys(local ?? {}), ...Object.keys(remote ?? {})])) {
    if (key === 'entities' || key === 'retired') continue;
    if (base && same(local?.[key], base[key]) && !same(remote?.[key], base[key])) merged[key] = remote[key];
  }
  // `retired` is the record of cards moved to another workspace or put in the Trash. Both the site
  // and the local app write it, so it merges per card against the last sync: a record only one side
  // added, changed or removed (a restore) takes that side; on a clash the bucket's wins. A card on
  // it stays out of this list whatever the local copy says (its folder is left on disk and is no
  // longer published).
  const mergedRetired = {};
  const LR = local?.retired ?? {}, RR = remote?.retired ?? {}, BR = base?.retired ?? {};
  for (const id of new Set([...Object.keys(LR), ...Object.keys(RR), ...Object.keys(BR)])) {
    const l = LR[id], r = RR[id], b = BR[id];
    let value;
    if (same(l, r)) value = l;
    else if (same(l, b)) value = r;
    else if (same(r, b)) value = l;
    else value = r ?? l;
    if (value !== undefined) mergedRetired[id] = value;
  }
  if (Object.keys(mergedRetired).length) merged.retired = mergedRetired; else delete merged.retired;
  const retired = mergedRetired;
  // A card deleted here (a record added or changed here) is deleted whatever the site did to it since.
  const deletedHere = id => LR[id] && !same(LR[id], BR[id]);
  const entities = [];
  for (const card of Array.isArray(local?.entities) ? local.entities : []) {
    if (!card?.id) { entities.push(card); continue; }
    const theirs = R.get(card.id), was = B.get(card.id);
    // A card made here (not in the last sync) that reuses a retired id is kept; mergeCardList says so.
    if (!theirs && retired[card.id] && (was || !base)) continue;
    if (!theirs) {
      // Gone from the bucket: removed there. Untouched here since, so let it go.
      if (was && same(card, was)) continue;
      entities.push(card);
    } else if (same(card, theirs) || (was && same(theirs, was))) entities.push(card);
    else if (was && same(card, was)) entities.push(theirs);
    else entities.push(mergeCard(was ?? null, card, theirs, notes));
  }
  for (const [id, card] of R) {
    if (L.has(id)) continue;
    // Deleted here, edited there: the delete wins, and Restore gives back the site's newer version.
    if (deletedHere(id) && retired[id]) {
      if (retired[id].kind === 'deleted') retired[id] = { ...retired[id], entity: card };
      continue;
    }
    // New there (not in the last sync): bring it in. In the last sync and gone from here: removed
    // here, unless it changed there since.
    if (!B.has(id) || !same(card, B.get(id))) entities.push(card);
  }
  merged.entities = entities;
  return merged;
}

/**
 * Bring the bucket's card list and this folder's together before anything else is compared, so a
 * card made on the site is in the scope (its folder comes down) and in what goes back up.
 *
 * @returns {{ merged: boolean, added: string[], etag: string|null }} whether the local list changed, the cards it gained,
 *   and the ETag of the bucket's list that was merged (the upload is conditional on it)
 */
export async function mergeCardList({ root, bucket, prefix, dryRun = false, log = () => {} }) {
  const base = prefix ? `${prefix.replace(/\/+$/, '')}/` : '';
  const file = path.join(root, 'workspace.json');
  const localText = await readFile(file, 'utf8');
  const remote = await bucket.getJson(`${base}workspace.json`);
  if (!remote || remote.etag === md5(Buffer.from(localText))) return { merged: false, added: [], etag: remote?.etag ?? null };
  const record = await loadBase(root, placeOf(bucket, prefix));
  const local = JSON.parse(localText);
  const notes = [];
  const result = mergeCardLists(record.list, local, remote.value, notes);
  const live = new Set((remote.value?.entities ?? []).map(item => item?.id));
  // An id that is retired on the site stays taken: a card made here with it would sit live next to
  // its own Trash or move record. The whole publish stops, before anything is written.
  const clash = (result.entities ?? []).filter(item => item?.id && !live.has(item.id) && result.retired?.[item.id]);
  if (clash.length) {
    const what = item => (result.retired[item.id].kind === 'moved' ? `moved to ${result.retired[item.id].to ?? 'another workspace'}` : 'is in the Trash');
    throw new Error(`Nothing published: ${clash.map(item => `the card "${item.id}" made here reuses an id that was ${what(item).replace('is in', 'put in')} on the site`).join('; ')}. Give it another id (or restore the old card on the site), then publish again.`);
  }
  for (const note of notes) log(note);
  if (same(result, local)) return { merged: false, added: [], etag: remote.etag };
  const known = new Set((local.entities ?? []).map(item => item?.id));
  const added = (result.entities ?? []).filter(item => item?.id && !known.has(item.id)).map(item => item.id);
  const kept = new Set((result.entities ?? []).map(item => item?.id));
  for (const item of local.entities ?? []) {
    const record = item?.id && !kept.has(item.id) ? result.retired?.[item.id] : null;
    if (record) log(`  retired: ${item.id} (${record.kind === 'moved' ? `moved to ${record.to ?? 'another workspace'}` : 'in the Trash'}); its local folder is no longer published`);
  }
  log(`  card list: ${added.length ? `${added.length} card(s) from the site (${added.join(', ')})` : 'changes from the site'} ${dryRun ? 'to merge in' : 'merged in'}`);
  if (!dryRun) {
    const temp = `${file}.${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify(result, null, 2)}\n`);
    await rename(temp, file);
  }
  return { merged: true, added, etag: remote.etag };
}

/** More deletes than this in one publish of one workspace is refused without --allow-deletes. */
export const MAX_DELETES = 5;

/**
 * Compare the folder with the bucket, then (unless dryRun) upload, bring down and delete.
 *
 * A publish that would delete more than `maxDeletes` objects stops before it writes anything, so a
 * folder that lost its files (a wrong path, a failed checkout) cannot empty the site. `allowDeletes`
 * is the "yes, I meant that".
 *
 * `listEtag` is the ETag of the bucket's card list that `mergeCardList` merged. The list is uploaded only
 * if the bucket still holds that version; if the site changed it meanwhile, it is merged again (twice at
 * most) and the publish then stops with a message rather than overwrite the change.
 *
 * A file changed only on the site comes down instead of being written over; one changed on both
 * sides is a conflict, left alone and reported, unless `force` (this folder's copy goes up).
 *
 * @returns {{ uploads: string[], downloads: string[], deletes: string[], conflicts: string[], unchanged: number, problems: string[] }}
 */
export async function syncUp({ root, bucket, prefix, scope, dryRun = false, force = false, allowDeletes = false, maxDeletes = MAX_DELETES, listEtag = null, log = () => {} }) {
  const base = prefix ? `${prefix.replace(/\/+$/, '')}/` : '';
  const where = placeOf(bucket, prefix);
  const record = await loadBase(root, where);
  const local = (await walk(root)).filter(file => inScope(file, scope));
  const { objects } = await bucket.list(base);
  const remote = new Map(objects.map(object => [object.key.slice(base.length), object]));

  const problems = [];
  const uploads = [];
  const downloads = [];
  const conflicts = [];
  const settled = {};
  let unchanged = 0;
  for (const file of local) {
    if (SECRET.test(file)) { problems.push(`${file}: looks like a secret`); continue; }
    const info = await stat(path.join(root, file));
    if (info.size > MAX_BYTES) { problems.push(`${file}: ${(info.size / 1048576).toFixed(0)} MB is over the 50 MB limit`); continue; }
    const have = remote.get(file);
    const mine = md5(await readFile(path.join(root, file)));
    if (have && have.etag === mine) { unchanged += 1; settled[file] = mine; continue; }
    const was = record.files[file];
    // New here, changed only here, or the card list (already merged with the bucket's): up.
    if (!have || force || file === 'workspace.json' || (was && have.etag === was)) { uploads.push(file); continue; }
    // Changed only on the site: down.
    if (was && mine === was) { downloads.push(file); continue; }
    // No record yet (a first sync): this folder wins as it always did, unless the bucket's copy is
    // the newer one. That, or a change on both sides, is for a person to settle.
    if (!was && !(Date.parse(have.lastModified) > info.mtimeMs)) { uploads.push(file); continue; }
    conflicts.push(file);
  }
  const deletes = [];
  for (const [file, object] of remote) {
    if (!file || file.endsWith('/') || !inScope(file, scope) || local.includes(file)) continue;
    // Removed here since the last sync and untouched there: remove it there too. Anything else
    // missing here is new on the site (a card's page, an added section) and comes down.
    if (record.files[file] && record.files[file] === object.etag) deletes.push(file);
    else downloads.push(file);
  }
  deletes.sort(); downloads.sort();
  if (problems.length) throw new Error(`Nothing published. Fix these first:\n  ${problems.join('\n  ')}`);
  if (!allowDeletes && deletes.length > maxDeletes) {
    const message = `${deletes.length} files would be deleted from ${where} (limit ${maxDeletes}):\n  ${deletes.join('\n  ')}`;
    if (!dryRun) throw new Error(`Nothing published: ${message}\nCheck them, then publish again with --allow-deletes.`);
    log(`  Warning: ${message}\n  A real publish stops here unless it is run with --allow-deletes.`);
  }
  if (conflicts.length) log(`  changed here and on the site, left alone (compare them, or publish with --force to keep this folder's):\n    ${conflicts.join('\n    ')}`);

  if (!dryRun) {
    for (const file of uploads) {
      let body = await readFile(path.join(root, file));
      if (file === 'workspace.json' && listEtag) {
        let etag = listEtag;
        for (let attempt = 0; ; attempt += 1) {
          try {
            await bucket.put(`${base}${toPosix(file)}`, body, { contentType: contentTypeOf(file), ifMatch: etag });
            break;
          } catch (error) {
            if (error.status !== 412) throw error;
            if (attempt >= 2) throw new Error('The card list changed on the site during the publish, so it was not uploaded. Run the publish again.');
            log('  the card list changed on the site meanwhile; merging again');
            etag = (await mergeCardList({ root, bucket, prefix, log })).etag;
            body = await readFile(path.join(root, file));
          }
        }
      } else {
        await bucket.put(`${base}${toPosix(file)}`, body, { contentType: contentTypeOf(file) });
      }
      settled[file] = md5(body);
      log(`  up   ${file}`);
    }
    for (const file of downloads) {
      const got = await bucket.get(`${base}${file}`);
      const body = Buffer.from(await new Response(got.body).arrayBuffer());
      const target = path.join(root, ...file.split('/'));
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, body);
      settled[file] = md5(body);
      log(`  down ${file}`);
    }
    for (const file of deletes) {
      await bucket.del(`${base}${file}`);
      delete record.files[file];
      log(`  gone ${file}`);
    }
    Object.assign(record.files, settled);
    if (settled['workspace.json']) record.list = JSON.parse(await readFile(path.join(root, 'workspace.json'), 'utf8'));
    await saveBase(root, where, record);
  }
  return { uploads, downloads, deletes, conflicts, unchanged, problems };
}

/**
 * Bring the bucket's copy of the scope down into the folder. Missing files are written, and so is
 * one that changed only on the site since the last sync; one changed here (or on both sides, or
 * with no record to tell) is reported and left, unless `force`. Nothing local is deleted.
 *
 * @returns {{ written: string[], differs: string[], unchanged: number }}
 */
export async function syncDown({ root, bucket, prefix, scope, dryRun = false, force = false, log = () => {} }) {
  const base = prefix ? `${prefix.replace(/\/+$/, '')}/` : '';
  const where = placeOf(bucket, prefix);
  const record = await loadBase(root, where);
  const { objects } = await bucket.list(base);
  const written = [];
  const differs = [];
  let unchanged = 0;
  for (const object of objects) {
    const file = object.key.slice(base.length);
    if (!file || file.endsWith('/') || !inScope(file, scope)) continue;
    const target = path.join(root, ...file.split('/'));
    const info = await stat(target).catch(() => null);
    if (info) {
      const mine = md5(await readFile(target));
      if (object.etag === mine) { unchanged += 1; record.files[file] = mine; continue; }
      const was = record.files[file];
      if (!force && !(was && was === mine)) { differs.push(file); continue; }
    }
    if (!dryRun) {
      const got = await bucket.get(object.key);
      const body = Buffer.from(await new Response(got.body).arrayBuffer());
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, body);
      record.files[file] = md5(body);
      log(`  down ${file}`);
    }
    written.push(file);
  }
  if (!dryRun) {
    if (record.files['workspace.json']) record.list = JSON.parse(await readFile(path.join(root, 'workspace.json'), 'utf8'));
    await saveBase(root, where, record);
  }
  return { written, differs, unchanged };
}
