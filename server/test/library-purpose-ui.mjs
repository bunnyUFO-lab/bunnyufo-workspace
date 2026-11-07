// Run after npm run build. Isolated repository and browser profile; fixture cards only.
// What a card is for: only a report or a done card goes to the Archive by date, a reference or a card with no purpose stays, and the
// row menu offers Keep as reference and Treat as report by the table (neither on a card archived by hand or a starter example). A
// choice shows at once, survives a reload, is card state (the card list is not written), and the menu is a sheet on a phone.
import { chromium } from '@playwright/test';
import { ms } from './ui-timeouts.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createService } from '../server.mjs';
import { contextWithListOpen, nav, openLibrary } from './shell-helpers.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
await mkdir(path.join(root, '.cache'), { recursive: true });
const repo = await mkdtemp(path.join(root, '.cache/library-purpose-ui-'));
const day = offset => new Date(Date.now() - offset * 86_400_000).toISOString().slice(0, 10);
const card = (id, extra = {}) => ({ id, folder: id, title: `Card ${id}`, description: 'A card.', category: 'test', created: day(30), updated: day(30), status: 'active', steps: [{ name: 'Page', path: 'index.html' }], ...extra });
const cards = [
  card('unset'),                                          // old, no purpose: stays
  card('ref', { purpose: 'reference' }),                  // old reference: stays
  card('rep', { purpose: 'report' }),                     // old report: Archive
  card('done', { status: 'done' }),                       // old done: Archive
  card('pinned-done', { status: 'done', pinned: true }),  // done but pinned: stays
  card('hand', { status: 'archived' }),                   // archived by hand
  card('starter', { sample: true }),                      // a starter example
  card('fresh', { created: day(0), updated: day(0), purpose: 'report' }),
];
await mkdir(path.join(repo, 'workspace'), { recursive: true });
for (const dir of ['inbox', 'projects']) await mkdir(path.join(repo, dir), { recursive: true });
for (const item of cards) {
  await mkdir(path.join(repo, 'workspace', item.folder), { recursive: true });
  await writeFile(path.join(repo, 'workspace', item.folder, 'index.html'), `<h1>${item.title}</h1>`);
}
const file = path.join(repo, 'workspace/workspace.json');
await writeFile(file, JSON.stringify({ entities: cards }, null, 2));
const published = await readFile(file, 'utf8');
const stateFile = path.join(repo, '.buw', 'card-state.json');
const stateOf = async id => JSON.parse(await readFile(stateFile, 'utf8')).cards[`template/${id}`];

