// Run after npm run build. Work through a real browser, over the fixture service: the six lanes with a
// card from every cell of the table, the Backlog fold, a live card, the phone's one-lane view, the
// Activity tab with Work lit in the nav, and the "Ask an agent" form from the default fixture.
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { startHubFixture } from './hub-fixture.mjs';

const step = name => console.log(`- ${name}`);
const channel = process.env.BUW_TEST_BROWSER || 'msedge';

const browser = await chromium.launch({ headless: true, channel });
const contexts = [];
const fixtures = [];
const open = async (viewport, options = {}) => {
  const context = await browser.newContext({ viewport, serviceWorkers: 'block', reducedMotion: 'reduce', ...options });
  contexts.push(context);
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => { throw error; });
  return page;
};
const go = (page, hash) => page.evaluate(value => { location.hash = value; }, hash);
const noSideways = async (page, what) => {
  const widths = await page.evaluate(() => ({ scroll: document.scrollingElement.scrollWidth, inner: innerWidth, hub: document.querySelector('.hub')?.scrollWidth ?? 0, hubInner: document.querySelector('.hub')?.clientWidth ?? 0 }));
  assert.ok(widths.scroll <= widths.inner, `${what}: the page scrolls sideways (${widths.scroll} > ${widths.inner}).`);
  assert.ok(widths.hub <= widths.hubInner, `${what}: the Hub scrolls sideways (${widths.hub} > ${widths.hubInner}).`);
};
const idsOf = (page, lane) => page.locator(`.wk-lane[data-lane="${lane}"] .wk-card .hub-id`).evaluateAll(list => list.map(item => item.textContent.trim()).sort());
const visibleLanes = page => page.locator('.wk-lane').evaluateAll(list => list.filter(item => getComputedStyle(item).display !== 'none').map(item => item.getAttribute('data-lane')));

