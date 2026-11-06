// Run after npm run build. The Hub shows a screen's last data at once when it is opened again, then refreshes it;
// nothing cached survives a write, a 401 or a reload. Through a real browser at phone width, over the hub fixture.
import { chromium } from '@playwright/test';
import { ms } from './ui-timeouts.mjs';
import assert from 'node:assert/strict';
import { FIXTURE_ASK, startHubFixture } from './hub-fixture.mjs';

const step = name => console.log(`- ${name}`);
const channel = process.env.BUW_TEST_BROWSER || 'msedge';
const fixture = await startHubFixture({ pc: 'fresh', hermes: true });
const browser = await chromium.launch({ headless: true, channel });
const contexts = [];
const open = async viewport => {
  const context = await browser.newContext({ viewport });
  await context.addInitScript(() => { try { localStorage.setItem('hub.undoMs', '0'); } catch { /* no storage */ } });
  contexts.push(context);
  const page = await context.newPage();
  page.setDefaultTimeout(ms(15000));
  page.on('pageerror', error => { throw error; });
  return page;
};
const go = (page, hash) => page.evaluate(value => { location.hash = value; }, hash);
const wait = time => new Promise(resolve => setTimeout(resolve, time));
const loading = page => page.locator('.hub-empty', { hasText: 'Loading…' });
const wrote = page => page.evaluate(() => window.dispatchEvent(new Event('buw:hub-wrote')));
const rename = (name, index = 0) => body => ({ ...body, agents: body.agents.map((agent, at) => (at === index ? { ...agent, name } : agent)) });
// Answers a route after a delay, from the real server, optionally changing the body.
const delayed = (page, pattern, time, change) => page.route(pattern, async route => {
  try {
    await wait(time);
    if (!change) return await route.continue();
    const response = await route.fetch();
    return await route.fulfill({ response, json: change(await response.json()) });
  } catch { /* the page moved on or the route was removed while it waited */ }
});

const TEAM = /\/api\/hub\/team$/;
const WORK = /\/api\/hub\/work/;
const ASK = new RegExp(`/api/hub/asks/${FIXTURE_ASK}$`);
const WRITTEN = /\/api\/hub\/(today|inbox)/;
const MAP = /\/api\/hub\/map\//;

