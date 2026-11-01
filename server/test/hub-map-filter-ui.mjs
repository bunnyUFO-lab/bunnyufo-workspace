// Run after npm run build. The Roadmap's filter through a real browser: open work by default, the status presets and
// chips, the date choices, the choice kept across a reload, the reset, Fit on the filtered view, and the panel as a
// popover on a desktop and a sheet on a phone.
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { startHubFixture } from './hub-fixture.mjs';
import { beadsIssue, minutesAgo } from '../../site/api/test/hub-fixtures.mjs';

const step = name => console.log(`- ${name}`);
const channel = process.env.BUW_TEST_BROWSER || 'msedge';

const DAY = 86_400_000;
const fixture = await startHubFixture();
const ago = days => new Date(Date.now() - days * DAY).toISOString();
const ymd = days => { const date = new Date(Date.now() - days * DAY); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; };
// Milestone 1: a fresh, a month-old, a stale and a finished task. Milestone 2: only finished work.
const issues = [
  beadsIssue({ id: 'wa-m1', title: 'Open milestone', type: 'milestone', created: ago(300), updated: ago(1) }),
  beadsIssue({ id: 'wa-f1', title: 'The feature', type: 'epic', parent: 'wa-m1', created: ago(300), updated: ago(1) }),
  beadsIssue({ id: 'wa-new', title: 'Fresh task', status: 'in_progress', parent: 'wa-f1', created: ago(300), updated: ago(2) }),
  beadsIssue({ id: 'wa-mid', title: 'Month-old task', parent: 'wa-f1', created: ago(300), updated: ago(20) }),
  beadsIssue({ id: 'wa-old', title: 'Stale task', parent: 'wa-f1', created: ago(300), updated: ago(200) }),
  beadsIssue({ id: 'wa-done', title: 'Finished task', status: 'closed', parent: 'wa-f1', created: ago(300), updated: ago(1), closed: ago(1) }),
  beadsIssue({ id: 'wa-m2', title: 'Finished milestone', type: 'milestone', status: 'closed', blocks: ['wa-m1'], created: ago(300), updated: ago(5), closed: ago(5) }),
  beadsIssue({ id: 'wa-f2', title: 'Old feature', type: 'epic', status: 'closed', parent: 'wa-m2', created: ago(300), updated: ago(5), closed: ago(5) }),
  beadsIssue({ id: 'wa-done2', title: 'Old finished task', status: 'closed', parent: 'wa-f2', created: ago(300), updated: ago(5), closed: ago(5) }),
];
fixture.seed.beads('workspace-app', issues, { pushedAt: minutesAgo(fixture.now, 10).toISOString(), host: 'pc.example.test', count: issues.length, repo: 'example/workspace-app' });

const browser = await chromium.launch({ headless: true, channel });
const contexts = [];
const open = async (viewport, options = {}) => {
  const context = await browser.newContext({ viewport, reducedMotion: 'reduce', ...options });
  contexts.push(context);
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => { throw error; });
  return page;
};
const showMap = async page => {
  await page.goto(`${fixture.url}#/~hub/map/workspace-app`);
  await page.locator('.hub-map-box svg').waitFor();
  await page.waitForTimeout(400);
};
const expandAll = async page => { await page.getByRole('button', { name: 'Expand all' }).click(); await page.waitForTimeout(500); };
const tasks = page => page.locator('[data-kind="t"]').evaluateAll(list => list.map(node => node.getAttribute('data-node')).sort());
const chip = page => page.locator('[data-filter-chip] .hub-filter-chip-text').innerText();
const stored = page => page.evaluate(() => localStorage.getItem('hub-map-filter'));
const openPanel = async page => { await page.getByRole('button', { name: 'Filter', exact: true }).click(); await page.locator('#hub-map-filter').waitFor(); };
const closePanel = async page => { await page.locator('#hub-map-filter').getByRole('button', { name: 'Done', exact: true }).last().click(); await page.waitForTimeout(300); };
const within = async (page, days) => { await page.locator(`[data-within="${days}"]`).click(); await page.waitForTimeout(500); };
const width = page => page.locator('.hub-map-box svg').evaluate(svg => Number(svg.getAttribute('width')));

