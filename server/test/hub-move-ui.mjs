// Run after npm run build. "Move to the cloud" on Today through a real browser, over the fixture service with a throwaway signing
// key and the cloud dry run: a request that has waited 6 hours for the PC gets a tile, one that waited 5 hours does not, the tap opens
// the new request's drawer (started in the cloud, nothing sent), the old request ends Stopped and its tile is gone, and the tile
// fits a phone. With BUW_SHOTS=<dir> it saves screenshots (for a pull request).
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { startHubFixture } from './hub-fixture.mjs';
import { minutesAgo } from '../../site/api/test/hub-fixtures.mjs';

const step = name => console.log(`- ${name}`);
const channel = process.env.BUW_TEST_BROWSER || 'msedge';
const browser = await chromium.launch({ headless: true, channel });
const contexts = [];
const fixtures = [];
const shots = process.env.BUW_SHOTS;
if (shots) await mkdir(shots, { recursive: true });
const open = async (viewport, options = {}) => {
  const context = await browser.newContext({ viewport, serviceWorkers: 'block', reducedMotion: 'reduce', ...options });
  contexts.push(context);
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  page.on('pageerror', error => { throw error; });
  return page;
};
const shot = async (page, name) => { if (shots) await page.screenshot({ path: path.join(shots, `${name}.png`) }); };
const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
const ids = { old: `${day}-magic-loops-waited-long-a1a1`, fresh: `${day}-magic-loops-waited-a-bit-b2b2`, needs: `${day}-magic-loops-needs-the-pc-c3c3` };
const NEVER = '2099-01-01T00:00:00.000Z';

try {
  const fixture = await startHubFixture({ signing: true, env: { HUB_ROUTINE_DRY_RUN: '1' } });
  fixtures.push(fixture);
  const { seed, now, fake } = fixture;
  const pcRequest = (id, text, extra = {}) => {
    seed.request({ id, project: 'magic-loops', createdAt: minutesAgo(now, 500).toISOString(), by: 'owner', text, preset: 'code-task', repo: 'example/magic-loops', target: 'pc', origin: { kind: 'owner', name: 'owner' }, ...extra });
  };
  const approve = (id, hours) => seed.put(`requests/${id}/approved.json`, { v: 1, request: id, project: 'magic-loops', repo: 'example/magic-loops', target: 'pc', limits: { minutes: 120 }, expires: NEVER, at: minutesAgo(now, hours * 60).toISOString(), by: 'owner', signature: 'x' });
  pcRequest(ids.old, 'Fix the tab order on the settings sheet');
  approve(ids.old, 7);
  pcRequest(ids.fresh, 'Rename the dash constants');
  approve(ids.fresh, 5);
  pcRequest(ids.needs, 'Build the playtest', { needs: ['unity'] });
  approve(ids.needs, 9);
  await new Promise(resolve => setTimeout(resolve, 100));

  step('Today offers the move for the request that waited 6 hours, and only for it');
  const page = await open({ width: 1280, height: 900 });
  await page.goto(`${fixture.url}#/~hub/today`);
  const tile = page.locator(`[data-move-offer="${ids.old}"]`);
  await tile.waitFor();
  assert.equal(await page.locator('[data-move-offer]').count(), 1);
  assert.match(await tile.innerText(), /Fix the tab order on the settings sheet/);
  assert.match(await tile.innerText(), /Waited 6 h for the PC\. Move it to the cloud\? It only needs the repo\./);
  await shot(page, 'move-today');

  step('the tap opens the new request: started in the cloud, nothing sent; the old one is stopped and its tile is gone');
  await tile.locator('[data-move-to-cloud]').click();
  const drawer = page.locator('[data-run-drawer]');
  await drawer.waitFor();
  const shownId = await drawer.locator('[data-run-id]').innerText();
  assert.notEqual(shownId.trim(), ids.old, 'The drawer shows the new request.');
  await drawer.locator('[data-run-cloud="fired"]').waitFor();
  assert.match(await drawer.locator('[data-run-cloud]').innerText(), /Started in the cloud at .*\(dev: nothing was sent\)/);
  await shot(page, 'move-drawer');
  assert.ok(fake.objects.has(`sections/inbox/requests/${ids.old}/stop.json`), 'The old request got a signed stop.');
  assert.match(fake.json(`sections/inbox/requests/${ids.old}/stop.json`).reason, new RegExp(`^moved to the cloud: ${shownId.trim()}$`));
  await page.keyboard.press('Escape');
  await page.goto(`${fixture.url}#/~hub/request/${encodeURIComponent(ids.old)}`);
  await page.locator('[data-run-state-chip]', { hasText: 'Stopped' }).waitFor();
  await page.goto(`${fixture.url}#/~hub/today`);
  await page.locator('[data-today-cloud]', { hasText: 'Cloud: 1 of 10 today' }).waitFor();
  assert.equal(await page.locator('[data-move-offer]').count(), 0, 'The tile is gone.');

  step('phone: the tile fits the screen');
  const other = await startHubFixture({ signing: true, env: { HUB_ROUTINE_DRY_RUN: '1' } });
  fixtures.push(other);
  other.seed.request({ id: ids.old, project: 'magic-loops', createdAt: minutesAgo(other.now, 500).toISOString(), by: 'owner', text: 'Fix the tab order on the settings sheet, the one on the phone that nobody can reach', preset: 'code-task', repo: 'example/magic-loops', target: 'pc', origin: { kind: 'owner', name: 'owner' } });
  other.seed.put(`requests/${ids.old}/approved.json`, { v: 1, request: ids.old, project: 'magic-loops', repo: 'example/magic-loops', target: 'pc', limits: { minutes: 120 }, expires: NEVER, at: minutesAgo(other.now, 400).toISOString(), by: 'owner', signature: 'x' });
  await new Promise(resolve => setTimeout(resolve, 100));
  const phone = await open({ width: 375, height: 812 }, { hasTouch: true, isMobile: true });
  await phone.goto(`${other.url}#/~hub/today`);
  await phone.locator('[data-move-offer]').waitFor();
  const widths = await phone.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: document.documentElement.clientWidth }));
  assert.ok(widths.scroll <= widths.inner, 'Today does not scroll sideways.');
  const box = await phone.locator('[data-move-to-cloud]').boundingBox();
  assert.ok(box.height >= 44, 'The button is a touch target.');
  await phone.locator('[data-move-offer]').scrollIntoViewIfNeeded();
  await shot(phone, 'move-today-phone');

  console.log('hub-move-ui: passed');
} finally {
  for (const context of contexts) await context.close().catch(() => {});
  await browser.close();
  for (const fixture of fixtures) await fixture.close();
}
