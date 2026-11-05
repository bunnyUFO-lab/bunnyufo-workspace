// Run after npm run build. QA round 3: a queued message keeps its row until it is sent or cancelled. The Hub's answers to two queued messages
// arrive out of order here (the first is held back), and a late, older answer must not take a row away. Fake Hermes only.
import { chromium } from '@playwright/test';
import { ms } from './ui-timeouts.mjs';
import assert from 'node:assert/strict';
import { startHubFixture } from './hub-fixture.mjs';

const step = name => console.log(`- ${name}`);
const channel = process.env.BUW_TEST_BROWSER || 'msedge';

const fixture = await startHubFixture({ hermes: true, chatRuns: true, hermesOptions: { runScripts: [[{ hold: true }]] } });
const browser = await chromium.launch({ headless: true, channel });
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  page.setDefaultTimeout(ms(15000));
  page.on('pageerror', error => { throw error; });
  const field = page.locator('textarea[aria-label="Message"]');
  const rows = page.locator('[data-queued]');
  const send = async text => { await field.fill(text); await page.keyboard.press('Enter'); };
  // The answer to the first queue post is held until `release()`: the Hub has it by then, the page hears it last.
  let release = () => {};
  let held = 0;
  await page.route(/\/api\/hub\/chat\/[^/]+\/queue$/, async route => {
    if (route.request().method() !== 'POST' || held++ > 0) { await route.continue(); return; }
    const answer = await route.fetch();
    await new Promise(resolve => { release = resolve; });
    await route.fulfill({ response: answer });
  });
  await page.goto(`${fixture.url}#/~hub/chat`);

  await send('Plan the forest');
  await page.locator('[data-pending]').waitFor();
  step('two messages queued, the older answer arrives last: both rows stay');
  await send('Second note');
  await page.locator('[data-queued-local]').first().waitFor();
  await send('Third note');
  await page.waitForFunction(() => [...document.querySelectorAll('[data-queued]:not([data-queued-local])')].some(row => /Third note/.test(row.textContent ?? '')));
  release();
  await page.waitForFunction(() => document.querySelectorAll('[data-queued-local]').length === 0);
  await page.waitForTimeout(ms(300));
  assert.equal(await rows.count(), 2, `two rows: ${await rows.allTextContents()}`);
  assert.match(await rows.nth(0).textContent(), /Second note/);
  assert.match(await rows.nth(1).textContent(), /Third note/);

  step('cancelling the third leaves the second');
  await rows.nth(1).locator('[data-queued-cancel]').click();
  await page.waitForFunction(() => document.querySelectorAll('[data-queued]').length === 1);
  await page.waitForTimeout(ms(300));
  assert.equal(await rows.count(), 1);
  assert.match(await rows.first().textContent(), /Second note/);

  console.log('ok');
} finally {
  await browser.close();
  await fixture.close();
}
