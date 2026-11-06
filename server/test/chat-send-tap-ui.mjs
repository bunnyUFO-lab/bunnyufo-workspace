// Run after npm run build. QA round 3: at phone width with touch, the first tap on Send sends, every time. The field is focused and has text, as when
// someone has just typed; each round taps once and the message must go. Fake Hermes only.
import { chromium } from '@playwright/test';
import { ms } from './ui-timeouts.mjs';
import assert from 'node:assert/strict';
import { startHubFixture } from './hub-fixture.mjs';

const step = name => console.log(`- ${name}`);
const channel = process.env.BUW_TEST_BROWSER || 'msedge';
const ROUNDS = 8;

const fixture = await startHubFixture({ hermes: true, chatRuns: true, hermesOptions: { runScripts: Array.from({ length: ROUNDS }, (_, index) => [`Reply ${index + 1}.`]) } });
const browser = await chromium.launch({ headless: true, channel });
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
  const page = await context.newPage();
  page.setDefaultTimeout(ms(15000));
  page.on('pageerror', error => { throw error; });
  const field = page.locator('textarea[aria-label="Message"]');
  const send = page.getByRole('button', { name: 'Send', exact: true });
  await page.goto(`${fixture.url}#/~hub/chat/new`);
  await field.waitFor();
  // Where Send is when the finger goes down and when the click arrives: on a phone, a tap that blurs the field closes the keyboard and the page
  // moves in between, so the click lands on nothing. The tap must not blur the field.
  await page.evaluate(() => {
    const send = event => [...document.querySelectorAll('button')].find(item => item.textContent === 'Send' && item.contains(event.target));
    const where = () => { const box = [...document.querySelectorAll('button')].find(item => item.textContent === 'Send').getBoundingClientRect(); return `${box.x},${box.y}`; };
    window.__taps = [];
    document.addEventListener('pointerdown', event => { if (send(event)) window.__down = where(); }, true);
    document.addEventListener('click', event => { if (send(event)) window.__taps.push({ down: window.__down, up: where(), focused: document.activeElement?.tagName }); }, true);
  });

  step(`${ROUNDS} rounds: type, tap Send once, the message goes`);
  for (let round = 1; round <= ROUNDS; round++) {
    await field.tap();
    await field.pressSequentially(`Note ${round}`, { delay: 5 });
    await page.waitForFunction(() => document.querySelector('button.hub-btn.pri')?.disabled === false);
    const box = await send.boundingBox();
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
    await page.locator('.hub-bubble.user', { hasText: `Note ${round}` }).waitFor({ timeout: ms(3000) });
    await page.locator('.hub-bubble.assistant', { hasText: `Reply ${round}.` }).waitFor();
    assert.equal(await field.inputValue(), '', `round ${round}: the tap sent it`);
  }
  const taps = await page.evaluate(() => window.__taps);
  assert.equal(taps.length, ROUNDS, 'one click per tap');
  for (const tap of taps) assert.equal(tap.focused, 'TEXTAREA', `the tap blurred the field (the phone's keyboard closes and the page moves): ${JSON.stringify(tap)}`);
  for (const tap of taps) assert.equal(tap.down, tap.up, `Send moved between the touch and the click: ${JSON.stringify(tap)}`);
  console.log('ok');
} finally {
  await browser.close();
  await fixture.close();
}
