import { chromium } from '@playwright/test';
import { startHubFixture } from './hub-fixture.mjs';
import { openLibrary, nav } from './shell-helpers.mjs';
const fixture = await startHubFixture({ hermes: true, secondSection: true, thirdSection: true });
const browser = await chromium.launch({ headless: true, channel: process.env.BUW_TEST_BROWSER || 'msedge' });
try {
  const ctx = await browser.newContext({ viewport: { width: 360, height: 740 }, serviceWorkers: 'block', hasTouch: true });
  const page = await ctx.newPage();
  await page.goto(`${fixture.url}#/~hub/today`);
  await page.locator('.hub[data-screen="today"]').waitFor();
  await nav(page, 'library'); await openLibrary(page);
  await page.locator('.lib-row-main').first().tap(); await page.locator('.topbar').waitFor();
  await page.waitForTimeout(500);
  console.log(JSON.stringify(await page.evaluate(() => {
    const b = document.querySelector('[data-back]'); const cs = getComputedStyle(b); const r = b.getBoundingClientRect();
    const t = document.querySelector('.topbar').getBoundingClientRect();
    return { r: [r.width, r.height], display: cs.display, minH: cs.minHeight, tap: getComputedStyle(document.documentElement).getPropertyValue('--tap'), tapBody: getComputedStyle(b).getPropertyValue('--tap'), topbar: [t.top, t.height], crumbs: [...document.querySelectorAll('.breadcrumb > *')].map(e => [e.className, Math.round(e.getBoundingClientRect().width), Math.round(e.getBoundingClientRect().height)]) };
  })));
  await page.screenshot({ path: process.env.TEMP + '/card-before.png' });
  await ctx.close();
} finally { await browser.close(); await fixture.close(); }
