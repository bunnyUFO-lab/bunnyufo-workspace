// Run after npm run build. A phone-width first load with no hash opens the Hub's Today; desktop keeps the cards' home;
// a deep link wins at any width.
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { startHubFixture } from './hub-fixture.mjs';

const step = name => console.log(`- ${name}`);
const channel = process.env.BUW_TEST_BROWSER || 'msedge';
const fixture = await startHubFixture();
const browser = await chromium.launch({ headless: true, channel });
const contexts = [];
const open = async viewport => {
  const context = await browser.newContext({ viewport });
  contexts.push(context);
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => { throw error; });
  return page;
};
const hashOf = page => page.evaluate(() => location.hash);

try {
  step('phone, no hash: opens on Today and the address says so');
  const phone = await open({ width: 375, height: 812 });
  await phone.goto(fixture.url);
  await phone.locator('.hub[data-screen="today"]').waitFor();
  assert.equal(await hashOf(phone), '#/~hub/today');

  step('phone, deep links win: a card and a Hub screen keep their address');
  await phone.goto(`${fixture.url}#/hub`);
  await phone.reload();
  await phone.locator('.buw-markdown h1', { hasText: 'The hub card' }).waitFor();
  assert.equal(await hashOf(phone), '#/hub');
  await phone.goto(`${fixture.url}#/~hub/needs`);
  await phone.reload();
  await phone.locator('.hub[data-screen="needs"]').waitFor();
  assert.equal(await hashOf(phone), '#/~hub/needs');

  step('phone Today: Needs you, then Working now, then Since yesterday, in reading order too');
  const panels = layout => phone.locator(`[data-today-layout="${layout}"] .today-stack > [aria-label]`).evaluateAll(list => list.map(e => e.getAttribute('aria-label')));
  await phone.goto(`${fixture.url}#/~hub/today`);
  await phone.locator('[data-today-layout="phone"]').waitFor();
  assert.deepEqual((await panels('phone')).slice(0, 3), ['Needs you', 'Working now', 'Since yesterday']);
  await phone.setViewportSize({ width: 1100, height: 812 });
  await phone.locator('[data-today-layout="wide"]').waitFor();
  assert.deepEqual((await panels('wide')).slice(0, 2), ['Needs you', 'Since yesterday'], 'Wide keeps two columns.');
  await phone.setViewportSize({ width: 375, height: 812 });
  await phone.locator('[data-today-layout="phone"]').waitFor();

  step('phone: from Today go to the cards home, open a card, press Back, and the cards home stays');
  await phone.goto(`${fixture.url}#/~hub/today`);
  await phone.locator('.hub[data-screen="today"]').waitFor();
  await phone.locator('.hub-tabs [data-hub-tab="more"]').click();
  await phone.locator('[data-hub-more="library"]').click();
  await phone.getByText('The hub card', { exact: true }).last().click();
  await phone.locator('.buw-markdown h1', { hasText: 'The hub card' }).waitFor();
  await phone.goBack();
  await phone.getByText('The hub card', { exact: true }).last().waitFor();
  await phone.waitForTimeout(500);
  assert.equal(await hashOf(phone), '', 'Back from a card does not bounce to Today.');
  assert.equal(await phone.locator('.hub[data-screen]').count(), 0, 'Back lands on the cards home, not a Hub screen.');

  step('desktop, no hash: the cards home, no redirect');
  const desk = await open({ width: 1280, height: 800 });
  await desk.goto(fixture.url);
  await desk.locator('.app-layout').waitFor();
  await desk.waitForTimeout(500);
  assert.equal(await hashOf(desk), '');
  assert.equal(await desk.locator('.hub').count(), 0);
  console.log('hub-phone-today-ui: ok');
} finally {
  for (const context of contexts) await context.close();
  await browser.close();
  await fixture.close();
}
