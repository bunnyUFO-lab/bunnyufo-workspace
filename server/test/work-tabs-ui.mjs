// Run after npm run build. Work's four tabs (Running, Delivered, Board, Activity) as links, so each tap is one step of history; a Board
// lane and an Activity filter are chips and add none; a lane the Hub cut (Backlog) shows the rest after "Show more"; the tabs and
// buttons are 44 px; a visitor who cannot write sees the same tabs with no New job. Phone and desktop, over the fixture service.
import { chromium } from '@playwright/test';
import { ms } from './ui-timeouts.mjs';
import assert from 'node:assert/strict';
import { startHubFixture } from './hub-fixture.mjs';
import { beadsIssue, iso, jsonl } from '../../site/api/test/hub-fixtures.mjs';
import { entryOf, noSideways } from './shell-helpers.mjs';

const step = name => console.log(`- ${name}`);
const channel = process.env.BUW_TEST_BROWSER || 'msedge';
const browser = await chromium.launch({ headless: true, channel });
const contexts = [];
const fixtures = [];
const open = async (viewport, options = {}) => {
  const context = await browser.newContext({ viewport, serviceWorkers: 'block', reducedMotion: 'reduce', ...options });
  contexts.push(context);
  const page = await context.newPage();
  page.setDefaultTimeout(ms(15000));
  page.on('pageerror', error => { throw error; });
  return page;
};
const go = (page, hash) => page.evaluate(value => { location.hash = value; }, hash);

