// Run after npm run build. One project selector in the Library, through a real browser, at 1280 and 390 wide.
// The project filter is the only control that picks a project: there is no workspace switcher, a new card always shows its
// target, and workspaces are made and managed in Settings. Two hosts: a stand-in for the published site's data service, and
// the local service (isolated repository and registry; temporary folders are the only things written).
import { chromium } from '@playwright/test';
import { ms } from './ui-timeouts.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { listenOnGoodPort } from '../listen.mjs';
import { createService } from '../server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
await mkdir(path.join(root, '.cache'), { recursive: true });
const today = new Date().toISOString().slice(0, 10);
const step = name => console.log(`- ${name}`);

const entity = (id, title, extra = {}) => ({
  id, folder: id, title, description: `${title} fixture.`, category: 'ideas', created: today, updated: today, status: 'active',
  steps: [{ name: 'Overview', path: 'overview.md' }], ...extra,
});
const sendJson = (response, status, value) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); };

/** A stand-in for the published site's data service, serving the built app. */
async function startSite(data, capabilities = { write: true, create: true, cards: true }) {
  const calls = [];
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://site');
    if (url.pathname === '/api/capabilities') return sendJson(response, 200, capabilities);
    if (url.pathname === '/api/card-state') return sendJson(response, 200, { cards: {} });
    if (url.pathname === '/sites.json') return sendJson(response, 200, Object.entries(data).map(([id, item]) => ({ id, name: item.name, base: `/w/${id}`, ...(item.archived ? { archived: true } : {}) })));
    const listed = /^\/w\/([^/]+)\/workspace\.json$/.exec(url.pathname);
    if (listed && data[listed[1]]) return sendJson(response, 200, { name: data[listed[1]].name, entities: data[listed[1]].entities });
    const page = /^\/w\/([^/]+)\/([^/]+)\/overview\.md$/.exec(url.pathname);
    if (page && data[page[1]]) {
      const card = data[page[1]].entities.find(item => item.folder === page[2]);
      if (card) { response.writeHead(200, { 'Content-Type': 'text/markdown' }); return response.end(`# ${card.title}\n\nBody of ${card.title}.\n`); }
    }
    if (url.pathname === '/api/cards/markdown' && request.method === 'GET') {
      const card = data[url.searchParams.get('workspace')]?.entities.find(item => item.id === url.searchParams.get('id'));
      return sendJson(response, 200, { text: `# ${card?.title}

Body of ${card?.title}.
`, etag: 'x' });
    }
    if (request.method === 'POST' && url.pathname.startsWith('/api/')) {
      let text = '';
      for await (const chunk of request) text += chunk;
      const body = text ? JSON.parse(text) : {};
      calls.push([url.pathname, body]);
      if (url.pathname === '/api/cards') {
        const card = entity(`made-${calls.length}`, body.title);
        data[body.workspace].entities.push(card);
        return sendJson(response, 200, { card });
      }
      if (url.pathname === '/api/sections/archive') { data[body.workspace].archived = body.archived || undefined; return sendJson(response, 200, { id: body.workspace, archived: body.archived }); }
      return sendJson(response, 200, {});
    }
    try {
      const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      const body = await readFile(path.join(root, 'dist', file));
      response.writeHead(200, { 'Content-Type': file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' });
      return response.end(body);
    } catch { response.writeHead(200, { 'Content-Type': 'text/html' }); return response.end(await readFile(path.join(root, 'dist/index.html'))); }
  });
  await listenOnGoodPort(server, '127.0.0.1');
  return { origin: `http://127.0.0.1:${server.address().port}`, calls, close: () => server.close() };
}

