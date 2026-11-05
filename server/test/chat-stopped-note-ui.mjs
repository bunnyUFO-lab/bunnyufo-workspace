// Run after npm run build. A reply stopped before any text says so, at phone width, over the fake Hermes:
//  1. Stop before any text: "Stopped before it replied" with Send again, still there after a reload, and Send again starts a fresh run;
//  2. a Stop pressed before the run has an id fires once the run starts, and never on the next message;
//  3. with messages held behind the Stop, the note and the held rows read together, and Send again joins the held rows.
import { chromium } from '@playwright/test';
import { ms } from './ui-timeouts.mjs';
import assert from 'node:assert/strict';
import { startHubFixture } from './hub-fixture.mjs';

const step = name => console.log(`- ${name}`);
const channel = process.env.BUW_TEST_BROWSER || 'msedge';
const fx = await startHubFixture({ hermes: true, chatRuns: true, hermesOptions: { runScript: [{ wait: 3000 }, 'Done.'] } });
const browser = await chromium.launch({ headless: true, channel });
const open = async () => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block', isMobile: true, hasTouch: true });
  const page = await context.newPage();
  page.setDefaultTimeout(ms(15000));
  page.on('pageerror', error => { throw error; });
  return page;
};
const shot = async (page, name) => { if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/${name}.png` }); };
try {
  step('1. Stop before any text: the note, after a reload too, and Send again');
  {
    const page = await open();
    const field = page.locator('textarea[aria-label="Message"]');
    await page.goto(`${fx.url}#/~hub/chat`);
    await field.fill('Say hello');
    await page.keyboard.press('Enter');
    await page.locator('[data-chat-stop]').waitFor();
    await page.waitForTimeout(300);
    await page.locator('[data-chat-stop]').tap();
    await page.locator('[data-chat-stopped]').waitFor({ timeout: 8000 });
    assert.equal(await page.locator('.hub-bubble.assistant').count(), 0, 'no reply bubble was made');
    await shot(page, 'stopped');
    await page.waitForTimeout(500);
    await page.reload();   // a new chat has no address until its first reply is done, so the owner opens it from the list
    await page.getByRole('button', { name: 'Chats' }).tap();
    await page.locator('[data-conversation]').first().tap();
    await page.locator('[data-chat-stopped]').waitFor({ timeout: 8000 });
    assert.equal(await page.locator('.hub-bubble.assistant').count(), 0, 'still no reply bubble after a reload');
    const stopsBefore = fx.hermes.stops.length;
    await page.locator('[data-chat-resend]').tap();
    await page.locator('.hub-bubble.assistant', { hasText: 'Done.' }).waitFor({ timeout: 15000 });
    assert.equal(fx.hermes.stops.length, stopsBefore, 'the new run was not stopped');
    assert.equal(await page.locator('[data-chat-resend]').count(), 0, 'an old note has no button once the chat moved on');
    await page.context().close();
  }

  step('2. a held Stop fires when the run starts, and not on the next message');
  {
    const page = await open();
    const field = page.locator('textarea[aria-label="Message"]');
    await page.route(/\/api\/hub\/chat$/, async route => { if (route.request().method() === 'POST') await new Promise(resolve => setTimeout(resolve, 1200)); return route.continue(); });
    await page.goto(`${fx.url}#/~hub/chat`);
    const stopsBefore = fx.hermes.stops.length;
    await field.fill('Early stop');
    await page.keyboard.press('Enter');
    await page.locator('[data-chat-stop]').waitFor();
    await page.locator('[data-chat-stop]').tap();   // no run id yet
    await page.locator('[data-chat-stopped]').waitFor({ timeout: 10000 });
    assert.equal(fx.hermes.stops.length, stopsBefore + 1, 'the held Stop reached the run once');
    await page.unroute(/\/api\/hub\/chat$/);
    await field.fill('Next message');
    await page.keyboard.press('Enter');
    await page.locator('.hub-bubble.assistant', { hasText: 'Done.' }).waitFor({ timeout: 15000 });
    assert.equal(fx.hermes.stops.length, stopsBefore + 1, 'the next message was not stopped');
    await page.context().close();
  }

  step('3. held rows and the note read together');
  {
    const page = await open();
    const field = page.locator('textarea[aria-label="Message"]');
    await page.goto(`${fx.url}#/~hub/chat`);
    await field.fill('First ask');
    await page.keyboard.press('Enter');
    await page.locator('[data-chat-stop]').waitFor();
    await page.waitForTimeout(500);
    await field.fill('Second ask');
    await page.keyboard.press('Enter');
    await page.locator('[data-queued]:not([data-queued-local])').waitFor();
    await page.locator('[data-chat-stop]').tap();
    await page.locator('[data-chat-stopped]').waitFor({ timeout: 8000 });
    await page.locator('[data-queued-state="held"]').waitFor({ timeout: 8000 });
    await shot(page, 'held');
    const resend = page.locator('[data-chat-resend]');
    assert.equal(await resend.count(), 1, 'Send again is there');
    await resend.tap();
    await page.locator('[data-queued-state="held"]', { hasText: 'First ask' }).waitFor({ timeout: 8000 });
    await page.context().close();
  }
  console.log('chat-stopped-note-ui: passed');
} finally {
  await browser.close();
  await fx.close();
}
