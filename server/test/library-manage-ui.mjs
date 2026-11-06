// Run after npm run build. Isolated repository, registry and browser profile; two temporary
// workspaces are the only things written.
//
// Managing the Library by hand: rename, move and delete a tab; rename and merge a category; change a
// card's category; delete a card, find it in the Trash and restore it; move a card to the other
// workspace and open it from its old link; every menu as a bottom sheet on a phone.
import { chromium } from '@playwright/test';
import { ms } from './ui-timeouts.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { listenOnGoodPort } from '../listen.mjs';
import { createService } from '../server.mjs';
import { addWorkspace } from '../workspaces.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
await mkdir(path.join(root, '.cache'), { recursive: true });
const base = await mkdtemp(path.join(root, '.cache/library-manage-ui-'));
const today = new Date().toISOString().slice(0, 10);

const entity = (id, title, category, steps) => ({
  id, folder: id, title, description: `${title} fixture.`, category, created: today, updated: today, status: 'active',
  steps: steps.map(name => ({ name, path: `${name.toLowerCase()}.md` })),
});
const alpha = path.join(base, 'alpha');
const beta = path.join(base, 'beta');
const cards = [
  entity('deck', 'Deck', 'ideas', ['Overview', 'Rules', 'Art']),
  entity('plan', 'Plan', 'ideas', ['Overview']),
  entity('brief', 'Brief', 'notes', ['Overview']),
];
for (const dir of [alpha, beta]) await mkdir(dir, { recursive: true });
for (const card of cards) {
  await mkdir(path.join(alpha, card.folder), { recursive: true });
  for (const step of card.steps) await writeFile(path.join(alpha, card.folder, step.path), `# ${step.name}\n\nBody of ${step.name}.\n`);
}
await writeFile(path.join(alpha, 'workspace.json'), JSON.stringify({ entities: cards }, null, 2));
await writeFile(path.join(beta, 'workspace.json'), JSON.stringify({ entities: [] }, null, 2));
const repo = await mkdtemp(path.join(root, '.cache/library-manage-ui-app-'));
for (const d of ['workspace', 'inbox', 'projects']) await mkdir(path.join(repo, d), { recursive: true });
await writeFile(path.join(repo, 'workspace/workspace.json'), JSON.stringify({ entities: [] }, null, 2));
const registryFile = path.join(base, 'registry/workspaces.json');
await mkdir(path.dirname(registryFile), { recursive: true });
await addWorkspace({ registryFile, path: alpha, name: 'Alpha', id: 'alpha', activate: true });
await addWorkspace({ registryFile, path: beta, name: 'Beta', id: 'beta' });
const listOf = async dir => JSON.parse(await readFile(path.join(dir, 'workspace.json'), 'utf8'));
const stepNames = async (dir, id) => (await listOf(dir)).entities.find(item => item.id === id).steps.map(step => step.name);

