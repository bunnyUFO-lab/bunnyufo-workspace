// Run after npm run build. The Roadmap through a real browser, over the hub fixture: where a
// project's work runs (the Runs on chip) and which project the Roadmap opens on.
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { startHubFixture } from './hub-fixture.mjs';
import { beadsIssue, minutesAgo } from '../../site/api/test/hub-fixtures.mjs';

const step = name => console.log(`- ${name}`);
const channel = process.env.BUW_TEST_BROWSER || 'msedge';

const fixture = await startHubFixture();
// Two more copies so the order matters: `aardvark` sorts before Magic Loops alphabetically but is not in the project table; Workspace app is.
for (const [project, title] of [['aardvark', 'Aardvark milestone'], ['workspace-app', 'App milestone']]) {
  fixture.seed.beads(project, [beadsIssue({ id: `${project.slice(0, 2)}-m1`, title, type: 'milestone', created: '2026-10-01T10:00:00Z' })], { pushedAt: minutesAgo(fixture.now, 10).toISOString(), host: 'pc.example.test', count: 1, repo: `example/${project}` });
}
const browser = await chromium.launch({ headless: true, channel });
const contexts = [];
const open = async (viewport, options = {}) => {
  const context = await browser.newContext({ viewport, ...options });
  contexts.push(context);
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => { throw error; });
  return page;
};
const noSideways = async (page, what) => {
  const widths = await page.evaluate(() => ({ scroll: document.scrollingElement.scrollWidth, inner: innerWidth, hub: document.querySelector('.hub')?.scrollWidth ?? 0, hubInner: document.querySelector('.hub')?.clientWidth ?? 0 }));
  assert.ok(widths.scroll <= widths.inner, `${what}: the page scrolls sideways (${widths.scroll} > ${widths.inner}).`);
  assert.ok(widths.hub <= widths.hubInner, `${what}: the Hub scrolls sideways (${widths.hub} > ${widths.hubInner}).`);
};
const go = async (page, hash) => {
  await page.evaluate(value => { location.hash = value; }, hash);
};

