// Run after npm run build. A Chat reply keeps streaming while the page re-renders around it.
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { startHubFixture } from './hub-fixture.mjs';

const step = name => console.log(`- ${name}`);
const channel = process.env.BUW_TEST_BROWSER || 'msedge';
const fixture = await startHubFixture({ hermes: true, chatRuns: true, hermesOptions: { runScript: ['One ', { tool: 'search_files', preview: 'cards/', ms: 900 }, 'two ', { wait: 800 }, 'three four five'] } });
const browser = await chromium.launch({ headless: true, channel });
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => { throw error; });
  const failed = [];
  page.on('requestfailed', request => failed.push(request.url()));
  await page.goto(fixture.url);
  await page.locator('[data-hub-link="chat"]').waitFor();
  await page.locator('[data-hub-link="chat"]').click();

  step('a reply survives the page refreshing its data and the window regaining focus mid-stream');
  await page.locator('textarea[aria-label="Message"]').fill('Say something long');
  await page.keyboard.press('Enter');
  await page.locator('.hub-bubble, .hub-pending, [data-pending]').first().waitFor();
  await page.waitForTimeout(1000);
  await page.evaluate(() => { window.dispatchEvent(new Event('focus')); window.dispatchEvent(new Event('bunnyufo-workspace-changed')); window.dispatchEvent(new Event('buw:hub-wrote')); document.dispatchEvent(new Event('visibilitychange')); });
  await page.locator('.hub-bubble.assistant', { hasText: 'One two three four five' }).waitFor();
  await page.locator('[data-conversation]').waitFor();
  assert.deepEqual(failed.filter(url => url.includes('/api/hub/chat')), [], 'The chat request was not cut.');
  const saved = [...fixture.fake.objects.keys()].filter(key => /inbox\/chat\/[^/]+\.jsonl$/.test(key));
  assert.equal(saved.length, 1);
  assert.equal(fixture.fake.text(saved[0]).trim().split('\n').length, 2, 'The user line and the reply are saved.');
  step('the same in a conversation opened from the list');
  await page.reload();
  await page.locator('[data-conversation]').first().click().catch(() => {});
  await page.locator('textarea[aria-label="Message"]').fill('And again');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1000);
  await page.evaluate(() => { window.dispatchEvent(new Event('focus')); window.dispatchEvent(new Event('bunnyufo-workspace-changed')); });
  await page.locator('.hub-bubble.assistant', { hasText: 'One two three four five' }).nth(1).waitFor();
  await page.waitForTimeout(500);
  assert.deepEqual(failed.filter(url => url.includes('/api/hub/chat')), [], 'No chat request was cut.');
  step('leaving the screen mid-stream does not lose the reply: Hermes finishes and it is saved');
  await page.goto(fixture.url + '#/~hub/chat');
  await page.locator('textarea[aria-label="Message"]').fill('Leave while it talks');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(800);
  await page.evaluate(() => { window.location.hash = '#/~hub/today'; });
  const started = Date.now();
  const mine = () => [...fixture.fake.objects.keys()].filter(key => /inbox\/chat\/[^/]+\.jsonl$/.test(key)).filter(key => fixture.fake.text(key).includes('Leave while it talks'));
  while (!(mine().length && fixture.fake.text(mine()[0]).includes('three four five')) && Date.now() - started < 10000) await page.waitForTimeout(100);
  assert.ok(mine().length, 'The conversation was saved.');
  assert.ok(fixture.fake.text(mine()[0]).includes('three four five'), 'With the reply, not only the question.');
  assert.ok(!fixture.fake.text(mine()[0]).includes('[interrupted]'));

  step('a stream that breaks says so in the chat, and keeps the question on screen');
  await page.route('**/api/hub/chat', route => (route.request().method() === 'POST'
    ? route.fulfill({ status: 200, contentType: 'text/event-stream', body: 'event: delta\ndata: {"text":"Half a rep"}\n\n' })
    : route.continue()));
  await page.goto(fixture.url + '#/~hub/chat');
  await page.locator('textarea[aria-label="Message"]').fill('This one breaks');
  await page.keyboard.press('Enter');
  await page.locator('.hub-error', { hasText: 'The reply was interrupted' }).waitFor();
  await page.locator('.hub-bubble.user', { hasText: 'This one breaks' }).waitFor();
  await page.locator('.hub-bubble.assistant', { hasText: 'Half a rep [interrupted]' }).waitFor();
  console.log('chat stream ui: ok');
} finally {
  await browser.close();
  await fixture.close?.();
}
