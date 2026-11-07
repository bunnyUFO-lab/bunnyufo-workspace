// Run after npm run build. The Library as a full screen, through a real browser: cards live only in the Library (no card on Today,
// Chat or any other screen, at both widths), a section chip adds no history entry, Back from a card finds the chip, the search and
// the view as they were, a row's menu is a sheet that Back closes, the Trash is a view with Restore, and a long list is drawn
// 60 rows at a time. A guest sees rows and nothing that writes.
import { chromium } from '@playwright/test';
import { ms } from './ui-timeouts.mjs';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startHubFixture } from './hub-fixture.mjs';
import { createService } from '../server.mjs';
import { addWorkspace } from '../workspaces.mjs';
import { contextWithListOpen, entryOf, hashOf, nav, noSideways, openLibrary } from './shell-helpers.mjs';
import { listenOnGoodPort } from '../listen.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const step = name => console.log(`- ${name}`);
const channel = process.env.BUW_TEST_BROWSER || 'msedge';
const fixture = await startHubFixture({ hermes: true, secondSection: true });
const browser = await chromium.launch({ headless: true, channel });
const contexts = [];
const errors = [];
const open = async (viewport, options = {}, make = options => browser.newContext(options)) => {
  const context = await make({ viewport, serviceWorkers: 'block', ...options });
  contexts.push(context);
  const page = await context.newPage();
  page.setDefaultTimeout(ms(15000));
  page.on('pageerror', error => errors.push(error.message));
  return page;
};
const rows = page => page.locator('[data-library] .lib-row');
const filter = page => page.locator('[data-library] [data-project-filter]');
// Opens the project filter (a sheet), ticks or unticks one row, and closes it the way Back does.
const pickProject = async (page, name) => {
  await filter(page).click();
  const list = page.locator('.ui-sheet [data-project-list]');
  await list.waitFor();
  await list.locator('label.lib-pick', { hasText: name }).click();
  await page.goBack();
  await list.waitFor({ state: 'detached' });
};
const view = (page, name) => page.locator('[data-library] .ui-seg button', { hasText: new RegExp('^' + name) });
const sizes = (page, selector) => page.locator(selector).evaluateAll(list => list.map(item => { const box = item.getBoundingClientRect(); return [Math.round(box.width), Math.round(box.height)]; }));
const tall = async (page, selector, what) => {
  const boxes = await sizes(page, selector);
  assert.ok(boxes.length > 0, `${what}: there is something to measure.`);
  for (const [width, height] of boxes) assert.ok(width >= 44 && height >= 44, `${what}: a target is ${width} x ${height}, under 44 px.`);
};