const service = await createService({ repo, uiDir: path.join(root, 'dist') });
let browser;
try {
  browser = await chromium.launch({ headless: true, channel: process.env.BUW_TEST_BROWSER || 'msedge' });
  const errors = [];
  const page = await (await contextWithListOpen(browser, { viewport: { width: 1200, height: 900 } })).newPage();
  page.setDefaultTimeout(ms(10000));
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(service.urls.workspace);
  const row = id => page.locator(`[data-library] .lib-row[data-entity="${id}"]`);
  const view = name => page.locator('[data-library] .ui-seg button', { hasText: new RegExp('^' + name) });
  const ids = () => page.locator('[data-library] .lib-row').evaluateAll(list => list.map(item => item.getAttribute('data-entity')).sort());
  const waitIds = async (target, why) => {
    await page.waitForFunction(expected => JSON.stringify([...document.querySelectorAll('[data-library] .lib-row')].map(item => item.getAttribute('data-entity')).sort()) === JSON.stringify(expected), target);
    assert.deepEqual(await ids(), target, why);
  };
  /** What a row's menu offers about purpose. */
  const purposeItems = async target => {
    await row(target).locator('[data-row-menu]').click();
    const names = await page.getByRole('menuitem').allInnerTexts();
    // The menu is a sheet with its own history entry: Back closes it.
    await page.goBack();
    await page.getByRole('menu').waitFor({ state: 'detached' });
    return names.filter(name => /report|reference/.test(name));
  };
  const choose = async (target, item) => {
    await row(target).locator('[data-row-menu]').click();
    await page.getByRole('menuitem', { name: item, exact: true }).click();
  };
  await page.locator('[data-library] .lib-row').first().waitFor();

  // The rule: only a report or a done card goes by date.
  await waitIds(['fresh', 'pinned-done', 'ref', 'starter', 'unset'], 'old cards with no purpose, a reference, a pinned done card and a starter stay');
  assert.equal(await view('Archive').locator('small').innerText(), '3');
  await view('Archive').click();
  await waitIds(['done', 'hand', 'rep'], 'an old report, an old done card and one archived by hand');
  assert.equal(
    (await page.locator('[data-archive-note]').innerText()).trim(),
    'Reports and done cards come here 7 days after their last change. Pin a card or choose Keep as reference to keep it in the list.',
  );

  // The menu follows the table.
  await view('All').click();
  await waitIds(['fresh', 'pinned-done', 'ref', 'starter', 'unset']);
  assert.deepEqual(await purposeItems('unset'), ['Keep as reference', 'Treat as report'], 'unset: both');
  assert.deepEqual(await purposeItems('ref'), ['Treat as report'], 'a reference: only Treat as report');
  assert.deepEqual(await purposeItems('fresh'), ['Keep as reference'], 'a report: only Keep as reference');
  assert.deepEqual(await purposeItems('starter'), [], 'a starter example: neither');
  await view('Archive').click();
  await waitIds(['done', 'hand', 'rep']);
  assert.deepEqual(await purposeItems('hand'), [], 'archived by hand: neither (Restore first)');
  assert.deepEqual(await purposeItems('rep'), ['Keep as reference']);
  assert.deepEqual(await purposeItems('done'), ['Keep as reference', 'Treat as report']);

  // Keep as reference on a card in the Archive brings it back at once, and it survives a reload.
  await choose('rep', 'Keep as reference');
  await waitIds(['done', 'hand'], 'the report left the Archive at once');
  assert.equal((await stateOf('rep')).purpose, 'reference');
  await view('All').click();
  await waitIds(['fresh', 'pinned-done', 'ref', 'rep', 'starter', 'unset']);
  await page.reload();
  await page.locator('[data-library] .lib-row').first().waitFor();
  await waitIds(['fresh', 'pinned-done', 'ref', 'rep', 'starter', 'unset'], 'after a reload');
  assert.deepEqual(await purposeItems('rep'), ['Treat as report'], 'the menu follows the choice');

  // Treat as report on an old card sends it to the Archive at once; the date is not touched.
  await choose('unset', 'Treat as report');
  await waitIds(['fresh', 'pinned-done', 'ref', 'rep', 'starter'], 'the old card left the list at once');
  assert.equal((await stateOf('unset')).purpose, 'report');
  await view('Archive').click();
  await waitIds(['done', 'hand', 'unset']);
  assert.match(await row('unset').locator('small').innerText(), new RegExp(day(30)), 'the date stays');
  assert.equal(await stateOf('starter'), undefined);
  assert.equal(await readFile(file, 'utf8'), published, 'the card list is not written by a choice');

  // Restore keeps today's behaviour: it touches the card, so even a report is live again.
  await choose('unset', 'Restore');
  await waitIds(['done', 'hand']);
  await view('All').click();
  await waitIds(['fresh', 'pinned-done', 'ref', 'rep', 'starter', 'unset']);

  // Phone width: the same items, in a sheet.
  const phone = await (await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, serviceWorkers: 'block' })).newPage();
  phone.setDefaultTimeout(ms(10000));
  phone.on('pageerror', error => errors.push(error.message));
  await phone.goto(service.urls.workspace);
  await nav(phone, 'library');
  await openLibrary(phone);
  await phone.locator('[data-library] .lib-row[data-entity="ref"]').waitFor();
  await phone.locator('[data-library] .lib-row[data-entity="fresh"] [data-row-menu]').tap();
  const sheet = phone.locator('.ui-sheet');
  await sheet.waitFor();
  assert.deepEqual((await sheet.getByRole('menuitem').allInnerTexts()).filter(name => /report|reference/.test(name)), ['Keep as reference']);
  await sheet.getByRole('menuitem', { name: 'Keep as reference', exact: true }).tap();
  await sheet.waitFor({ state: 'detached' });
  for (let tries = 0; tries < 50 && (await stateOf('fresh').catch(() => null))?.purpose !== 'reference'; tries += 1) await phone.waitForTimeout(100);
  assert.equal((await stateOf('fresh')).purpose, 'reference', 'the phone’s choice is stored');
  await phone.locator('[data-library] .ui-seg button', { hasText: /^Archive/ }).tap();
  assert.match(await phone.locator('[data-archive-note]').innerText(), /Keep as reference/);

  assert.equal(errors.length, 0, errors.join('\n'));
  console.log('Library purpose UI passed: the rule, the menu table, a choice shows at once and survives a reload, and the phone sheet.');
} finally { await browser?.close(); await service.close(); }
