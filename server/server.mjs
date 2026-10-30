import http from 'node:http';
import path from 'node:path';
import { readFile, realpath } from 'node:fs/promises';
import os from 'node:os';
import { watch } from 'node:fs';
import { WebSocketServer, WebSocket } from 'ws';
import { Files, serveFile } from './files.mjs';
import { importFile, moveFile, MAX_FILE_BYTES } from './file-transfers.mjs';
import { ContextLibrary } from './context.mjs';
import { McpInventory } from './mcp.mjs';
import { body, equalSecret, json, publicError, readJson, realFile, saveJson, secret } from './util.mjs';
import { ProjectAdapterRegistry } from './project-adapters/registry.mjs';
import { KnowledgeManager, MarkdownKnowledgeProvider } from './knowledge/providers.mjs';
import { IntegrationManager } from './integrations/manager.mjs';
import { addWorkspace, createWorkspace, listWorkspaces, loadRegistry, removeWorkspace, resolveWorkspace, samePath, useWorkspace } from './workspaces.mjs';
// Two modules shared with the published site's API (site/api is rsynced whole to the server, so
// the files travel with that deploy and this service imports them from where they live).
import { createBucketCardStore, createCardStore, validEmoji } from '../site/api/card-state.mjs';
import { createBucket, loadCredentials, parseS3Url } from '../site/api/s3.mjs';
import { cardRoute, cardWriter, folderStore } from '../site/api/card-writes.mjs';
import { createHub } from '../site/api/hub.mjs';

/**
 * Where pinned, archived and tags live. When a bucket is known — BUW_S3_BUCKET, or the bucket any
 * registered workspace publishes to — and this machine has credentials for it, it is the same
 * state.json the published site uses, so a pin made on a phone is the pin the desktop shows.
 * Otherwise a local file in .buw, exactly as before.
 */
async function chooseBucket({ registryFile, env = process.env, bucketOptions = {} }) {
  let name = env.BUW_S3_BUCKET || null;
  if (!name && registryFile) {
    try { name = (await loadRegistry(registryFile)).workspaces.map(item => parseS3Url(item.bucket)?.bucket).find(Boolean) || null; }
    catch { name = null; }
  }
  if (name && (bucketOptions.credentials || await loadCredentials(env))) {
    return createBucket({ bucket: name, region: env.BUW_S3_REGION || undefined, ...bucketOptions });
  }
  return null;
}

async function chooseCardStore({ stateDir, registryFile, env = process.env, bucketOptions = {} }) {
  const bucket = await chooseBucket({ registryFile, env, bucketOptions });
  return bucket ? createBucketCardStore(bucket) : createCardStore(path.join(stateDir, 'card-state.json'));
}

/**
 * Where the service listens. The default is unchanged: a random port on the loopback
 * address, which is what every test assumes.
 *
 * In a container there is no shell and no loopback to share, so BUW_HOST and BUW_PORT open
 * it up, and BUW_PUBLIC_ORIGIN says what address a browser will actually use — behind a
 * reverse proxy that is not the address the process binds, and every Host, Origin, CSP and
 * WebSocket check in here is derived from it.
 */
/** The card API's address for pages: BUW_CARD_API, else "cardApi" in ~/.buw/config.json (BUW_CONFIG moves it), else null. Read per request so edits show at once. */
async function configuredCardApi() {
  let value = process.env.BUW_CARD_API || '';
  if (!value) {
    try {
      value = JSON.parse(await readFile(process.env.BUW_CONFIG || path.join(os.homedir(), '.buw', 'config.json'), 'utf8')).cardApi;
    } catch {
      value = '';
    }
  }
  return typeof value === 'string' && /^https?:\/\//.test(value) ? value.replace(/\/+$/, '') : null;
}

const listen = (server, { host = '127.0.0.1', port = 0, publicOrigin } = {}) =>
  new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(publicOrigin || `http://${host.includes(':') ? `[${host}]` : host}:${server.address().port}`));
  });

