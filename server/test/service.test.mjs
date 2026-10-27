import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import http from 'node:http';
import { createService } from '../server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
async function fixture() {
  await mkdir(path.join(root, '.cache'), { recursive: true });
  const repo = await mkdtemp(path.join(root, '.cache', 'service-test-'));
  await mkdir(path.join(repo, 'workspace', 'A space'), { recursive: true });
  await mkdir(path.join(repo, 'inbox')); await mkdir(path.join(repo, 'projects'));
  await mkdir(path.join(repo, 'ui'));
  await writeFile(path.join(repo, 'ui', 'index.html'), '<html>bunnyUFO Workspace UI</html>');
  await writeFile(path.join(repo, 'workspace', 'workspace.json'), JSON.stringify({ entities: [] }));
  await writeFile(path.join(repo, 'workspace', 'A space', 'report.html'), '<html><img src="image.bin"></html>');
  await writeFile(path.join(repo, 'workspace', 'A space', 'image.bin'), Buffer.from('0123456789'));
  await writeFile(path.join(repo, '.env'), 'OPENAI_KEY=not-a-real-key\n');
  const service = await createService({ repo, uiDir: path.join(repo, 'ui'), hubOptions: { env: { BUW_S3_BUCKET: '' } } });
  const request = (route, data, headers = {}) => fetch(service.origin + '/api' + route, { method: data === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${service.token}`, 'Content-Type': 'application/json', ...headers }, body: data === undefined ? undefined : JSON.stringify(data) });
  return { repo, service, request };
}

test('local authorization and report isolation protect the local service', async () => {
  const { service, request, repo } = await fixture();
  try {
    assert.equal((await fetch(service.origin + '/api/bootstrap')).status, 401);
    assert.equal((await fetch(service.origin + '/api/mcp')).status, 401);
    assert.equal((await fetch(service.origin + '/api/capabilities')).status, 401);
    delete process.env.BUW_CARD_API; process.env.BUW_CONFIG = path.join(repo, 'no-config.json');
    const capabilities = await (await request('/capabilities')).json();
    assert.deepEqual(capabilities, { write: true, create: false, cards: true, files: true, mcp: true, saves: true, settings: true, workspaces: true, live: true, routes: 'hash', cardApi: null, hub: false, chat: false, transcribe: false });
    await writeFile(path.join(repo, 'config.json'), JSON.stringify({ cardApi: 'https://api.example.net/' }));
    process.env.BUW_CONFIG = path.join(repo, 'config.json');
    assert.equal((await (await request('/capabilities')).json()).cardApi, 'https://api.example.net', 'From config.json, read per request.');
    process.env.BUW_CARD_API = 'http://127.0.0.1:9';
    assert.equal((await (await request('/capabilities')).json()).cardApi, 'http://127.0.0.1:9', 'BUW_CARD_API wins.');
    delete process.env.BUW_CARD_API; delete process.env.BUW_CONFIG;
    assert.equal((await request('/mcp/check', { id: 'not-a-server' }, { Origin: 'https://unrelated.example' })).status, 403);
    assert.equal((await request('/bootstrap', undefined, { Origin: 'https://unrelated.example' })).status, 403);
    const wrongHost = await new Promise(resolve => { http.get(service.origin + '/api/bootstrap', { headers: { Host: 'attacker.example', Authorization: `Bearer ${service.token}` } }, response => { response.resume(); resolve(response.statusCode); }); });
    assert.equal(wrongHost, 403);
    const bootstrap = await (await request('/bootstrap')).json();
    assert.deepEqual(Object.keys(bootstrap.settings).sort(), ['workspaceRoute', 'workspaceTheme']);
    assert.equal(JSON.stringify(bootstrap).includes('not-a-real-key'), false);
    assert.notEqual(new URL(bootstrap.contentBase).origin, service.origin);
    const report = service.files.url(path.join(repo, 'workspace', 'A space', 'report.html'));
    const response = await fetch(report);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /image\.bin/);
    const image = await fetch(new URL('image.bin', report), { headers: { Range: 'bytes=3-6' } });
    assert.equal(image.status, 206); assert.equal(await image.text(), '3456');
    const suffix = await fetch(new URL('image.bin', report), { headers: { Range: 'bytes=-3' } });
    assert.equal(await suffix.text(), '789');
    assert.equal((await fetch(new URL('image.bin', report), { headers: { Range: 'bytes=30-50' } })).status, 416);
    assert.equal((await fetch(bootstrap.contentBase + '/.env')).status, 403);
    assert.equal((await fetch(bootstrap.contentBase + '/%2e%2e%5c.env')).status, 403);
    assert.equal((await request('/bootstrap', undefined, { Origin: service.contentOrigin })).status, 403);
    const ui = await fetch(service.origin);
    assert.equal(ui.headers.get('x-frame-options'), 'DENY');
    // Live web tabs (card steps with `url`) embed local and LAN apps such as Sprite Studio or ComfyUI on the GPU PC.
    assert.match(ui.headers.get('content-security-policy'), /frame-src [^;]* http: https:/);
    assert.match(ui.headers.get('content-security-policy'), /script-src 'self';/, 'Scripts stay limited to the app itself.');
    // Edit mode's frame has a policy of its own, written for editing; the app's stays as it was.
    assert.match(ui.headers.get('content-security-policy'), /base-uri 'self'/);
    const editFrame = await fetch(service.origin + '/html-editor-frame');
    assert.equal(editFrame.status, 200);
    const editPolicy = editFrame.headers.get('content-security-policy');
    assert.match(editPolicy, new RegExp(`base-uri [^;]*${service.contentOrigin}`));
    assert.match(editPolicy, /script-src 'none'/);
    assert.match(editPolicy, /frame-ancestors 'self'/);
    assert.equal(editFrame.headers.get('x-frame-options'), 'SAMEORIGIN');
    // A missing page answers with its real status and the CORS header the app needs to read it.
    const missing = await fetch(bootstrap.contentBase + '/missing.html', { method: 'HEAD' });
    assert.equal(missing.status, 404);
    assert.equal(missing.headers.get('access-control-allow-origin'), service.origin);
    const main = await (await request('/files')).json();
    assert.deepEqual(main.entries.map(item => item.name).sort(), ['inbox', 'projects', 'workspace']);
    const all = await (await request('/files?mode=all')).json();
    assert.ok(all.entries.some(item => item.name === '.env'));
    const envPreview = await (await request('/preview?path=' + encodeURIComponent(path.join(repo, '.env')))).json();
    assert.equal(envPreview.kind, 'text'); // The authorized local user retains access.
  } finally { await service.close(); }
});

test('websocket rejects report origins and unauthenticated messages', async () => {
  const { service } = await fixture();
  try {
    const wrong = new WebSocket(service.origin.replace('http:', 'ws:') + '/events', { origin: service.contentOrigin });
    await new Promise(resolve => wrong.on('error', resolve));
    const socket = new WebSocket(service.origin.replace('http:', 'ws:') + '/events', { origin: service.origin });
    await new Promise(resolve => socket.on('open', resolve));
    const closed = new Promise(resolve => socket.on('close', code => resolve(code)));
    socket.send(JSON.stringify({ type: 'input', id: 'anything', data: 'whoami\r' }));
    assert.equal(await closed, 1008);
  } finally { await service.close(); }
});

test('context access reads project guidance and excludes credential and runtime files', async () => {
  const { service, repo } = await fixture();
  try {
    const { ContextLibrary } = await import('../context.mjs');
    const library = new ContextLibrary(repo);
    await writeFile(path.join(repo, 'projects', 'brief.md'), '# Project brief\nA task description.');
    assert.match((await library.read('projects/brief.md')).text, /task description/);
    await assert.rejects(library.read('.env'), /Private runtime/);
    await mkdir(path.join(repo, '.buw'), { recursive: true });
    await writeFile(path.join(repo, '.buw', 'runtime.json'), '{}');
    await assert.rejects(library.read('.buw/runtime.json'), /Private runtime/);
  } finally { await service.close(); }
});

test('the archive button writes card state, not the card’s own file', async () => {
  const { service, request, repo } = await fixture();
  const file = path.join(repo, 'workspace', 'workspace.json');
  const published = JSON.stringify({ entities: [{ id: 'card', folder: 'A space', title: 'A card', created: '2026-01-01', updated: '2026-01-01', status: 'active', steps: [] }] });
  const cards = async () => (await (await request('/workspace/all')).json()).workspaces[0].entities;
  try {
    await writeFile(file, published);
    assert.equal((await request('/workspace/status', { id: 'card', status: 'deleted' })).status, 400);
    assert.equal((await request('/workspace/status', { id: 'missing', status: 'archived' })).status, 404);
    const archived = await (await request('/workspace/status', { id: 'card', status: 'archived' })).json();
    assert.equal(archived.status, 'archived');
    assert.equal((await cards())[0].status, 'archived', 'The app sees it at once.');
    assert.equal((await cards())[0].updated, '2026-01-01', 'Archiving a card leaves its date alone.');
    // The card's own file is content, and content takes a commit. This was not one.
    assert.equal(await readFile(file, 'utf8'), published, 'workspace.json is untouched.');
    assert.equal(JSON.parse(await readFile(path.join(repo, '.buw', 'card-state.json'), 'utf8')).cards['template/card'].status, 'archived');
    // Bringing a card back counts as a touch; without it the 7-day date rule would archive it again at once.
    const restored = await (await request('/workspace/status', { id: 'card', status: 'active' })).json();
    assert.equal(restored.status, 'active');
    assert.equal(restored.updated, new Date().toISOString().slice(0, 10));
    assert.equal((await cards())[0].updated, restored.updated, 'The overlay carries the fresh date.');
  } finally { await service.close(); }
});

test('the pin button writes card state, and unpinning takes the place in the list away', async () => {
  const { service, request, repo } = await fixture();
  const file = path.join(repo, 'workspace', 'workspace.json');
  const published = JSON.stringify({ entities: [{ id: 'card', folder: 'A space', title: 'A card', created: '2026-01-01', updated: '2026-01-01', status: 'active', steps: [] }] });
  const shown = async () => (await (await request('/workspace/all')).json()).workspaces[0].entities[0];
  try {
    await writeFile(file, published);
    assert.equal((await request('/workspace/pin', { id: 'card' })).status, 400);
    assert.equal((await request('/workspace/pin', { id: 'missing', pinned: true })).status, 404);
    assert.equal((await (await request('/workspace/pin', { id: 'card', pinned: true })).json()).pinned, true);
    assert.equal((await shown()).pinned, true);
    // Pinning does not touch the dates: it says where a card is shown, not that it was worked on.
    assert.equal((await shown()).updated, '2026-01-01');
    // A place in the list is stored per card, because the list mixes workspaces.
    assert.equal((await request('/workspace/pin', { id: 'card', pinned: true, order: -1 })).status, 400);
    assert.equal((await (await request('/workspace/pin', { id: 'card', pinned: true, order: 2 })).json()).pinOrder, 2);
    assert.equal((await shown()).pinOrder, 2);
    assert.equal((await (await request('/workspace/pin', { id: 'card', pinned: false })).json()).pinned, false);
    const after = await shown();
    assert.ok(!('pinned' in after), 'An unpinned card carries no pinned key.');
    assert.ok(!('pinOrder' in after), '…and no place in a list it is not on.');
    assert.equal(await readFile(file, 'utf8'), published, 'None of it was a write into the card list.');
    assert.equal((await (await request('/card-state')).json()).cards['template/card'].pinned, false);
  } finally { await service.close(); }
});
test('cards are made and edited in a workspace folder, never in the starter examples', async () => {
  const { repo, service, request } = await fixture();
  let own;
  try {
    assert.equal((await request('/cards', { title: 'Nope' })).status, 409, 'The starter examples ship with the app.');
    const folder = path.join(repo, 'mine');
    await mkdir(folder);
    await writeFile(path.join(folder, 'workspace.json'), JSON.stringify({ entities: [] }));
    own = await createService({ repo, uiDir: path.join(repo, 'ui'), content: folder });
    const ask = (route, data) => fetch(own.origin + '/api' + route, { method: data === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${own.token}`, 'Content-Type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) });
    const made = await ask('/cards', { title: 'Desk notes' });
    assert.equal(made.status, 201);
    const { card } = await made.json();
    assert.equal(await readFile(path.join(folder, card.folder, 'index.md'), 'utf8'), '# Desk notes\n\n');
    const { path: file } = await (await ask('/cards/section', { id: card.id, name: 'Later' })).json();
    const opened = await (await ask(`/cards/markdown?id=${card.id}&path=${file}`)).json();
    assert.equal((await ask('/cards/markdown', { id: card.id, path: file, text: '# Later\n\nSoon.\n', base: opened.etag })).status, 200);
    assert.equal(await readFile(path.join(folder, card.folder, file), 'utf8'), '# Later\n\nSoon.\n');
    assert.equal(JSON.parse(await readFile(path.join(folder, 'workspace.json'), 'utf8')).entities[0].steps.length, 2);
  } finally { await own?.close(); await service.close(); }
});
