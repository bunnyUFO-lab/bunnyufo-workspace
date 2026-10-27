import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { addWorkspace, createWorkspace, findCard, listWorkspaces, loadRegistry, normalizePath, removeWorkspace, resolveWorkspace, setWorkspaceFields, useWorkspace } from '../workspaces.mjs';
import { createService } from '../server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const card = (id, folder = id) => ({ id, title: id, type: 'group', category: 'test', folder, steps: [{ name: 'Page', path: 'index.md' }], status: 'active' });

async function setup() {
  await mkdir(path.join(root, '.cache'), { recursive: true });
  const base = await mkdtemp(path.join(root, '.cache', 'workspaces-test-'));
  const app = path.join(base, 'app'), one = path.join(base, 'one'), two = path.join(base, 'two');
  for (const [dir, cards] of [[path.join(app, 'workspace'), [card('sample')]], [one, [card('hub-one')]], [two, [card('hub-two')]]]) {
    await mkdir(path.join(dir, '_shared'), { recursive: true });
    await writeFile(path.join(dir, 'workspace.json'), JSON.stringify({ entities: cards }));
    await writeFile(path.join(dir, '_shared', 'report.css'), 'body{}');
    for (const item of cards) {
      await mkdir(path.join(dir, item.folder), { recursive: true });
      await writeFile(path.join(dir, item.folder, 'index.md'), `# ${item.id}\n`);
      await writeFile(path.join(dir, item.folder, 'report.html'), '<link rel="stylesheet" href="../_shared/report.css">');
    }
  }
  await mkdir(path.join(app, 'ui'), { recursive: true });
  await writeFile(path.join(app, 'ui', 'index.html'), '<html></html>');
  return { base, app, one, two, registryFile: path.join(base, 'registry', 'workspaces.json') };
}

test('resolver order: flag, BUW_CONTENT, BUW_WORKSPACE (content only), registry, template', async () => {
  const { app, one, two, registryFile } = await setup();
  const resolve = (options = {}) => resolveWorkspace({ appRepo: app, registryFile, env: {}, ...options });
  assert.equal((await resolve()).id, 'template');
  assert.equal((await resolve()).root, normalizePath(path.join(app, 'workspace')));
  await addWorkspace({ registryFile, path: one, name: 'One' });
  await addWorkspace({ registryFile, path: two, name: 'Two', site: 'http://example.invalid:4001', activate: true });
  const active = await resolve();
  assert.deepEqual([active.id, active.pinned, active.source, active.site], ['two', false, 'registry', 'http://example.invalid:4001']);
  assert.equal((await resolve({ content: 'one' })).id, 'one');
  assert.equal((await resolve({ content: one })).pinned, true);
  assert.equal((await resolve({ env: { BUW_CONTENT: 'one' } })).source, 'BUW_CONTENT');
  // BUW_WORKSPACE keeps meaning "the app repo" unless it points straight at a content folder.
  assert.equal((await resolve({ env: { BUW_WORKSPACE: app } })).id, 'two');
  assert.equal((await resolve({ env: { BUW_WORKSPACE: one } })).id, 'one');
  await assert.rejects(resolve({ content: path.join(app, 'nowhere') }), /neither a registered workspace/);
  // Without a registry file only explicit choices and the template count.
  assert.equal((await resolveWorkspace({ appRepo: app, env: {} })).id, 'template');
});

test('registry: add validates and rejects duplicates, use and remove leave files alone', async () => {
  const { app, one, base, registryFile } = await setup();
  await assert.rejects(addWorkspace({ registryFile, path: base }), /no workspace\.json/);
  // Windows paths ignore case, so the same folder in capitals is a duplicate there.
  const windows = process.platform === 'win32';
  const entry = await addWorkspace({ registryFile, path: windows ? one.toUpperCase() : one, name: 'Magic Loops' });
  assert.equal(entry.id, 'magic-loops');
  await assert.rejects(addWorkspace({ registryFile, path: one, name: 'Other' }), /already registered/);
  await assert.rejects(addWorkspace({ registryFile, path: one, name: 'Magic Loops' }), /already registered/);
  await assert.rejects(addWorkspace({ registryFile, path: one, id: 'template' }), /reserved/);
  assert.equal(await useWorkspace({ registryFile, id: 'magic-loops' }), 'magic-loops');
  await assert.rejects(useWorkspace({ registryFile, id: 'missing' }), /No registered workspace/);
  assert.equal(await useWorkspace({ registryFile, id: 'template' }), 'template');
  assert.equal(await removeWorkspace({ registryFile, id: 'magic-loops' }), 'template');
  assert.deepEqual((await loadRegistry(registryFile)).workspaces, []);
  assert.ok((await readdir(one)).includes('workspace.json'), 'Removing only unregisters.');
  const list = await listWorkspaces({ appRepo: app, registryFile });
  assert.deepEqual(list.map(item => [item.id, item.exists]), [['template', true]]);
});

