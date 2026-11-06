import { chromium } from '@playwright/test';
import { startHubFixture } from './hub-fixture.mjs';
import { openLibrary, nav } from './shell-helpers.mjs';
const fixture = await startHubFixture({ hermes: true, secondSection: true, thirdSection: true });
const browser = await chromium.launch({ headless: true, channel: process.env.BUW_TEST_BROWSER || 'msedge' });
const measure = () => ({
  inner: innerWidth, doc: document.scrollingElement.scrollWidth,
  over: [...document.querySelectorAll('*')].filter(el => el.scrollWidth > el.clientWidth + 1 && el.clientWidth && getComputedStyle(el).overflowX !== 'visible').map(el => [el.tagName, String(el.className).slice(0, 30), el.scrollWidth, el.clientWidth, el.scrollLeft]).slice(0, 10),
  wide: [...document.querySelectorAll('.lib *')].filter(el => { const b = el.getBoundingClientRect(); return b.width && b.right > el.closest('.lib').getBoundingClientRect().right + 1; }).map(el => [el.tagName, String(el.className).slice(0, 30), Math.round(el.getBoundingClientRect().right)]).slice(0, 8),
});
try {
  for (const [width, card] of [[360, false], [1200, true], [1000, true]]) {
    const ctx = await browser.newContext({ viewport: { width, height: 800 }, serviceWorkers: 'block', hasTouch: width < 900 });
    await ctx.addInitScript(() => { try { localStorage.setItem('buw.menuCollapsed', '0'); } catch {} });
    const page = await ctx.newPage();
    await page.goto(`${fixture.url}#/~hub/today`);
    await page.locator('.hub[data-screen="today"]').waitFor();
    await nav(page, 'library'); await openLibrary(page);
    if (card) { await page.locator('.lib-row-main').first().click(); await page.locator('.topbar').waitFor(); }
    await page.waitForTimeout(400);
    await page.locator('[data-library] .lib-search input').focus();
    await page.keyboard.type('a');
    console.log(width, card, JSON.stringify(await page.evaluate(measure)));
    await ctx.close();
  }
} finally { await browser.close(); await fixture.close(); }
