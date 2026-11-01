// Run after npm run build. A Work card opens the item's details in place, through a real browser over the fixture
// service: a Beads card opens the Roadmap's panel over the board (a side panel on a desktop, a bottom sheet at 390 px),
// the address is #/~hub/work/<board>/<id>, Escape and Back close it, a shared link opens it and closes onto the board,
// "Show on roadmap" goes to the Roadmap, a Working now chip opens it, the All board opens a card from another project,
// an unknown id shows the note and no sheet, and request cards still open what they did.
// BUW_SHOTS=<prefix> also writes screenshots.
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { startHubFixture } from './hub-fixture.mjs';

const step = name => console.log(`- ${name}`);
const channel = process.env.BUW_TEST_BROWSER || 'msedge';

const browser = await chromium.launch({ headless: true, channel });
const contexts = [];
let fixture;
const open = async viewport => {
  const context = await browser.newContext({ viewport, serviceWorkers: 'block', reducedMotion: 'reduce' });
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
const hashOf = page => page.evaluate(() => location.hash);
const panelOf = page => page.locator('dialog#hub-map-panel');
const titled = (page, text) => panelOf(page).locator('h3').filter({ hasText: text });
const settled = page => page.waitForTimeout(250);
const atBoard = async (page, hash) => { await page.waitForFunction(value => location.hash === value, hash); await page.locator('dialog#hub-map-panel').waitFor({ state: 'detached' }); };
const clickCard = async (page, key) => {
  const card = page.locator(`[data-card="${key}"]`);
  await card.scrollIntoViewIfNeeded();
  await card.click();
};
/** The board of a project (or All), on the lane that holds `lane` on a phone. */
const goBoard = async (page, url, phoneLane) => {
  await page.goto(url);
  await page.locator('.wk-lane').first().waitFor({ state: 'attached' });
  if (phoneLane) await page.locator(`[data-lane-chip="${phoneLane}"]`).click();
};

try {
  fixture = await startHubFixture({ work: true, workSide: true, links: true });
  await new Promise(resolve => setTimeout(resolve, 100));
  const board = `${fixture.url}#/~hub/work/lanes`;

  for (const [label, viewport] of [['desktop', { width: 1280, height: 800 }], ['phone', { width: 390, height: 844 }]]) {
    const phone = label === 'phone';
    const lane = name => (phone ? name : undefined);
    const page = await open(viewport);

    step(`${label}: a Beads card has a real Work link, and a click opens the sheet with the item's title`);
    await goBoard(page, board, lane('ready'));
    assert.equal(await page.locator('[data-card="bead:ws-ready"]').getAttribute('href'), '#/~hub/work/lanes/ws-ready');
    assert.equal(await panelOf(page).count(), 0, 'No sheet until a card is clicked.');
    await clickCard(page, 'bead:ws-ready');
    await titled(page, 'Ready to start').waitFor();
    assert.equal(await hashOf(page), '#/~hub/work/lanes/ws-ready');
    assert.equal(await page.locator('[data-focused="true"]').getAttribute('data-card'), 'bead:ws-ready', 'The card stays highlighted while its sheet is open.');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'hub-map-panel-title', 'The focus moves into the sheet.');
    assert.equal(await page.locator('[data-show-on-roadmap]').getAttribute('href'), '#/~hub/map/lanes/ws-ready');

    step(`${label}: the sheet is ${phone ? 'a bottom sheet' : 'a 420 px side panel with the lanes beside it'}`);
    const box = await panelOf(page).boundingBox();
    if (phone) {
      assert.ok(Math.abs(box.y + box.height - viewport.height) <= 1 && Math.abs(box.width - viewport.width) <= 1, `A bottom sheet across the width (${JSON.stringify(box)}).`);
      assert.ok(box.height <= viewport.height * 0.76, 'No taller than three quarters of the screen.');
    } else {
      assert.ok(Math.abs(box.width - 420) <= 1, `About 420 px wide (${box.width}).`);
      const rail = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--hub-rail')) || 0);
      assert.ok(Math.abs(box.x + box.width - (viewport.width - rail)) <= 1, `At the right edge, beside the tool rail (${JSON.stringify(box)}, rail ${rail}).`);
      assert.ok(box.height >= viewport.height - 80, 'Full height under the top bar.');
      const lanes = await page.locator('.wk-lanes').boundingBox();
      assert.ok(lanes.x + lanes.width <= box.x + 1, 'The lanes sit beside the panel, not under it.');
      assert.equal(await page.locator('.hub-map-scrim').evaluate(element => getComputedStyle(element).display), 'none', 'No scrim on a desktop: the board stays usable.');
    }
    await noSideways(page, `Work sheet at ${label} width`);
    if (process.env.BUW_SHOTS) await page.screenshot({ path: `${process.env.BUW_SHOTS}-sheet-${label}.png` });

    step(`${label}: Escape closes it, back on the board, with the focus on the card; a later Back does not reopen it`);
    await page.keyboard.press('Escape');
    await atBoard(page, '#/~hub/work/lanes');
    assert.equal(await panelOf(page).count(), 0);
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-card')), 'bead:ws-ready', 'The focus returns to the card.');
    await page.goBack().catch(() => {});
    await settled(page);
    assert.doesNotMatch(page.url(), /ws-ready/, 'Back from the board does not reopen the sheet.');

    step(`${label}: the close button closes it too`);
    await goBoard(page, board, lane('ready'));
    await clickCard(page, 'bead:ws-ready');
    await titled(page, 'Ready to start').waitFor();
    await page.getByRole('button', { name: 'Close details' }).click();
    await atBoard(page, '#/~hub/work/lanes');
    assert.equal(await panelOf(page).count(), 0);

    step(`${label}: browser Back closes it`);
    await clickCard(page, 'bead:ws-ready');
    await titled(page, 'Ready to start').waitFor();
    await page.goBack();
    await atBoard(page, '#/~hub/work/lanes');
    await panelOf(page).waitFor({ state: 'detached' });

    step(`${label}: another card while one is open swaps the sheet without stacking history`);
    await clickCard(page, 'bead:ws-ready');
    await titled(page, 'Ready to start').waitFor();
    if (phone) {
      // The scrim covers the board on a phone: pick the next card from a closed sheet.
      await page.keyboard.press('Escape');
      await atBoard(page, '#/~hub/work/lanes');
      await page.locator('[data-lane-chip="running"]').click();
      await clickCard(page, 'bead:ws-doing');
    } else {
      await clickCard(page, 'bead:ws-doing');
    }
    await titled(page, 'In progress').waitFor();
    assert.equal(await hashOf(page), '#/~hub/work/lanes/ws-doing');
    await page.keyboard.press('Escape');
    await atBoard(page, '#/~hub/work/lanes');
    await page.goBack().catch(() => {});
    await settled(page);
    assert.doesNotMatch(page.url(), /#\/~hub\/work\/lanes\/ws-/, 'Close went to the board, and Back left it.');

    step(`${label}: a shared link opens the sheet, and closing lands on the board`);
    await page.goto(`${fixture.url}#/~hub/work/lanes/ws-ready`);
    await titled(page, 'Ready to start').waitFor();
    assert.equal(await page.locator('[data-card="bead:ws-ready"][data-focused="true"]').count(), 1);
    await page.getByRole('button', { name: 'Close details' }).click();
    await atBoard(page, '#/~hub/work/lanes');
    assert.equal(await panelOf(page).count(), 0);
    assert.equal(await page.locator('[data-board-note]').count(), 0);

    step(`${label}: Show on roadmap goes to the Roadmap node`);
    await page.goto(`${fixture.url}#/~hub/work/lanes/ws-ready`);
    await titled(page, 'Ready to start').waitFor();
    await page.locator('[data-show-on-roadmap]').click();
    await page.waitForFunction(() => location.hash === '#/~hub/map/lanes/ws-ready');
    await panelOf(page).waitFor();

    step(`${label}: an item the board lacks but the map has opens its sheet, and a task inside it opens in Work`);
    await page.goto(`${fixture.url}#/~hub/work/lanes/ws-grp`);
    await titled(page, 'A feature group').waitFor();
    assert.equal(await page.locator('[data-board-note]').count(), 0, 'The map has it, so no note.');
    await panelOf(page).getByRole('button', { name: 'Child of the group' }).click();
    await titled(page, 'Child of the group').waitFor();
    assert.equal(await hashOf(page), '#/~hub/work/lanes/ws-child');
    await noSideways(page, `Work related item at ${label} width`);

    step(`${label}: an unknown id shows the note and no sheet`);
    await page.goto(`${fixture.url}#/~hub/work/lanes/ws-nowhere`);
    await page.locator('[data-board-note]').waitFor();
    assert.match(await page.locator('[data-board-note]').innerText(), /ws-nowhere is not on the board/);
    await settled(page);
    assert.equal(await panelOf(page).count(), 0);
    assert.equal(await page.locator('.hub-map-scrim').count(), 0);
    assert.equal(await page.locator('[data-focused="true"]').count(), 0);

    step(`${label}: a Working now chip opens the sheet`);
    await page.goto(`${fixture.url}#/~hub/today`);
    const chip = page.locator('[aria-label="Working now"] [data-bead-chip="ws-ready"]');
    await chip.waitFor();
    await chip.click();
    await titled(page, 'Ready to start').waitFor();
    assert.equal(await hashOf(page), '#/~hub/work/lanes/ws-ready');
    await page.keyboard.press('Escape');
    await atBoard(page, '#/~hub/work/lanes');
    assert.equal(await panelOf(page).count(), 0);

    step(`${label}: on the All board a card from another project opens its own sheet`);
    await goBoard(page, `${fixture.url}#/~hub/work/all`, lane('ready'));
    assert.equal(await page.locator('[data-card="bead:sd-one"]').getAttribute('href'), '#/~hub/work/all/sd-one');
    await clickCard(page, 'bead:sd-one');
    await titled(page, 'Side quest').waitFor();
    assert.equal(await hashOf(page), '#/~hub/work/all/sd-one');
    assert.equal(await page.locator('[data-show-on-roadmap]').getAttribute('href'), '#/~hub/map/side/sd-one');
    assert.equal(await page.locator('[data-card="bead:sd-one"][data-focused="true"]').count(), 1);
    await page.keyboard.press('Escape');
    await atBoard(page, '#/~hub/work/all');
    await page.goto(`${fixture.url}#/~hub/work/all/ws-ready`);
    await titled(page, 'Ready to start').waitFor();
    await page.goto(`${fixture.url}#/~hub/work/all/ws-nowhere`);
    await page.locator('[data-board-note]').waitFor();
    assert.equal(await panelOf(page).count(), 0);

    step(`${label}: a request card still opens the request`);
    await goBoard(page, board, lane('backlog'));
    const request = page.locator('[data-card^="request:"]');
    assert.match(await request.getAttribute('href'), /^#\/~hub\/request\/\d{8}-lanes-/);
    await request.click();
    await page.waitForFunction(() => location.hash.startsWith('#/~hub/request/'));
    assert.equal(await panelOf(page).count(), 0);
    await page.close();
  }

  console.log('hub-work-sheet-ui: passed');
} finally {
  for (const context of contexts) await context.close().catch(() => {});
  await browser.close();
  await fixture?.close();
}