const browser = await chromium.launch({ headless: true, channel: process.env.BUW_TEST_BROWSER || 'msedge' });
const errors = [];
const contexts = [];
const SIZES = [{ width: 1280, height: 800 }, { width: 390, height: 800 }];
const newPage = async (size, extraStorage = {}) => {
  const storage = { 'buw.menuCollapsed': '0', ...extraStorage };
  const context = await browser.newContext({ viewport: size, serviceWorkers: 'block' });
  contexts.push(context);
  const page = await context.newPage();
  page.setDefaultTimeout(ms(10000));
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(values => { for (const [key, value] of Object.entries(values)) localStorage.setItem(key, value); }, storage);
  return page;
};
const filterOf = page => page.locator('[data-library] [data-project-filter]');
const filterText = async page => (await filterOf(page).innerText()).trim();
const rowIds = page => page.locator('[data-library] .lib-row').evaluateAll(list => list.map(row => row.dataset.entity).sort());
const waitRows = async (page, ids) => { await page.waitForFunction(wanted => [...document.querySelectorAll('[data-library] .lib-row')].map(row => row.dataset.entity).sort().join() === wanted, [...ids].sort().join()); };
const noSideways = async (page, what) => assert.ok(await page.evaluate(() => document.scrollingElement.scrollWidth <= innerWidth), `no sideways scroll: ${what}`);
const library = async (page, origin, at = '/one') => { await page.goto(`${origin}${at}#/~hub/library`); await page.locator('[data-library] .lib-scroll').waitFor(); };
const newCardForm = page => page.getByRole('form', { name: 'New card' });
const openNewCard = async page => { await page.locator('[data-library] [data-new-card]').click(); await page.locator('form[aria-label="New card"], [data-new-card-none]').waitFor(); };
const chipsOf = page => newCardForm(page).getByRole('radiogroup', { name: 'Project' });
const submitOf = page => newCardForm(page).locator('button[type="submit"]');

