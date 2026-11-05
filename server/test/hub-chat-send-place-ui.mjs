// Run after npm run build. Send stays where it is (QA round 1): the Model menu used to arrive under the box after the chat list loaded, or after
// the first message, and moved the compose row, so the next tap missed. The list is held back here so the menu comes late; Send must not move.
import { chromium } from '@playwright/test';
import { ms } from './ui-timeouts.mjs';
import assert from 'node:assert/strict';
import { startHubFixture } from './hub-fixture.mjs';

const step = name => console.log(`- ${name}`);
const channel = process.env.BUW_TEST_BROWSER || 'msedge';
const browser = await chromium.launch({ headless: true, channel });
let fx;
try {
  fx = await startHubFixture({ hermes: true, chatRuns: true });
  for (const [name, viewport] of [['phone', { width: 390, height: 844 }], ['wide', { width: 1280, height: 900 }]]) {
    step(`${name}: Send keeps its place while the Model menu arrives late`);
    const context = await browser.newContext({ viewport, serviceWorkers: 'block', reducedMotion: 'reduce', ...(name === 'phone' ? { isMobile: true, hasTouch: true } : {}) });
    const page = await context.newPage();
    page.setDefaultTimeout(ms(15000));
    page.on('pageerror', error => { throw error; });
    await page.route(/\/api\/hub\/chat(\?.*)?$/, async route => { await new Promise(resolve => setTimeout(resolve, 1500)); await route.continue(); });
    await page.goto(`${fx.url}#/~hub/chat`);
    const send = page.getByRole('button', { name: 'Send', exact: true });
    await send.waitFor();
    const before = await send.boundingBox();
    assert.equal(await page.locator('[data-chat-model]').count(), 0, 'the menu is not there yet (the test holds the list back)');
    await page.locator('[data-chat-model]').waitFor();
    const after = await send.boundingBox();
    assert.deepEqual([after.x, after.y, after.width, after.height], [before.x, before.y, before.width, before.height], `Send moved when the menu arrived: ${JSON.stringify(before)} then ${JSON.stringify(after)}`);
    await context.close();
  }
  console.log('hub-chat-send-place-ui: passed');
} finally {
  await browser.close();
  await fx?.close();
}