const service = await createService({ repo, uiDir: path.join(root, 'dist'), registryFile });
let browser;
try {
  browser = await chromium.launch({ headless: true, channel: process.env.BUW_TEST_BROWSER || 'msedge' });
  const errors = [];
  const open = async (context, hash, project = 'alpha') => {
    const page = await context.newPage();
    page.setDefaultTimeout(ms(10000));
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(value => { localStorage.setItem('buw.project', value); localStorage.setItem('buw.menuCollapsed', '0'); }, project);
    await page.goto(service.urls.workspace + hash);
    return page;
  };
  const pick = (page, name) => page.getByRole('menuitem', { name, exact: true }).click();
  const toast = page => page.locator('[data-undo-toast]');

  // 1. Tabs: rename in place, move right, delete and undo.
  const desktop = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  let page = await open(desktop, '#/deck/0');
  await page.locator('.step-tab.active').waitFor();
  await page.locator('.step-tab-more').click();
  assert.equal(await page.getByRole('menu').count(), 1, 'the tab menu opens');
  await pick(page, 'Rename');
  await page.locator('.step-tab-rename').fill('Intro');
  await page.keyboard.press('Enter');
  await page.getByRole('tab', { name: 'Intro', exact: true }).waitFor();
  assert.deepEqual(await stepNames(alpha, 'deck'), ['Intro', 'Rules', 'Art'], 'rename wrote the tab name');
  assert.ok((await readFile(path.join(alpha, 'deck/overview.md'), 'utf8')).includes('Body of Overview'), 'the file keeps its name');
  // Rename offers Undo, too.
  await toast(page).getByRole('button', { name: 'Undo' }).click();
  await page.getByRole('tab', { name: 'Overview', exact: true }).waitFor();
  assert.deepEqual(await stepNames(alpha, 'deck'), ['Overview', 'Rules', 'Art'], 'undo of the rename');
  await page.locator('.step-tab-more').click();
  await pick(page, 'Rename');
  await page.locator('.step-tab-rename').fill('Intro');
  await page.keyboard.press('Enter');
  await page.getByRole('tab', { name: 'Intro', exact: true }).waitFor();

  await page.locator('.step-tab-more').click();
  await pick(page, 'Move right');
  await page.waitForFunction(() => document.querySelector('.step-tab.active')?.textContent === 'Intro' && document.querySelectorAll('.step-tab')[1]?.textContent === 'Intro');
  assert.deepEqual(await stepNames(alpha, 'deck'), ['Rules', 'Intro', 'Art'], 'move wrote the order');
  // Move offers Undo, too (and sends the tab's path).
  await toast(page).getByRole('button', { name: 'Undo' }).click();
  await page.waitForFunction(() => document.querySelectorAll('.step-tab')[0]?.textContent === 'Intro');
  assert.deepEqual(await stepNames(alpha, 'deck'), ['Intro', 'Rules', 'Art'], 'undo of the move');
  await page.locator('.step-tab-more').click();
  await pick(page, 'Move right');
  await page.waitForFunction(() => document.querySelectorAll('.step-tab')[1]?.textContent === 'Intro');
  assert.deepEqual(await stepNames(alpha, 'deck'), ['Rules', 'Intro', 'Art']);

  // The card menu by keyboard: Enter opens it, arrows move, Esc closes and gives the focus back.
  const more = page.getByRole('button', { name: 'More for this card' });
  await more.focus();
  await page.keyboard.press('Enter');
  await page.getByRole('menu').waitFor();
  await page.waitForFunction(() => document.activeElement?.textContent === 'Rename…');
  await page.keyboard.press('ArrowDown');
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Category…');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Delete', 'the arrows wrap');
  await page.keyboard.press('Escape');
  await page.getByRole('menu').waitFor({ state: 'detached' });
  assert.ok(await more.evaluate(el => el === document.activeElement), 'Esc returns the focus to the button');
  assert.match(await page.locator('.crumb-current').innerText(), /Deck/, 'Esc did not leave the card');

  await page.getByRole('tab', { name: 'Rules', exact: true }).click({ button: 'right' });
  await pick(page, 'Delete');
  await toast(page).filter({ hasText: 'Deleted the' }).waitFor();
  assert.deepEqual(await stepNames(alpha, 'deck'), ['Intro', 'Art'], 'delete took the tab off');
  assert.ok((await readFile(path.join(alpha, 'deck/rules.md'), 'utf8')).includes('Body of Rules'), 'the file stays');
  await toast(page).getByRole('button', { name: 'Undo' }).click();
  await page.getByRole('tab', { name: 'Rules', exact: true }).waitFor();
  assert.deepEqual(await stepNames(alpha, 'deck'), ['Rules', 'Intro', 'Art'], 'undo put the tab back where it was');

  // 2. Home: rename a category, then merge one into another.
  // The service remembers the last route (now every tab click is one), so Home is asked for by its address.
  await page.evaluate(() => { location.hash = '#/'; });
  await page.reload();
  await page.locator('.section-head-row').first().waitFor();
  const heading = label => page.locator('.section-head-row', { hasText: label });
  await heading('ideas').getByRole('button', { name: /More for the ideas category/ }).click();
  await pick(page, 'Rename…');
  await page.getByLabel('New name').fill('Game Ideas');
  await page.getByRole('button', { name: 'Rename', exact: true }).click();
  await heading('game ideas').waitFor();
  assert.deepEqual((await listOf(alpha)).entities.map(item => item.category), ['game-ideas', 'game-ideas', 'notes']);

  await heading('notes').getByRole('button', { name: /More for the notes category/ }).click();
  await pick(page, 'Merge into…');
  // The target is a typeable list: typing filters it, Escape closes the list and not the dialog, Enter picks.
  const into = page.getByLabel('Merge into');
  assert.notEqual(await page.evaluate(() => document.activeElement?.getAttribute('role')), 'combobox', 'the dialog opens with the list closed');
  await into.click();
  await into.fill('oth');
  assert.deepEqual(await page.locator('.lib-dialog [role="option"]').allInnerTexts(), ['other'], 'typing filters the categories');
  await page.keyboard.press('Escape');
  await page.locator('.lib-dialog [role="listbox"]').waitFor({ state: 'detached' });
  await page.locator('.lib-dialog').waitFor();
  await into.fill('GAME');
  await page.keyboard.press('Enter');
  assert.equal(await into.getAttribute('data-value'), 'game-ideas', 'Enter picks the match');
  await page.getByRole('button', { name: 'Merge…' }).click();
  await page.getByText(/Merge 1 card into game ideas\?/).waitFor();
  await page.getByRole('button', { name: 'Merge', exact: true }).click();
  await page.waitForFunction(() => ![...document.querySelectorAll('.section-title')].some(el => /notes/.test(el.textContent)));
  assert.deepEqual([...new Set((await listOf(alpha)).entities.map(item => item.category))], ['game-ideas']);

  // 3. A card's category by its menu.
  const card = id => page.locator(`.buw-card[data-entity="${id}"]`);
  await card('brief').getByRole('button', { name: /More for Brief/ }).click();
  await pick(page, 'Category…');
  await page.getByLabel('New category').fill('spend');
  await page.getByRole('button', { name: 'Use', exact: true }).click();
  await heading('spend').waitFor();
  assert.equal((await listOf(alpha)).entities.find(item => item.id === 'brief').category, 'spend');

  // 4. Delete a card, find it in the Trash, restore it.
  await card('plan').getByRole('button', { name: /More for Plan/ }).click();
  await pick(page, 'Delete');
  await card('plan').waitFor({ state: 'detached' });
  assert.ok((await listOf(alpha)).retired.plan.entity, 'the card is in the Trash record');
  assert.ok((await readFile(path.join(alpha, 'plan/overview.md'), 'utf8')).includes('Body of Overview'), 'its files stay');
  await page.locator('[data-trash-link]').click();
  const row = page.locator('[data-trash="plan"]');
  await row.waitFor();
  assert.ok(!/forever/i.test(await row.innerText()), 'the local app deletes nothing, so it promises nothing');
  await row.getByRole('button', { name: 'Restore' }).click();
  await card('plan').waitFor();
  assert.equal((await listOf(alpha)).retired, undefined, 'restore emptied the Trash record');
  await page.keyboard.press('Escape');

  // A link to a deleted card says so, and offers Restore.
  await card('plan').getByRole('button', { name: /More for Plan/ }).click();
  await pick(page, 'Delete');
  await card('plan').waitFor({ state: 'detached' });
  await page.evaluate(() => { location.hash = '#/plan'; });
  const notice = page.locator('[data-trash-notice]');
  await notice.waitFor();
  assert.match(await notice.innerText(), /in the Trash of Alpha/);
  await notice.getByRole('button', { name: 'Restore' }).click();
  await page.evaluate(() => { location.hash = ''; });
  await card('plan').waitFor();

  // A Hub run names its card by folder: the card with that folder opens.
  const list = await listOf(alpha);
  list.entities.push({ ...entity('hubrun', 'Hub run', 'ideas', ['Overview']), folder: '2026-10-30_hub-run' });
  await mkdir(path.join(alpha, '2026-10-30_hub-run'), { recursive: true });
  await writeFile(path.join(alpha, '2026-10-30_hub-run/overview.md'), '# Hub run\n');
  await writeFile(path.join(alpha, 'workspace.json'), JSON.stringify(list, null, 2));
  await page.evaluate(() => { location.hash = '#/2026-10-30_hub-run'; });
  await page.locator('.crumb-current', { hasText: 'Hub run' }).waitFor();
  assert.equal(await page.evaluate(() => location.hash), '#/hubrun', 'the address is rewritten to the card id');
  await page.evaluate(() => { location.hash = ''; });
  await card('hubrun').waitFor();
  const cleaned = await listOf(alpha);
  cleaned.entities = cleaned.entities.filter(item => item.id !== 'hubrun');
  await writeFile(path.join(alpha, 'workspace.json'), JSON.stringify(cleaned, null, 2));

  // 5. Move a card to the other workspace and open it from its old link.
  await card('deck').getByRole('button', { name: /More for Deck/ }).click();
  await pick(page, 'Move to workspace…');
  const moveTo = page.getByLabel('Move to');
  await moveTo.click();
  await moveTo.fill('bet');
  assert.deepEqual(await page.locator('.lib-dialog [role="option"]').allInnerTexts(), ['Beta'], 'typing filters the workspaces');
  await page.keyboard.press('Enter');
  assert.equal(await moveTo.getAttribute('data-value'), 'beta');
  await page.getByText(/Links keep working/).waitFor();
  // A big card moves in slices: the first answer says 300 of 600 files are copied, the second (held back a moment) finishes it.
  let asked = 0;
  await page.route('**/api/cards/move', async route => {
    asked += 1;
    if (asked === 1) return route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ pending: true, from: 'alpha', to: 'beta', files: 300, progress: { done: 300, total: 600, doneBytes: 3 * 1024 * 1024, bytes: 6 * 1024 * 1024 } }) });
    await new Promise(resolve => setTimeout(resolve, 1500));
    return route.continue();
  });
  await page.getByRole('button', { name: 'Move', exact: true }).click();
  const progress = page.locator('.lib-progress');
  await progress.getByText('Copying 300 of 600 files (3 MB of 6 MB)').waitFor();
  assert.equal(await progress.locator('progress').getAttribute('value'), '300', 'the bar shows the files copied');
  assert.equal(await page.getByRole('button', { name: 'Moving…' }).isDisabled(), true, 'the dialog is locked while it moves');
  await page.waitForFunction(() => location.hash.startsWith('#/deck')).catch(async error => { throw new Error(`${error.message}; dialog says: ${await page.locator('.lib-dialog').innerText().catch(() => '(gone)')}`); });
  assert.equal(asked, 2, 'the page asked again after the pending answer');
  await page.unroute('**/api/cards/move');
  await page.locator('.crumb-current', { hasText: 'Deck' }).waitFor();
  assert.deepEqual((await listOf(beta)).entities.map(item => item.id), ['deck']);
  assert.equal((await listOf(alpha)).retired.deck.to, 'beta');
  assert.ok((await readFile(path.join(beta, 'deck/rules.md'), 'utf8')).includes('Body of Rules'), 'the files were copied');
  assert.ok((await readFile(path.join(alpha, 'deck/rules.md'), 'utf8')).includes('Body of Rules'), 'the old files stay');
  const old = await open(desktop, '#/deck/1', 'alpha');
  await old.locator('.crumb-current', { hasText: 'Deck' }).waitFor();
  assert.match(await old.locator('.crumb-current').innerText(), /Deck/, 'the old link opens the moved card');
  await old.close();
  await page.close();
  await desktop.close();

  // 6. A phone: each menu is a bottom sheet.
  const phone = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });
  page = await open(phone, '#/plan', 'alpha');
  await page.locator('.crumb-current').waitFor();
  await page.getByRole('button', { name: 'More for this card' }).tap();
  let box = await page.locator('.item-menu.sheet').boundingBox();
  assert.ok(box && box.width >= 370 && box.y + box.height >= 800, `the card menu is a sheet at the bottom (${JSON.stringify(box)})`);
  await page.keyboard.press('Escape');
  await page.locator('.item-menu').waitFor({ state: 'detached' });
  assert.match(await page.locator('.crumb-current').innerText(), /Plan/, 'Esc closed the menu and stayed on the card');
  await page.getByRole('button', { name: 'More for this card' }).tap();
  await pick(page, 'Move to workspace…');
  box = await page.locator('.lib-dialog').boundingBox();
  assert.ok(box && box.width >= 370 && box.y + box.height >= 800, `the move dialog is a sheet (${JSON.stringify(box)})`);
  assert.ok(await page.evaluate(() => document.scrollingElement.scrollWidth <= innerWidth), 'no sideways scroll');
  // At phone width the workspace list opens inside the sheet, filters, and picks.
  const phoneTo = page.getByLabel('Move to');
  await phoneTo.tap();
  await phoneTo.fill('bet');
  const options = page.locator('.lib-dialog [role="option"]');
  assert.deepEqual(await options.allInnerTexts(), ['Beta']);
  const listBox = await page.locator('.lib-dialog [role="listbox"]').boundingBox();
  assert.ok(listBox.x >= 0 && listBox.x + listBox.width <= 375, `the list fits the phone (${JSON.stringify(listBox)})`);
  await options.first().tap();
  assert.equal(await phoneTo.getAttribute('data-value'), 'beta');
  assert.equal(await phoneTo.getAttribute('aria-expanded'), 'false', 'a tap on an option closes the list and does not reopen it through the label');
  assert.ok(await page.evaluate(() => document.scrollingElement.scrollWidth <= innerWidth), 'no sideways scroll with the list used');
  await page.keyboard.press('Escape');
  await page.getByRole('tab', { name: 'Overview', exact: true }).tap();
  await page.locator('.step-tab-more').tap();
  box = await page.locator('.item-menu.sheet').boundingBox();
  assert.ok(box && box.y + box.height >= 800, 'the tab menu is a sheet');
  await page.keyboard.press('Escape');

  // The Trash on a phone: a sheet with Restore.
  await page.evaluate(() => { location.hash = ''; });
  const phoneCard = id => page.locator(`.buw-card[data-entity="${id}"]`);
  await phoneCard('brief').getByRole('button', { name: /More for Brief/ }).tap();
  await pick(page, 'Delete');
  await phoneCard('brief').waitFor({ state: 'detached' });
  // No side bar on a phone: the Trash link sits above the grid.
  await page.locator('[data-trash-link]').tap();
  box = await page.locator('.lib-dialog').boundingBox();
  assert.ok(box && box.width >= 370 && box.y + box.height >= 800, `the Trash is a sheet (${JSON.stringify(box)})`);
  assert.ok(await page.evaluate(() => document.scrollingElement.scrollWidth <= innerWidth), 'no sideways scroll in the Trash');
  await page.locator('[data-trash="brief"]').getByRole('button', { name: 'Restore' }).tap();
  await page.keyboard.press('Escape');
  await phoneCard('brief').waitFor();
  assert.equal((await listOf(alpha)).entities.some(item => item.id === 'brief'), true, 'Restore on the phone brought the card back');
  await phone.close();

  // The published site's switcher: rename and archive a workspace against a stand-in for the site's data service.
  const siteData = {
    one: { name: 'Section One', entities: [entity('alpha', 'Alpha', 'ideas', ['Overview'])] },
    two: { name: 'Section Two', entities: [{ ...entity('beta', 'Beta', 'ideas', ['Overview']), status: 'archived' }] },
    old: { name: 'Old Stuff', archived: true, entities: [] },
  };
  const siteCalls = [];
  const sendJson = (response, status, value) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); };
  const siteServer = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://site');
    if (url.pathname === '/api/capabilities') return sendJson(response, 200, { write: true, create: true, cards: true });
    if (url.pathname === '/api/card-state') return sendJson(response, 200, { cards: {} });
    if (url.pathname === '/sites.json') return sendJson(response, 200, Object.entries(siteData).map(([id, item]) => ({ id, name: item.name, base: `/w/${id}`, ...(item.archived ? { archived: true } : {}) })));
    const listed = /^\/w\/([^/]+)\/workspace\.json$/.exec(url.pathname);
    if (listed && siteData[listed[1]]) return sendJson(response, 200, { name: siteData[listed[1]].name, entities: siteData[listed[1]].entities });
    if (request.method === 'POST' && url.pathname.startsWith('/api/sections/')) {
      let text = '';
      for await (const chunk of request) text += chunk;
      const data = JSON.parse(text);
      siteCalls.push([url.pathname, data]);
      const item = siteData[data.workspace];
      if (url.pathname.endsWith('/rename')) { item.name = data.name; return sendJson(response, 200, { id: data.workspace, name: data.name }); }
      if (data.archived && item.entities.some(card => card.status !== 'archived')) return sendJson(response, 409, { error: `"${item.name}" still has 1 active card. Archive or move them first.` });
      item.archived = data.archived || undefined;
      return sendJson(response, 200, { id: data.workspace, archived: data.archived });
    }
    try {
      const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      const body = await readFile(path.join(root, 'dist', file));
      response.writeHead(200, { 'Content-Type': file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' });
      return response.end(body);
    } catch { response.writeHead(200, { 'Content-Type': 'text/html' }); return response.end(await readFile(path.join(root, 'dist/index.html'))); }
  });
  await listenOnGoodPort(siteServer, '127.0.0.1');
  const siteOrigin = `http://127.0.0.1:${siteServer.address().port}`;
  try {
    for (const size of [{ width: 1280, height: 800 }, { width: 390, height: 800 }]) {
      siteData.one.name = 'Section One'; siteData.two.archived = undefined; siteData.old.archived = true; siteCalls.length = 0;
      const sitePage = await (await browser.newContext({ viewport: size })).newPage();
      sitePage.setDefaultTimeout(ms(10000));
      sitePage.on('pageerror', error => errors.push(error.message));
      await sitePage.goto(`${siteOrigin}/one`);
      const opener = name => sitePage.getByRole('button', { name: new RegExp(`^Workspace: ${name}`) }).first();
      // On a phone the switcher sits in the slide-over menu.
      const reveal = async () => { const box = await opener('Section').boundingBox().catch(() => null); if (box && box.x >= 0 && box.x < size.width) return; const show = sitePage.getByRole('button', { name: 'Show list' }); if (await show.isVisible()) await show.click(); };
      const pop = async name => { await reveal(); await opener(name).click(); };
      await pop('Section One');
      const menu = sitePage.getByRole('menu', { name: 'Workspaces' });
      await menu.waitFor();
      // The archived one is listed apart, with Restore, and is not a switch target.
      assert.equal(await menu.getByText('Old Stuff').count(), 1, 'the archived workspace is listed under Archived');
      assert.equal(await menu.getByRole('menuitemradio', { name: 'Old Stuff' }).count(), 0, 'and is not a switch target');
      assert.ok(await sitePage.evaluate(() => document.scrollingElement.scrollWidth <= innerWidth), `no sideways scroll at ${size.width}`);

      // Escape closes the open workspace menu first and the list second; closing the list forgets both.
      const group = menu.getByRole('group', { name: 'Manage Section One' });
      await menu.getByRole('button', { name: 'Manage Section One' }).click();
      await group.waitFor();
      await sitePage.keyboard.press('Escape');
      await group.waitFor({ state: 'detached' });
      assert.equal(await menu.isVisible(), true, 'the first Escape leaves the list open');
      await menu.getByRole('button', { name: 'Manage Section One' }).click();
      await menu.getByRole('button', { name: 'Rename…' }).click();
      await menu.getByRole('textbox', { name: 'New name for Section One' }).fill('Half typed');
      await sitePage.keyboard.press('Escape');
      await menu.getByRole('textbox', { name: 'New name for Section One' }).waitFor({ state: 'detached' });
      await menu.getByRole('button', { name: 'Manage Section One' }).click();
      await group.waitFor();
      await sitePage.keyboard.press('Escape');
      await sitePage.keyboard.press('Escape');
      await menu.waitFor({ state: 'detached' });
      await pop('Section One');
      assert.equal(await group.count(), 0, 'a reopened list has no open workspace menu');
      await menu.getByRole('button', { name: 'Manage Section One' }).click();
      await menu.getByRole('button', { name: 'Rename…' }).click();
      assert.equal(await menu.getByRole('textbox', { name: 'New name for Section One' }).inputValue(), 'Section One', 'and no half-typed name');
      await menu.getByRole('button', { name: 'Cancel' }).click();

      // Rename: Escape cancels and sends nothing, Enter saves, the address stays.
      await menu.getByRole('button', { name: 'Manage Section One' }).click();
      await menu.getByRole('button', { name: 'Rename…' }).click();
      const field = menu.getByRole('textbox', { name: 'New name for Section One' });
      await field.fill('Throwaway');
      await field.press('Escape');
      assert.equal(await field.count(), 0, 'Escape cancels');
      assert.equal(siteCalls.length, 0, 'and sends nothing');
      await menu.getByRole('button', { name: 'Manage Section One' }).click();
      await menu.getByRole('button', { name: 'Rename…' }).click();
      await field.fill('Section Uno');
      await Promise.all([sitePage.waitForNavigation(), field.press('Enter')]);
      assert.deepEqual(siteCalls[0], ['/api/sections/rename', { workspace: 'one', name: 'Section Uno' }]);
      assert.equal(new URL(sitePage.url()).pathname, '/one', 'the address does not change');
      await reveal();
      await opener('Section Uno').waitFor();

      // Archive is refused while a card is active, and says why.
      await pop('Section Uno');
      await menu.getByRole('button', { name: 'Manage Section Uno' }).click();
      await menu.getByRole('button', { name: 'Archive' }).click();
      await menu.getByRole('alert').waitFor();
      assert.match(await menu.getByRole('alert').textContent(), /still has 1 active card/);

      // Archive the idle one, then restore it from the Archived list.
      await menu.getByRole('button', { name: 'Manage Section Two' }).click();
      await Promise.all([sitePage.waitForNavigation(), menu.getByRole('button', { name: 'Archive' }).click()]);
      assert.equal(siteData.two.archived, true);
      await pop('Section Uno');
      assert.equal(await menu.getByRole('menuitemradio', { name: 'Section Two' }).count(), 0, 'an archived workspace leaves the switcher');
      await Promise.all([sitePage.waitForNavigation(), menu.getByRole('button', { name: 'Restore Section Two' }).click()]);
      assert.equal(siteData.two.archived, undefined, 'Restore clears the flag');
      await pop('Section Uno');
      await menu.getByRole('menuitemradio', { name: 'Section Two' }).waitFor();
      await sitePage.context().close();
    }
  } finally { siteServer.close(); }

  assert.deepEqual(errors, [], 'no page errors');
  console.log('library-manage-ui: ok');
} finally { await browser?.close(); await service.close(); }
