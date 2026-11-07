// Run after npm run build. A bead that says it needs the owner but asks nothing, through a real browser over the hub fixture:
// Today's "says it needs you" panel (count, rows, marking a row), and the Work board's warning glyph and "Open Ask" link.
// Desktop (1280x800) and phone (390x844).
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { startHubFixture, askId } from './hub-fixture.mjs';
import { askJson, beadsIssue, minutesAgo, threeOptions } from '../../site/api/test/hub-fixtures.mjs';

const step = name => console.log(`- ${name}`);
const channel = process.env.BUW_TEST_BROWSER || 'msedge';
const PROJECT = 'unaskdev';

async function seeded() {
  const fixture = await startHubFixture();
  const issues = [
    beadsIssue({ id: 'ua-m1', title: 'Milestone', type: 'milestone', created: '2026-10-01T10:00:00Z' }),
    beadsIssue({ id: 'ua-one', title: 'Register the domain', parent: 'ua-m1', labels: ['needs-owner'], description: 'Register the example domain at the registrar. Then point it at the site.', created: '2026-10-02T14:00:00Z' }),
    beadsIssue({ id: 'ua-two', title: 'Pay the invoice', parent: 'ua-m1', labels: ['needs-owner'], created: '2026-10-02T15:00:00Z' }),
    beadsIssue({ id: 'ua-ask', title: 'Pick the arc', parent: 'ua-m1', labels: ['needs-owner'], created: '2026-10-02T16:00:00Z' }),
    beadsIssue({ id: 'ua-blocked', title: 'Announce the launch', parent: 'ua-m1', labels: ['needs-owner'], blocks: ['ua-later'], created: '2026-10-02T18:00:00Z' }),
    beadsIssue({ id: 'ua-later', title: 'Build the launch page', parent: 'ua-m1', created: '2026-10-02T19:00:00Z' }),
    beadsIssue({ id: 'ua-plain', title: 'Just work', parent: 'ua-m1', created: '2026-10-02T17:00:00Z' }),
  ];
  fixture.seed.beads(PROJECT, issues, { pushedAt: minutesAgo(fixture.now, 5).toISOString(), host: 'pc.example.test', count: issues.length, repo: 'example/unaskdev' });
  const ASK = askId('unasked-arc', 'u1u1');
  fixture.seed.ask(askJson({ id: ASK, bead: 'ua-ask', now: minutesAgo(fixture.now, 10), options: threeOptions() }));
  return { fixture, ASK };
}

const browser = await chromium.launch({ headless: true, channel });
const contexts = [];
const fixtures = [];
const open = async (viewport, options = {}) => {
  const context = await browser.newContext({ viewport, reducedMotion: 'reduce', ...options });
  await context.addInitScript(() => { try { localStorage.setItem('hub.undoMs', '0'); } catch { /* no storage */ } });
  contexts.push(context);
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.errors = [];
  page.on('pageerror', error => page.errors.push(error));
  return page;
};
const noSideways = async (page, what) => {
  const widths = await page.evaluate(() => ({ scroll: document.scrollingElement.scrollWidth, inner: innerWidth }));
  assert.ok(widths.scroll <= widths.inner, `${what}: the page scrolls sideways (${widths.scroll} > ${widths.inner}).`);
};