try {
  const page = await open({ width: 390, height: 844 });
  const gets = [];
  page.on('request', request => { if (request.method() === 'GET' && request.url().includes('/api/hub/')) gets.push(new URL(request.url()).pathname.replace('/api/hub', '')); });
  await page.goto(`${fixture.url}#/~hub/team`);
  await page.locator('.team-card').first().waitFor();

  step('Team again after Today: the cards are there at once, no Loading, one GET, and the new name lands');
  await go(page, '#/~hub/today');
  await page.locator('[data-today-open]').waitFor();
  await delayed(page, TEAM, 1000, rename('Renamed agent'));
  const before = gets.filter(path => path === '/team').length;
  await go(page, '#/~hub/team');
  await page.locator('.team .team-card').first().waitFor({ timeout: ms(500) });
  assert.equal(await loading(page).count(), 0, 'No Loading line on a return.');
  assert.notEqual(await page.locator('.team-card h3').first().innerText(), 'Renamed agent', 'The old name shows first.');
  await page.locator('.team-card h3', { hasText: 'Renamed agent' }).waitFor();
  await wait(300);
  assert.equal(gets.filter(path => path === '/team').length - before, 1, 'One GET for the return.');
  await page.unroute(TEAM);

  step('Work: a project never visited shows Loading and no card of the other project; the first project is back at once');
  await go(page, '#/~hub/work/magic-loops');
  await page.locator('[data-card]').first().waitFor({ state: 'attached' });
  const cardsOfA = await page.locator('[data-card]').evaluateAll(list => list.map(node => node.getAttribute('data-card')));
  assert.ok(cardsOfA.length > 0);
  await delayed(page, WORK, 1000);
  await go(page, '#/~hub/work/wayfind');
  await loading(page).waitFor();
  for (const key of cardsOfA) assert.equal(await page.locator(`[data-card="${key}"]`).count(), 0, 'No card of the other project.');
  await loading(page).waitFor({ state: 'detached' });
  await go(page, '#/~hub/work/magic-loops');
  await page.locator('[data-card]').first().waitFor({ state: 'attached', timeout: ms(500) });
  assert.equal(await loading(page).count(), 0);
  await page.unroute(WORK);

  step('a cached Ask answered with 404: the error shows, not the old Ask');
  await go(page, `#/~hub/ask/${FIXTURE_ASK}`);
  await page.locator('.hub-option-pick').first().waitFor();
  await go(page, '#/~hub/today');
  await page.locator('[data-today-open]').waitFor();
  await page.route(ASK, route => route.fulfill({ status: 404, json: { error: 'There is no such Ask.' } }));
  await go(page, `#/~hub/ask/${FIXTURE_ASK}`);
  await page.locator('.hub-empty', { hasText: 'There is no such Ask.' }).waitFor();
  assert.equal(await page.locator('.hub-option-pick').count(), 0, 'The old Ask is gone.');
  await page.unroute(ASK);

  step('after a write: Today and Needs show Loading, never the pre-write data');
  await go(page, '#/~hub/today');
  await page.locator('[data-today-open]').waitFor();
  const oldCount = await page.locator('[data-today-open] .today-num').innerText();
  await go(page, '#/~hub/needs');
  const card = page.locator(`.ni[data-need="ask-${FIXTURE_ASK}"]`);
  await card.waitFor();
  await delayed(page, WRITTEN, 1500);
  await card.locator('[data-option="B"] .hub-option-pick').click();
  await card.getByRole('button', { name: 'Send answer' }).click();
  await card.waitFor({ state: 'detached' });
  await go(page, '#/~hub/today');
  await loading(page).waitFor();
  assert.equal(await page.locator('[data-today-open]').count(), 0, 'The old count does not show.');
  await go(page, '#/~hub/needs');
  await loading(page).waitFor();
  assert.equal(await card.count(), 0, 'The answered Ask is not shown from the cache.');
  await loading(page).waitFor({ state: 'detached' });
  assert.equal(await card.count(), 0);
  await go(page, '#/~hub/today');
  await page.locator('[data-today-open] .today-num').waitFor();
  assert.notEqual(await page.locator('[data-today-open] .today-num').innerText(), oldCount, 'The count dropped by the answered Ask.');
  await page.unroute(WRITTEN);

  step('a GET held open across a write does not leave its old answer in the cache');
  await go(page, '#/~hub/team');
  await page.locator('.team-card').first().waitFor();
  let served = 0;
  await page.route(TEAM, async route => {
    served += 1;
    const old = served === 1;
    const response = await route.fetch();
    if (old) await wait(1500);
    return route.fulfill({ response, json: rename(old ? 'Old answer' : 'New answer')(await response.json()) });
  });
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));   // a GET is out
  await wrote(page);                                                                  // and a write lands
  await page.locator('.team-card h3', { hasText: 'New answer' }).waitFor();
  await wait(1800);
  assert.equal(await page.locator('.team-card h3', { hasText: 'Old answer' }).count(), 0);
  await go(page, '#/~hub/today');
  await page.locator('[data-today-open]').waitFor();
  await page.unroute(TEAM);
  await delayed(page, TEAM, 800);
  await go(page, '#/~hub/team');
  await page.locator('.team-card').first().waitFor({ timeout: ms(500) });
  assert.equal(await page.locator('.team-card h3', { hasText: 'Old answer' }).count(), 0, 'The old answer is not in the cache.');
  await page.locator('.team-card h3', { hasText: 'New answer' }).count();
  await page.unroute(TEAM);

  step('a failed refresh keeps the data and says so quietly; it recovers');
  await go(page, '#/~hub/today');
  await page.locator('[data-today-open]').waitFor();
  let failing = true;
  await page.route(TEAM, route => (failing ? route.fulfill({ status: 500, json: { error: 'The Hub is down.' } }) : route.continue()));
  await go(page, '#/~hub/team');
  await page.locator('.team-card').first().waitFor();
  await page.locator('[data-hub-stale]').waitFor();
  assert.equal(await page.locator('.hub-error').count(), 0, 'No red error over good data.');
  assert.equal(await loading(page).count(), 0);
  failing = false;
  await page.locator('[data-hub-stale]').waitFor({ state: 'detached', timeout: ms(20000) });
  await page.unroute(TEAM);

  step('project page Roadmap tab: rows stay when the map read fails');
  await go(page, '#/~hub/project/magic-loops');
  await page.locator('[data-pp-milestone]').first().waitFor();
  const rows = await page.locator('[data-pp-milestone]').count();
  await page.route(MAP, route => route.fulfill({ status: 500, json: { error: 'The Hub is down.' } }));
  await wrote(page);
  await page.locator('[data-hub-stale]').waitFor();
  assert.equal(await page.locator('[data-pp-milestone]').count(), rows, 'The rows stay.');
  assert.equal(await page.locator('.hub-error').count(), 0);
  await page.unroute(MAP);

  step('a 401 empties everything cached and shows the error');
  await go(page, '#/~hub/team');
  await page.locator('.team-card').first().waitFor();
  await go(page, '#/~hub/work/magic-loops');
  await page.locator('[data-card]').first().waitFor({ state: 'attached' });
  await go(page, '#/~hub/today');
  await page.locator('[data-today-open]').waitFor();
  await page.route(TEAM, route => route.fulfill({ status: 401, json: { error: 'Sign in again.' } }));
  await go(page, '#/~hub/team');
  await page.locator('.hub-empty', { hasText: 'Sign in again.' }).waitFor();
  assert.equal(await page.locator('.team-card').count(), 0, 'The old cards are gone.');
  await page.unroute(TEAM);
  await delayed(page, WORK, 800);
  await go(page, '#/~hub/work/magic-loops');
  await loading(page).waitFor();
  await page.locator('[data-card]').first().waitFor({ state: 'attached' });
  await page.unroute(WORK);

  step('a reload starts empty, and web storage holds no Hub data');
  await go(page, '#/~hub/team');
  await page.locator('.team-card').first().waitFor();
  await delayed(page, TEAM, 1000);
  await page.reload();
  await loading(page).waitFor();
  assert.equal(await page.locator('.team-card').count(), 0);
  await page.locator('.team-card').first().waitFor();
  const stored = await page.evaluate(() => JSON.stringify([{ ...localStorage }, { ...sessionStorage }]));
  for (const text of ['Planner', 'Hermes', FIXTURE_ASK]) assert.ok(!stored.includes(text), `Web storage holds no "${text}".`);
  console.log('hub-cache-ui: ok');
} finally {
  for (const context of contexts) await context.close();
  await browser.close();
  await fixture.close();
}
