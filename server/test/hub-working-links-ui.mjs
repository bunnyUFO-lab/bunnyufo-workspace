// Run after npm run build. Working now rows link to the Work-board items and the Library cards a session touched,
// through a real browser over the fixture service (work + links): the chips on a row, a Beads chip landing on the
// Work board with that card highlighted, an item the board does not have showing a note, a card chip opening the
// card, and a session from before the field rendering with no chips. At 1280 x 800 and 390 x 844.
// BUW_SHOTS=<prefix> also writes the panel and board screenshots.
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
  const widths = await page.evaluate(() => ({ scroll: document.scrollingElement.scrollWidth, inner: innerWidth }));
  assert.ok(widths.scroll <= widths.inner, `${what}: the page scrolls sideways (${widths.scroll} > ${widths.inner}).`);
};

try {
  fixture = await startHubFixture({ work: true, links: true });
  await new Promise(resolve => setTimeout(resolve, 100));

  for (const [label, viewport] of [['desktop', { width: 1280, height: 800 }], ['phone', { width: 390, height: 844 }]]) {
    step(`${label}: the row shows chips under its title, newest first, three at most and a +1`);
    const page = await open(viewport);
    await page.goto(`${fixture.url}#/~hub/today`);
    const panel = page.locator('[aria-label="Working now"]');
    const row = panel.locator('[data-source="pc"][data-working="working"]');
    await row.locator('[data-wn-links]').waitFor();
    assert.deepEqual(await row.locator('[data-bead-chip]').evaluateAll(list => list.map(item => item.getAttribute('data-bead-chip'))), ['ws-gone', 'ws-ready', 'ws-pr']);
    assert.equal(await row.locator('.wn-chip.more').innerText(), '+1', 'The branch names a fourth item.');
    assert.equal(await row.locator('[data-card-chip]').count(), 1, 'The card the site lists is a chip; the one it does not list is not.');
    assert.equal(await row.locator('[data-card-chip]').getAttribute('data-card-chip'), 'hub');
    assert.equal(await row.locator('[data-bead-chip="ws-ready"]').getAttribute('title'), 'ws-ready: Ready to start', 'The hover names the item.');
    assert.match(await row.locator('[data-bead-chip="ws-ready"]').getAttribute('aria-label'), /ws-ready, Ready to start, open on the Work board/);
    assert.equal(await row.locator('[data-bead-chip="ws-ready"]').getAttribute('href'), '#/~hub/work/lanes/ws-ready');
    assert.equal(await row.locator('[data-bead-chip="ws-gone"]').getAttribute('title'), 'ws-gone', 'An id the copy lacks has no title to show.');

    step(`${label}: a session from before the field shows no chips, and a title id the copy lacks is not linked`);
    const old = panel.locator('[data-working-idle]');
    await old.locator('summary').click();
    const oldRow = old.locator('[data-working="idle"]');
    assert.match(await oldRow.innerText(), /Older session about ws-nothere/);
    assert.equal(await oldRow.locator('[data-wn-links]').count(), 0);
    await noSideways(page, `Today at ${label} width`);
    if (process.env.BUW_SHOTS) await panel.screenshot({ path: `${process.env.BUW_SHOTS}-working-${label}.png` });

    step(`${label}: a Beads chip opens the Work board with that card highlighted`);
    await row.locator('[data-bead-chip="ws-ready"]').click();
    await page.locator('.wk-lane').first().waitFor({ state: 'attached' });
    const card = page.locator('[data-card="bead:ws-ready"]');
    await card.waitFor();
    assert.equal(await card.getAttribute('data-focused'), 'true');
    assert.equal(await page.locator('[data-focused="true"]').count(), 1, 'Exactly one card is highlighted.');
    assert.equal(await page.locator('.wk-lane[data-lane="ready"] [data-focused="true"]').count(), 1, 'It is in the Ready lane.');
    assert.equal(await card.isVisible(), true, 'The lane that holds it is the one showing, on a phone too.');
    assert.equal(await page.locator('[data-board-note]').count(), 0);
    assert.equal(await card.evaluate(el => { const r = el.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth; }), true, 'The card is scrolled into view.');
    await noSideways(page, `Work at ${label} width`);
    if (process.env.BUW_SHOTS) await page.screenshot({ path: `${process.env.BUW_SHOTS}-board-${label}.png` });

    if (label === 'phone') {
      step('phone: a lane the person moved to stays when the board refreshes');
      await page.locator('[data-lane-chip="blocked"]').click();
      await page.waitForTimeout(300);
      assert.equal(await page.locator('[data-lane-chip="blocked"]').getAttribute('aria-pressed'), 'true');
      assert.equal(await page.locator('[data-card="bead:ws-ready"]').isVisible(), false, 'The board did not pull the person back to the highlighted lane.');
    }

    step(`${label}: an item the board does not have opens the board with a note`);
    await page.goto(`${fixture.url}#/~hub/today`);
    await row.locator('[data-wn-links]').waitFor();
    await row.locator('[data-bead-chip="ws-gone"]').click();
    await page.locator('.wk-lane').first().waitFor({ state: 'attached' });
    const note = page.locator('[data-board-note]');
    await note.waitFor();
    assert.match(await note.innerText(), /ws-gone is not on the board/);
    assert.equal(await page.locator('[data-focused="true"]').count(), 0);
    await noSideways(page, `Work note at ${label} width`);

    step(`${label}: a card chip opens the card`);
    await page.goto(`${fixture.url}#/~hub/today`);
    await row.locator('[data-wn-links]').waitFor();
    assert.equal(await row.locator('[data-card-chip="hub"]').getAttribute('href'), '/one#/hub');
    await row.locator('[data-card-chip="hub"]').click();
    // The section's page is the site's; the local service has none, so the address is what counts.
    await page.waitForURL(/\/one#\/hub$/);
    await page.close();
  }

  console.log('hub-working-links-ui: passed');
} finally {
  for (const context of contexts) await context.close().catch(() => {});
  await browser.close();
  await fixture?.close();
}
