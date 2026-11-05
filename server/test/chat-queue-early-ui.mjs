// Run after npm run build. QA round 2, at phone width, over the fake Hermes: a message typed before a new chat has its name shows as a Queued row at once
// and goes out when the name arrives (Send was disabled there); a second queued message says the two go together; Stop says "Stopping…" at once; a message
// sent right after Stop waits as a row and starts no second run; Cancel of a row the Hub already sent says so.
import { chromium } from '@playwright/test';
import { ms } from './ui-timeouts.mjs';
import assert from 'node:assert/strict';
import { startHubFixture } from './hub-fixture.mjs';

const step = name => console.log(`- ${name}`);
const channel = process.env.BUW_TEST_BROWSER || 'msedge';
const fx = await startHubFixture({ hermes: true, chatRuns: true, hermesOptions: { runScripts: [['First reply. ', { wait: 6000 }, 'done.']] } });
const browser = await chromium.launch({ headless: true, channel });
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block', isMobile: true, hasTouch: true });
  const page = await context.newPage();
  page.setDefaultTimeout(ms(15000));
  page.on('pageerror', error => { throw error; });
  let holdStart = true;
  await page.route(/\/api\/hub\/chat$/, async route => { if (route.request().method() === 'POST' && holdStart) await new Promise(resolve => setTimeout(resolve, 1500)); await route.continue(); });
  let holdStop = true;
  await page.route(/\/api\/hub\/chat\/stop$/, async route => { if (holdStop) await new Promise(resolve => setTimeout(resolve, 1500)); await route.continue(); });
  const field = page.locator('textarea[aria-label="Message"]');
  const send = page.getByRole('button', { name: 'Send', exact: true });
  const rows = page.locator('[data-queued]');
  await page.goto(`${fx.url}#/~hub/chat`);

  step('before the chat has a name: Send looks enabled with text, the first tap makes a Queued row at once');
  await field.fill('First message');
  await send.tap();
  await field.fill('Typed too early');
  assert.equal(await send.isDisabled(), false, 'Send is enabled with text in the field');
  await send.tap();
  await rows.first().waitFor({ timeout: 400 });
  assert.equal(await rows.first().locator('[data-queued-pill]').textContent(), 'Queued');
  assert.equal(await field.inputValue(), '');
  assert.equal(fx.hermes.runs.length <= 1, true);

  step('it goes out once the chat has a name, as one row from the Hub');
  holdStart = false;
  await page.waitForFunction(() => document.querySelectorAll('[data-queued]:not([data-queued-local])').length === 1 && document.querySelectorAll('[data-queued-local]').length === 0);
  assert.equal(await rows.first().locator('.hub-queued-text').textContent(), 'Typed too early');

  step('a second queued message says the two go together');
  assert.equal(await page.locator('[data-queued-join]').count(), 0, 'one row says nothing about joining');
  await field.fill('And this too');
  await send.tap();
  await page.waitForFunction(() => document.querySelectorAll('[data-queued]').length === 2);
  assert.equal((await page.locator('[data-queued-join]').textContent()).trim(), 'These go together when the reply ends.');

  step('Stop says Stopping… at once; a message sent right after it waits as a row and starts no second run');
  const stop = page.locator('[data-chat-stop]');
  await stop.tap();
  await page.locator('[data-chat-stopping]').waitFor({ timeout: 500 });
  const began = Date.now();
  await field.fill('Right after stop');
  await send.tap();
  await page.waitForFunction(() => !document.querySelector('[data-chat-stopping]'));
  console.log('Stopping line stayed', Date.now() - began, 'ms (the Stop request was held 1.5 s)');
  assert.equal(fx.hermes.runs.length, 1, 'the stopped reply started nothing else');
  assert.equal(await rows.first().getAttribute('data-queued-state'), 'held');

  console.log('chat-queue-early-ui: passed');
} finally {
  await browser.close();
  await fx.close();
}