test('the inbox and assistant sections are never local workspaces', async () => {
  const { app, one, two, registryFile } = await setup();
  await assert.rejects(addWorkspace({ registryFile, path: one, id: 'inbox' }), /written by agents and the Hub/);
  await assert.rejects(createWorkspace({ registryFile, appRepo: app, name: 'Assistant' }), /"assistant" is written by agents/);
  await assert.rejects(addWorkspace({ registryFile, path: two, id: 'two', bucket: 's3://b/sections/inbox' }), /never a local workspace/);
  const entry = await addWorkspace({ registryFile, path: two, name: 'Two' });
  for (const bucket of ['s3://b/sections/inbox', 's3://b/sections/assistant/']) {
    await assert.rejects(setWorkspaceFields({ registryFile, id: entry.id, fields: { bucket } }), /never a local workspace/);
  }
  await setWorkspaceFields({ registryFile, id: entry.id, fields: { bucket: 's3://b/sections/two' } });
});

test('registry: create starts an empty workspace beside the active one, publishing where it does', async () => {
  const { app, one, base, registryFile } = await setup();
  await addWorkspace({ registryFile, path: one, id: 'one', name: 'One', bucket: 's3://cards/sections/one', site: 'http://example.invalid/one', activate: true });
  const entry = await createWorkspace({ registryFile, appRepo: app, name: 'Pixel Scenery' });
  assert.deepEqual([entry.id, entry.name, entry.bucket, entry.site], ['pixel-scenery', 'Pixel Scenery', 's3://cards/sections/pixel-scenery', 'http://example.invalid/pixel-scenery']);
  assert.equal(entry.path, normalizePath(path.join(base, 'pixel-scenery')));
  assert.deepEqual(JSON.parse(await readFile(path.join(base, 'pixel-scenery', 'workspace.json'), 'utf8')), { name: 'Pixel Scenery', entities: [] });
  assert.deepEqual((await readdir(path.join(base, 'pixel-scenery'))).sort(), ['_shared', 'workspace.json'], 'The template files come along, its sample cards do not.');
  await assert.rejects(createWorkspace({ registryFile, appRepo: app, name: 'Pixel Scenery' }), /already registered/);
  await assert.rejects(createWorkspace({ registryFile, appRepo: app, name: 'Template' }), /reserved/);
  await assert.rejects(createWorkspace({ registryFile, appRepo: app, name: '  ' }), /Name the workspace/);
});

test('an invalid active entry falls back to the template', async () => {
  const { app, registryFile } = await setup();
  await mkdir(path.dirname(registryFile), { recursive: true });
  await writeFile(registryFile, JSON.stringify({ version: 1, active: 'gone', workspaces: [{ id: 'gone', name: 'Gone', path: path.join(app, 'missing') }] }));
  const warnings = [];
  const listener = warning => warnings.push(warning.message);
  process.on('warning', listener);
  try { assert.equal((await resolveWorkspace({ appRepo: app, registryFile, env: {} })).id, 'template'); }
  finally { await new Promise(resolve => setImmediate(resolve)); process.off('warning', listener); }
});

test('findCard searches every workspace, active first', async () => {
  const { app, one, two, registryFile } = await setup();
  await addWorkspace({ registryFile, path: one, name: 'One' });
  await addWorkspace({ registryFile, path: two, name: 'Two', activate: true });
  const found = await findCard({ appRepo: app, registryFile, id: 'hub-one', env: {} });
  assert.equal(found.workspace.id, 'one');
  assert.equal(normalizePath(found.folder), normalizePath(path.join(one, 'hub-one')));
  assert.equal(await findCard({ appRepo: app, registryFile, id: 'nope', env: {} }), null);
});

