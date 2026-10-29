// Run after npm run build. The Ctrl+K palette through a real browser, over the Hub fixture service.
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { startHubFixture } from './hub-fixture.mjs';

const step = name => console.log(`- ${name}`);
const channel = process.env.BUW_TEST_BROWSER || 'msedge';

const fixture = await startHubFixture({ secondSection: true });
const browser = await chromium.launch({ headless: true, channel });
const contexts = [];
const open = async (viewport, options = {}) => {
  const context = await browser.newContext({ viewport, ...options });
  contexts.push(context);
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => { throw error; });
  return page;
};
const hashOf = page => page.evaluate(() => location.hash);

try {
  const page = await open({ width: 1280, height: 900 });
  await page.goto(`${fixture.url}#/~hub/today`);
  await page.locator('.hub[data-screen="today"]').waitFor();
  const dialog = page.locator('dialog.pal');

  step('Ctrl+K opens the palette: Go to first, then Needs you; the input is a combobox on a listbox');
  await page.keyboard.press('Control+k');
  await dialog.waitFor();
  const input = dialog.locator('input');
  assert.equal(await input.getAttribute('role'), 'combobox');
  const listId = await input.getAttribute('aria-controls');
  assert.equal(await page.locator(`[id="${listId}"]`).getAttribute('role'), 'listbox');
  assert.ok(await input.evaluate(el => el === document.activeElement), 'The input has focus.');
  const field = await input.evaluate(el => { const style = getComputedStyle(el); return { left: style.paddingLeft, border: style.borderTopWidth, radius: style.borderTopLeftRadius }; });
  assert.deepEqual(field, { left: '44px', border: '0px', radius: '0px' }, 'The app-wide input rule does not reach the palette field.');
  assert.ok(await dialog.locator('[role="group"][aria-labelledby]').count() >= 2, 'Groups are labelled.');
  const groups = await dialog.locator('.pal-g').allInnerTexts();
  assert.deepEqual(groups.slice(0, 2).map(text => text.toLowerCase()), ['go to', 'needs you']);
  assert.equal(await dialog.locator('[role="option"][aria-selected="true"]').count(), 1);
  assert.match(await dialog.locator('[role="option"]', { hasText: 'Needs you' }).first().innerText(), /3 waiting/);

  step('Ctrl+K again closes it');
  await page.keyboard.press('Control+k');
  await dialog.waitFor({ state: 'detached' });

  step('typing "need" and Enter lands on the Needs you screen');
  await page.keyboard.press('Control+k');
  await dialog.waitFor();
  await page.keyboard.type('need');
  await page.keyboard.press('Enter');
  await page.locator('.hub[data-screen="needs"]').waitFor();
  assert.equal(await hashOf(page), '#/~hub/needs');
  await dialog.waitFor({ state: 'detached' });

  step('the fixture Ask opens by its words');
  await go(page, '#/~hub/today');
  await page.keyboard.press('Control+k');
  await dialog.waitFor();
  await page.keyboard.type('jump arc');
  assert.equal((await dialog.locator('.pal-g').first().innerText()).toLowerCase(), 'needs you');
  await page.keyboard.press('Enter');
  await page.locator('.hub[data-screen="ask"]').waitFor();

  step('a roadmap and a card are found by name');
  await page.keyboard.press('Control+k');
  await dialog.waitFor();
  await page.keyboard.type('magic');
  await dialog.locator('[role="option"]', { hasText: /magic/i }).first().waitFor();
  await page.keyboard.press('Enter');
  await page.locator('.hub[data-screen="map"]').waitFor();
  assert.match(await hashOf(page), /^#\/~hub\/map\/magic-loops/);
  await page.keyboard.press('Control+k');
  await dialog.waitFor();
  await page.keyboard.type('hub card');
  assert.equal((await dialog.locator('.pal-g').first().innerText()).toLowerCase(), 'cards');
  await page.keyboard.press('Enter');
  await page.locator('.buw-markdown h1', { hasText: 'The hub card' }).waitFor();

  step('a card in another section is found too; the open section comes first');
  await page.keyboard.press('Control+k');
  await dialog.waitFor();
  await page.keyboard.type('zebra');
  const other = dialog.locator('[role="option"]', { hasText: 'Zebra crossing' });
  await other.first().waitFor();
  assert.match(await other.first().innerText(), /Two/, 'The hint names its section.');
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });
  await page.keyboard.press('Control+k');
  await dialog.waitFor();
  await page.keyboard.type('a');
  const cardTitles = await dialog.locator('[role="group"]', { has: page.locator('.pal-g', { hasText: /^cards$/i }) }).locator('.pal-i-label').allInnerTexts();
  assert.ok(cardTitles.includes('The hub card') && cardTitles.includes('Zebra crossing'), `Both cards match "a" (${cardTitles}).`);
  assert.ok(cardTitles.indexOf('The hub card') < cardTitles.indexOf('Zebra crossing'), 'The open section comes first.');
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });

  step('Ctrl+K works from inside a text field, and Esc closes it and gives the focus back');
  const search = page.locator('.sidebar-search input');
  await search.focus();
  await page.keyboard.press('Control+k');
  await dialog.waitFor();
  assert.equal(await dialog.locator('[role="option"]').count() > 0, true);
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });
  assert.ok(await search.evaluate(el => el === document.activeElement), 'The search box has the focus again.');

  step('Tab stays inside, arrows move the selection, no match says so');
  await page.keyboard.press('Control+k');
  await dialog.waitFor();
  await page.keyboard.press('Tab');
  assert.ok(await dialog.locator('input').evaluate(el => el === document.activeElement), 'Tab leaves focus on the input.');
  await page.keyboard.press('ArrowDown');
  assert.equal(await dialog.locator('[role="option"][aria-selected="true"]').evaluate(el => el.id), await dialog.locator('input').getAttribute('aria-activedescendant'));
  assert.equal(await dialog.locator('[role="option"]').nth(1).getAttribute('aria-selected'), 'true');
  await page.keyboard.type('zzzzqq');
  await dialog.locator('.pal-empty').waitFor();
  await page.keyboard.press('Escape');

  step('the sidebar button opens it and shows the key; the shortcut sheet lists it');
  const button = page.locator('[data-palette-open]');
  assert.match(await button.innerText(), /Search\s+Ctrl K/);
  await button.click();
  await dialog.waitFor();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+h');
  await page.locator('dialog.shortcuts', { hasText: 'Open the palette' }).waitFor();
  await page.keyboard.press('Escape');

  step('reduced motion: no transition');
  const calm = await open({ width: 1280, height: 900 }, { reducedMotion: 'reduce' });
  await calm.goto(`${fixture.url}#/~hub/today`);
  await calm.locator('.hub[data-screen="today"]').waitFor();
  await calm.keyboard.press('Control+k');
  await calm.locator('dialog.pal').waitFor();
  assert.equal(await calm.locator('dialog.pal').evaluate(el => getComputedStyle(el).transitionDuration), '0s');

  step('375 px: Search under More opens it and the rows fit and are 44 px tall');
  const phone = await open({ width: 375, height: 800 }, { hasTouch: true, isMobile: true });
  await phone.goto(`${fixture.url}#/~hub/today`);
  await phone.locator('.hub[data-screen="today"]').waitFor();
  await phone.locator('[data-hub-tab="more"]').click();
  await phone.locator('[data-hub-more-search]').click();
  await phone.locator('dialog.pal').waitFor();
  const box = await phone.locator('dialog.pal').boundingBox();
  assert.ok(box.x >= 0 && box.x + box.width <= 375, `The palette fits the screen (${box.x}, ${box.width}).`);
  const row = await phone.locator('.pal-i').first().boundingBox();
  assert.ok(row.height >= 44, `Rows are at least 44 px tall (${row.height}).`);
  assert.ok(await phone.locator('dialog.pal input').evaluate(el => el === document.activeElement), 'The field has focus on open at 375 px, before anything is typed.');
  await phone.keyboard.type('work');
  await phone.locator('.pal-i', { hasText: 'Work' }).first().tap();
  await phone.locator('.hub[data-screen="work"]').waitFor();

  console.log('palette-ui: passed');
} finally {
  for (const context of contexts) await context.close().catch(() => {});
  await browser.close();
  await fixture.close();
}

async function go(page, hash) {
  await page.evaluate(value => { location.hash = value; }, hash);
}
