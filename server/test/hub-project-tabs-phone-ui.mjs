// Run after npm run build. The project page's three tabs (ws-cl0.6.9): Roadmap, Work and Cards, drawn as links in one row at every width.
// Checks: nothing scrolls sideways at 320 and 390, every tab is in the row, selected, 44 px high and inside the screen, each tab is one
// history step, the Work tab carries the Needs count, the old tab addresses land on the new tabs, no More button, and a visitor who cannot
// write sees the same tabs.
import { chromium, expect } from '@playwright/test';
import { ms, SCALE } from './ui-timeouts.mjs';
expect.configure({ timeout: 5000 * SCALE });
import assert from 'node:assert/strict';
import { startHubFixture } from './hub-fixture.mjs';

const step = name => console.log(`- ${name}`);
const channel = process.env.BUW_TEST_BROWSER || 'msedge';
const browser = await chromium.launch({ headless: true, channel });
const contexts = [];
let fixture;

const PHONE = { hasTouch: true, isMobile: true };
const TABS = ['roadmap', 'work', 'cards'];
const LABEL = { roadmap: 'Roadmap', work: 'Work', cards: 'Cards' };

const open = async (viewport, options = {}) => {
  const context = await browser.newContext({ viewport, serviceWorkers: 'block', reducedMotion: 'reduce', ...options });
  contexts.push(context);
  const page = await context.newPage();
  page.setDefaultTimeout(ms(15000));
  page.on('pageerror', error => { throw error; });
  return page;
};
/** The page, the app's scroller (.content), .hub and the tab row: each one that is wider than it is shown. */
const sideways = page => page.evaluate(() => [document.scrollingElement, document.querySelector('.content'), document.querySelector('.hub'), document.querySelector('.pp-tabs')].filter(Boolean).filter(el => el.scrollWidth > el.clientWidth).map(el => `${el.tagName}.${el.className}: ${el.scrollWidth} > ${el.clientWidth}`));
const ready = async (page, tab) => {
  await page.goto(`${fixture.url}#/~hub/project/probe/${tab}`);
  await page.locator(`[data-project-tab="${tab}"].on`).waitFor();
};
const panel = page => page.locator('.pp-main').getAttribute('aria-label');