try {
  for (const [label, viewport, options] of [['desktop', { width: 1280, height: 800 }, {}], ['phone', { width: 390, height: 844 }, { hasTouch: true, isMobile: true }]]) {
    const { fixture, ASK } = await seeded();
    fixtures.push(fixture);
    const page = await open(viewport, options);

    step(`${label}: Today lists the beads that ask nothing, each linking its Work sheet`);
    await page.goto(`${fixture.url}#/~hub/today`);
    const panel = page.locator('[data-today-unasked]');
    await panel.waitFor();
    assert.equal(await panel.locator('h3').innerText(), '⚠ 2 items say they need you but ask nothing', 'The blocked one is not counted.');
    assert.equal(await panel.locator('[data-unasked-row="ua-blocked"]').count(), 0, 'A needs-owner item behind an open blocker is not yet for the owner.');
    assert.equal(await panel.locator('[data-unasked-row="ua-one"] [data-unasked-why]').innerText(), 'Register the example domain at the registrar.', 'One line of why.');
    assert.equal(await panel.locator('[data-unasked-row="ua-two"] [data-unasked-why]').count(), 0, 'No line when the bead says nothing.');
    assert.deepEqual(await panel.locator('[data-unasked-row] a').allInnerTexts(), ['Pay the invoice', 'Register the domain']);
    assert.equal(await panel.locator('[data-unasked-row="ua-one"] a').getAttribute('href'), `#/~hub/project/${PROJECT}/roadmap/ua-one`, "The row uses the item's own href.");
    await page.waitForFunction(() => document.querySelector('[data-unasked-row="ua-one"] small')?.textContent === 'Unaskdev · ua-one');
    assert.equal(await panel.locator('[data-unasked-row="ua-one"] small').innerText(), 'Unaskdev · ua-one', 'The row names the project, not its id.');
    for (const row of ['ua-one', 'ua-two']) {
      for (const name of ['done', 'not-needed', 'unblock']) assert.equal(await panel.locator(`[data-unasked-row="${row}"] [data-mark-${name}]`).count(), 1, `${row} ${name}`);
    }
    assert.equal(await panel.getByText("Unblock: it doesn't wait on you").count(), 0, 'The rows have buttons only.');
    await noSideways(page, `${label} Today`);
    await panel.locator('[data-unasked-row="ua-one"] a').click();
    await page.locator('.hub-map-panel').waitFor();
    assert.match(page.url(), new RegExp(`#/~hub/project/${PROJECT}/roadmap/ua-one$`), 'The link opens the item.');
    await page.goto(`${fixture.url}#/~hub/today`);
    await panel.waitFor();

    step(`${label}: Work shows the warning glyph on a card that asks nothing, and a link under a card that has an Ask`);
    await page.goto(`${fixture.url}#/~hub/work/${PROJECT}`);
    await page.locator('[data-card]').first().waitFor({ state: 'attached' });
    if (label === 'phone') await page.locator('[data-lane-chip="blocked"]').click();
    const unasked = page.locator('[data-card="bead:ua-one"]');
    await unasked.waitFor();
    assert.match(await unasked.innerText(), /needs you · nothing asked yet/);
    assert.equal(await unasked.locator('[role="img"][aria-label="Nothing asked yet"]').innerText(), '⚠');
    const blockedCard = page.locator('[data-card="bead:ua-blocked"]');
    await blockedCard.waitFor();
    assert.match(await blockedCard.innerText(), /blocked by ua-later/);
    assert.equal(await blockedCard.locator('[aria-label="Nothing asked yet"]').count(), 0, 'A blocked item carries no warning.');
    const asked = page.locator('[data-card="bead:ua-ask"]');
    assert.equal(await asked.locator('[aria-label="Nothing asked yet"]').count(), 0);
    const link = page.locator('.wk-card-group > a.wk-asked');
    assert.equal(await link.count(), 1, 'Only the Ask card has a group.');
    assert.equal(await link.innerText(), 'Open Ask →');
    assert.equal(await link.getAttribute('href'), `#/~hub/ask/${ASK}`);
    assert.equal(await link.evaluate(node => node.closest('a.wk-card') === null), true, 'The link is a sibling of the card, not inside it.');
    assert.equal(await asked.evaluate(node => node.parentElement.classList.contains('wk-card-group')), true);
    await noSideways(page, `${label} Work`);
    await asked.click();
    await page.locator('.hub-map-panel').waitFor();
    assert.match(page.url(), /#\/~hub\/work\/unaskdev\/ua-ask$/, 'The card click still opens the sheet.');
    assert.equal(await page.locator('.hub-map-panel [data-needed-link="ask"]').getAttribute('href'), `#/~hub/ask/${ASK}`);

    step(`${label}: the Work sheet of a bead that asks nothing says so and offers the three marks`);
    await page.goto(`${fixture.url}#/~hub/work/${PROJECT}/ua-one`);
    const sheet = page.locator('.hub-map-panel [data-whats-needed]');
    await sheet.waitFor();
    assert.equal(await sheet.locator('[data-nothing-asked]').count(), 1);
    for (const name of ['done', 'not-needed', 'unblock']) assert.equal(await sheet.locator(`[data-mark-${name}]`).count(), 1, name);

    step(`${label}: Mark done confirms the first time, keeps the row marked with a visible Undo, and asks no more on this device`);
    await page.goto(`${fixture.url}#/~hub/today`);
    await panel.waitFor();
    const one = panel.locator('[data-unasked-row="ua-one"]');
    await one.locator('[data-mark-done]').click();
    assert.equal(await one.locator('[data-mark-confirm-first]').innerText().then(text => text.replace(/\s+/g, ' ')), 'This closes Register the domain in Beads. Undo stays here until the PC applies it, within minutes. Confirm Cancel');
    await one.locator('[data-mark-confirm-cancel]').click();
    assert.equal(await panel.locator('[data-mark-pending]').count(), 0, 'Cancel writes nothing.');
    await one.locator('[data-mark-done]').click();
    await one.locator('[data-mark-confirm-yes]').click();
    await one.locator('[data-mark-pending]').waitFor();
    assert.match(await one.innerText(), /Marked done\s*Undo/, 'The row stays, marked, with Undo.');
    assert.equal(await one.evaluate(node => node.classList.contains('marked')), true);
    assert.ok((await one.locator('[data-mark-undo]').boundingBox()).height >= 43.5, 'Undo is a tall button.');
    assert.equal(await panel.locator('h3').innerText(), '⚠ 1 item says it needs you but asks nothing');
    await noSideways(page, `${label} marked`);
    await one.locator('[data-mark-undo]').click();
    await one.locator('[data-mark-done]').waitFor();
    assert.equal(await panel.locator('h3').innerText(), '⚠ 2 items say they need you but ask nothing');
    await page.reload();
    await panel.waitFor();
    await panel.locator('[data-unasked-row="ua-two"] [data-mark-done]').click();
    await panel.locator('[data-unasked-row="ua-two"] [data-mark-pending]').waitFor();
    assert.equal(await panel.locator('[data-mark-confirm-first]').count(), 0, 'The second time on this device asks nothing.');
    assert.equal(await panel.locator('[data-mark-undo]').count(), 1);

    step(`${label}: without storage, Mark done always confirms`);
    await page.addInitScript(() => { const get = Storage.prototype.getItem; Storage.prototype.getItem = function (key) { if (key === 'buw.markConfirmed') throw new Error('no storage'); return get.call(this, key); }; });
    await page.reload();
    await panel.waitFor();
    await panel.locator('[data-unasked-row="ua-one"] [data-mark-done]').click();
    await panel.locator('[data-mark-confirm-first]').waitFor();
    await panel.locator('[data-mark-confirm-cancel]').click();

    step(`${label}: unblocking the last asked row leaves only the marked one`);
    await panel.locator('[data-unasked-row="ua-one"] [data-mark-unblock]').click();
    await panel.locator('[data-unasked-row="ua-one"]').waitFor({ state: 'detached' });
    assert.equal(await panel.locator('[data-unasked-row="ua-two"] [data-mark-pending]').count(), 1);
    assert.equal(await panel.locator('h3').count(), 0, 'With none asking, the heading goes and the marked row stays.');
    await panel.locator('[data-unasked-row="ua-two"] [data-mark-undo]').click();
    await panel.locator('[data-unasked-row="ua-two"] [data-mark-done]').waitFor();
    assert.deepEqual(page.errors, [], `${label}: no page errors`);

  }
  console.log('hub-unasked-ui: passed');
} finally {
  for (const context of contexts) await context.close().catch(() => {});
  await browser.close();
  for (const fixture of fixtures) await fixture.close();
}
