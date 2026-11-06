// Run after npm run build. Isolated repository, registry and browser profile; one temporary workspace
// is the only thing written.
//
// The Organize sheet of a card's tabs: drag to reorder (mouse and touch), the arrow buttons by keyboard,
// the last tab cannot be removed, a refused save puts the row back and says why, read-only visitors get
// no button, and the bar and the sheet fit every width from 360 to 1280 with 44 px targets on a phone.
import { chromium } from '@playwright/test';
import { ms } from './ui-timeouts.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createService } from '../server.mjs';
import { addWorkspace } from '../workspaces.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
await mkdir(path.join(root, '.cache'), { recursive: true });
const base = await mkdtemp(path.join(root, '.cache/tab-organize-ui-'));
const today = new Date().toISOString().slice(0, 10);

const entity = (id, title, steps) => ({
  id, folder: id, title, description: `${title} fixture.`, category: 'test', created: today, updated: today, status: 'active',
  steps: steps.map(name => ({ name, path: `${name.toLowerCase()}.md` })),
});
const alpha = path.join(base, 'alpha');
const cards = [
  entity('four', 'Four', ['Alpha', 'Bravo', 'Charlie', 'Delta']),
  entity('solo', 'Solo', ['Only']),
  entity('wide', 'Wide', ['Overview', 'A rather long section name that gets clipped in the bar', 'Goals', 'Timeline', 'Research', 'Interviews', 'Sketches']),
];
const write = async (dir, list) => {
  for (const card of list) {
    await mkdir(path.join(dir, card.folder), { recursive: true });
    for (const step of card.steps) await writeFile(path.join(dir, card.folder, step.path), `# ${step.name}\n\nBody of ${step.name}.\n`);
  }
  await writeFile(path.join(dir, 'workspace.json'), JSON.stringify({ entities: list }, null, 2));
};
await mkdir(alpha, { recursive: true });
await write(alpha, cards);
// The starter examples (the app's own workspace folder) are read-only.
const repo = await mkdtemp(path.join(root, '.cache/tab-organize-ui-app-'));
for (const d of ['workspace', 'inbox', 'projects']) await mkdir(path.join(repo, d), { recursive: true });
await write(path.join(repo, 'workspace'), [entity('starter', 'Starter', ['One', 'Two'])]);
const registryFile = path.join(base, 'registry/workspaces.json');
await mkdir(path.dirname(registryFile), { recursive: true });
await addWorkspace({ registryFile, path: alpha, name: 'Alpha', id: 'alpha', activate: true });
const stepNames = async id => JSON.parse(await readFile(path.join(alpha, 'workspace.json'), 'utf8')).entities.find(item => item.id === id).steps.map(step => step.name);

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
    await page.locator('.step-tab[role="tab"]').first().waitFor();
    return page;
  };
  const sheet = page => page.getByRole('dialog', { name: 'Organize tabs' });
  const organize = page => page.getByRole('button', { name: 'Organize', exact: true });
  const order = page => sheet(page).locator('li[data-tab-row] .tab-org-name span').allInnerTexts();
  const handle = (page, name) => page.getByRole('img', { name: `Drag the ${name} tab`, exact: true });
  const noSideways = async (page, label) => assert.ok(await page.evaluate(() => document.scrollingElement.scrollWidth <= innerWidth), `${label}: no sideways scroll`);

  // 1. Desktop: drag with the mouse, two rows down.
  const desktop = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  let page = await open(desktop, '#/four/0');
  assert.equal(await page.locator('.step-tab-more').count(), 0, 'no control over a tab label');
  assert.equal(await page.getByRole('tab').count(), 4, 'four tabs');
  await organize(page).click();
  await sheet(page).waitFor();
  assert.deepEqual(await order(page), ['Alpha', 'Bravo', 'Charlie', 'Delta']);
  let box = await handle(page, 'Alpha').boundingBox();
  const rowHeight = (await page.locator('li[data-tab-row]').nth(1).boundingBox()).y - (await page.locator('li[data-tab-row]').first().boundingBox()).y;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + rowHeight, { steps: 4 });
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + rowHeight * 2, { steps: 4 });
  await page.mouse.up();
  await page.waitForFunction(() => document.querySelectorAll('.tab-org-name span')[2]?.textContent === 'Alpha');
  assert.deepEqual(await order(page), ['Bravo', 'Charlie', 'Alpha', 'Delta'], 'the drag reordered the rows');
  await page.waitForFunction(() => document.querySelectorAll('.step-tab[role="tab"]')[2]?.textContent === 'Alpha');
  assert.deepEqual(await stepNames('four'), ['Bravo', 'Charlie', 'Alpha', 'Delta'], 'the drag was saved once, as one move');
  assert.match(await page.evaluate(() => location.hash), /\/four\/2\/~o$/, 'the open tab followed its page, and the sheet kept its entry');
  assert.equal(await sheet(page).count(), 1, 'the sheet is still open');

  // 2. Keyboard: the arrow buttons work with Enter, and a button at an end does nothing.
  await page.getByRole('button', { name: 'Move Delta down', exact: true }).focus();
  await page.keyboard.press('Enter');
  assert.deepEqual(await order(page), ['Bravo', 'Charlie', 'Alpha', 'Delta'], 'the last row cannot go down');
  await page.getByRole('button', { name: 'Move Delta up', exact: true }).focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelectorAll('.step-tab[role="tab"]')[2]?.textContent === 'Delta');
  assert.deepEqual(await stepNames('four'), ['Bravo', 'Charlie', 'Delta', 'Alpha']);
  assert.equal(await page.getByRole('button', { name: 'Move Bravo up', exact: true }).getAttribute('aria-disabled'), 'true', 'the first row cannot go up');

  // 3. A refused save puts the row back and says why.
  await page.route('**/cards/section/move', route => route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'The card changed on disk. Reload it and try again.' }) }));
  await page.getByRole('button', { name: 'Move Bravo down', exact: true }).click();
  await sheet(page).getByRole('alert').waitFor();
  assert.match(await sheet(page).getByRole('alert').innerText(), /card changed on disk/, 'the reason is shown');
  assert.deepEqual(await order(page), ['Bravo', 'Charlie', 'Delta', 'Alpha'], 'the row is back');
  assert.deepEqual(await stepNames('four'), ['Bravo', 'Charlie', 'Delta', 'Alpha'], 'nothing was written');
  await page.unroute('**/cards/section/move');

  // 4. A refused rename puts the name back too.
  await page.route('**/cards/section/rename', route => route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'Nope.' }) }));
  await page.getByRole('button', { name: 'Rename the Bravo tab', exact: true }).click();
  await page.locator('.tab-org-name-input').fill('Zulu');
  await page.keyboard.press('Enter');
  await sheet(page).getByRole('alert').filter({ hasText: 'Nope.' }).waitFor();
  assert.deepEqual(await order(page), ['Bravo', 'Charlie', 'Delta', 'Alpha'], 'the old name is back');
  await page.unroute('**/cards/section/rename');
  // Escape inside the name cancels the rename and leaves the sheet open.
  await page.getByRole('button', { name: 'Rename the Bravo tab', exact: true }).click();
  await page.locator('.tab-org-name-input').fill('Zulu');
  await page.keyboard.press('Escape');
  assert.deepEqual(await stepNames('four'), ['Bravo', 'Charlie', 'Delta', 'Alpha'], 'Escape sent nothing');
  assert.equal(await sheet(page).count(), 1, 'Escape in the name leaves the sheet open');

  // 5. Remove says it can be brought back.
  await page.getByRole('button', { name: 'Remove the Delta tab', exact: true }).click();
  await sheet(page).getByRole('status').waitFor();
  assert.match(await sheet(page).getByRole('status').innerText(), /bring it back/i);
  assert.deepEqual(await stepNames('four'), ['Bravo', 'Charlie', 'Alpha']);
  await page.getByRole('button', { name: 'Bring back the Delta tab', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.tab-org-name span').length === 4);
  assert.deepEqual(await stepNames('four'), ['Bravo', 'Charlie', 'Delta', 'Alpha'], 'Bring back restored it');
  await page.goBack();
  await sheet(page).waitFor({ state: 'detached' });
  await desktop.close();

  // 6. The last tab stays.
  const solo = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  page = await open(solo, '#/solo/0');
  await organize(page).click();
  const remove = page.getByRole('button', { name: 'Remove the Only tab', exact: true });
  assert.equal(await remove.getAttribute('aria-disabled'), 'true', 'Remove is marked unavailable');
  await remove.click({ force: true });
  await page.waitForTimeout(300);
  assert.deepEqual(await stepNames('solo'), ['Only'], 'the last tab was not removed');
  assert.match(await sheet(page).innerText(), /keeps at least one tab/, 'it says why');
  await solo.close();

  // 7. Read-only: the starter examples show their tabs and no Organize button.
  const visitor = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  page = await open(visitor, '#/starter/0', 'all');
  assert.equal(await page.getByRole('tab').count(), 2, 'the tabs show');
  assert.equal(await organize(page).count(), 0, 'no Organize button');
  await page.getByRole('tab', { name: 'Two', exact: true }).click({ button: 'right' });
  assert.equal(await sheet(page).count(), 0, 'a right-click opens nothing');
  await visitor.close();

  // 8. Touch: a drag with a finger, on a phone.
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  page = await open(phone, '#/four/0');
  await page.getByRole('button', { name: 'Organize', exact: true }).tap();
  await sheet(page).waitFor();
  const before = await order(page);
  const grip = await handle(page, before[0]).boundingBox();
  const step = (await page.locator('li[data-tab-row]').nth(1).boundingBox()).y - (await page.locator('li[data-tab-row]').first().boundingBox()).y;
  const cdp = await phone.newCDPSession(page);
  const at = (x, y) => [{ x, y, id: 1 }];
  const x = grip.x + grip.width / 2;
  const y = grip.y + grip.height / 2;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: at(x, y) });
  for (let i = 1; i <= 6; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: at(x, y + (step * 1 * i) / 6) });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForFunction(first => document.querySelectorAll('.tab-org-name span')[1]?.textContent === first, before[0]);
  assert.deepEqual(await order(page), [before[1], before[0], before[2], before[3]], 'a touch drag moved the row one place');
  await phone.close();

  // 9. Every width: the bar and the sheet fit, a phone's targets are 44 px.
  for (const width of [360, 390, 640, 768, 900, 1024, 1280]) {
    const small = width <= 640;
    const context = await browser.newContext({ viewport: { width, height: 800 }, isMobile: small, hasTouch: small });
    page = await open(context, '#/wide/0');
    const label = `${width}px`;
    await noSideways(page, label);
    const tops = await page.$$eval('.step-tab', tabs => tabs.map(tab => Math.round(tab.getBoundingClientRect().top)));
    assert.ok(tops.length > 0);
    const bar = await page.$eval('.step-tabs', el => el.getBoundingClientRect().height);
    assert.ok(bar < (small ? 70 : 44), `${label}: the tab strip is one row (${bar})`);
    const button = await organize(page).boundingBox();
    assert.ok(button && button.x >= 0 && button.x + button.width <= width, `${label}: Organize is on screen`);
    if (small) {
      const heights = await page.$$eval('.step-tab', tabs => tabs.map(tab => tab.getBoundingClientRect().height));
      assert.ok(heights.every(h => h >= 43.5), `${label}: every tab and the buttons beside them are 44 px high (${heights})`);
    }
    // No control is drawn over a tab's label.
    assert.equal(await page.$$eval('.step-tab[role="tab"] *', nodes => nodes.length), 0, `${label}: a tab holds only text`);
    await organize(page).click();
    await page.waitForTimeout(400);
    const dialog = await sheet(page).boundingBox();
    assert.ok(dialog.x >= 0 && dialog.x + dialog.width <= width && dialog.y >= 0 && dialog.y + dialog.height <= 800, `${label}: the sheet fits (${JSON.stringify(dialog)})`);
    const rows = await page.$$eval('li[data-tab-row]', els => els.map(el => { const r = el.getBoundingClientRect(); return [r.height, el.scrollWidth - el.clientWidth]; }));
    assert.ok(rows.every(([h, over]) => h >= 43.5 && over <= 0), `${label}: rows are 44 px and do not overflow (${JSON.stringify(rows)})`);
    const buttons = await page.$$eval('li[data-tab-row] button', els => els.map(el => { const r = el.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; }));
    assert.ok(buttons.every(([w, h]) => h >= 43.5 && w >= 36), `${label}: the row buttons are tappable (${JSON.stringify(buttons)})`);
    await noSideways(page, `${label} with the sheet`);
    await page.goBack();
    await sheet(page).waitFor({ state: 'detached' });
    await context.close();
  }

  assert.deepEqual(errors, [], 'no page errors');
  console.log('tab-organize-ui: ok');
} finally { await browser?.close(); await service.close(); }