let stub;
let long;
try {
  step('no card anywhere but the Library, at 390 and at 1280');
  for (const size of [{ width: 390, height: 800 }, { width: 1280, height: 900 }]) {
    const page = await open(size);
    await page.goto(`${fixture.url}#/~hub/today`);
    await page.locator('.hub[data-screen="today"]').waitFor();
    for (const screen of ['today', 'chat', 'work', 'project', 'team', 'needs']) {
      await page.evaluate(hash => { location.hash = hash; }, `#/~hub/${screen}`);
      await page.locator(`.hub[data-screen="${screen}"]`).waitFor();
      assert.equal(await rows(page).count(), 0, `${screen} at ${size.width}: no card row`);
      assert.equal(await page.locator('[data-library], .sidebar, .entity-card, .buw-card').count(), 0, `${screen} at ${size.width}: no card list, side bar or grid`);
    }
    await nav(page, 'library');
    await openLibrary(page);
    assert.ok(await rows(page).count() >= 2, `the Library lists the cards at ${size.width}`);
    if (size.width >= 900) assert.equal(await page.locator('[data-rail] .lib-row, [data-rail] [data-library]').count(), 0, 'the rail has no card in it');
  }

  step('phone: one column of rows, chips scroll inside their row, every target is 44 px');
  const phone = await open({ width: 390, height: 800 }, {}, options => browser.newContext({ ...options, hasTouch: true }));
  await phone.goto(`${fixture.url}#/~hub/today`);
  await phone.locator('.hub[data-screen="today"]').waitFor();
  await nav(phone, 'library');
  await openLibrary(phone);
  const lefts = await phone.locator('[data-library] .lib-row').evaluateAll(list => list.map(item => Math.round(item.getBoundingClientRect().left)));
  assert.equal(new Set(lefts).size, 1, `rows share one column (${lefts})`);
  assert.equal(await phone.locator('[data-library] .ui-chips').count(), 0, 'no row of chips to scroll sideways: one filter button');
  assert.equal((await filter(phone).innerText()).trim(), 'All projects');
  await noSideways(phone, 'Library at 390');
  await tall(phone, '[data-library] .lib-row-main, [data-library] [data-row-menu], [data-library] .lib-filter, [data-library] .ui-seg button, [data-library] .lib-search', 'Library');
  await phone.setViewportSize({ width: 320, height: 700 });
  await noSideways(phone, 'Library at 320');
  await phone.setViewportSize({ width: 390, height: 800 });

  step('phone: a section chip narrows the list and adds no step; Back leaves the Library');
  const before = await entryOf(phone);
  await pickProject(phone, 'Two');
  await phone.waitForFunction(() => document.querySelectorAll('[data-library] .lib-row').length === 1);
  assert.equal((await filter(phone).innerText()).trim(), 'Two');
  assert.deepEqual(await entryOf(phone), before, 'a chip changes neither the address nor the history entry');
  await view(phone, 'Pinned').click();
  await view(phone, 'All').click();
  assert.deepEqual(await entryOf(phone), before, 'a view adds no step either');

  step('phone: open a card and go back: the same chip, search text and view');
  await phone.locator('[data-library] .lib-search input').fill('Zebra');
  await phone.locator('[data-matches]').waitFor();
  await phone.locator('.lib-row-main', { hasText: 'Zebra crossing' }).tap();
  await phone.locator('.buw-markdown h1', { hasText: 'Zebra crossing' }).waitFor();
  assert.equal(await phone.locator('[data-library]').count(), 0, 'a card is alone on a phone');
  await phone.locator('.topbar [data-back]').click();
  await phone.locator('[data-library] .lib-scroll').waitFor();
  assert.equal((await filter(phone).innerText()).trim(), 'Two', 'the project is as it was');
  assert.equal(await phone.locator('[data-library] .lib-search input').inputValue(), 'Zebra', 'the search is as it was');
  assert.equal(await view(phone, 'All').getAttribute('aria-pressed'), 'true', 'and the view');
  await phone.locator('[data-matches] .lib-clear').click();
  await pickProject(phone, 'Two');
  assert.equal((await filter(phone).innerText()).trim(), 'All projects');
  await phone.goBack();
  await phone.locator('.hub[data-screen="today"]').waitFor();
  assert.equal(await hashOf(phone), '#/~hub/today', 'Back left the Library; it did not undo the chip');
  await nav(phone, 'library');
  await openLibrary(phone);

  step('phone: a row menu is a sheet, Back closes it and stays on the Library');
  const zebra = phone.locator('[data-library] .lib-row[data-entity="zebra"]');
  await zebra.locator('[data-row-menu]').tap();
  const sheet = phone.locator('.ui-sheet');
  await sheet.waitFor();
  const box = await sheet.boundingBox();
  assert.ok(box && box.width >= 380 && box.y + box.height >= 790, `a sheet at the bottom (${JSON.stringify(box)})`);
  for (const name of ['Pin', 'Archive', 'Change icon…', 'Rename…', 'Category…', 'Move to workspace…', 'Delete']) await sheet.getByRole('menuitem', { name, exact: true }).waitFor();
  await phone.goBack();
  await sheet.waitFor({ state: 'detached' });
  assert.match(await hashOf(phone), /#\/~hub\/library$/, 'Back closed the sheet and stayed');

  step('phone: the top bar has no workspace selector; the project filter is the one');
  assert.equal(await phone.getByRole('button', { name: /^Workspace:/ }).count(), 0, 'no Workspace: button');
  assert.equal(await phone.locator('.workspace-switcher').count(), 0);

  step('phone: the Trash shows a deleted card, and Restore works');
  await zebra.locator('[data-row-menu]').tap();
  await sheet.getByRole('menuitem', { name: 'Delete', exact: true }).tap();
  await zebra.waitFor({ state: 'detached' });
  await view(phone, 'Trash').tap();
  const trashed = phone.locator('[data-library] [data-trash="zebra"]');
  await trashed.waitFor();
  await trashed.getByRole('button', { name: 'Restore' }).tap();
  await view(phone, 'All').tap();
  await zebra.waitFor();

  step('desktop: the list is on the left, a card opens on the right, and the rail has no card in it');
  const desk = await open({ width: 1280, height: 900 }, {}, options => contextWithListOpen(browser, options));
  await desk.goto(`${fixture.url}#/~hub/library`);
  await openLibrary(desk);
  await desk.locator('.lib-row-main', { hasText: 'Zebra crossing' }).click();
  await desk.locator('.lib-detail .buw-markdown h1', { hasText: 'Zebra crossing' }).waitFor();
  assert.ok(await rows(desk).count() >= 2, 'the list stays beside the card');
  assert.equal(await desk.locator('.lib-row[data-entity="zebra"] .lib-row-main').getAttribute('aria-current'), 'page', 'the open card is lit');
  const list = await desk.locator('[data-library]').boundingBox();
  const detail = await desk.locator('.lib-detail').boundingBox();
  assert.ok(list.x + list.width <= detail.x + 1, 'the list is left of the card');
  assert.equal(await desk.locator('[data-rail] .lib-row, [data-rail] .lib-row-main').count(), 0, 'the rail has no card');
  assert.ok(!(await desk.locator('[data-rail]').innerText()).includes('Zebra'), 'and does not name one');

  step('a guest sees rows and nothing that writes');
  const day = new Date().toISOString().slice(0, 10);
  const canned = {
    '/api/capabilities': { write: false, create: false, cards: false, hub: true, chat: false, reason: 'Read-only here: sign in to change cards.' },
    '/api/card-state': { cards: {} },
    '/sites.json': [{ id: 'one', name: 'One', base: '/w/one' }],
    '/w/one/workspace.json': { entities: [
      { id: 'alpha', folder: 'alpha', title: 'Alpha card', category: 'test', created: day, updated: day, status: 'active', pinned: true, steps: [{ name: 'Notes', path: 'index.md' }] },
      { id: 'beta', folder: 'beta', title: 'Beta card', category: 'test', created: day, updated: day, status: 'active', steps: [{ name: 'Notes', path: 'index.md' }] },
    ] },
    '/api/hub/today': { counts: { needsYou: 0, running: 0, recent: 0, alerts: 0 }, needsYou: [], running: [], recent: [], alerts: [] },
  };
  const dist = path.join(root, 'dist');
  stub = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://site');
    const send = (status, type, body) => { response.writeHead(status, { 'Content-Type': type }); response.end(body); };
    if (canned[url.pathname]) return send(200, 'application/json', JSON.stringify(canned[url.pathname]));
    if (url.pathname.startsWith('/api/')) return send(404, 'application/json', '{"error":"none"}');
    try {
      const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      return send(200, file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html', await readFile(path.join(dist, file)));
    } catch { return send(200, 'text/html', await readFile(path.join(dist, 'index.html'))); }
  });
  await listenOnGoodPort(stub, '127.0.0.1');
  for (const size of [{ width: 390, height: 800 }, { width: 1280, height: 900 }]) {
    const guest = await open(size);
    await guest.goto(`http://127.0.0.1:${stub.address().port}/one#/~hub/library`);
    await openLibrary(guest);
    await rows(guest).first().waitFor();
    assert.equal(await rows(guest).count(), 2, `a guest sees both rows at ${size.width}`);
    assert.equal(await guest.locator('[data-library] [data-row-menu], [data-library] [data-new-card]').count(), 0, `a guest has no row menu and no New card at ${size.width}`);
    assert.equal(await guest.locator('[data-library] [role="list"][aria-label="Pinned"] .lib-row').count(), 1, 'the pin is shown');
  }

  step('a long list: 60 rows, then Show more; Back from a card keeps the place');
  await mkdir(path.join(root, '.cache'), { recursive: true });
  const base = await mkdtemp(path.join(root, '.cache/library-screen-ui-'));
  const cards = Array.from({ length: 75 }, (_, i) => ({ id: `c${String(i).padStart(2, '0')}`, folder: `c${String(i).padStart(2, '0')}`, title: `Card ${String(i).padStart(2, '0')}`, description: 'A card.', category: 'test', created: day, updated: day, status: 'active', steps: [{ name: 'Page', path: 'index.html' }] }));
  const dir = path.join(base, 'ws');
  for (const card of cards) { await mkdir(path.join(dir, card.folder), { recursive: true }); await writeFile(path.join(dir, card.folder, 'index.html'), `<h1>${card.title}</h1>`); }
  await writeFile(path.join(dir, 'workspace.json'), JSON.stringify({ entities: cards }, null, 2));
  const repo = await mkdtemp(path.join(root, '.cache/library-screen-ui-app-'));
  for (const folder of ['workspace', 'inbox', 'projects']) await mkdir(path.join(repo, folder), { recursive: true });
  await writeFile(path.join(repo, 'workspace/workspace.json'), JSON.stringify({ entities: [] }, null, 2));
  const registryFile = path.join(base, 'registry/workspaces.json');
  await mkdir(path.dirname(registryFile), { recursive: true });
  await addWorkspace({ registryFile, path: dir, name: 'Long', activate: true });
  long = await createService({ repo, uiDir: path.join(root, 'dist'), registryFile });
  const small = await open({ width: 390, height: 800 });
  await small.goto(long.urls.workspace);
  await rows(small).first().waitFor();
  assert.equal(await rows(small).count(), 60, 'the first 60 rows');
  await small.locator('[data-show-more]').click();
  await small.waitForFunction(() => document.querySelectorAll('[data-library] .lib-row').length === 75);
  // Open a card low in the list and come back: the rows are all there and the scroll is where it was.
  const scroller = small.locator('[data-library] .lib-scroll');
  const lowCard = small.locator('.lib-row-main', { hasText: 'Card 40' });
  await lowCard.scrollIntoViewIfNeeded();
  await small.waitForTimeout(400);
  const atOpen = await scroller.evaluate(el => el.scrollTop);
  assert.ok(atOpen > 800, `scrolled down (${atOpen})`);
  await lowCard.click();
  await small.locator('.report-document').waitFor();
  await small.locator('.topbar [data-back]').click();
  await scroller.waitFor();
  assert.equal(await rows(small).count(), 75, 'Show more is remembered');
  const restored = await scroller.evaluate(el => el.scrollTop);
  assert.ok(Math.abs(restored - atOpen) <= 4, `the scroll is where it was (${restored} against ${atOpen})`);

  assert.deepEqual(errors, [], 'no page errors');
  console.log('library-screen-ui: passed');
} finally {
  for (const context of contexts) await context.close().catch(() => {});
  await browser.close();
  await new Promise(resolve => (stub ? stub.close(resolve) : resolve()));
  await long?.close();
  await fixture.close();
}