try {
  for (const size of SIZES) {
    const at = `${size.width}`;
    const data = {
      one: { name: 'Section One', entities: [entity('alpha', 'Alpha'), entity('dup', 'Dup in one')] },
      two: { name: 'Section Two', entities: [entity('beta', 'Beta'), entity('dup', 'Dup in two')] },
      idle: { name: 'Idle Section', entities: [entity('old', 'Old', { status: 'archived' })] },
    };
    const site = await startSite(data);
    try {
      step(`${at}: no workspace switcher on the Library`);
      let page = await newPage(size);
      await library(page, site.origin);
      assert.equal(await page.locator('.workspace-switcher').count(), 0);
      assert.equal(await page.getByRole('button', { name: /^Workspace:/ }).count(), 0);
      assert.equal(await filterText(page), 'Section One', '/one: the filter reads the section in the address');
      await waitRows(page, ['alpha', 'dup']);
      await noSideways(page, 'Library');

      step(`${at}: /two and /two#/card open with the filter on Section Two`);
      await library(page, site.origin, '/two');
      assert.equal(await filterText(page), 'Section Two');
      await waitRows(page, ['beta', 'dup']);
      await page.goto(`${site.origin}/two#/beta`);
      await page.locator('.buw-markdown h1', { hasText: 'Beta' }).waitFor();
      assert.equal(new URL(page.url()).pathname, '/two');
      if (size.width > 900) assert.equal(await filterText(page), 'Section Two', 'the list beside the card has the same filter');

      step(`${at}: the filter moves the address and adds no history step`);
      await library(page, site.origin, '/one');
      await filterOf(page).click();
      const list = page.locator('[data-project-list]');
      await list.waitFor();
      const length = await page.evaluate(() => history.length);
      const at_ = path => page.waitForFunction(wanted => location.pathname === wanted, path);
      await list.locator('[data-pick=""] input').click();           // All
      await at_('/');
      await list.locator('[data-pick="two"] input').click();        // just Two
      await at_('/two');
      await list.locator('[data-pick="one"] input').click();        // Two and One: the address cannot hold two
      await at_('/');
      await list.locator('[data-pick="two"] input').click();        // just One
      await at_('/one');
      assert.equal(await page.evaluate(() => history.length), length, 'picking project after project did not grow the history');
      await list.locator('[data-pick="two"] input').click();        // One and Two
      await at_('/');
      await page.keyboard.press('Escape');
      assert.equal(await filterText(page), '2 projects');

      step(`${at}: a stored pick of two keeps the filter at /, an unknown id is dropped`);
      await page.close();
      page = await newPage(size, { 'buw.projects': JSON.stringify(['one', 'two']) });
      await library(page, site.origin, '/');
      assert.equal(await filterText(page), '2 projects');
      page = await newPage(size, { 'buw.projects': JSON.stringify(['one', 'gone']) });
      await library(page, site.origin, '/');
      assert.equal(await filterText(page), 'Section One', 'the unknown id is dropped');

      step(`${at}: New card on one project: its chip is on, the button names it, the request names it`);
      await library(page, site.origin, '/one');
      await openNewCard(page);
      assert.equal(await chipsOf(page).getByRole('radio', { name: 'Section One' }).getAttribute('aria-checked'), 'true');
      assert.equal(await submitOf(page).innerText(), 'Create in Section One');
      await newCardForm(page).getByLabel('Title').fill('First made');
      site.calls.length = 0;
      await submitOf(page).click();
      await page.waitForFunction(() => location.hash.startsWith('#/made-'));
      assert.equal(site.calls.find(([route]) => route === '/api/cards')[1].workspace, 'one');

      step(`${at}: New card on All and on several: nothing chosen, the button is off until a chip is tapped`);
      page = await newPage(size);
      await library(page, site.origin, '/');
      await openNewCard(page);
      assert.equal(await newCardForm(page).locator('[role="radio"][aria-checked="true"]').count(), 0, 'no chip is on');
      assert.equal(await submitOf(page).innerText(), 'Pick a project');
      await newCardForm(page).getByLabel('Title').fill('Needs a target');
      assert.equal(await submitOf(page).isDisabled(), true);
      await chipsOf(page).getByRole('radio', { name: 'Section Two' }).click();
      assert.equal(await submitOf(page).innerText(), 'Create in Section Two');
      site.calls.length = 0;
      await submitOf(page).click();
      await page.waitForFunction(() => location.hash.startsWith('#/made-'));
      assert.equal(site.calls.find(([route]) => route === '/api/cards')[1].workspace, 'two');
      // With All in view the card's project is in the filter already (All includes it).
      await page.goBack();
      await page.locator('[data-library] .lib-scroll').waitFor();
      assert.equal(await filterText(page), 'All projects', 'All stays All: the new card is in it');
      await page.locator('[data-library] .lib-row', { hasText: 'Needs a target' }).waitFor();

      step(`${at}: a chip outside a one-project filter moves the filter to that project, with no extra step for Back`);
      await library(page, site.origin, '/one');
      await openNewCard(page);
      await chipsOf(page).getByRole('radio', { name: 'Section Two' }).click();
      await newCardForm(page).getByLabel('Title').fill('Other project');
      await submitOf(page).click();
      await page.waitForFunction(() => location.hash.startsWith('#/made-') && location.pathname === '/two');
      assert.equal(await page.evaluate(() => JSON.stringify(localStorage.getItem('buw.projects'))).then(value => value.includes('two') || value === 'null'), true);
      await page.goBack();
      await page.locator('[data-library] .lib-scroll').waitFor();
      assert.equal(await filterText(page), 'Section Two');
      assert.ok(await page.locator('[data-library] .lib-row', { hasText: 'Other project' }).count() > 0, 'the new row is there');

      step(`${at}: closing the filter sheet keeps the pick and the address; Back from the sheet is not a screen`);
      await library(page, site.origin, '/one');
      const closeSheet = async () => { await page.keyboard.press('Escape'); await page.locator('[data-project-list]').waitFor({ state: 'detached' }); };
      const inSheet = async fn => { await filterOf(page).click(); const sheet = page.locator('[data-project-list]'); await sheet.waitFor(); await fn(sheet); await closeSheet(); };
      await inSheet(async sheet => { await sheet.locator('[data-pick=""] input').click(); await sheet.locator('[data-pick="two"] input').click(); });
      assert.equal(await filterText(page), 'Section Two', 'one pick survives the sheet closing');
      assert.equal(new URL(page.url()).pathname, '/two', 'and so does its address');
      await inSheet(async sheet => { await sheet.locator('[data-pick="one"] input').click(); });
      assert.equal(await filterText(page), '2 projects', 'several picks survive');
      assert.equal(new URL(page.url()).pathname, '/', 'at the address that holds them');
      await inSheet(async sheet => { await sheet.locator('[data-pick=""] input').click(); });
      assert.equal(await filterText(page), 'All projects', 'All survives');
      assert.equal(new URL(page.url()).pathname, '/');
      assert.equal(new URL(page.url()).hash, '#/~hub/library', 'the sheet left nothing in the address');

      step(`${at}: a card id in two sections opens from the project picked in the real filter sheet`);
      await library(page, site.origin, '/one');
      await inSheet(async sheet => { await sheet.locator('[data-pick=""] input').click(); await sheet.locator('[data-pick="two"] input').click(); });
      await page.locator('[data-library] .lib-row[data-entity="dup"] .lib-row-main').click();
      await page.locator('.buw-markdown h1', { hasText: 'Dup in two' }).waitFor();
      assert.equal(new URL(page.url()).pathname, '/two');
      if (size.width > 900) assert.equal(await filterText(page), 'Section Two');

      step(`${at}: workspaces are in Settings, with no section links; archiving the section in the address stays on Settings`);
      await page.goto(`${site.origin}/idle#/~hub/settings`);
      const managed = page.locator('[data-site-workspaces]');
      await managed.waitFor();
      assert.equal(await managed.getByRole('link').count(), 0);
      assert.equal(await managed.locator('[aria-checked], [aria-current]').count(), 0, 'nothing marks a current workspace');
      await managed.getByRole('button', { name: '＋ New workspace…' }).waitFor();
      await noSideways(page, 'Settings');
      site.calls.length = 0;
      await Promise.all([page.waitForNavigation(), managed.getByRole('button', { name: 'Archive Idle Section' }).click()]);
      assert.deepEqual(site.calls[0], ['/api/sections/archive', { workspace: 'idle', archived: true }]);
      await page.locator('[data-site-workspaces]').waitFor();
      assert.equal(new URL(page.url()).pathname, '/', 'left the archived section');
      assert.equal(new URL(page.url()).hash, '#/~hub/settings', 'and stayed on Settings');
      await page.close();
    } finally { site.close(); }
  }

  step('one section that can take cards: no filter, the target is a line, the request names it');
  {
    const data = { only: { name: 'Only Section', entities: [entity('solo', 'Solo')] } };
    const site = await startSite(data);
    try {
      const page = await newPage(SIZES[0]);
      await library(page, site.origin, '/only');
      assert.equal(await filterOf(page).count(), 0, 'one project: nothing to select');
      await openNewCard(page);
      assert.equal(await newCardForm(page).locator('[data-new-card-target]').innerText(), 'Goes in Only Section');
      assert.equal(await submitOf(page).innerText(), 'Create in Only Section');
      await newCardForm(page).getByLabel('Title').fill('Lone card');
      await submitOf(page).click();
      await page.waitForFunction(() => location.hash.startsWith('#/made-'));
      assert.equal(site.calls.find(([route]) => route === '/api/cards')[1].workspace, 'only');
      // The only way to a new workspace used to be the switcher.
      await page.goto(`${site.origin}/only#/~hub/settings`);
      await page.getByRole('button', { name: '＋ New workspace…' }).waitFor();
    } finally { site.close(); }
  }

  step('a visitor who cannot write has no workspace section in Settings');
  {
    const site = await startSite({ one: { name: 'Section One', entities: [entity('alpha', 'Alpha')] }, two: { name: 'Section Two', entities: [] } }, { write: false, create: false, cards: false });
    try {
      const page = await newPage(SIZES[1]);
      await page.goto(`${site.origin}/one#/~hub/settings`);
      await page.locator('[data-settings]').waitFor();
      assert.equal(await page.locator('[data-site-workspaces]').count(), 0);
      await library(page, site.origin, '/one');
      assert.equal(await page.locator('[data-new-card]').count(), 0);
      assert.equal(await filterOf(page).count(), 1, 'they still get the filter');
    } finally { site.close(); }
  }

  // The local service: only the starter examples, then a workspace made in Settings.
  const base = await mkdtemp(path.join(root, '.cache/library-one-selector-ui-'));
  const repo = path.join(base, 'app');
  for (const d of ['workspace', 'inbox', 'projects']) await mkdir(path.join(repo, d), { recursive: true });
  await writeFile(path.join(repo, 'workspace/workspace.json'), JSON.stringify({ entities: [entity('starter', 'Starter')] }, null, 2));
  const registryFile = path.join(base, 'registry/workspaces.json');
  await mkdir(path.dirname(registryFile), { recursive: true });
  const extra = path.join(base, 'extra');
  await mkdir(extra, { recursive: true });
  await writeFile(path.join(extra, 'workspace.json'), JSON.stringify({ entities: [entity('extra-card', 'Extra card')] }, null, 2));
  const service = await createService({ repo, uiDir: path.join(root, 'dist'), registryFile });
  try {
    for (const size of SIZES) {
      const at = `${size.width}`;
      const page = await newPage(size);
      await page.goto(`${service.urls.workspace}#/~hub/library`);
      await page.locator('[data-library] .lib-scroll').waitFor();
      step(`${at}: local, only the starter examples: the + shows a note and a way to Settings`);
      assert.equal(await page.locator('.workspace-switcher').count(), 0);
      assert.equal(await page.getByRole('button', { name: /^Workspace:/ }).count(), 0);
      if (size === SIZES[0]) {
        await openNewCard(page);
        await page.locator('[data-new-card-none]').waitFor();
        await page.locator('[data-new-card-none]').getByRole('button', { name: 'Settings' }).click();
      } else {
        // Later runs have a workspace already: the one project that can take cards is the target.
        await openNewCard(page);
        assert.match(await newCardForm(page).locator('[data-new-card-target]').innerText(), /^Goes in Fresh 1280/);
        await page.goto(`${service.urls.workspace}#/~hub/settings`);
      }
      await page.locator('.settings-workspaces').waitFor();
      await noSideways(page, 'local Settings');

      step(`${at}: local, New workspace in Settings makes it, switches to it and opens the Library on it`);
      const name = `Fresh ${at}`;
      await page.getByLabel('New workspace name').fill(name);
      await page.getByRole('button', { name: 'Create and open' }).click();
      await page.locator('[data-library] .lib-scroll').waitFor();
      await page.waitForFunction(() => document.querySelector('[data-project-filter]') !== null || document.querySelector('[data-new-card]') !== null);
      await openNewCard(page);
      assert.match(await submitOf(page).innerText(), /Create in|Pick a project/);
      assert.ok(await page.getByRole('radio', { name }).count() + await page.locator('[data-new-card-target]').count() > 0, 'the form shows a target');
      await noSideways(page, 'local Library');
    }
    // Add an existing folder: it is switched to and the Library opens.
    const page = await newPage(SIZES[0]);
    await page.goto(`${service.urls.workspace}#/~hub/settings`);
    await page.locator('.settings-workspaces').waitFor();
    await page.getByLabel('Workspace folder').fill(extra);
    await page.getByRole('button', { name: 'Add and open' }).click();
    await page.locator('[data-library] .lib-scroll').waitFor();
    await page.locator('[data-library] .lib-row[data-entity="extra-card"]').waitFor();
    assert.equal(await page.locator('.workspace-switcher').count(), 0);
  } finally { await service.close(); }

  assert.deepEqual(errors, [], 'no page errors');
  console.log('library-one-selector-ui: ok');
} finally {
  for (const context of contexts) await context.close().catch(() => {});
  await browser.close();
}