try {
  const lanes = await startHubFixture({ work: true });
  fixtures.push(lanes);
  await new Promise(resolve => setTimeout(resolve, 100));

  step('desktop: six lanes in a row, each fixture card in its lane, the Backlog folded');
  const page = await open({ width: 1920, height: 1080 });
  await page.goto(`${lanes.url}#/~hub/work/lanes`);
  await page.locator('.wk-lane').first().waitFor();
  assert.deepEqual(await page.locator('.wk-lane').evaluateAll(list => list.map(item => item.getAttribute('data-lane'))), ['backlog', 'ready', 'running', 'blocked', 'review', 'done']);
  const tops = await page.locator('.wk-lane').evaluateAll(list => list.map(item => Math.round(item.getBoundingClientRect().top)));
  assert.equal(new Set(tops).size, 1, 'The six lanes sit in one row.');
  assert.deepEqual(await idsOf(page, 'ready'), ['ws-child', 'ws-ready']);
  assert.deepEqual(await idsOf(page, 'running'), ['ws-doing']);
  assert.deepEqual(await idsOf(page, 'blocked'), ['ws-ask', 'ws-owner', 'ws-stuck', 'ws-wait']);
  assert.deepEqual(await idsOf(page, 'review'), ['ws-pr']);
  assert.deepEqual(await idsOf(page, 'done'), ['ws-fresh']);
  const count = lane => page.locator(`.wk-lane[data-lane="${lane}"] > h3 span`).innerText();
  assert.deepEqual([await count('backlog'), await count('blocked'), await count('done')], ['14', '4', '1']);
  assert.equal(await page.locator('.wk-lane[data-lane="backlog"] .wk-card').count(), 10, 'The Backlog shows ten and folds the rest.');
  await page.locator('.wk-lane[data-lane="backlog"] .wk-more', { hasText: 'Show all 14' }).click();
  assert.equal(await page.locator('.wk-lane[data-lane="backlog"] .wk-card').count(), 14);
  assert.equal(await page.locator('.wk-lane[data-lane="done"] .wk-more').count(), 0, 'A short lane has no fold.');
  assert.equal(await page.locator('.wk-lane[data-lane="ready"] .wk-card .wk-project').count(), 0, 'One project: no project chip on its cards.');
  await noSideways(page, 'Work at 1920 px');

  step('cards: title first, the id, a source icon, why in amber on Blocked, a live dot only on the working card, each a link');
  const doing = page.locator('[data-card="bead:ws-doing"]');
  assert.equal(await doing.evaluate(card => card.tagName), 'A');
  assert.equal(await doing.locator(':scope > *').first().getAttribute('class'), 'wk-title');
  assert.equal((await doing.locator('.wk-title').innerText()).trim(), 'In progress');
  assert.equal(await doing.locator('.wk-dot.working').count(), 1);
  assert.ok((await doing.getAttribute('class')).includes('live'));
  assert.equal(await doing.locator('.wk-src').getAttribute('title'), 'Beads task');
  assert.equal(await page.locator('.wk-card.live').count(), 1, 'Only the working card glows.');
  assert.match(await doing.getAttribute('href'), /^#\/~hub\/map\/lanes\/ws-doing$/);
  const why = page.locator('[data-card="bead:ws-ask"] .wk-why');
  assert.equal((await why.innerText()).trim(), 'needs you');
  assert.notEqual(await why.evaluate(node => getComputedStyle(node).color), await page.locator('[data-card="bead:ws-ask"] .wk-title').evaluate(node => getComputedStyle(node).color), 'The why line has its own colour.');
  assert.match((await page.locator('[data-card="bead:ws-wait"] .wk-why').innerText()), /blocked by ws-doing/);
  assert.ok(await page.locator('[data-card="bead:ws-pr"] .hub-sign').count() >= 1, 'The review card carries its signs.');
  assert.equal(await page.locator('[data-card^="request:"]').count(), 1);
  const request = page.locator('[data-card^="request:"]');
  assert.equal(await request.evaluate(card => card.closest('.wk-lane').getAttribute('data-lane')), 'backlog', 'An open request is proposed work in the Backlog.');
  assert.equal(await request.getAttribute('href'), '#/~hub/needs/requests');

  step('All shows every project, with the project on each card');
  await page.locator('.hub-chip', { hasText: /^All$/ }).click();
  await page.waitForFunction(() => location.hash === '#/~hub/work/all');
  await page.locator('.wk-card .wk-project').first().waitFor();
  assert.ok(await page.locator('.hub-chip.on', { hasText: /^All$/ }).count() === 1);
  assert.ok(await page.locator('.wk-lane[data-lane="running"] .wk-project').count() >= 1);

  step('the tabs: Lanes lit on Work, Activity under the same tab strip with Work lit in the nav');
  assert.equal(await page.locator('[data-work-tab="lanes"]').getAttribute('aria-selected'), 'true');
  await page.locator('[data-work-tab="activity"]').click();
  await page.locator('.hub[data-screen="activity"] .hub-row').first().waitFor();
  assert.equal(await page.locator('[data-work-tab="activity"]').getAttribute('aria-selected'), 'true');
  assert.equal(await page.locator('.hub h2').first().innerText(), 'Work');
  assert.equal(await page.locator('[data-hub-link="work"]').getAttribute('aria-current'), 'page', 'Work stays lit on the Activity tab.');
  assert.equal(await page.locator('[data-hub-link="activity"]').count(), 0, 'Activity has left the nav.');
  await go(page, '#/~hub/activity/agents');
  await page.locator('.hub-chip.on', { hasText: 'Agents' }).waitFor();
  assert.equal(await page.locator('[data-hub-link="work"]').getAttribute('aria-current'), 'page');
  await page.locator('[data-work-tab="lanes"]').click();
  await page.locator('.wk-lane').first().waitFor();

  step('phone: one lane at a time, Running first, the chip switches it, nothing scrolls sideways');
  const phone = await open({ width: 390, height: 844 }, { hasTouch: true, isMobile: true });
  await phone.goto(`${lanes.url}#/~hub/work/lanes`);
  await phone.locator('.wk-lane-chips').waitFor();
  assert.deepEqual(await visibleLanes(phone), ['running']);
  assert.equal(await phone.locator('[data-lane-chip="running"]').getAttribute('aria-pressed'), 'true');
  assert.match(await phone.locator('[data-lane-chip="blocked"]').innerText(), /Blocked\s*4/);
  await phone.locator('[data-lane-chip="blocked"]').tap();
  assert.deepEqual(await visibleLanes(phone), ['blocked']);
  assert.equal(await phone.locator('.wk-lane[data-lane="blocked"] .wk-card').count(), 4);
  const chip = await phone.locator('[data-lane-chip="done"]').boundingBox();
  assert.ok(chip.height >= 44, `A lane chip is at least 44 px high (${chip.height}).`);
  await phone.waitForTimeout(250);
  await noSideways(phone, 'Work at 390 px');
  await go(phone, '#/~hub/work/all');
  await phone.locator('.wk-lane:visible .wk-card .wk-project').first().waitFor();
  await noSideways(phone, 'Work, All, at 390 px');
  await go(phone, '#/~hub/activity');
  await phone.locator('.hub[data-screen="activity"] .hub-row').first().waitFor();
  await phone.waitForTimeout(250);
  await noSideways(phone, 'Activity at 390 px');
  assert.equal(await phone.locator('[data-hub-tab="work"]').getAttribute('class').then(value => value.includes('active')), true, 'The phone bar lights Work on Activity.');
  await phone.locator('[data-hub-tab="more"]').tap();
  assert.deepEqual(await phone.locator('[data-hub-more]').evaluateAll(list => list.map(item => item.getAttribute('data-hub-more'))), ['map', 'library', 'sketch']);

  step('phone: with nothing running, Blocked is the lane that opens');
  const quiet = await open({ width: 390, height: 844 }, { hasTouch: true, isMobile: true });
  await quiet.route('**/api/hub/work*', async route => {
    const answer = await (await route.fetch()).json();
    answer.lanes.ready.push(...answer.lanes.running);
    answer.lanes.running = [];
    answer.counts.ready += answer.counts.running;
    answer.counts.running = 0;
    await route.fulfill({ json: answer });
  });
  await quiet.goto(`${lanes.url}#/~hub/work/lanes`);
  await quiet.locator('.wk-lane-chips').waitFor();
  assert.deepEqual(await visibleLanes(quiet), ['blocked']);

  step('a very long title wraps on a phone and nothing scrolls sideways');
  const longTitle = `${'Alpha beta gamma delta '.repeat(4)}${'x'.repeat(60)} tail`.slice(0, 160);
  const wide = await open({ width: 390, height: 844 }, { hasTouch: true, isMobile: true });
  await wide.route('**/api/hub/work*', async route => {
    const answer = await (await route.fetch()).json();
    for (const cards of Object.values(answer.lanes)) for (const card of cards) card.title = longTitle;
    await route.fulfill({ json: answer });
  });
  await wide.goto(`${lanes.url}#/~hub/work/lanes`);
  await wide.locator('.wk-lane:visible .wk-card').first().waitFor();
  await wide.waitForTimeout(250);
  await noSideways(wide, 'Work with a long title');
  const longBox = await wide.locator('.wk-lane:visible .wk-card').first().evaluate(card => ({ title: card.querySelector('.wk-title').getBoundingClientRect().width, card: card.getBoundingClientRect().width, text: card.querySelector('.wk-title').textContent }));
  assert.equal(longBox.text, longTitle, 'Work never clips a title.');
  assert.ok(longBox.title <= longBox.card, 'The title is no wider than its card.');

  // The default fixture: Beads copies for magic-loops only, no PC status.
  const plain = await startHubFixture();
  fixtures.push(plain);
  await new Promise(resolve => setTimeout(resolve, 100));
  const desk = await open({ width: 1920, height: 1080 });
  await desk.goto(`${plain.url}#/~hub/work/magic-loops`);
  await desk.locator('.wk-lane').first().waitFor();

  step('CUJ 5: a request from Work lands in the bucket as next-sprint');
  assert.equal(await desk.locator('.wk-lane').count(), 6);
  await desk.locator('button:has-text("Ask an agent to do something")').click();
  await desk.locator('.hub-field textarea').fill('Add wall-slide dust particles');
  await desk.locator('button:has-text("Send")').last().click();
  await desk.locator('.hub-ok', { hasText: 'Request sent' }).waitFor();
  const requests = [...plain.fake.objects.keys()].filter(key => /sections\/inbox\/requests\/[^/]+\/request\.json$/.test(key));
  assert.equal(requests.length, 1);
  const stored = plain.fake.json(requests[0]);
  assert.deepEqual([stored.project, stored.when, stored.text], ['magic-loops', 'next-sprint', 'Add wall-slide dust particles']);

  step('Work cards lead with the title; the id is a small selectable line after it');
  const [answer] = await Promise.all([desk.waitForResponse(response => response.url().includes('/api/hub/work')), desk.reload()]);
  const work = await answer.json();
  await desk.locator('.wk-card').first().waitFor();
  const first = desk.locator('.wk-card').first();
  const key = await first.getAttribute('data-card');
  const card = Object.values(work.lanes).flat().find(item => item.key === key);
  assert.equal((await first.locator('.wk-title').innerText()).trim(), card.title);
  assert.notEqual(card.title, card.id, 'The title is not the id.');
  assert.equal((await first.locator('.hub-id').innerText()).trim(), card.id);

  step('Work shows Loading before its lanes, and never Nothing here before the data arrives');
  await desk.route('**/api/hub/work*', async route => { await new Promise(resolve => setTimeout(resolve, 800)); await route.continue(); });
  await go(desk, '#/~hub/work/nosprint');
  await go(desk, '#/~hub/work/magic-loops');
  await desk.locator('.hub-empty', { hasText: 'Loading…' }).waitFor();
  assert.equal(await desk.locator('.hub-empty', { hasText: 'Nothing here' }).count(), 0, 'Nothing here before the data arrived.');
  await desk.locator('.wk-lane').first().waitFor();
  await desk.unroute('**/api/hub/work*');

  step('Work with no projects says so instead of loading forever');
  const none = await open({ width: 1200, height: 800 });
  await none.route('**/api/hub/projects', route => route.fulfill({ status: 200, contentType: 'application/json', body: '{"projects":[]}' }));
  await none.goto(plain.url);
  await none.locator('.sidebar-list').waitFor();
  await go(none, '#/~hub/work');
  await none.locator('.hub-empty', { hasText: 'No projects yet' }).waitFor();
  assert.equal(await none.locator('.hub-empty', { hasText: 'Loading…' }).count(), 0, 'Work keeps loading with an empty project list.');

  console.log('hub-work-ui: passed');
} finally {
  for (const context of contexts) await context.close().catch(() => {});
  await browser.close();
  for (const fixture of fixtures) await fixture.close();
}
