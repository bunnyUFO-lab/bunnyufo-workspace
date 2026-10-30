// Run after npm run build. Dismiss, Clear all and Undo on Today's Alerts panel (ws-9xg), desktop and phone; a dismissal
// holds on a second browser (it is kept on the server). Data is the fixture's own fake S3.
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { startHubFixture } from './hub-fixture.mjs';
import { eventJson, minutesAgo } from '../../site/api/test/hub-fixtures.mjs';

const step = name => console.log(`- ${name}`);
const channel = process.env.BUW_TEST_BROWSER || 'msedge';
const browser = await chromium.launch({ headless: true, channel });
const contexts = [];
const fixtures = [];
const open = async viewport => {
  const context = await browser.newContext({ viewport, serviceWorkers: 'block', reducedMotion: 'reduce' });
  contexts.push(context);
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => { throw error; });
  return page;
};

try {
  for (const [label, viewport] of [['desktop', { width: 1280, height: 900 }], ['phone', { width: 390, height: 844 }]]) {
    const fx = await startHubFixture({ seedData: false });
    fixtures.push(fx);
    for (const [index, title] of ['Run failed: 20261030-workspace-app-fix-a-typo-m8nl', 'Run failed: 20261030-workspace-app-fix-a-typo-92vg', 'Request failed: Fix a typo in docs'].entries()) {
      fx.seed.event(eventJson({ kind: 'alert', ts: minutesAgo(fx.now, 10 + index), title, summary: 'It stopped.', project: 'workspace-app' }));
    }
    await new Promise(resolve => setTimeout(resolve, 100));
    const page = await open(viewport);
    await page.goto(`${fx.url}#/~hub/today`);
    const alerts = page.locator('[aria-label="Alerts"]');
    await alerts.locator('[data-alert]').first().waitFor();
    assert.equal(await alerts.locator('[data-alert]').count(), 3);
    assert.equal((await page.locator('[data-kpi="alerts"] .hub-kpi-v').innerText()).trim(), '3');

    step(`${label}: Dismiss removes one alert and the count drops; Undo brings it back`);
    const box = await alerts.locator('[data-alert-dismiss]').first().boundingBox();
    if (label === 'phone') assert.ok(box.height >= 44, 'The Dismiss target is at least 44 px high.');
    await alerts.locator('[data-alert-dismiss]').first().click();
    await alerts.locator('[data-alerts-undo]').waitFor();
    await page.waitForFunction(() => document.querySelectorAll('[aria-label="Alerts"] [data-alert]').length === 2);
    assert.equal((await page.locator('[data-kpi="alerts"] .hub-kpi-v').innerText()).trim(), '2');
    await page.screenshot({ path: process.env.SHOTS ? `${process.env.SHOTS}/alerts-dismissed-${label}.png` : undefined, fullPage: true }).catch(() => {});
    await alerts.locator('[data-alerts-undo-button]').click();
    await page.waitForFunction(() => document.querySelectorAll('[aria-label="Alerts"] [data-alert]').length === 3);

    step(`${label}: Clear all empties the panel, and a second browser sees it empty too`);
    await alerts.locator('[data-alerts-clear]').click();
    await alerts.locator('.hub-empty', { hasText: 'No alerts.' }).waitFor();
    assert.equal((await page.locator('[data-kpi="alerts"] .hub-kpi-v').innerText()).trim(), '0');
    const other = await open(viewport);
    await other.goto(`${fx.url}#/~hub/today`);
    await other.locator('[aria-label="Alerts"] .hub-empty', { hasText: 'No alerts.' }).waitFor();
    await other.goto(`${fx.url}#/~hub/activity/alerts`);
    await other.locator('.hub-row', { hasText: 'Request failed: Fix a typo in docs' }).waitFor();
    const widths = await page.evaluate(() => ({ scroll: document.scrollingElement.scrollWidth, inner: innerWidth }));
    assert.ok(widths.scroll <= widths.inner, `${label}: the page scrolls sideways.`);
  }
  console.log('hub-alerts-ui: passed');
} finally {
  for (const context of contexts) await context.close().catch(() => {});
  await browser.close();
  for (const fixture of fixtures) await fixture.close();
}
