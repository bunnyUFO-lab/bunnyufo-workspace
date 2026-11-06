// Run after npm run build. Isolated repository and browser profile. Nothing writes the fixture
// workspace.json any more: archiving is card state (.buw/card-state.json), not a card's content.
// Archiving is a row menu action in the Library (and Ctrl+Shift+P on an open card); the Archive view lists what was put away.
import { chromium } from '@playwright/test';
import { ms } from './ui-timeouts.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createService } from '../server.mjs';
import { contextWithListOpen } from './shell-helpers.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
await mkdir(path.join(root, '.cache'), { recursive: true });
const repo = await mkdtemp(path.join(root, '.cache/archive-ui-'));
for (const dir of ['workspace/one', 'workspace/two', 'inbox', 'projects']) await mkdir(path.join(repo, dir), { recursive: true });
const today = new Date().toISOString().slice(0, 10);
// Both cards are fresh, so the date rule archives neither: only the button can.
const card = (id, title) => ({ id, folder: id, title, description: 'A card.', category: 'test', created: today, updated: today, status: 'active', steps: [{ name: 'Page', path: 'index.html' }] });
const file = path.join(repo, 'workspace/workspace.json');
await writeFile(path.join(repo, 'workspace/one/index.html'), '<h1>One</h1>');
await writeFile(path.join(repo, 'workspace/two/index.html'), '<h1>Two</h1>');
await writeFile(file, JSON.stringify({ entities: [card('one', 'Card one'), card('two', 'Card two')] }, null, 2));
const published = await readFile(file, 'utf8');
/** What the app thinks of a card: the state file, which is where archiving goes now. */
const status = async id => {
  try {
    const stored = JSON.parse(await readFile(path.join(repo, '.buw', 'card-state.json'), 'utf8'));
    return stored.cards[`template/${id}`]?.status ?? 'active';
  } catch {
    return 'active';
  }
};
/** The card list is content, and nothing here is a commit. */
const cardsUntouched = async () => assert.equal(await readFile(file, 'utf8'), published, 'workspace.json must not be written by a pin or an archive.');

const service = await createService({ repo, uiDir: path.join(root, 'dist') });
let browser;
try {
  browser = await chromium.launch({ headless: true, channel: process.env.BUW_TEST_BROWSER || 'msedge' });
  const page = await (await contextWithListOpen(browser, { viewport: { width: 1200, height: 900 } })).newPage();
  page.setDefaultTimeout(ms(10000));
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(service.urls.workspace);
  const rows = () => page.locator('[data-library] .lib-row');
  const row = id => page.locator(`[data-library] .lib-row[data-entity="${id}"]`);
  const view = name => page.locator('[data-library] .ui-seg button', { hasText: new RegExp('^' + name) });
  /** A row's menu: open it, pick an item. */
  const menu = async (id, item) => {
    await row(id).locator('[data-row-menu]').click();
    await page.getByRole('menuitem', { name: item, exact: true }).click();
  };
  await rows().first().waitFor();
  assert.equal(await rows().count(), 2);
  // Nothing is archived: the Archive segment has no count to show beyond 0.
  assert.equal(await view('Archive').locator('small').innerText(), '0');

  // Archiving from the row menu takes the card out of the live list; the Archive segment counts it.
  await menu('one', 'Archive');
  await page.waitForFunction(() => document.querySelectorAll('[data-library] .lib-row').length === 1);
  assert.equal(await status('one'), 'archived');
  await cardsUntouched();
  assert.equal(await view('Archive').locator('small').innerText(), '1');

  // The Archive view shows the archived card instead of the live one, with the rule's wording; Restore puts it back.
  await view('Archive').click();
  await row('one').waitFor();
  assert.equal(await row('two').count(), 0, 'Live cards step aside.');
  assert.match(await page.locator('[data-archive-note]').innerText(), /7 days/);
  await menu('one', 'Restore');
  await page.locator('.lib-empty', { hasText: 'No cards here' }).waitFor();
  assert.equal(await status('one'), 'active');
  assert.equal(await view('Archive').locator('small').innerText(), '0', 'the count follows a restore');
  await view('All').click();
  await page.waitForFunction(() => document.querySelectorAll('[data-library] .lib-row').length === 2);

  // Ctrl+Shift+P archives and restores the open card.
  await row('two').locator('.lib-row-main').click();
  await page.frameLocator('iframe.report-frame').getByRole('heading', { name: 'Two' }).waitFor();
  await page.locator('body').press('Control+Shift+P');
  await page.waitForFunction(() => document.querySelectorAll('[data-library] .lib-row').length === 1);
  assert.equal(await status('two'), 'archived');
  await page.locator('body').press('Control+Shift+P');
  await page.waitForFunction(() => document.querySelectorAll('[data-library] .lib-row').length === 2);
  assert.equal(await status('two'), 'active');
  await cardsUntouched();

  // The icon is in the row menu: a preset lands in the card state and shows in the row; "back to the card's own" clears it. No card file is written.
  const iconOf = id => row(id).locator('.lib-row-icon');
  const ownIcon = await iconOf('one').innerText();
  await menu('one', 'Change icon…');
  await page.getByRole('dialog', { name: /Icon of/ }).getByRole('button', { name: '\u{1F680}' }).click();
  await iconOf('one').filter({ hasText: '\u{1F680}' }).waitFor();
  const stateFile = path.join(repo, '.buw', 'card-state.json');
  assert.equal(JSON.parse(await readFile(stateFile, 'utf8')).cards['template/one'].emoji, '\u{1F680}');
  await menu('one', 'Change icon…');
  await page.getByRole('button', { name: /card’s own icon/ }).click();
  await iconOf('one').filter({ hasText: ownIcon }).waitFor();
  assert.equal(JSON.parse(await readFile(stateFile, 'utf8')).cards['template/one']?.emoji, undefined);
  await cardsUntouched();

  assert.equal(errors.length, 0, errors.join('\n'));
  console.log('Archive UI passed: archive and restore from the row menu, the Archive view and its count, Ctrl+Shift+P, and no card file was written.');
} finally { await browser?.close(); await service.close(); }
