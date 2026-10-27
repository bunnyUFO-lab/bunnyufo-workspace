// Workspace registry: which folder of cards (workspace.json plus card folders) the app,
// scripts and skills use. The app repo's own workspace/ holds the starter examples and is
// the fallback; personal content lives in separate repos registered in a user-level file,
// so every checkout, worktree and game repo helper agrees on the active workspace.
//
// Resolution order: explicit `content` (flag) > BUW_CONTENT > BUW_WORKSPACE when it points
// straight at a content folder (otherwise it keeps meaning "the app repo") > the registry's
// active entry > <appRepo>/workspace.
// Node built-ins only: scripts, the skill helper and the packaged service all import it.
import { copyFile, mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const TEMPLATE_ID = 'template';
/** Sections agents and the Hub write through the card API; no local workspace may ever publish over them. */
export const RESERVED_IDS = new Set(['inbox', 'assistant']);
const refuseReserved = id => {
  if (RESERVED_IDS.has(id)) throw new Error(`"${id}" is written by agents and the Hub through the card API; it is never a local workspace.`);
};
/** A bucket "s3://b/sections/<id>" with a reserved id is as much a no as the id itself. */
const refuseReservedBucket = bucket => {
  if (/\/sections\//.test(String(bucket ?? ''))) refuseReserved(String(bucket).replace(/\/+$/, '').split('/').pop());
};
const windows = process.platform === 'win32';

/** Where the registry lived before the rename to bunnyUFO Workspace (2026-10-09). */
const legacyRegistryFile = () => path.join(os.homedir(), '.gdw', 'workspaces.json');

export const defaultRegistryFile = (env = process.env) => env.BUW_REGISTRY || env.GDW_REGISTRY || path.join(os.homedir(), '.buw', 'workspaces.json');

const expand = value => (value === '~' || /^~[\\/]/.test(value) ? path.join(os.homedir(), value.slice(1)) : value);
/** Absolute path with forward slashes, without a \\?\ prefix: the stored form. */
export const normalizePath = value => path.resolve(expand(String(value).replace(/^\\\\\?\\/, ''))).split(path.sep).join('/');
export const samePath = (a, b) => {
  const left = normalizePath(a), right = normalizePath(b);
  return windows ? left.toLowerCase() === right.toLowerCase() : left === right;
};
const slug = value => String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'workspace';

/** A content folder has a workspace.json with an entities array. */
export async function isContentRoot(dir) {
  try {
    const data = JSON.parse(await readFile(path.join(expand(dir), 'workspace.json'), 'utf8'));
    return Array.isArray(data?.entities);
  } catch { return false; }
}

export async function loadRegistry(file = defaultRegistryFile()) {
  const parse = text => {
    const data = JSON.parse(text);
    const workspaces = Array.isArray(data?.workspaces) ? data.workspaces.filter(item => item && typeof item.id === 'string' && typeof item.path === 'string') : [];
    return { version: 1, active: typeof data?.active === 'string' ? data.active : null, workspaces };
  };
  try {
    return parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`Cannot read the workspace registry ${file}: ${error.message}`);
  }
  // Nothing at the new path: adopt ~/.gdw/workspaces.json from before the rename, once, and
  // copy it across. Losing the registry would quietly drop every workspace the user has
  // registered and leave the app showing the starter examples instead.
  const legacy = legacyRegistryFile();
  if (file === defaultRegistryFile() && !samePath(file, legacy)) {
    try {
      const registry = parse(await readFile(legacy, 'utf8'));
      await saveRegistry(file, registry);
      process.emitWarning(`Workspace registry moved from ${legacy} to ${file}.`);
      return registry;
    } catch (error) {
      if (error.code !== 'ENOENT') process.emitWarning(`Could not adopt the old registry ${legacy}: ${error.message}`);
    }
  }
  return { version: 1, active: null, workspaces: [] };
}

async function saveRegistry(file, registry) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(registry, null, 2)}\n`);
  await rename(temp, file);
}

const template = appRepo => ({ id: TEMPLATE_ID, name: 'Starter examples', path: normalizePath(path.join(appRepo, 'workspace')), builtin: true });
// `bucket` is where the workspace publishes to, "s3://<bucket>/sections/<id>"; `repo` is only a
// source link now, for workspaces that still keep one.
const describe = (entry, extra = {}) => ({ id: entry.id, name: entry.name || entry.id, root: normalizePath(entry.path), builtin: !!entry.builtin, repo: entry.repo || null, site: entry.site || null, bucket: entry.bucket || null, ...extra });

/** Every workspace: the app's starter examples first, then the registered ones (with `exists`). */
export async function listWorkspaces({ appRepo, registryFile } = {}) {
  const registry = registryFile ? await loadRegistry(registryFile) : { active: null, workspaces: [] };
  const all = [template(appRepo), ...registry.workspaces];
  return Promise.all(all.map(async entry => describe(entry, { exists: await isContentRoot(entry.path) })));
}

async function byIdOrPath(value, { appRepo, registryFile }) {
  const all = await listWorkspaces({ appRepo, registryFile });
  const found = all.find(item => item.id === value) || all.find(item => samePath(item.root, value));
  if (found) return found;
  if (await isContentRoot(value)) return describe({ id: slug(path.basename(normalizePath(value))), path: value });
  throw new Error(`"${value}" is neither a registered workspace nor a folder with workspace.json.`);
}

/**
 * The active workspace: { id, name, root, builtin, repo, site, pinned, source }.
 * `pinned` means a flag or environment variable chose it, so the app cannot switch.
 * Without a registryFile only explicit choices and the template are considered.
 */
export async function resolveWorkspace({ appRepo, content, env = process.env, registryFile } = {}) {
  const options = { appRepo, registryFile };
  if (content) return { ...(await byIdOrPath(content, options)), pinned: true, source: 'flag' };
  // The old GDW_ names are still honoured: they are set in the user's own ~/.claude
  // settings and shell profiles, which this rename cannot reach.
  const content_env = env.BUW_CONTENT || env.GDW_CONTENT;
  const workspace_env = env.BUW_WORKSPACE || env.GDW_WORKSPACE;
  if (content_env) return { ...(await byIdOrPath(content_env, options)), pinned: true, source: env.BUW_CONTENT ? 'BUW_CONTENT' : 'GDW_CONTENT' };
  if (workspace_env && await isContentRoot(workspace_env)) return { ...(await byIdOrPath(workspace_env, options)), pinned: true, source: env.BUW_WORKSPACE ? 'BUW_WORKSPACE' : 'GDW_WORKSPACE' };
  if (registryFile) {
    const registry = await loadRegistry(registryFile);
    const entry = registry.workspaces.find(item => item.id === registry.active);
    if (entry && await isContentRoot(entry.path)) return { ...describe(entry), pinned: false, source: 'registry' };
    if (registry.active && registry.active !== TEMPLATE_ID) process.emitWarning(`Active workspace "${registry.active}" is missing or has no workspace.json; using the starter examples.`);
  }
  return { ...describe(template(appRepo)), pinned: false, source: 'template' };
}

export async function addWorkspace({ registryFile = defaultRegistryFile(), path: folder, name, id, repo, site, bucket, activate = false } = {}) {
  if (typeof folder !== 'string' || !folder.trim()) throw new Error('Choose the workspace folder.');
  if (!(await isContentRoot(folder))) throw new Error(`${folder} has no workspace.json with an "entities" list.`);
  const registry = await loadRegistry(registryFile);
  const entry = { id: slug(id || name || path.basename(normalizePath(folder))), name: name || path.basename(normalizePath(folder)), path: normalizePath(folder), ...(repo ? { repo } : {}), ...(site ? { site } : {}), ...(bucket ? { bucket } : {}), addedAt: new Date().toISOString() };
  if (entry.id === TEMPLATE_ID) throw new Error('"template" is reserved for the starter examples.');
  refuseReserved(entry.id);
  refuseReservedBucket(entry.bucket);
  if (registry.workspaces.some(item => item.id === entry.id)) throw new Error(`A workspace with id "${entry.id}" is already registered.`);
  if (registry.workspaces.some(item => samePath(item.path, entry.path))) throw new Error(`${entry.path} is already registered.`);
  registry.workspaces.push(entry);
  if (activate) registry.active = entry.id;
  await saveRegistry(registryFile, registry);
  return entry;
}

/**
 * Starts an empty workspace beside the others: a folder named after it with the app's template
 * files (not its sample cards) and an empty card list, registered. It publishes where its
 * neighbours do — a sibling's `bucket` and `site` ending in that sibling's id give this one's —
 * so `npm run publish` takes it to the site with no further setup.
 */
export async function createWorkspace({ registryFile = defaultRegistryFile(), appRepo, name, near, activate = false } = {}) {
  const wanted = String(name ?? '').trim();
  if (!wanted) throw new Error('Name the workspace.');
  const id = slug(wanted);
  if (id === TEMPLATE_ID) throw new Error('"template" is reserved for the starter examples.');
  refuseReserved(id);
  const registry = await loadRegistry(registryFile);
  if (registry.workspaces.some(item => item.id === id)) throw new Error(`A workspace with id "${id}" is already registered.`);
  const sibling = registry.workspaces.find(item => item.id === near) ?? registry.workspaces.find(item => item.id === registry.active) ?? registry.workspaces.at(-1);
  const parent = sibling ? path.dirname(normalizePath(sibling.path)) : path.join(path.dirname(registryFile), 'workspaces');
  const folder = path.join(parent, id);
  if (await exists(folder)) throw new Error(`${normalizePath(folder)} already exists.`);
  const templateDir = path.join(appRepo, 'workspace');
  // The sample cards (and the pages listing them) show the formats; a new workspace starts empty.
  const samples = new Set(['categories', 'index.md', 'workspace.json']);
  try {
    for (const card of JSON.parse(await readFile(path.join(templateDir, 'workspace.json'), 'utf8')).entities ?? []) {
      if (typeof card?.folder === 'string') samples.add(card.folder.split('/')[0]);
    }
  } catch { /* no card list in the template: copy it as it is */ }
  const copy = async (from, to) => {
    await mkdir(to, { recursive: true });
    for (const entry of await readdir(from, { withFileTypes: true })) {
      if (from === templateDir && (samples.has(entry.name) || entry.name.startsWith('sample-'))) continue;
      if (['_site', '.jekyll-cache', '.git', 'node_modules'].includes(entry.name)) continue;
      if (entry.isDirectory()) await copy(path.join(from, entry.name), path.join(to, entry.name));
      else await copyFile(path.join(from, entry.name), path.join(to, entry.name));
    }
  };
  await copy(templateDir, folder);
  await writeFile(path.join(folder, 'workspace.json'), `${JSON.stringify({ name: wanted, entities: [] }, null, 2)}
