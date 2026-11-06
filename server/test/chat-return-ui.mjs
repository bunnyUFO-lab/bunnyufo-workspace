// Run after npm run build. At phone width: a reply that is still running (what Hermes thinks, the tool it runs), and a message queued behind it, are still on screen after leaving the
// Chat screen and coming back (another Hub tab, the Chats list), after the page is hidden and shown, and after a full reload. Fake Hermes only.
import { chromium } from '@playwright/test';
import { ms } from './ui-timeouts.mjs';
import assert from 'node:assert/strict';
import { startHubFixture } from './hub-fixture.mjs';

const step = name => console.log(`- ${name}`);
const channel = process.env.BUW_TEST_BROWSER || 'msedge';

const fixture = await startHubFixture({ hermes: true, chatRuns: true, hermesOptions: { runScripts: [['Hello.'], [{ reasoning: 'Weighing the forest and the cave.' }, { tool: 'terminal', preview: 'ls cards/', ms: 300 }, { hold: true }], ['Next reply.']] } });
const browser = await chromium.launch({ headless: true, channel });
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  page.setDefaultTimeout(ms(15000));
  page.on('pageerror', error => { throw error; });
  // A phone that suspends a page ends its open streams: the reply stream of a message sent here is cut on demand, as that does.
  await page.addInitScript(() => {
    const original = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const response = await original(input, init);
      const url = typeof input === 'string' ? input : input.url;
      if (!response.body || init?.method !== 'POST' || !url.endsWith('/api/hub/chat')) return response;
      const reader = response.body.getReader();
      let cut = false;
      window.__cutStream = () => { cut = true; void reader.cancel().catch(() => {}); };
      const body = new ReadableStream({ async pull(controller) { const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined })); if (done || cut) controller.close(); else controller.enqueue(value); } });
      return new Response(body, { status: response.status, headers: response.headers });
    };
  });
  const field = page.locator('textarea[aria-label="Message"]');
  const rows = page.locator('[data-queued]');
  const send = async text => { await field.fill(text); await page.keyboard.press('Enter'); };
  const seen = async what => {
    await page.locator('[data-pending] [data-thinking]', { hasText: 'Weighing the forest' }).waitFor({ timeout: ms(8000) }).catch(() => { throw new Error(`${what}: what Hermes is thinking is not shown`); });
    await page.locator('[data-tool="terminal"]').waitFor({ timeout: ms(4000) }).catch(() => { throw new Error(`${what}: the tool it ran is not shown`); });
    await rows.first().waitFor({ timeout: ms(4000) }).catch(() => { throw new Error(`${what}: the queued message is not shown`); });
    assert.match(await rows.first().textContent(), /Also check the cave/, `${what}: the queued row is the one sent`);
  };
  const hidden = async value => page.evaluate(state => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state }); document.dispatchEvent(new Event('visibilitychange')); }, value);

  await page.goto(`${fixture.url}#/~hub/chat/new`);
  await send('Hi');
  await page.locator('.hub-bubble.assistant', { hasText: 'Hello.' }).waitFor();
  await page.waitForFunction(() => /chat\/\d{8}-/.test(location.hash));
  await send('Plan the forest');
  await page.locator('[data-tool="terminal"]').waitFor();
  await send('Also check the cave.');
  await rows.first().waitFor();

  step('the phone suspends the page that sent the message: its stream breaks while Hermes goes on');
  await page.evaluate(() => window.__cutStream());
  await seen('stream cut');

  step('another Hub tab, then back to the chat');
  const chatHash = await page.evaluate(() => location.hash);
  await page.evaluate(() => { window.location.hash = '#/~hub/today'; });
  await page.waitForTimeout(ms(500));
  await page.evaluate(hash => { window.location.hash = hash; }, chatHash);
  await seen('Hub tab and back');

  step('the Chats list, then the chat again');
  await page.evaluate(() => { window.location.hash = '#/~hub/chat'; });
  await page.locator('[data-conversation]').first().click();
  await seen('Chats list');

  step('the page hidden and shown again');
  await hidden('hidden');
  await page.waitForTimeout(ms(300));
  await hidden('visible');
  await seen('hidden and shown');

  step('a full reload');
  await page.reload();
  await seen('reload');

  fixture.hermes.release(fixture.hermes.runs[1].id, 'Forest done.');
  console.log('ok');
} finally {
  await browser.close();
  await fixture.close();
}
