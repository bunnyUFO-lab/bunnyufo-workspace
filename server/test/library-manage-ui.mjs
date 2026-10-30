// Run after npm run build. Isolated repository, registry and browser profile; two temporary
// workspaces are the only things written.
//
// Managing the Library by hand: rename, move and delete a tab; rename and merge a category; change a
// card's category; delete a card, find it in the Trash and restore it; move a card to the other
// workspace and open it from its old link; every menu as a bottom sheet on a phone.
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
    page.setDefaultTimeout(10000);
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
  await page.goto(service.urls.workspace + '#');
  await page.evaluate(() => history.pushState(null, '', location.pathname));
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
  await page.getByLabel('Move to').selectOption('beta');
  await page.getByText(/Links keep working/).waitFor();
  await page.getByRole('button', { name: 'Move', exact: true }).click();
  await page.waitForFunction(() => location.hash.startsWith('#/deck'));
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
  await page.getByRole('button', { name: 'Show menu' }).tap();
  await page.locator('[data-trash-link]').tap();
  box = await page.locator('.lib-dialog').boundingBox();
  assert.ok(box && box.width >= 370 && box.y + box.height >= 800, `the Trash is a sheet (${JSON.stringify(box)})`);
  assert.ok(await page.evaluate(() => document.scrollingElement.scrollWidth <= innerWidth), 'no sideways scroll in the Trash');
  await page.locator('[data-trash="brief"]').getByRole('button', { name: 'Restore' }).tap();
  await page.keyboard.press('Escape');
  await phoneCard('brief').waitFor();
  assert.equal((await listOf(alpha)).entities.some(item => item.id === 'brief'), true, 'Restore on the phone brought the card back');
  await phone.close();

  assert.deepEqual(errors, [], 'no page errors');
  console.log('library-manage-ui: ok');
} finally { await browser?.close(); await service.close(); }