`);
  const beside = value => (sibling && typeof value === 'string' && value.endsWith(`/${sibling.id}`) ? `${value.slice(0, -sibling.id.length)}${id}` : undefined);
  return addWorkspace({ registryFile, path: folder, name: wanted, id, bucket: beside(sibling?.bucket), site: beside(sibling?.site), activate });
}

export async function useWorkspace({ registryFile = defaultRegistryFile(), id } = {}) {
  const registry = await loadRegistry(registryFile);
  if (id === TEMPLATE_ID) registry.active = null;
  else {
    const entry = registry.workspaces.find(item => item.id === id);
    if (!entry) throw new Error(`No registered workspace "${id}".`);
    if (!(await isContentRoot(entry.path))) throw new Error(`${entry.path} has no workspace.json.`);
    registry.active = id;
  }
  await saveRegistry(registryFile, registry);
  return registry.active || TEMPLATE_ID;
}

/** Change one registered workspace's `bucket`, `repo` or `site`; an empty value removes the field. */
export async function setWorkspaceFields({ registryFile = defaultRegistryFile(), id, fields = {} } = {}) {
  const registry = await loadRegistry(registryFile);
  const entry = registry.workspaces.find(item => item.id === id);
  if (!entry) throw new Error(`No registered workspace "${id}".`);
  refuseReservedBucket(fields.bucket);
  for (const name of ['bucket', 'repo', 'site', 'name']) {
    if (!(name in fields)) continue;
    if (fields[name]) entry[name] = fields[name]; else delete entry[name];
  }
  await saveRegistry(registryFile, registry);
  return entry;
}

/** Unregisters only; the folder and its files stay untouched. */
export async function removeWorkspace({ registryFile = defaultRegistryFile(), id } = {}) {
  const registry = await loadRegistry(registryFile);
  if (!registry.workspaces.some(item => item.id === id)) throw new Error(`No registered workspace "${id}".`);
  registry.workspaces = registry.workspaces.filter(item => item.id !== id);
  if (registry.active === id) registry.active = null;
  await saveRegistry(registryFile, registry);
  return registry.active || TEMPLATE_ID;
}

/** Finds a card by id in any workspace (active first): { workspace, card, folder }. */
export async function findCard({ appRepo, registryFile = defaultRegistryFile(), id, env = process.env } = {}) {
  const active = await resolveWorkspace({ appRepo, registryFile, env });
  const all = await listWorkspaces({ appRepo, registryFile });
  const ordered = [active, ...all.filter(item => !samePath(item.root, active.root))];
  for (const workspace of ordered) {
    try {
      const { entities } = JSON.parse(await readFile(path.join(workspace.root, 'workspace.json'), 'utf8'));
      const card = entities?.find(item => item.id === id);
      if (card) return { workspace, card, folder: path.join(workspace.root, card.folder) };
    } catch { /* Missing or unreadable workspace: try the next one. */ }
  }
  return null;
}

/** Is `folder` the given workspace root or inside it? */
export const insideRoot = async (root, folder) => {
  const rel = path.relative(normalizePath(root), normalizePath(folder));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

export const exists = async file => !!(await stat(file).catch(() => null));
