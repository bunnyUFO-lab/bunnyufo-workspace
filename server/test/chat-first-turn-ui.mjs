// Run after npm run build. At phone width: a new chat gets its address as soon as Hermes starts answering, and leaving it during that first
// reply (another Hub tab, the Chat list, a full reload) finds it again: it is in the list as "Replying", and opening it follows the reply.
import { chromium } from '@playwright/test';
import { ms } from './ui-timeouts.mjs';
import assert from 'node:assert/strict';
import { startHubFixture } from './hub-fixture.mjs';

const step = name => console.log(`- ${name}`);
const channel = process.env.BUW_TEST_BROWSER || 'msedge';
const fixture = await startHubFixture({ hermes: true, chatRuns: true, hermesOptions: { runScripts: [['Working on it. ', { hold: true }]] } });
const browser = await chromium.launch({ headless: true, channel });
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block', reducedMotion: 'reduce' });
  const page = await context.newPage();
  page.setDefaultTimeout(ms(15000));
  page.on('pageerror', error => { throw error; });
  await page.goto(`${fixture.url}#/~hub/chat/new`);
  await page.locator('textarea[aria-label="Message"]').fill('Plan the forest level');
  await page.keyboard.press('Enter');
  await page.locator('[data-pending]').waitFor();

  step('the address names the chat while the first reply is still running');
  await page.waitForFunction(() => /#\/~hub\/chat\/\d{8}-[a-z0-9]{6}$/.test(location.hash));
  const hash = await page.evaluate(() => location.hash);
  await page.locator('.hub-bubble.assistant', { hasText: 'Working on it.' }).waitFor();

  step('another Hub tab, then back to the address: the reply so far is shown');
  await page.evaluate(() => { location.hash = '#/~hub/today'; });
  await page.locator('.hub[data-screen="today"]').waitFor();
  await page.evaluate(h => { location.hash = h; }, hash);
  await page.locator('.hub-bubble.assistant', { hasText: 'Working on it.' }).waitFor();

  step('the Chat list shows the chat as Replying, titled by its first message; opening it follows the reply');
  await page.evaluate(() => { location.hash = '#/~hub/chat'; });
  const row = page.locator('[data-chat-list] [data-conversation]', { hasText: 'Plan the forest level' });
  await row.waitFor();
  await row.locator('[data-conversation-running]').waitFor();
  await row.click();
  await page.locator('.hub-bubble.user', { hasText: 'Plan the forest level' }).waitFor();
  await page.locator('.hub-bubble.assistant', { hasText: 'Working on it.' }).waitFor();

  step('a full reload on the address finds it too');
  await page.reload();
  await page.locator('.hub-bubble.assistant', { hasText: 'Working on it.' }).waitFor();

  fixture.hermes.release(fixture.hermes.runs[0].id, 'All done.');
  await page.locator('[data-pending]').waitFor({ state: 'detached' });   // the reply is saved and shown as a line
  await page.evaluate(() => { location.hash = '#/~hub/chat'; });
  await page.locator('[data-chat-list] [data-conversation]', { hasText: 'Plan the forest level' }).waitFor();
  assert.equal(await page.locator('[data-conversation-running]').count(), 0, 'The mark goes when the reply is saved.');
  console.log('ok');
} finally {
  await browser.close();
  await fixture.close();
}