try {
  step('a first visit opens Magic Loops, and the chips follow the table order');
  const desk = await open({ width: 1280, height: 800 }, { reducedMotion: 'reduce' });
  await desk.goto(`${fixture.url}#/~hub/map`);
  await desk.locator('.hub-map-wrap').waitFor();
  assert.equal(await desk.locator('.hub-chip.on').innerText(), 'Magic Loops', 'A first visit opens the first project in table order.');
  const names = await desk.locator('.hub-map-chips .hub-chip').allInnerTexts();
  assert.deepEqual(names, ['Magic Loops', 'Workspace app', 'Aardvark', 'Nosprint', 'Wayfind']);

  step('the Runs on chip: full text at desktop width, the rule as its title');
  const chip = desk.locator('.hub-runs');
  assert.equal(await chip.innerText(), 'Runs on: Gaming PC');
  assert.equal(await chip.getAttribute('title'), 'Work for this project runs on the PC by default.');
  await desk.locator('.hub-chip', { hasText: 'Workspace app' }).click();
  await desk.locator('.hub-chip.on', { hasText: 'Workspace app' }).waitFor();
  assert.equal(await chip.innerText(), 'Runs on: cloud');
  assert.equal(await chip.getAttribute('title'), 'This project lives in a GitHub repository, so its work runs in the cloud.');
  await desk.locator('.hub-chip', { hasText: 'Nosprint' }).click();
  await desk.locator('.hub-chip.on', { hasText: 'Nosprint' }).waitFor();
  assert.equal(await desk.locator('.hub-runs').count(), 0, 'A project outside the table has no chip.');

  step('at phone width: short text, one line, nothing sideways');
  const phone = await open({ width: 390, height: 844 }, { hasTouch: true, isMobile: true });
  await phone.goto(`${fixture.url}#/~hub/map`);
  await phone.locator('.hub-map-wrap').waitFor();
  assert.equal(await phone.locator('.hub-chip.on').innerText(), 'Magic Loops');
  assert.equal(await phone.locator('.hub-runs').innerText(), 'PC');
  assert.equal(await phone.locator('.hub-runs').getAttribute('title'), 'Work for this project runs on the PC by default.');
  assert.match(await phone.locator('.hub-runs').getAttribute('aria-label'), /^Runs on: Gaming PC/);
  await noSideways(phone, 'Roadmap at 390');
  const heights = await phone.evaluate(() => ({ row: document.querySelector('.hub-map-chips').getBoundingClientRect().height, chips: document.querySelector('.hub-map-chips .hub-chips-wrap').getBoundingClientRect().height }));
  console.log(`  chips row height at 390: ${heights.row} (the project chips alone, as on main: ${heights.chips})`);
  assert.ok(heights.row <= heights.chips + 0.5, `The chips row is no taller than on main (${heights.row} > ${heights.chips}).`);
  await phone.locator('.hub-chip', { hasText: 'Workspace app' }).click();
  await phone.locator('.hub-chip.on', { hasText: 'Workspace app' }).waitFor();
  assert.equal(await phone.locator('.hub-runs').innerText(), 'Cloud');

  step('the Wayfinder row: destination, decisions and open questions at desktop width');
  await go(desk, '#/~hub/map/wayfind');
  await desk.locator('.hub-wayfinder').waitFor();
  assert.equal(await desk.locator('.hub-wayfinder-text').innerText(), 'A tidy Roadmap that tells the owner where to go next, and why, in one line.');
  assert.equal(await desk.locator('.hub-wayfinder-count').innerText(), '3 decisions');
  assert.equal(await desk.locator('.hub-wayfinder-toggle').getAttribute('aria-expanded'), 'true', 'The list starts open on a wide box.');
  const links = desk.locator('.hub-wayfinder-list a');
  assert.equal(await links.count(), 2);
  assert.equal(await desk.locator('.hub-runs').count(), 0, 'The Runs on chip is not repeated in this row, and wayfind is not in the table.');
  await links.first().click();
  await desk.locator('.hub-map-panel').waitFor();
  assert.match(await desk.locator('.hub-map-panel').innerText(), /Which project comes first\?/);
  await go(desk, '#/~hub/map/magic-loops');
  await desk.locator('.hub-map-wrap').waitFor();
  assert.equal(await desk.locator('.hub-wayfinder').count(), 0, 'A project without a map issue has no row.');

  step('the Wayfinder row at phone width: one line, collapsed, the map keeps the rest');
  await go(phone, '#/~hub/map/wayfind');
  await phone.locator('.hub-wayfinder').waitFor();
  const row = () => phone.locator('.hub-wayfinder').boundingBox();
  assert.equal(await phone.locator('.hub-wayfinder-toggle').getAttribute('aria-expanded'), 'false');
  assert.equal(await phone.locator('.hub-wayfinder-list').count(), 0);
  const collapsed = await row();
  assert.ok(collapsed.height < 50, `The collapsed row is one line (${collapsed.height}).`);
  const fits = async what => {
    const view = await phone.evaluate(() => ({ box: document.querySelector('.hub-map-box').getBoundingClientRect().bottom, bar: document.querySelector('.hub').getBoundingClientRect().bottom }));
    assert.ok(Math.abs(view.box - (view.bar - 8)) <= 10, `${what}: the map box still reaches the bottom (${view.box} vs ${view.bar}).`);
  };
  await fits('collapsed');
  await noSideways(phone, 'Wayfinder row at 390 collapsed');
  await phone.locator('.hub-wayfinder-toggle').click();
  assert.equal(await phone.locator('.hub-wayfinder-list a').count(), 2);
  await fits('expanded');
  await noSideways(phone, 'Wayfinder row at 390 expanded');
  const axis = await phone.locator('.hub-map-box').getAttribute('data-axis');
  if (axis !== null) assert.equal(axis, 'y', 'The row does not change the axis.');

  console.log('hub-map-ui: passed');
} finally {
  for (const context of contexts) await context.close().catch(() => {});
  await browser.close();
  await fixture.close();
}
