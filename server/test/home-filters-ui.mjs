// Run after npm run build. Isolated repository, registry and browser profile; the fixture
// workspaces are the only files written.
//
// The board's filters: going back to the cards clears the search, the header counts what the
// list shows, "All" turns the archive filter off, the project chips carry their number keys,
// Recent lists every card in one newest-first run, and a card whose page is gone says so.
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createService } from '../server.mjs';
import { addWorkspace } from '../workspaces.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
await mkdir(path.join(root, '.cache'), { recursive: true });
const base = await mkdtemp(path.join(root, '.cache/home-filters-ui-'));
const day = offset => new Date(Date.now() - offset * 86_400_000).toISOString().slice(0, 10);
const card = (id, title, extra = {}) => ({
  id, folder: id, title, description: 'A card.', category: 'test',
  created: day(0), updated: day(0), status: 'active',
  steps: [{ name: 'Page', path: 'index.html' }], ...extra,
});

async function workspace(name, cards) {
  const dir = path.join(base, name);
  for (const entity of cards) {
    await mkdir(path.join(dir, entity.folder), { recursive: true });
    if (entity.id !== 'ghost') await writeFile(path.join(dir, entity.folder, 'index.html'), `<h1>${entity.title}</h1>`);
  }
  await writeFile(path.join(dir, 'workspace.json'), JSON.stringify({ entities: cards }, null, 2));
  return dir;
}
// One: two live cards and one untouched for ten days. Two: a live card and one whose page is missing.
const one = await workspace('one', [card('alpha', 'Alpha'), card('bravo', 'Bravo', { created: day(1), updated: day(1) }), card('old', 'Old', { created: day(10), updated: day(10) })]);
const two = await workspace('two', [card('gamma', 'Gamma', { created: day(2), updated: day(2) }), card('ghost', 'Ghost', { created: day(3), updated: day(3) })]);
const repo = await mkdtemp(path.join(root, '.cache/home-filters-ui-app-'));
for (const dir of ['workspace', 'inbox', 'projects']) await mkdir(path.join(repo, dir), { recursive: true });
await writeFile(path.join(repo, 'workspace/workspace.json'), JSON.stringify({ entities: [] }, null, 2));
const registryFile = path.join(base, 'registry/workspaces.json');
await mkdir(path.dirname(registryFile), { recursive: true });
await addWorkspace({ registryFile, path: one, name: 'One', activate: true });
await addWorkspace({ registryFile, path: two, name: 'Two' });