test('the service switches workspaces: registry, files and content server', async () => {
  const { app, one, two, registryFile } = await setup();
  await addWorkspace({ registryFile, path: one, name: 'One', activate: true });
  await addWorkspace({ registryFile, path: two, name: 'Two' });
  const service = await createService({ repo: app, uiDir: path.join(app, 'ui'), registryFile });
  const request = (route, data) => fetch(service.origin + '/api' + route, { method: data === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${service.token}`, 'Content-Type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) });
  try {
    const bootstrap = await (await request('/bootstrap')).json();
    assert.equal(bootstrap.workspace.id, 'one');
    assert.deepEqual((await (await request('/workspace')).json()).entities.map(item => item.id), ['hub-one']);
    // A report in a workspace outside the app repo can load ../_shared from its own workspace.
    const report = await fetch(`${bootstrap.workspace.contentBase}/hub-one/report.html`);
    assert.equal(report.status, 200);
    assert.equal((await fetch(new URL('../_shared/report.css', report.url))).status, 200);
    const list = await (await request('/workspaces')).json();
    assert.equal(list.canSwitch, true);
    assert.deepEqual(list.workspaces.map(item => item.id), ['template', 'one', 'two']);
    assert.equal((await request('/workspaces/remove', { id: 'one' })).status, 409, 'The active workspace cannot be removed.');
    const switched = await (await request('/workspaces/switch', { id: 'two' })).json();
    assert.equal(switched.active.id, 'two');
    assert.deepEqual((await (await request('/workspace')).json()).entities.map(item => item.id), ['hub-two']);
    assert.equal((await fetch(`${bootstrap.workspace.contentBase}/hub-one/report.html`)).status, 404, 'The old workspace grant is revoked.');
    assert.equal((await loadRegistry(registryFile)).active, 'two');
    const main = await (await request('/files')).json();
    assert.ok(main.entries.some(item => item.name === 'Workspace: two'), 'The Files rail shows the active workspace outside the repo.');
    assert.equal((await request('/workspaces/add', { path: path.join(app, 'ui') })).status, 400);
  } finally { await service.close(); }
});

test('a workspace fixed by --content cannot be switched', async () => {
  const { app, one, two, registryFile } = await setup();
  await addWorkspace({ registryFile, path: two, name: 'Two' });
  const service = await createService({ repo: app, uiDir: path.join(app, 'ui'), registryFile, content: one });
  const request = (route, data) => fetch(service.origin + '/api' + route, { method: data === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${service.token}`, 'Content-Type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) });
  try {
    const list = await (await request('/workspaces')).json();
    assert.equal(list.active.pinned, true);
    assert.equal(list.canSwitch, false);
    assert.equal((await request('/workspaces/switch', { id: 'two' })).status, 409);
    assert.equal((await loadRegistry(registryFile)).active, null);
  } finally { await service.close(); }
});

test('without a registry the service shows the app\'s own workspace and refuses switching', async () => {
  const { app } = await setup();
  const service = await createService({ repo: app, uiDir: path.join(app, 'ui') });
  try {
    const headers = { Authorization: `Bearer ${service.token}`, 'Content-Type': 'application/json' };
    const bootstrap = await (await fetch(service.origin + '/api/bootstrap', { headers })).json();
    assert.equal(bootstrap.workspace.builtin, true);
    assert.equal((await fetch(service.origin + '/api/workspaces/switch', { method: 'POST', headers, body: '{"id":"x"}' })).status, 409);
    assert.match(await readFile(path.join(app, 'workspace', 'workspace.json'), 'utf8'), /sample/);
  } finally { await service.close(); }
});

test('with a bucket registered, pins live in the shared state object the site reads', async () => {
  const { startFakeS3 } = await import('../../site/api/test/fake-s3.mjs');
  const fake = await startFakeS3();
  try {
    const { app, one, registryFile } = await setup();
    await addWorkspace({ registryFile, path: one, name: 'One', bucket: `s3://${fake.bucket}/sections/one`, activate: true });
    const service = await createService({ repo: app, uiDir: path.join(app, 'ui'), registryFile, bucketOptions: { endpoint: fake.endpoint, credentials: fake.credentials, region: 'us-east-1' } });
    try {
      const request = (route, data) => fetch(`${service.origin}/api${route}`, { method: data === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${service.token}`, 'Content-Type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) });
      assert.equal((await (await request('/bootstrap')).json()).cardStore, 'bucket');
      assert.equal((await request('/workspace/pin', { workspace: 'one', id: 'hub-one', pinned: true, order: 0 })).status, 200);
      assert.deepEqual(fake.json('state.json').cards['one/hub-one'], { pinned: true, pinOrder: 0 }, 'The pin is in the bucket, where the site reads it.');
      // Made on the phone meanwhile: the desktop shows it on its next read.
      fake.seed('state.json', JSON.stringify({ version: 1, cards: { 'one/hub-one': { pinned: true, pinOrder: 0, tags: ['phone'] } } }), 'application/json');
      await new Promise(resolve => setTimeout(resolve, 10));
      const all = await (await request('/workspace/all')).json();
      const shown = all.workspaces.find(item => item.id === 'one');
      assert.equal(shown.bucket, `s3://${fake.bucket}/sections/one`);
      // Cached for a few seconds, so this read may still be the old one; a write always re-reads.
      await request('/workspace/tags', { workspace: 'one', id: 'hub-one', tags: ['desk'] });
      assert.deepEqual(fake.json('state.json').cards['one/hub-one'], { pinned: true, pinOrder: 0, tags: ['desk'] });
      const files = await readdir(path.join(app, '.buw')).catch(() => []);
      assert.ok(!files.includes('card-state.json'), 'No local copy is kept when the bucket holds the state.');
    } finally { await service.close(); }
  } finally { await fake.close(); }
});