try {
  fixture = await startHubFixture({ work: true });
  await new Promise(resolve => setTimeout(resolve, 100));

  for (const width of [390, 320]) {
    step(`At ${width} px each tab, opened by address, is in the row, selected, 44 px high and inside the screen, with nothing sideways`);
    const page = await open({ width, height: 844 }, PHONE);
    for (const tab of TABS) {
      await ready(page, tab);
      const current = page.locator(`[data-project-tab="${tab}"]`);
      assert.equal(await current.getAttribute('aria-selected'), 'true', `${tab}: selected.`);
      assert.equal(await panel(page), LABEL[tab], `${tab}: its panel.`);
      assert.deepEqual(await sideways(page), [], `${tab} at ${width}: the page scrolls sideways.`);
      const boxes = await page.locator('.pp-tabs [data-project-tab]').evaluateAll(list => list.map(node => { const r = node.getBoundingClientRect(); return { key: node.getAttribute('data-project-tab'), h: r.height, x: r.x, right: r.right, top: Math.round(r.top) }; }));
      assert.deepEqual(boxes.map(box => box.key), TABS, `${tab}: the three tabs in order.`);
      assert.ok(boxes.every(box => box.h >= 44 && box.x >= 0 && box.right <= width), `${tab}: 44 px high and inside the screen (${JSON.stringify(boxes)}).`);
      assert.equal(new Set(boxes.map(box => box.top)).size, 1, `${tab}: one row.`);
      assert.equal(await page.locator('.pp-more, [data-pp-tabs-row]').count(), 0, `${tab}: no More.`);
    }
    await page.context().close();
  }

  step('Each tab is one history step, and Back follows; the Map switch adds none');
  {
    const page = await open({ width: 390, height: 844 }, PHONE);
    await ready(page, 'roadmap');
    const start = await page.evaluate(() => history.length);
    await page.locator('[data-project-tab="work"]').tap();
    await page.waitForFunction(() => location.hash === '#/~hub/project/probe/work');
    await page.locator('[data-project-tab="cards"]').tap();
    await page.waitForFunction(() => location.hash === '#/~hub/project/probe/cards');
    assert.equal(await page.evaluate(() => history.length), start + 2, 'Two taps, two entries.');
    await page.goBack();
    await page.waitForFunction(() => location.hash === '#/~hub/project/probe/work');
    await expect(page.locator('[data-project-tab="work"]')).toHaveClass(/\bon\b/);
    await page.goBack();
    await page.waitForFunction(() => /^#\/~hub\/project\/probe(\/roadmap)?$/.test(location.hash));
    await expect(page.locator('[data-project-tab="roadmap"]')).toHaveClass(/\bon\b/);
    const before = await page.evaluate(() => history.length);
    await page.locator('[data-roadmap-view="map"]').tap();
    await page.waitForFunction(() => location.hash.startsWith('#/~hub/map/probe'));
    await page.locator('[data-roadmap-view="list"]').tap();
    await page.waitForFunction(() => location.hash === '#/~hub/project/probe');
    assert.equal(await page.evaluate(() => history.length), before, 'List and Map add no entry.');
    await page.context().close();
  }

  step('The Work tab carries the Needs count');
  {
    const page = await open({ width: 390, height: 844 }, PHONE);
    await ready(page, 'roadmap');
    await expect(page.locator('[data-project-tab="work"] small')).toHaveText(/^\d+$/);
    assert.ok(Number(await page.locator('[data-project-tab="work"] small').innerText()) > 0);
    await page.context().close();
  }

  step('The old tab addresses land on the new tabs');
  {
    const page = await open({ width: 390, height: 844 }, PHONE);
    for (const [old, now] of [['running', 'work'], ['needs', 'work'], ['library', 'cards']]) {
      await page.goto(`${fixture.url}#/~hub/project/probe/${old}`);
      await page.waitForFunction(value => location.hash === `#/~hub/project/probe/${value}`, now);
      await expect(page.locator(`[data-project-tab="${now}"]`)).toHaveClass(/\bon\b/);
    }
    await page.context().close();
  }

  step('At 640, 641 and 1280 px the same three tabs, no More; the list stands beside the project from 900');
  for (const width of [640, 641, 1280]) {
    const page = await open({ width, height: 800 });
    await ready(page, 'work');
    assert.deepEqual(await page.locator('.pp-tabs > [data-project-tab]').evaluateAll(list => list.map(node => node.getAttribute('data-project-tab'))), TABS, `${width}: the three tabs.`);
    assert.equal(await page.locator('.pp-more').count(), 0);
    assert.equal(await page.locator('[data-projects-list]').isVisible(), width >= 900, `${width}: the list ${width >= 900 ? 'is' : 'is not'} beside the project.`);
    await page.context().close();
  }

  step('a visitor who cannot write sees the same tabs, and no Plan in Hermes or New job');
  {
    const guestContext = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
    contexts.push(guestContext);
    await guestContext.route('**/api/capabilities', async route => {
      const response = await route.fetch();
      await route.fulfill({ response, json: { ...(await response.json()), write: false } });
    });
    const guest = await guestContext.newPage();
    guest.setDefaultTimeout(ms(15000));
    await guest.goto(`${fixture.url}#/~hub/project/probe`);
    await guest.locator('[data-project-tab="roadmap"].on').waitFor();
    assert.equal(await guest.locator('[data-project-tab]').count(), 3);
    assert.equal(await guest.locator('[data-spawn-open], [data-plan-in-hermes], [data-project-action="build"]').count(), 0);
  }
  console.log('hub-project-tabs-phone-ui: passed');
} finally {
  for (const context of contexts) await context.close().catch(() => {});
  await browser.close();
  await fixture?.close?.().catch(() => {});
}