const service = await createService({ repo, uiDir: path.join(root, 'dist'), registryFile });
let browser;
try {
  browser = await chromium.launch({ headless: true, channel: process.env.BUW_TEST_BROWSER || 'msedge' });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  page.setDefaultTimeout(10000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const logs = []; page.on('console', message => logs.push(message.text()));
  await page.goto(service.urls.workspace);
  await page.locator('.home .entity-card').first().waitFor();

  // By attribute, not role: with the menu put away the field is hidden from the accessibility tree.
  const search = page.locator('input[aria-label="Search entities"]');
  const startSearch = async term => {
    await page.keyboard.press('Control+Shift+f');
    await search.waitFor();
    await search.fill(term);
    await page.locator('.home .home-filter').waitFor();
  };
  const blur = () => page.evaluate(() => document.activeElement?.blur?.());
  const openCard = async id => {
    await page.evaluate(hash => { location.hash = hash; }, `#/${id}/0`);
    await page.locator('.report-document').waitFor();
    await blur();
  };
  const assertBoardWhole = async what => {
    await page.locator('.home').waitFor();
    assert.equal(await search.inputValue(), '', `${what}: the search box is empty`);
    assert.equal(await page.locator('.home .home-filter').count(), 0, `${what}: no matches line`);
    assert.equal(await page.locator('.home .entity-card').count(), 4, `${what}: every live card is back`);
  };

  // Item 2: back to the cards clears the search, whichever way back it is.
  await startSearch('Bravo');
  assert.equal(await page.locator('.home .entity-card').count(), 1);
  await openCard('bravo');
  await page.keyboard.press('q');
  await assertBoardWhole('Q');

  await startSearch('Bravo');
  await openCard('bravo');
  await page.keyboard.press('Escape');
  await assertBoardWhole('Esc');

  await startSearch('Bravo');
  await openCard('bravo');
  await page.getByRole('link', { name: /Library/ }).click();
  await assertBoardWhole('← Library');

  // With a search running and the box blurred, Esc on the board clears it; so does the Clear link.
  await startSearch('Bravo');
  await blur();
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.querySelectorAll('.home .home-filter').length === 0);
  assert.equal(await search.inputValue(), '');
  await startSearch('Bravo');
  await blur();
  await page.getByRole('button', { name: 'Hide menu' }).click();
  await page.locator('.home .home-filter-clear').click();
  await assertBoardWhole('Clear');

  // Item 3: the header counts the list. The card dated ten days ago is archived, not active.
  const sectionSum = () => page.locator('.home .section-count').allInnerTexts().then(list => list.reduce((n, text) => n + Number(text), 0));
  const heroText = () => page.locator('.home-sub').innerText();
  assert.match(await heroText(), /^\s*4 active \u00b7 1 archived/);
  assert.equal(await sectionSum(), 4, 'the active number is the sum of the section counts');
  assert.equal(await page.locator('.home-archive-note').count(), 0);
  await blur();
  await page.keyboard.press('Shift+A');
  await page.locator('.home-archive-note').waitFor();
  assert.match(await page.locator('.home-archive-note').innerText(), /7 days/);
  assert.equal(await page.locator('.home .archive-chip .project-chip-count').innerText(), '1', 'the archived number is the archive chip count');
  assert.match(await heroText(), /^\s*4 active \u00b7 1 archived/, 'the header does not change with the filter');
  await page.keyboard.press('Shift+A');
  await page.waitForFunction(() => !document.querySelector('.home-archive-note'));

  // Item 4: "All" turns the archive filter off, by click, 0 and Alt+A; a project keeps it.
  const archiveChip = page.locator('.home .archive-chip');
  const archiveOn = async () => (await archiveChip.getAttribute('aria-pressed')) === 'true';
  const setArchive = async on => {
    if ((await archiveOn()) !== on) { await blur(); await page.keyboard.press('Shift+A'); }
    await page.waitForFunction(want => document.querySelector('.home .archive-chip')?.getAttribute('aria-pressed') === String(want), on);
  };
  const projectChip = name => page.locator('.home .project-chip', { hasText: new RegExp('^[0-9]?' + name) });
  await setArchive(true);
  await projectChip('One').click();
  assert.equal(await archiveOn(), true, 'picking a project keeps the archive filter');
  await projectChip('All').click();
  assert.equal(await archiveOn(), false, 'All by click');
  await setArchive(true);
  await projectChip('One').click();
  await blur();
  await page.keyboard.press('0');
  await page.waitForFunction(() => document.querySelector('.home .archive-chip')?.getAttribute('aria-pressed') === 'false');
  await setArchive(true);
  await projectChip('One').click();
  await page.keyboard.press('Alt+a');
  await page.waitForFunction(() => document.querySelector('.home .archive-chip')?.getAttribute('aria-pressed') === 'false');
  assert.equal(await page.locator('.home .project-chip.active').innerText().then(text => text.includes('All')), true);
  assert.equal(await page.locator('.home .project-filter-sep').count(), 1);

  // Item 6b: the chips carry the number keys App binds (0 for All, then the projects in order).
  const keys = await page.locator('.home .project-chip-key').allInnerTexts();
  assert.deepEqual(keys, keys.map((_, index) => String(index)), 'keys run 0, 1, 2 in chip order');
  assert.ok(keys.length >= 3);
  await blur();
  await page.keyboard.press('2');
  await page.waitForFunction(() => document.querySelector('.home .project-chip.active .project-chip-key')?.textContent === '2');
  await page.keyboard.press('0');
  await page.waitForFunction(() => document.querySelector('.home .project-chip.active .project-chip-key')?.textContent === '0');

  // Recent: one section, newest first, remembered, Shift+R, and "All" leaves it alone.
  const recentChip = page.locator('.home .recent-chip');
  const recentOn = async () => (await recentChip.getAttribute('aria-pressed')) === 'true';
  const boardIds = () => page.locator('.home .entity-card').evaluateAll(list => list.map(el => el.getAttribute('data-entity')));
  const waitRecent = on => page.waitForFunction(want => document.querySelector('.home .recent-chip')?.getAttribute('aria-pressed') === String(want), on);
  assert.equal(await recentOn(), false);
  assert.ok((await page.locator('.home .home-section').count()) > 1, 'sections to begin with');
  assert.equal(await recentChip.getAttribute('title'), 'Newest first, no sections ( Shift+R )');
  await recentChip.click();
  await waitRecent(true);
  assert.equal(await page.locator('.home .home-section').count(), 1, 'Recent is one section');
  assert.match(await page.locator('.home .section-title').innerText(), /recent/i);
  assert.deepEqual(await boardIds(), ['alpha', 'bravo', 'gamma', 'ghost'], 'newest first');
  assert.equal(await page.locator('.sidebar-list .sidebar-section-toggle').count(), 1, 'the list is one section too');
  assert.deepEqual(await page.locator('.sidebar-list .sidebar-item').evaluateAll(list => list.map(el => el.textContent.trim().split(/\s+/)[0])).then(list => list.length), 4, 'the list holds the same four');
  await projectChip('One').click();
  assert.deepEqual(await boardIds(), ['alpha', 'bravo'], 'a project chip still narrows');
  await projectChip('All').click();
  assert.equal(await recentOn(), true, 'All does not turn Recent off');
  await setArchive(true);
  assert.deepEqual(await boardIds(), ['old'], 'Recent with the archive');
  assert.equal(await page.locator('.home .home-section').count(), 1);
  await setArchive(false);
  await page.reload();
  // The app may reopen the card last read (then the board is one click back) or land on the board.
  await page.locator('.home .entity-card, .crumb-back').first().waitFor();
  if (await page.locator('.crumb-back').count()) await page.getByRole('link', { name: /Library/ }).click();
  await page.locator('.home .entity-card').first().waitFor();
  assert.equal(await recentOn(), true, 'Recent survives a reload');
  assert.equal(await page.locator('.home .home-section').count(), 1);
  // Shift+R does nothing while typing in the search box.
  await page.keyboard.press('/');
  await search.focus();
  await page.keyboard.press('Shift+R');
  assert.equal(await search.inputValue(), 'R');
  assert.equal(await recentOn(), true, 'typing R leaves Recent alone');
  await search.fill('');
  await blur();
  await page.keyboard.press('Shift+R');
  await waitRecent(false);
  assert.ok((await page.locator('.home .home-section').count()) > 1, 'the sections are back');

  // Item 6d: a card whose page is gone says so, with the real status.
  await page.evaluate(() => { location.hash = '#/ghost/0'; });
  await page.locator('.report-error', { hasText: 'Page unavailable (404)' }).waitFor();

  // Item 6a: no theme message was posted to a frame that was still blank.
  assert.equal(logs.filter(text => /postMessage/.test(text)).length, 0, logs.join(' | '));

  assert.equal(errors.length, 0, errors.join('\n'));
  console.log('home filters ui: ok');
} finally { await browser?.close(); await service.close(); }
