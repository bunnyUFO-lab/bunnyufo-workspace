// Run after npm run build. On a phone (touch, 390 px) the picture buttons must let the owner pick an existing screenshot: neither the
// checklist step's camera button nor the Chat's attach button may carry `capture` (that opens the camera and nothing else), and both list
// explicit picture types. Without a real phone only the markup can be checked, not what Android or iOS then offers.
import { chromium } from '@playwright/test';
import { ms } from './ui-timeouts.mjs';
import assert from 'node:assert/strict';
import { FIXTURE_CHECKLIST, startHubFixture } from './hub-fixture.mjs';

const step = name => console.log(`- ${name}`);
const channel = process.env.BUW_TEST_BROWSER || 'msedge';
const fixture = await startHubFixture({ checklists: true, hermes: true, chatRuns: true });
const browser = await chromium.launch({ headless: true, channel });
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, serviceWorkers: 'block' });
  const page = await context.newPage();
  page.setDefaultTimeout(ms(15000));
  page.on('pageerror', error => { throw error; });
  const check = async (what, locator) => {
    await locator.first().waitFor({ state: 'attached' });
    for (const input of await locator.all()) {
      assert.equal(await input.getAttribute('capture'), null, `${what}: no capture attribute, or the phone opens the camera only`);
      const accept = await input.getAttribute('accept');
      assert.ok(accept && !accept.split(',').includes('image/*'), `${what}: accept names explicit picture types (${accept})`);
      for (const type of ['image/png', 'image/jpeg']) assert.ok(accept.split(',').includes(type), `${what}: accepts ${type}`);
    }
  };

  step('a checklist step: its camera button has no capture');
  await page.goto(`${fixture.url}#/~hub/checklist/${FIXTURE_CHECKLIST}`);
  await check('checklist step', page.locator('[data-item] [data-attach-input]'));

  step('the Chat: the attach button has no capture');
  await page.goto(`${fixture.url}#/~hub/chat`);
  await check('chat', page.locator('.hub-compose [data-attach-input]'));
  console.log('ok');
} finally {
  await browser.close();
  await fixture.close();
}
