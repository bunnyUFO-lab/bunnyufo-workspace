// Run after npm run build. Isolated repository and browser profile. Nothing writes the fixture
// workspace.json any more: archiving is card state (.buw/card-state.json), not a card's content.
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createService } from '../server.mjs';

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

// Dragging is a pointer gesture, not HTML5 drag-and-drop (see src/lib/drag.ts), so it is
// driven here the way a hand drives it: press, move, release. `edge` aims at the top or
// bottom of the target instead of its middle, which is how a place in the list is chosen.
const dragCard = async (page, source, target, edge) => {
  // The sidebar slides in and out; measure once it has stopped moving.
  await source.waitFor();
  let settled = null;
  for (let tries = 0; tries < 40; tries++) {
    const box = await source.boundingBox();
    if (settled && box.x === settled.x && box.y === settled.y) break;
    settled = box;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const from = await source.boundingBox();
  const to = await target.boundingBox();
  const y = edge === 'top' ? to.y + 3 : edge === 'bottom' ? to.y + to.height - 3 : to.y + to.height / 2;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + 12, from.y + from.height / 2 + 12, { steps: 4 });
  await page.mouse.move(to.x + to.width / 2, y, { steps: 10 });
  await page.mouse.up();
};

const service = await createService({ repo, uiDir: path.join(root, 'dist') });
let browser;
try {
  browser = await chromium.launch({ headless: true, channel: process.env.BUW_TEST_BROWSER || 'msedge' });
  const page = await (await browser.newContext({ viewport: { width: 1200, height: 900 } })).newPage();
  page.setDefaultTimeout(10000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(service.urls.workspace);
  await page.locator('.entity-card').first().waitFor();
  assert.equal(await page.locator('.entity-card').count(), 2);
  // Nothing is archived, so there is no archive chip — only the band that takes a drop.
  const gridChip = page.locator('.home .archive-chip');
  const sideChip = page.locator('.sidebar .archive-chip');
  await page.locator('.sidebar-archive-drop').waitFor();
  assert.equal(await sideChip.count(), 0);
  assert.equal(await gridChip.count(), 0);
  await page.getByRole('button', { name: 'Hide menu' }).click();

  // Archiving from the grid takes the card out of the live list; the archive chip appears.
  await page.locator('.entity-card[data-entity="one"] .card-archive').click();
  await page.waitForFunction(() => document.querySelectorAll('.entity-card').length === 1);
  assert.equal(await status('one'), 'archived');
  await cardsUntouched();
  await gridChip.waitFor();
  assert.equal(await gridChip.getAttribute('aria-pressed'), 'false');
  assert.match(await gridChip.textContent(), /Archive\s*1/);

  // The chip is a filter: on, the grid shows the archived card instead of the live one, in its
  // own category section rather than one heap.
  await gridChip.click();
  await page.locator('.home-section .entity-card[data-entity="one"] .chip-archived').waitFor();
  assert.equal(await page.locator('.entity-card[data-entity="two"]').count(), 0, 'Live cards step aside.');
  assert.match(await page.locator('.home-section .section-title').first().textContent(), /test/);
  // The same button restores it; the chip stays, so the way out is where the way in was.
  await page.locator('.entity-card[data-entity="one"] .card-archive').click();
  await page.locator('.home-empty', { hasText: 'Nothing archived' }).waitFor();
  assert.equal(await status('one'), 'active');
  await gridChip.click();
  await page.waitForFunction(() => document.querySelectorAll('.entity-card').length === 2);
  assert.equal(await gridChip.count(), 0, 'With the filter off and nothing archived the chip goes.');

  // The sidebar archives too, so putting work away never means hunting the card down in the grid.
  await page.getByRole('button', { name: 'Show menu' }).click();
  await page.getByRole('button', { name: 'Archive Card one' }).click();
  await page.waitForFunction(() => document.querySelectorAll('.sidebar-groups .sidebar-row').length === 1);
  assert.equal(await status('one'), 'archived');
  // The sidebar's chip and the grid's are one filter.
  await sideChip.click();
  await page.getByRole('button', { name: 'Restore Card one' }).click();
  await page.locator('.sidebar-empty', { hasText: 'Nothing archived' }).waitFor();
  assert.equal(await status('one'), 'active');
  await sideChip.click();
  await page.waitForFunction(() => document.querySelectorAll('.sidebar-groups .sidebar-row').length === 2);

  // Sidebar sections fold away, and stay folded across a reload: this browser's view preference.
  const groups = page.locator('.sidebar-groups .sidebar-section-toggle').first();
  await groups.click();
  await page.waitForFunction(() => document.querySelectorAll('.sidebar-groups .sidebar-row').length === 0);
  await page.reload();
  // The sidebar's open state is remembered too, so it is still open here.
  await page.locator('.sidebar-groups .sidebar-section-toggle').first().waitFor();
  assert.equal(await page.locator('.sidebar-groups .sidebar-row').count(), 0, 'A folded section is still folded after a reload.');
  // …and the board's section is folded with it: one state for both panes.
  assert.equal(await page.locator('.home .entity-card').count(), 0);
  await page.locator('.sidebar-groups .sidebar-section-toggle').first().click();
  await page.waitForFunction(() => document.querySelectorAll('.sidebar-groups .sidebar-row').length === 2);

  // …and dropping a card on the archive band, the same gesture as pinning one.
  await dragCard(page, page.locator('.sidebar-item', { hasText: 'Card two' }), page.locator('.sidebar-archive-drop'));
  await page.waitForFunction(() => document.querySelectorAll('.sidebar-groups .sidebar-row').length === 1);
  assert.equal(await status('two'), 'archived');
  await cardsUntouched();
  // Out of the grid's way: the open menu floats over it.
  await page.getByRole('button', { name: 'Hide menu' }).click();

  // The board folds its sections too, and remembers it.
  const boardHead = page.locator('.home-section .section-toggle').first();
  await boardHead.click();
  await page.waitForFunction(() => document.querySelectorAll('.home .entity-card').length === 0);
  await page.reload();
  await page.locator('.home-section .section-toggle').first().waitFor();
  assert.equal(await page.locator('.home .entity-card').count(), 0, 'A folded board section is still folded after a reload.');
  await page.locator('.home-section .section-toggle').first().click();
  await page.locator('.home .entity-card').first().waitFor();

  // A bare A does nothing (too easy to hit); Shift+A toggles the archive filter.
  await page.locator('body').press('a');
  assert.equal(await page.locator('.home .archive-chip.active').count(), 0);
  await page.locator('body').press('Shift+A');
  await page.locator('.entity-card[data-entity="two"] .chip-archived').waitFor();
  await page.locator('.entity-card[data-entity="two"] .card-archive').click();
  await page.locator('.home-empty', { hasText: 'Nothing archived' }).waitFor();
  assert.equal(await status('two'), 'active');
  await page.locator('body').press('Shift+A');
  await page.waitForFunction(() => document.querySelectorAll('.home .entity-card').length === 2);

  // The icon is a picker: a preset lands in the card state and shows on the card and in the list;
  // "back to the card's own" clears it. No card file is written.
  // The card shows its category's icon until it is given one; the reset button shows that same icon.
  const ownIcon = await page.locator('.entity-card[data-entity="one"] .card-emoji').innerText();
  await page.getByRole('button', { name: 'Change the icon of Card one' }).click();
  await page.getByRole('dialog', { name: 'Choose an icon' }).getByRole('button', { name: '\u{1F680}' }).click();
  await page.locator('.entity-card[data-entity="one"] .card-emoji', { hasText: '\u{1F680}' }).waitFor();
  const stateFile = path.join(repo, '.buw', 'card-state.json');
  assert.equal(JSON.parse(await readFile(stateFile, 'utf8')).cards['template/one'].emoji, '\u{1F680}');
  await page.getByRole('button', { name: 'Change the icon of Card one' }).click();
  assert.ok(ownIcon.length > 0 && (await page.getByRole('button', { name: /card’s own icon/ }).textContent()).includes(ownIcon), 'the reset button shows the card’s own icon');
  await page.getByRole('button', { name: /card’s own icon/ }).click();
  await page.waitForFunction(() => !document.querySelector('.entity-card[data-entity="one"] .card-icon-button:not(.empty)'));
  assert.equal(JSON.parse(await readFile(stateFile, 'utf8')).cards['template/one']?.emoji, undefined);
  await cardsUntouched();

  // The button sits above the title link, which still covers the whole card.
  await page.locator('.entity-card[data-entity="two"]').click();
  await page.frameLocator('iframe.report-frame').getByRole('heading', { name: 'Two' }).waitFor();
  assert.equal(errors.length, 0, errors.join('\n'));
  console.log('Archive UI passed: archive is a filter that keeps the sections, board and sidebar sections fold and stay folded, and no card file was written.');
} finally { await browser?.close(); await service.close(); }