try {
  const page = await open({ width: 1280, height: 800 });

  step('the default is Open: done tasks are hidden, the chip says Open, there is nothing to reset');
  await showMap(page);
  assert.equal(await chip(page), 'Open');
  assert.equal(await page.locator('.hub-filter-chip-x').count(), 0, 'no reset on the default');
  await expandAll(page);
  assert.deepEqual(await tasks(page), ['wa-mid', 'wa-new', 'wa-old']);
  const openWidth = await width(page);
  const thin = page.locator('[data-node="wa-m2"]');
  assert.match(await thin.textContent(), /1 hidden/, 'a milestone with nothing left is a thin "n hidden" line');
  assert.equal(await page.locator('[data-toggle="wa-m2"]').count(), 0, 'and has nothing to open');
  assert.match(await page.locator('[data-node="wa-m1"]').textContent(), /3\/4/, 'the milestone counts shown/total');
  assert.equal(await stored(page), null, 'the default stores nothing');

  step('the panel: presets, status chips, a count, at most 600 px wide, Escape closes it');
  await openPanel(page);
  const panel = page.locator('#hub-map-filter');
  assert.ok((await panel.boundingBox()).width <= 600, 'a popover of at most 600 px');
  assert.equal(await panel.locator('[data-preset="open"]').getAttribute('aria-pressed'), 'true');
  assert.deepEqual(await panel.locator('[data-state-chip]').evaluateAll(list => list.map(item => [item.dataset.stateChip, item.getAttribute('aria-pressed')])),
    [['doing', 'true'], ['you', 'true'], ['next', 'true'], ['later', 'true'], ['done', 'false']]);
  assert.match(await panel.locator('[data-filter-count]').innerText(), /3 of 5 tasks shown/);
  await page.keyboard.press('Escape');
  assert.equal(await panel.count(), 0, 'Escape closes the panel');

  step('All shows the done tasks; the choice is stored and survives a reload');
  await openPanel(page);
  await page.locator('[data-preset="all"]').click();
  await page.waitForTimeout(500);
  assert.deepEqual(await tasks(page), ['wa-done', 'wa-mid', 'wa-new', 'wa-old']);
  assert.equal(await chip(page), 'All');
  assert.ok(JSON.parse(await stored(page)).states.includes('done'));
  assert.ok(await width(page) > openWidth, 'the drawing is wider with the done tasks in it');
  assert.equal(await page.locator('[data-node="wa-m2"]').textContent().then(text => /hidden/.test(text)), false);
  await page.reload();
  await page.locator('.hub-map-box svg').waitFor();
  await page.waitForTimeout(400);
  assert.equal(await chip(page), 'All', 'the choice survived the reload');
  await expandAll(page);
  assert.deepEqual(await tasks(page), ['wa-done', 'wa-done2', 'wa-mid', 'wa-new', 'wa-old']);

  step('the reset (x) returns to Open and forgets the choice');
  await page.getByRole('button', { name: 'Reset the filter to Open' }).click();
  await page.waitForTimeout(500);
  assert.equal(await chip(page), 'Open');
  assert.deepEqual(await tasks(page), ['wa-mid', 'wa-new', 'wa-old']);
  assert.equal(await stored(page), null);
  assert.equal(await page.locator('.hub-filter-chip-x').count(), 0);

  step('status chips: In progress only, then a custom pair; the last state cannot be switched off');
  await openPanel(page);
  await page.locator('[data-preset="doing"]').click();
  await page.waitForTimeout(500);
  assert.deepEqual(await tasks(page), ['wa-new']);
  assert.equal(await chip(page), 'In progress only');
  await page.locator('[data-state-chip="doing"]').click();
  assert.equal(await page.locator('[data-state-chip="doing"]').getAttribute('aria-pressed'), 'true', 'the only state stays on');
  await page.locator('[data-state-chip="done"]').click();
  await page.waitForTimeout(500);
  assert.deepEqual(await tasks(page), ['wa-done', 'wa-done2', 'wa-new']);
  assert.equal(await chip(page), 'In progress, Done');

  step('dates: 7, 30 and 90 days, and a custom from-to');
  await page.locator('[data-preset="open"]').click();
  await within(page, 30);
  assert.deepEqual(await tasks(page), ['wa-mid', 'wa-new']);
  assert.equal(await chip(page), 'Open · 30 d');
  await within(page, 7);
  assert.deepEqual(await tasks(page), ['wa-new']);
  await within(page, 90);
  assert.deepEqual(await tasks(page), ['wa-mid', 'wa-new']);
  await panel.locator('input[type="date"]').first().fill(ymd(25));
  await panel.locator('input[type="date"]').nth(1).fill(ymd(10));
  await page.waitForTimeout(500);
  assert.deepEqual(await tasks(page), ['wa-mid'], 'only the task updated between the two days');
  assert.match(await chip(page), /^Open · .+ to .+$/);
  await within(page, 'any');
  assert.deepEqual(await tasks(page), ['wa-mid', 'wa-new', 'wa-old']);
  assert.equal(await panel.locator('input[type="date"]').first().inputValue(), '', 'a preset clears the custom range');

  step('Fit fits the filtered items');
  await closePanel(page);
  await page.getByRole('button', { name: 'Fit the whole map' }).click();
  await page.waitForTimeout(700);
  const outside = await page.evaluate(() => {
    const box = document.querySelector('.hub-map-box').getBoundingClientRect();
    return [...document.querySelectorAll('.hub-map-box [data-node]')].filter(node => {
      const rect = node.getBoundingClientRect();
      return rect.width && (rect.left < box.left - 1 || rect.right > box.right + 1 || rect.top < box.top - 1 || rect.bottom > box.bottom + 1);
    }).map(node => node.dataset.node);
  });
  assert.deepEqual(outside, [], 'every drawn node is inside the box after Fit');
  assert.equal(await page.locator('[data-node="wa-done"]').count(), 0, 'and the done task is not drawn');

  step('Now works on the filtered view, and a bad stored value falls back to Open');
  await page.getByRole('button', { name: 'Go to now' }).click();
  await page.waitForTimeout(500);
  assert.ok(await page.locator('.hub-map-now').isVisible());
  await page.evaluate(() => localStorage.setItem('hub-map-filter', '{bad'));
  await page.reload();
  await page.locator('.hub-map-box svg').waitFor();
  assert.equal(await chip(page), 'Open');
  await page.evaluate(() => localStorage.setItem('hub-map-filter', JSON.stringify({ states: [], within: 5 })));
  await page.reload();
  await page.locator('.hub-map-box svg').waitFor();
  assert.equal(await chip(page), 'Open');

  step('a phone: the panel is a sheet along the bottom, nothing scrolls sideways');
  const phone = await open({ width: 390, height: 844 }, { hasTouch: true, isMobile: true });
  await showMap(phone);
  assert.equal(await chip(phone), 'Open');
  await phone.getByRole('button', { name: 'Filter', exact: true }).tap();
  const sheet = phone.locator('#hub-map-filter');
  await sheet.waitFor();
  const rect = await sheet.boundingBox();
  const wrap = await phone.locator('.hub-map-wrap').boundingBox();
  assert.ok(Math.abs(rect.x - wrap.x) <= 1 && Math.abs(rect.width - wrap.width) <= 1, `the sheet spans the map's width (${rect.x}, ${rect.width})`);
  assert.ok(rect.width >= 360, 'nearly the whole phone');
  assert.ok(Math.abs(rect.y + rect.height - (wrap.y + wrap.height)) <= 2, 'and sits on the bottom edge of the map');
  const widths = await phone.evaluate(() => ({ scroll: document.scrollingElement.scrollWidth, inner: innerWidth }));
  assert.ok(widths.scroll <= widths.inner, 'no sideways scroll');
  await phone.locator('[data-preset="all"]').tap();
  await phone.waitForTimeout(400);
  assert.equal(await chip(phone), 'All');

  console.log('hub-map-filter-ui: passed');
} finally {
  for (const context of contexts) await context.close().catch(() => {});
  await browser.close();
  await fixture.close();
}