// registryFile: the user's workspace registry (see workspaces.mjs). Without one (tests), only
// `content` or the app's own workspace/ is used. content: a folder or id that pins the workspace.
export async function createService({ repo, uiDir, stateDir, token = secret(), mcpOptions, registryFile, content, host, port, publicOrigin, contentPort, contentOrigin, bucketOptions, hubOptions }) {
  // Everything below is unchanged when these are unset, which is how local runs and
  // the tests run: loopback, a random port, and an origin nobody else can reach.
  const bind = { host: host || process.env.BUW_HOST || '127.0.0.1', port: Number(port ?? process.env.BUW_PORT ?? 0) };
  const publicAddress = publicOrigin || process.env.BUW_PUBLIC_ORIGIN || null;
  repo = await realpath(repo);
  stateDir ||= path.join(repo, '.buw');
  const files = new Files(repo);
  const library = new ContextLibrary(repo);
  const knowledgeSources = await readJson(path.join(stateDir, 'knowledge-sources.json'), []);
  const knowledgeProviders = (Array.isArray(knowledgeSources) ? knowledgeSources : []).filter(item => typeof item?.root === 'string').map(item => new MarkdownKnowledgeProvider(item.root, { id: item.id, label: item.label }));
  const knowledge = new KnowledgeManager(library, knowledgeProviders);
  const projects = new ProjectAdapterRegistry();
  const integrations = await new IntegrationManager(stateDir).init();
  const mcp = new McpInventory(repo, mcpOptions);
  const settingsPath = path.join(stateDir, 'settings.json');
  // Pinned, archived, tags and the pinned list's order. Not in a workspace folder: a card's content
  // is what gets published, and which cards you keep in front of you is not. In the cards bucket
  // when there is one (shared with the site), else in .buw. See site/api/card-state.mjs.
  const cardState = await chooseCardStore({ stateDir, registryFile, bucketOptions });
  // The Hub (site/api/hub.mjs) over the same bucket, when this machine has one: the inbox the site shows.
  const hubEnv = { ...process.env, ...hubOptions?.env };
  const hubBucket = await chooseBucket({ registryFile, env: hubEnv, bucketOptions });
  const hub = createHub({ bucket: hubBucket, prefix: hubEnv.BUW_S3_PREFIX || 'sections', enabled: !!hubBucket && hubEnv.HUB !== '0', env: hubEnv, fetchImpl: hubOptions?.fetchImpl });
  // Only the Workspace window's own preferences remain; older chat and voice settings are dropped.
  const saved = await readJson(settingsPath, {});
  const settings = { workspaceTheme: ['dark', 'light', 'system'].includes(saved.workspaceTheme) ? saved.workspaceTheme : 'dark', workspaceRoute: typeof saved.workspaceRoute === 'string' ? saved.workspaceRoute : null };
  let settingsTimer;
  let settingsSave = Promise.resolve();
  const saveSettings = () => { settingsSave = settingsSave.catch(() => {}).then(() => saveJson(settingsPath, settings)); return settingsSave; };
  const scheduleSettings = () => { clearTimeout(settingsTimer); settingsTimer = setTimeout(() => saveSettings().catch(() => {}), 500); };
  let closing = false;
  const clients = new Set();
  const send = (ws, type, value) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type, ...value })); };
  const broadcast = (type, value) => { for (const ws of clients) send(ws, type, value); };
  // The active workspace: where workspace.json and the card folders live.
  let active;
  let watchers = [];
  const writers = new Map();
  const describeActive = () => ({ id: active.id, name: active.name, root: active.root, builtin: active.builtin, pinned: active.pinned, repo: active.repo, site: active.site, bucket: active.bucket, contentBase: `${files.origin}/view/${files.workspaceGrant}` });
  // Every workspace the app shows cards from: the registered ones, with the active one's resolved
  // root, so that one list can hold them all and the project filter is the only thing that narrows
  // it. A session pinned to one workspace (--content, BUW_CONTENT) keeps showing only that one.
  const allWorkspaces = async () => {
    const listed = registryFile && !active.pinned ? await listWorkspaces({ appRepo: repo, registryFile }) : [];
    const entries = listed.map(item => (item.id === active.id || samePath(item.root, active.root) ? { ...item, ...describeActive(), exists: true } : item));
    if (!entries.some(item => item.id === active.id)) entries.unshift({ ...describeActive(), exists: true });
    return entries.filter(item => item.exists);
  };
  const workspaceRoot = async id => {
    if (!id || id === active.id) return active.root;
    const found = (await allWorkspaces()).find(item => item.id === id);
    if (!found) throw Object.assign(new Error(`No workspace "${id}" in this session.`), { status: 404 });
    return found.root;
  };
  const bindWatchers = async () => {
    for (const item of watchers) item.close();
    watchers = [];
    if (closing) return;
    // Watch each folder: saveJson writes a temp file and renames it over workspace.json. Cards from
    // every workspace are on screen at once, so a change in any of them has to reach the app.
    for (const { root } of await allWorkspaces()) {
      try {
        const watcher = watch(root, (event, name) => { if (!name || name === 'workspace.json') broadcast('workspace-changed', {}); });
        watcher.on('error', () => {});
        watchers.push(watcher);
      } catch { /* Folder may appear after first setup. */ }
    }
  };
  const activate = async chosen => {
    const root = await realpath(chosen.root).catch(() => path.resolve(chosen.root));
    active = { ...chosen, root };
    files.setWorkspace(root);
    await bindWatchers();
    return active;
  };
  const registry = async () => readJson(path.join(active.root, 'workspace.json'), { entities: [] });
  /** The cards of every workspace, each with the base its files are served from. */
  const allCards = async () => ({
    active: active.id,
    workspaces: await Promise.all((await allWorkspaces()).map(async item => {
      const { entities, retired } = await readJson(path.join(item.root, 'workspace.json'), { entities: [] });
      return {
        id: item.id, name: item.name, root: item.root, builtin: !!item.builtin, repo: item.repo || null,
        site: item.site || null, bucket: item.bucket || null, active: item.id === active.id,
        ...(retired && typeof retired === 'object' && !Array.isArray(retired) ? { retired } : {}),
        contentBase: `${files.origin}/view/${files.cardGrant(item.root)}`,
        // What the file says, with what has been pinned or put away since laid over it.
        entities: await cardState.decorate(item.id, Array.isArray(entities) ? entities : []),
      };
    })),
  });
  const contentServer = http.createServer(async (request, response) => {
    try {
      if (request.headers.host !== new URL(files.origin).host || !['GET', 'HEAD'].includes(request.method)) throw Object.assign(new Error('Not allowed'), { status: 403 });
      await files.content(request, response, new URL(request.url, files.origin));
    // The app reads these answers cross-origin (its HEAD check before showing a page), so an error
    // carries the same CORS header as a file: without it the browser hides the 404 behind a network error.
    } catch (error) { if (!response.headersSent) json(response, error.status || 404, { error: publicError(error) }, { 'Access-Control-Allow-Origin': files.uiOrigin }); }
  });
  files.origin = await listen(contentServer, { host: bind.host, port: Number(contentPort ?? process.env.BUW_CONTENT_PORT ?? 0), publicOrigin: contentOrigin || process.env.BUW_CONTENT_ORIGIN || null });
  await activate(await resolveWorkspace({ appRepo: repo, content, registryFile, env: registryFile ? process.env : {} }));

  function authorize(request) {
    if (request.headers.host !== new URL(origin).host) throw Object.assign(new Error('Unexpected host'), { status: 403 });
    if (request.headers.origin && request.headers.origin !== origin) throw Object.assign(new Error('Unexpected origin'), { status: 403 });
    if (!equalSecret(request.headers.authorization, `Bearer ${token}`)) throw Object.assign(new Error('Open bunnyUFO Workspace from the address its service printed'), { status: 401 });
  }
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, origin);
      if (request.headers.host !== new URL(origin).host) throw Object.assign(new Error('Unexpected host'), { status: 403 });
      if (url.pathname === '/health') return json(response, 200, { service: 'buw', version: '0.4.14' });
      // The edit-mode frame's own document. A srcdoc frame inherits the app's policy, whose base-uri,
      // style-src and font-src refuse the page's relative stylesheets and images; a frame with its
      // own response gets a policy written for editing. It holds nothing, so it needs no token.
      if (url.pathname === '/html-editor-frame') {
        if (!['GET', 'HEAD'].includes(request.method)) throw Object.assign(new Error('Not allowed'), { status: 405 });
        response.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
          'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'SAMEORIGIN',
          'Content-Security-Policy': `default-src 'none'; script-src 'none'; style-src 'unsafe-inline' ${files.origin} https:; font-src ${files.origin} https: data:; img-src ${files.origin} https: data: blob:; media-src ${files.origin} https: blob:; connect-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri ${files.origin}; frame-ancestors 'self'`,
        });
        return response.end(request.method === 'HEAD' ? undefined : '<!doctype html><meta charset="utf-8"><title>Editing</title>');
      }
      if (url.pathname.startsWith('/api/')) {
        authorize(request);
        const method = request.method;
        // What this host can do, read once by the page before it mounts. Behind the token like every
        // /api route: a 401 here means the service is present and the page is not signed in.
        if (method === 'GET' && url.pathname === '/api/capabilities') return json(response, 200, {
          write: true, create: false, cards: true,
          files: true, mcp: true, saves: true, settings: true, workspaces: true, live: true,
          routes: 'hash', // no SPA fallback here: keep the project out of the path
          cardApi: await configuredCardApi(),
          ...hub.capabilities({ signedIn: true, requireRemoteUser: false }),
        });
        if (url.pathname.startsWith('/api/hub/')) {
          if (await hub.handle({ request, response, method, route: url.pathname.slice(4), query: url.searchParams, user: 'local' })) return;
        }
        if (method === 'POST' && url.pathname === '/api/files/import') {
          if (Number(request.headers['content-length']) > MAX_FILE_BYTES) throw Object.assign(new Error('Choose files of 1 GB or less.'), { status: 413 });
          const result = await importFile(request, url.searchParams.get('folder'), url.searchParams.get('name'));
          await integrations.publish('artifact', { kind: 'imported', ...result });
          broadcast('workspace-changed', {});
          return json(response, 201, result);
        }
        const data = ['POST', 'PATCH', 'PUT', 'DELETE'].includes(method) ? await body(request, url.pathname === '/api/cards/drawing' ? 8 * 1024 * 1024 : ['/api/files/markdown', '/api/cards/markdown'].includes(url.pathname) ? 12 * 1024 * 1024 : 256 * 1024) : {};
        // Cards made and edited by hand, the same routes the published site answers. One store per
        // folder, so its writes queue behind each other. Not into the starter examples: those ship
        // with the app and an update would take a card made there away.
        const card = await cardRoute({
          method, route: url.pathname.slice(4), query: url.searchParams, data, state: cardState,
          writerFor: async id => {
            const found = (await allWorkspaces()).find(item => item.id === (id || active.id));
            if (!found) throw Object.assign(new Error(`No workspace "${id}" in this session.`), { status: 404 });
            if (found.builtin) throw Object.assign(new Error('The starter examples are read-only; register a workspace of your own to add cards.'), { status: 409 });
            if (!writers.has(found.root)) writers.set(found.root, cardWriter(folderStore(found.root), { section: found.id }));
            return writers.get(found.root);
          },
        });
        if (card) {
          if (method !== 'GET') broadcast('workspace-changed', {});
          return json(response, card.status, card.body);
        }
        if (method === 'GET' && url.pathname === '/api/bootstrap') {
          return json(response, 200, { repo, contentBase: `${files.origin}/view/${files.repoGrant}`, workspace: describeActive(), settings, cardStore: cardState.kind });
        }
        if (method === 'GET' && url.pathname === '/api/workspace') return json(response, 200, await registry());
        if (method === 'GET' && url.pathname === '/api/workspace/all') return json(response, 200, await allCards());
        // Pinned, archived and the order of the pinned list: not content, so not a write into
        // workspace.json. They go to .buw/card-state.json, which means an agent's card files and
        // a human's reading of them stay exactly as committed while the app's own view of what
        // matters changes as often as it likes. The card must exist in the workspace it names —
        // the grid holds cards from all of them and an id alone is not unique across them.
        const findCard = async (workspace, id) => {
          const stored = await readJson(path.join(await workspaceRoot(workspace), 'workspace.json'), null);
          const entity = Array.isArray(stored?.entities) ? stored.entities.find(item => item?.id === id) : null;
          if (!entity) throw Object.assign(new Error('No card with that id in this workspace.'), { status: 404 });
          return entity;
        };
        if (method === 'POST' && url.pathname === '/api/workspace/status') {
          if (!['active', 'archived'].includes(data.status)) throw new Error('Unknown card status');
          await findCard(data.workspace, data.id);
          const state = await cardState.setStatus(data.workspace ?? active.id, data.id, data.status);
          broadcast('workspace-changed', {});
          return json(response, 200, { id: data.id, status: state.status, updated: state.restoredAt });
        }
        if (method === 'POST' && url.pathname === '/api/workspace/pin') {
          if (typeof data.pinned !== 'boolean') throw new Error('Say whether the card is pinned.');
          if (data.order !== undefined && !(Number.isInteger(data.order) && data.order >= 0)) throw new Error('A pin position is a whole number from 0.');
          await findCard(data.workspace, data.id);
          const state = await cardState.setPinned(data.workspace ?? active.id, data.id, data.pinned, data.order);
          broadcast('workspace-changed', {});
          return json(response, 200, { id: data.id, pinned: !!state.pinned, pinOrder: state.pinOrder });
        }
        if (method === 'POST' && url.pathname === '/api/workspace/tags') {
          if (!Array.isArray(data.tags) || data.tags.some(tag => typeof tag !== 'string')) throw new Error('Tags are a list of strings.');
          await findCard(data.workspace, data.id);
          const state = await cardState.setTags(data.workspace ?? active.id, data.id, data.tags);
          broadcast('workspace-changed', {});
          return json(response, 200, { id: data.id, tags: state.tags ?? [] });
        }
        if (method === 'POST' && url.pathname === '/api/workspace/icon') {
          if (!validEmoji(data.emoji)) throw new Error('An icon is one emoji, or empty to go back to the card’s own.');
          await findCard(data.workspace, data.id);
          const state = await cardState.setEmoji(data.workspace ?? active.id, data.id, data.emoji);
          broadcast('workspace-changed', {});
          return json(response, 200, { id: data.id, emoji: state.emoji ?? null });
        }
        // The whole pinned list in one write. A reorder moves several cards at once and they can
        // live in different workspaces; one request per card left the list visibly half-sorted.
        if (method === 'POST' && url.pathname === '/api/workspace/pins') {
          const list = Array.isArray(data.list) ? data.list : null;
          if (!list?.length) throw new Error('Say which cards are pinned, in order.');
          const ordered = [];
          for (const item of list) {
            if (!item?.id) throw new Error('Every pinned card needs an id.');
            await findCard(item.workspace, item.id);
            ordered.push({ id: item.id, workspace: item.workspace ?? active.id });
          }
          const pins = await cardState.setPins(ordered);
          broadcast('workspace-changed', {});
          return json(response, 200, { pins });
        }
        // The same overlay the published site serves, for anything reading cards without
        // going through /api/workspace/all.
        if (method === 'GET' && url.pathname === '/api/card-state') {
          return json(response, 200, { cards: await cardState.all() });
        }
        if (method === 'GET' && url.pathname === '/api/workspaces') {
          const all = await listWorkspaces({ appRepo: repo, registryFile });
          return json(response, 200, { active: describeActive(), workspaces: all, canSwitch: !!registryFile && !active.pinned });
        }
        if (method === 'POST' && ['/api/workspaces/add', '/api/workspaces/new', '/api/workspaces/switch', '/api/workspaces/remove'].includes(url.pathname)) {
          if (!registryFile) throw Object.assign(new Error('This app session has no workspace registry.'), { status: 409 });
          if (url.pathname === '/api/workspaces/add') {
            const entry = await addWorkspace({ registryFile, path: data.path, name: data.name, repo: data.repo, site: data.site, bucket: data.bucket });
            await bindWatchers();
            broadcast('workspace-changed', {});
            return json(response, 201, { added: entry, workspaces: await listWorkspaces({ appRepo: repo, registryFile }) });
          }
          if (url.pathname === '/api/workspaces/new') {
            const entry = await createWorkspace({ registryFile, appRepo: repo, name: data.name, near: active.id });
            await bindWatchers();
            broadcast('workspace-changed', {});
            return json(response, 201, { added: entry, workspaces: await listWorkspaces({ appRepo: repo, registryFile }) });
          }
          if (url.pathname === '/api/workspaces/remove') {
            if (data.id === active.id) throw Object.assign(new Error('Switch to another workspace before removing this one.'), { status: 409 });
            await removeWorkspace({ registryFile, id: data.id });
            await bindWatchers();
            return json(response, 200, { workspaces: await listWorkspaces({ appRepo: repo, registryFile }) });
          }
          if (active.pinned) throw Object.assign(new Error(`The workspace is fixed by ${active.source} for this session.`), { status: 409 });
          await useWorkspace({ registryFile, id: data.id });
          await activate(await resolveWorkspace({ appRepo: repo, registryFile }));
          settings.workspaceRoute = null; scheduleSettings();
          broadcast('workspace-switched', { workspace: describeActive() }); broadcast('workspace-changed', {});
          return json(response, 200, { active: describeActive() });
        }
        if (method === 'GET' && url.pathname === '/api/projects') {
          const matches = await projects.detect(url.searchParams.get('path') || repo);
          return json(response, 200, { matches, adapters: projects.adapters.map(item => ({ id: item.id, label: item.label })) });
        }
        if (method === 'GET' && url.pathname === '/api/projects/capabilities') {
          const matches = await projects.detect(url.searchParams.get('path') || repo);
          const selected = matches.find(item => item.adapterId === (url.searchParams.get('adapter') || matches[0]?.adapterId));
          return json(response, 200, selected ? await projects.capabilities(selected) : { matches: [] });
        }
        if (method === 'GET' && url.pathname === '/api/knowledge/providers') return json(response, 200, knowledge.list());
        if (method === 'GET' && url.pathname === '/api/knowledge/search') return json(response, 200, await knowledge.search(url.searchParams.get('q') || '', url.searchParams.get('provider')));
        if (method === 'GET' && url.pathname === '/api/knowledge/document') return json(response, 200, await knowledge.retrieve(url.searchParams.get('provider') || '', url.searchParams.get('ref') || '', url.searchParams.get('offset')));
        if (method === 'GET' && url.pathname === '/api/integrations') return json(response, 200, { providers: integrations.list(), bindings: integrations.bindings.map(({ providerId, externalId, workspaceId, boundAt }) => ({ providerId, externalId, workspaceId, boundAt })) });
        if (method === 'POST' && url.pathname === '/api/integrations/bind') return json(response, 200, await integrations.bind(data));
        if (method === 'GET' && url.pathname === '/api/mcp') return json(response, 200, await mcp.list());
        if (method === 'POST' && url.pathname === '/api/mcp/check') return json(response, 200, await mcp.check(data.id));
        if (method === 'GET' && url.pathname === '/api/files') return json(response, 200, await files.list(url.searchParams.get('path') || repo, url.searchParams.get('mode') || 'main', url.searchParams.get('q') || ''));
        if (method === 'POST' && url.pathname === '/api/files/move') {
          const result = await moveFile(data.path, data.folder);
          broadcast('workspace-changed', {});
          return json(response, 200, result);
        }
        if (method === 'GET' && url.pathname === '/api/files/source') return json(response, 200, await files.source(url.searchParams.get('path') || ''));
        if (method === 'GET' && url.pathname === '/api/preview') return json(response, 200, await files.preview(url.searchParams.get('path') || ''));
        if (method === 'POST' && url.pathname === '/api/files/markdown') {
          const preview = await files.saveMarkdown(data); await integrations.publish('artifact', { kind: 'updated', path: preview.path, name: preview.name }); broadcast('workspace-changed', {});
          return json(response, 200, preview);
        }
        if (method === 'POST' && url.pathname === '/api/settings') {
          if (['dark', 'light', 'system'].includes(data.workspaceTheme)) settings.workspaceTheme = data.workspaceTheme;
          await saveSettings(); broadcast('settings', { settings }); return json(response, 200, settings);
        }
        throw Object.assign(new Error('Endpoint not found'), { status: 404 });
      }
      if (!['GET', 'HEAD'].includes(request.method)) throw Object.assign(new Error('Not allowed'), { status: 405 });
      const relative = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
      const { file, info } = await realFile(uiDir, relative);
      if (!info.isFile()) throw new Error('File not found');
      // Live tool tabs (card steps with `url`) may be on the LAN, e.g. a home server or the GPU PC,
      // so http: joins https: for frames and their reachability check. Reports stay on files.origin.
      await serveFile(request, response, file, info, {
        'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
        'Content-Security-Policy': `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: blob: ${files.origin} https://raw.githubusercontent.com; media-src 'self' blob: ${files.origin}; connect-src 'self' ${wsOrigin} ${files.origin} http: https:; frame-src ${files.origin} http: https:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'`,
      });
    } catch (error) { if (!response.headersSent) json(response, error.status || 400, { error: publicError(error), ...(error.current !== undefined ? { current: error.current } : {}) }); }
  });
  const origin = await listen(server, { ...bind, publicOrigin: publicAddress });
  // The page opens its WebSocket against its own origin, so the policy has to name that one:
  // wss when the page is https (behind a proxy), ws otherwise.
  const wsOrigin = origin.replace(/^http/, 'ws');
  files.uiOrigin = origin;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024 });
  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url, origin);
    if (request.headers.host !== new URL(origin).host || request.headers.origin !== origin || url.pathname !== '/events') { socket.destroy(); return; }
    wss.handleUpgrade(request, socket, head, ws => wss.emit('connection', ws));
  });
  wss.on('connection', ws => {
    ws.authenticated = false;
    const authTimer = setTimeout(() => ws.close(1008, 'Authentication required'), 5000);
    ws.on('message', async raw => {
      try {
        const message = JSON.parse(raw.toString());
        if (!ws.authenticated) {
          if (message.type !== 'auth' || !equalSecret(message.token, token)) return ws.close(1008, 'Authentication failed');
          ws.authenticated = true; ws.clientId = message.clientId; clients.add(ws); clearTimeout(authTimer);
          send(ws, 'connected', {}); return;
        }
        if (message.type === 'workspace-route') { settings.workspaceRoute = String(message.route || '').slice(0, 500); scheduleSettings(); }
        else if (message.type === 'ping') send(ws, 'pong', {});
      } catch (error) { send(ws, 'service-error', { error: publicError(error) }); }
    });
    ws.on('close', () => { clearTimeout(authTimer); clients.delete(ws); });
    ws.on('error', () => {});
  });
  return {
    origin, contentOrigin: files.origin, token, files, projects, knowledge, integrations,
    urls: { workspace: `${origin}/?token=${token}` },
    async close() {
      if (closing) return; closing = true; mcp.close(); await files.writes.catch(() => {});
      for (const item of watchers) item.close(); watchers = []; clearTimeout(settingsTimer); await saveSettings();
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      server.closeAllConnections(); contentServer.closeAllConnections();
      await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => contentServer.close(resolve))]);
    },
  };
}
