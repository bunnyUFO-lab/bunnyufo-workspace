// Run after npm run build. Review of QA rounds 1 and 2, at phone width, over the fake Hermes: nothing the owner typed is lost, and a failure is never silent.
//  1. a new chat's first post fails while a second message waits for its name: no row is left stuck, both texts are in the box, and Send works again;
//  2. the name arriving does not wipe what is being typed, and a failed queue post puts its text back in front of what is in the box;
//  3. a Stop that does not reach Hermes says so and Stop can be pressed again ("Stopping…" never stays);
//  4. Cancel of a message the Hub already sent says it had gone out (and the thread has it).
import { chromium } from '@playwright/test';
import { ms } from './ui-timeouts.mjs';
import assert from 'node:assert/strict';
import { startHubFixture } from './hub-fixture.mjs';

const step = name => console.log(`- ${name}`);
const channel = process.env.BUW_TEST_BROWSER || 'msedge';
const fx = await startHubFixture({ hermes: true, chatRuns: true, hermesOptions: { runScript: ['Working on it. ', { wait: 5000 }, 'Done.'] } });
const browser = await chromium.launch({ headless: true, channel });
const open = async () => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block', isMobile: true, hasTouch: true });
  const page = await context.newPage();
  page.setDefaultTimeout(ms(15000));
  page.on('pageerror', error => { throw error; });
  return page;
};
const POST_CHAT = /\/api\/hub\/chat$/;
try {
  step('1. the first post fails while a second message waits: no stuck row, both texts back in the box, Send starts a turn');
  {
    const page = await open();
    let failFirst = true;
    await page.route(POST_CHAT, async route => {
      if (route.request().method() === 'POST' && failFirst) { await new Promise(resolve => setTimeout(resolve, 800)); return route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"Hermes is down."}' }); }
      return route.continue();
    });
    const field = page.locator('textarea[aria-label="Message"]');
    const send = page.getByRole('button', { name: 'Send', exact: true });
    await page.goto(`${fx.url}#/~hub/chat`);
    await field.fill('First message');
    await send.tap();
    await field.fill('Second message');
    await send.tap();
    await page.locator('[data-queued]').first().waitFor({ timeout: 500 });
    await page.waitForFunction(() => document.querySelectorAll('[data-queued]').length === 0, null, { timeout: 5000 });
    const text = await field.inputValue();
    assert.ok(text.includes('First message') && text.includes('Second message'), `both texts are back in the box: ${JSON.stringify(text)}`);
    assert.ok(text.indexOf('First message') < text.indexOf('Second message'), 'in the order they were sent');
    assert.ok(await page.locator('.hub-error').count() > 0, 'the failure is shown');
    failFirst = false;
    await send.tap();
    await page.locator('[data-chat-stop]').waitFor();
    assert.equal(fx.hermes.runs.length, 1, 'Send starts a turn again');
    await page.context().close();
  }

  step('2a. the name arriving does not wipe what is being typed');
  {
    const page = await open();
    await page.route(POST_CHAT, async route => { if (route.request().method() === 'POST') await new Promise(resolve => setTimeout(resolve, 1200)); return route.continue(); });
    const field = page.locator('textarea[aria-label="Message"]');
    const send = page.getByRole('button', { name: 'Send', exact: true });
    await page.goto(`${fx.url}#/~hub/chat`);
    await field.fill('Name me');
    await send.tap();
    await field.fill('Waiting row');
    await send.tap();
    await field.fill('Still typing the third');
    await page.waitForFunction(() => document.querySelectorAll('[data-queued]:not([data-queued-local])').length === 1, null, { timeout: 8000 });
    assert.equal(await field.inputValue(), 'Still typing the third', 'what was typed is still there');
    await page.context().close();
  }

  step('2b. a failed queue post puts its text in front of what is in the box');
  {
    const page = await open();
    const field = page.locator('textarea[aria-label="Message"]');
    const send = page.getByRole('button', { name: 'Send', exact: true });
    await page.goto(`${fx.url}#/~hub/chat`);
    await field.fill('Run something');
    await send.tap();
    await page.locator('[data-chat-stop]').waitFor();
    await page.waitForTimeout(500);
    await page.route(/\/queue$/, async route => { await new Promise(resolve => setTimeout(resolve, 600)); return route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"The queue is down."}' }); });
    await field.fill('This post fails');
    await send.tap();
    await field.fill('Typed meanwhile');
    await page.waitForFunction(() => document.querySelectorAll('[data-queued]').length === 0 && document.querySelector('.hub-error'), null, { timeout: 5000 });
    const text = await field.inputValue();
    assert.ok(text.includes('This post fails') && text.includes('Typed meanwhile'), `neither text is lost: ${JSON.stringify(text)}`);
    await page.context().close();
  }

  step('3. a Stop that does not reach Hermes says so, Stopping… goes, and Stop can be pressed again');
  {
    const page = await open();
    const field = page.locator('textarea[aria-label="Message"]');
    await page.route(/\/api\/hub\/chat\/stop$/, route => route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"no"}' }));
    await page.goto(`${fx.url}#/~hub/chat`);
    await field.fill('A long one');
    await page.keyboard.press('Enter');
    const stop = page.locator('[data-chat-stop]');
    await stop.waitFor();
    await page.waitForTimeout(600);
    await stop.tap();
    await page.locator('[data-chat-stop-error]').waitFor({ timeout: 3000 });
    await page.waitForFunction(() => !document.querySelector('[data-chat-stopping]'), null, { timeout: 3000 });
    await page.locator('[data-chat-stop]:not([disabled])').waitFor({ timeout: 3000 });
    await page.context().close();
  }

  step('4. Cancel of a message the Hub already sent says it had gone out');
  {
    const page = await open();
    const field = page.locator('textarea[aria-label="Message"]');
    await page.goto(`${fx.url}#/~hub/chat`);
    await field.fill('Start a reply');
    await page.keyboard.press('Enter');
    await page.locator('[data-chat-stop]').waitFor();
    await page.waitForTimeout(500);
    await field.fill('Cancel me');
    await page.keyboard.press('Enter');
    await page.locator('[data-queued]:not([data-queued-local])').waitFor();
    await page.route(/\/queue\/[^/]+\/cancel$/, route => route.fulfill({ status: 409, contentType: 'application/json', body: '{"error":"That message has been sent."}' }));
    await page.locator('[data-queued-cancel]').tap();
    await page.locator('.hub-error', { hasText: 'already gone out' }).waitFor({ timeout: 3000 });
    await page.context().close();
  }

  step('5. a send that gets a 409 keeps what was typed while it was in flight');
  {
    const page = await open();
    const field = page.locator('textarea[aria-label="Message"]');
    const send = page.getByRole('button', { name: 'Send', exact: true });
    await page.goto(`${fx.url}#/~hub/chat`);
    await field.fill('Name this chat');
    await send.tap();
    await page.locator('[data-chat-stop]').waitFor();
    await page.waitForFunction(() => !document.querySelector('[data-chat-stop]'), null, { timeout: 15000 });
    await page.route(POST_CHAT, async route => {
      if (route.request().method() !== 'POST') return route.continue();
      await new Promise(resolve => setTimeout(resolve, 800));
      return route.fulfill({ status: 409, contentType: 'application/json', body: '{"error":"A reply is running."}' });
    });
    await field.fill('Sent into a 409');
    await send.tap();
    await field.fill('Typed while it was in flight');
    await page.waitForTimeout(2000);   // the 409 has come and the message has gone to the queue (it starts at once: the chat is idle)
    assert.equal(await field.inputValue(), 'Typed while it was in flight', 'only the sent text goes; what was typed since stays');
    await page.context().close();
  }

  console.log('chat-queue-failures-ui: passed');
} finally {
  await browser.close();
  await fx.close();
}