try {
  const fx = await startHubFixture({ seedData: false });
  fixtures.push(fx);
  // Seventy deferred tasks: the Hub sends 50 of the Backlog and says there are more.
  const issues = Array.from({ length: 70 }, (_, index) => beadsIssue({ id: `pr-b${String(index).padStart(2, '0')}`, title: `Backlog task ${index}`, status: 'deferred', created: iso(new Date(fx.now.getTime() - index * 60_000)) }));
  fx.seed.put('beads/probe.jsonl', jsonl(issues), 'application/x-ndjson');
  fx.seed.put('beads/probe.meta.json', { pushedAt: iso(fx.now) });
  await new Promise(resolve => setTimeout(resolve, 100));

  for (const [label, viewport] of [['phone', { width: 390, height: 844 }], ['desktop', { width: 1280, height: 900 }]]) {
    const page = await open(viewport);
    await page.goto(`${fx.url}#/~hub/today`);
    await page.locator('.hub[data-screen="today"]').waitFor();
    const start = await entryOf(page);

    step(`${label}: Work opens from a link, has four tabs of 44 px, and each tab is one step`);
    await go(page, '#/~hub/jobs/running');
    await page.locator('[data-work-tabs]').waitFor();
    assert.deepEqual(await page.locator('[data-work-tab]').evaluateAll(list => list.map(node => node.getAttribute('data-work-tab'))), ['running', 'delivered', 'board', 'activity']);
    assert.deepEqual(await page.locator('[data-work-tab]').evaluateAll(list => list.map(node => node.textContent.replace(/\d+$/, '').trim())), ['Running', 'Delivered', 'Board', 'Activity']);
    const small = await page.locator('[data-work-tab]').evaluateAll(list => list.map(node => Math.round(node.getBoundingClientRect().height)).filter(height => height < 44));
    assert.deepEqual(small, [], `${label}: every tab is at least 44 px high`);
    if (label === 'phone') {
      assert.equal(await page.locator('[data-tabs]').count(), 0, 'Work has no tab bar on a phone.');
      assert.equal(await page.locator('[data-back]').count(), 1, 'It has a Back button.');
    }
    assert.equal((await entryOf(page)).serial, start.serial + 1);
    for (const [tab, serial] of [['delivered', 2], ['board', 3], ['activity', 4]]) {
      await page.locator(`[data-work-tab="${tab}"]`).click();
      await page.locator(`[data-work-tab="${tab}"][aria-selected="true"]`).waitFor();
      assert.equal((await entryOf(page)).serial, start.serial + serial, `${tab}: one step`);
    }
    assert.match(await page.evaluate(() => location.hash), /^#\/~hub\/activity$/);

    step(`${label}: an Activity filter is a chip: it changes the address and adds no step`);
    const before = await entryOf(page);
    await page.locator('[data-activity-filter="agents"]').click();
    await page.locator('[data-activity-filter="agents"][aria-current="true"]').waitFor();
    assert.match(await page.evaluate(() => location.hash), /^#\/~hub\/activity\/agents$/);
    assert.equal((await entryOf(page)).serial, before.serial, 'The filter added no entry.');

    step(`${label}: Back walks the tabs one at a time and ends on Today`);
    for (const hash of [/^#\/~hub\/work/, /^#\/~hub\/jobs\/finished$/, /^#\/~hub\/jobs\/running$/]) {
      await page.goBack();
      await page.waitForFunction(source => new RegExp(source).test(location.hash), hash.source);
    }
    await page.goBack();
    await page.locator('.hub[data-screen="today"]').waitFor();
    await noSideways(page, `${label} Work`);
  }

  step('phone: the Board shows one lane; a lane chip adds no step; Show more adds the rest of the Backlog');
  const phone = await open({ width: 390, height: 844 });
  await phone.goto(`${fx.url}#/~hub/work/probe`);
  await phone.locator('[data-lane-chip]').first().waitFor();
  assert.equal(await phone.locator('.wk-lane').evaluateAll(list => list.filter(node => getComputedStyle(node).display !== 'none').length), 1, 'One lane at a time.');
  const at = await entryOf(phone);
  await phone.locator('[data-lane-chip="backlog"]').click();
  assert.equal((await entryOf(phone)).serial, at.serial, 'A lane chip adds no step.');
  assert.equal((await phone.locator('[data-lane-chip="backlog"] .n').innerText()).trim(), '70');
  const cards = phone.locator('.wk-lane[data-lane="backlog"] .wk-card');
  assert.equal(await cards.count(), 10, 'The lane folds at ten.');
  await phone.locator('.wk-lane[data-lane="backlog"] .wk-more', { hasText: 'Show all 50' }).click();
  assert.equal(await cards.count(), 50, 'The Hub sent 50.');
  const more = phone.locator('[data-lane-more="backlog"]');
  assert.match(await more.innerText(), /Show more · 20 left/);
  assert.equal((await more.boundingBox()).height >= 44, true, 'Show more is a tap target.');
  let asked = 0;
  await phone.route('**/api/hub/work?*', async route => { asked += 1; await route.continue(); });
  await more.click();
  await phone.locator('.wk-lane[data-lane="backlog"] .wk-card').nth(69).waitFor();
  assert.equal(await cards.count(), 70);
  assert.equal(asked, 1, 'One request for the page.');
  assert.equal(await phone.locator('[data-lane-more="backlog"]').count(), 0, 'Nothing left to show.');
  assert.equal(new Set(await cards.evaluateAll(list => list.map(node => node.getAttribute('data-card')))).size, 70, 'Each card once.');
  assert.equal((await entryOf(phone)).serial, at.serial, 'Paging adds no step.');
  assert.match(await phone.locator('[data-spawn-open]').innerText(), /^New job$/);

  step('desktop: the Board shows its lanes as columns, with New job on the Board itself');
  const wide = await open({ width: 1280, height: 900 });
  await wide.goto(`${fx.url}#/~hub/work/probe`);
  await wide.locator('.wk-lane').first().waitFor();
  const tops = await wide.locator('.wk-lane').evaluateAll(list => list.filter(node => getComputedStyle(node).display !== 'none').map(node => Math.round(node.getBoundingClientRect().top)));
  assert.ok(tops.length >= 4 && new Set(tops).size === 1, 'Lanes in one row.');
  assert.equal(await wide.locator('[data-spawn-open]').count(), 1, 'One New job button on the Board.');

  step('a visitor who cannot write sees the same tabs and no New job, on every tab');
  const guestContext = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  contexts.push(guestContext);
  await guestContext.route('**/api/capabilities', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...(await response.json()), write: false } });
  });
  const guest = await guestContext.newPage();
  guest.setDefaultTimeout(ms(15000));
  for (const hash of ['jobs/running', 'jobs/finished', 'work/probe', 'activity']) {
    await guest.goto(`${fx.url}#/~hub/${hash}`);
    await guest.locator('[data-work-tabs]').waitFor();
    assert.equal(await guest.locator('[data-work-tab]').count(), 4, `${hash}: the same four tabs`);
    assert.equal(await guest.locator('[data-spawn-open]').count(), 0, `${hash}: no New job`);
  }
  console.log('work-tabs-ui: ok');
} finally {
  for (const context of contexts) await context.close().catch(() => {});
  await browser.close().catch(() => {});
  for (const fixture of fixtures) await fixture.close().catch(() => {});
}
