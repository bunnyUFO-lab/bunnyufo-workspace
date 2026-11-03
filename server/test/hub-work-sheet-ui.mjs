// Run after npm run build. A Work card opens the item's details in place, through a real browser over the fixture
// service: a Beads card opens the Roadmap's panel over the board (a side panel on a desktop, a bottom sheet at 390 px),
// the address is #/~hub/work/<board>/<id>, Escape and Back close it, a shared link opens it and closes onto the board,
// "Show on roadmap" goes to the Roadmap, a Working now chip opens it, the All board opens a card from another project,
// an unknown id shows the note and no sheet, and request cards still open what they did.
// Search and filters: a word only in a description finds its card, ids and two words match, old closed beads show under Also found and open,
// the chips narrow and Clear resets, the choice survives a reload (a bad stored value is the default), a linked card is never hidden, and a phone keeps 44 px targets.
// BUW_SHOTS=<prefix> also writes screenshots.
import { chromium } from '@playwright/test';
import { ms } from './ui-timeouts.mjs';
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
  page.setDefaultTimeout(ms(15000));
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
  fixture = await startHubFixture({ work: true, workSide: true, workSearch: true, links: true });
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

    step(`${label}: from the bare #/~hub/work, a click then Close leaves no extra history entry`);
    const bare = await open(viewport);
    await bare.addInitScript(() => { try { localStorage.setItem('buw.hub.project', 'lanes'); } catch { /* about:blank has none */ } });
    await bare.goto(`${fixture.url}#/~hub/work`);
    await bare.locator('.wk-lane').first().waitFor({ state: 'attached' });
    await bare.locator('[data-card="bead:ws-doing"]').waitFor();
    await bare.locator('[data-card="bead:ws-doing"]').evaluate(element => { element.dataset.mounted = 'yes'; });
    await clickCard(bare, 'bead:ws-doing');
    await titled(bare, 'In progress').waitFor();
    assert.equal(await bare.locator('[data-card="bead:ws-doing"]').getAttribute('data-mounted'), 'yes', 'The board was not remounted by the click.');
    await bare.getByRole('button', { name: 'Close details' }).click();
    await bare.waitForFunction(() => location.hash === '#/~hub/work');
    await panelOf(bare).waitFor({ state: 'detached' });
    await bare.goBack();
    await settled(bare);
    assert.doesNotMatch(bare.url(), /~hub\/work/, 'One Back after Close leaves Work, as before the click.');
    await bare.close();

    step(`${label}: a request card still opens the request`);
    await goBoard(page, board, lane('backlog'));
    const request = page.locator('[data-card^="request:"]');
    assert.match(await request.getAttribute('href'), /^#\/~hub\/request\/\d{8}-lanes-/);
    await request.click();
    await page.waitForFunction(() => location.hash.startsWith('#/~hub/request/'));
    assert.equal(await panelOf(page).count(), 0);
    await page.close();

    // ---- Search and filters. A page of its own, so the storage starts empty.
    const sp = await open(viewport);
    const keys = () => sp.evaluate(() => [...document.querySelectorAll('[data-card]')].map(element => element.getAttribute('data-card')));
    const count = () => sp.locator('[data-work-count]').innerText();
    const search = async value => { await sp.locator('[data-work-search]').fill(value); };
    const stored = () => sp.evaluate(() => localStorage.getItem('hub-work-filter'));
    const clear = async () => { await sp.locator('[data-work-count] .wk-clear').click(); await sp.locator('[data-work-count]').waitFor({ state: 'detached' }); };

    step(`${label}: a word only in a description finds its card, with the text line and the hit marked`);
    await goBoard(sp, board, lane('ready'));
    assert.equal(await sp.locator('[data-work-count]').count(), 0, 'No count line while nothing is on.');
    await search('quokka');
    await sp.locator('.wk-snip').waitFor();
    assert.deepEqual(await keys(), ['bead:ws-rare']);
    assert.match(await sp.locator('.wk-snip').innerText(), /^text: .*quokka/);
    assert.equal(await sp.locator('.wk-snip mark').innerText(), 'quokka');
    assert.match(await count(), /^1 of \d+ shown · Clear$/);
    assert.equal(await sp.locator('[data-work-count]').getAttribute('role'), 'status');
    if (phone) assert.equal(await sp.locator('[data-lane-chip="ready"]').getAttribute('aria-pressed'), 'true', 'The phone moves to the first lane with a match.');
    if (phone) assert.equal(await sp.locator('[data-lane-chip="backlog"] .n').innerText(), '0', 'Lane chips count the matches.');
    assert.ok(JSON.parse(await stored()).q === 'quokka');

    step(`${label}: an id, full or partial, in either case, finds it; two words must both match`);
    await search('WS-DOIN');
    await sp.locator('[data-card="bead:ws-doing"]').waitFor();
    assert.deepEqual(await keys(), ['bead:ws-doing']);
    await search('ws-doing');
    assert.deepEqual(await keys(), ['bead:ws-doing']);
    await search('slide quokka');
    await sp.locator('.wk-snip').waitFor();
    assert.deepEqual(await keys(), ['bead:ws-rare']);
    await search('slide zebra');
    await sp.waitForFunction(() => !document.querySelector('[data-card]'));
    assert.match(await count(), /^0 of \d+ shown/);
    assert.match(await sp.locator('.wk-lane .hub-empty').first().innerText(), /No match/);
    assert.equal(await sp.locator('.wk-more').count(), 0, 'No fold while searching.');

    step(`${label}: a closed bead with no card shows under Also found and opens its sheet`);
    await search('quokka');
    const ancient = sp.locator('[data-also="ws-ancient"]');
    await ancient.waitFor();
    assert.match(await ancient.innerText(), /closed/);
    assert.equal(await ancient.getAttribute('href'), '#/~hub/work/lanes/ws-ancient');
    await ancient.click();
    await titled(sp, 'Ancient wall bug').waitFor();
    assert.equal(await hashOf(sp), '#/~hub/work/lanes/ws-ancient');
    await sp.keyboard.press('Escape');
    await atBoard(sp, '#/~hub/work/lanes');
    await goBoard(sp, `${fixture.url}#/~hub/work/all`, lane('ready'));
    const sideOld = sp.locator('[data-also="sd-ancient"]');
    await sideOld.waitFor();
    await sideOld.click();
    await titled(sp, 'Side ancient').waitFor();
    assert.equal(await hashOf(sp), '#/~hub/work/all/sd-ancient');
    await sp.keyboard.press('Escape');
    await atBoard(sp, '#/~hub/work/all');

    step(`${label}: the chips narrow, the count reads N of M shown, and Clear returns the board and the storage key`);
    await goBoard(sp, board, lane('ready'));
    await clear();
    for (const more of await sp.locator('.wk-more').all()) await more.evaluate(element => element.click());
    const full = (await keys()).length;
    assert.ok(full >= 15, `The full board (${full}).`);
    assert.equal(await stored(), null, 'Clear removes the key.');
    const only = async (selector, expected, what) => {
      await sp.locator(selector).click();
      await sp.locator('[data-work-count]').waitFor();
      assert.deepEqual((await keys()).sort(), expected.map(id => `bead:${id}`).sort(), what);
      assert.match(await count(), new RegExp(`^${expected.length} of ${full} shown`));
      await clear();
    };
    await only('[data-filter="needs-you"]', ['ws-ask', 'ws-owner'], 'Needs you');
    await only('[data-filter="blocked"]', ['ws-stuck', 'ws-wait'], 'Blocked leaves out what needs the owner');
    await sp.locator('[data-filter="needs-you"]').click();
    await sp.locator('[data-filter="blocked"]').click();
    assert.equal((await keys()).length, 4, 'Both on is either.');
    await clear();
    await only('[data-filter-type="feature"]', ['ws-feat'], 'Type feature');
    await only('[data-filter-type="question"]', ['ws-ques'], 'Type question');
    await sp.locator('[data-filter-label]').click();
    await sp.getByRole('option', { name: 'area:feel' }).click();
    await sp.locator('[data-work-count]').waitFor();
    assert.deepEqual(await keys(), ['bead:ws-feat'], 'Label');
    await clear();
    await sp.locator('[data-filter-within="7d"]').click();
    await sp.locator('[data-work-count]').waitFor();
    const recent = await keys();
    assert.ok(recent.includes('bead:ws-rare') && recent.includes('bead:ws-fresh'), 'Updated in the last 7 days keeps the fresh ones.');
    assert.ok(!recent.includes('bead:ws-ready') && !recent.includes('bead:ws-ask'), 'And leaves out the old ones.');
    await clear();
    assert.equal((await keys()).length, full);

    step(`${label}: the choice survives a reload, and a bad stored value is the default with no error`);
    await search('quokka');
    await sp.locator('[data-filter-type="task"]').click();
    await sp.locator('.wk-snip').waitFor();
    await sp.reload();
    await sp.locator('.wk-snip').waitFor();
    assert.equal(await sp.locator('[data-work-search]').inputValue(), 'quokka');
    assert.equal(await sp.locator('[data-filter-type="task"]').getAttribute('aria-pressed'), 'true');
    assert.match(await count(), /^1 of \d+ shown/);
    for (const bad of ['{not json', '{"type":"epic","within":99,"q":5}', '[]', '"x"']) {
      await sp.evaluate(value => localStorage.setItem('hub-work-filter', value), bad);
      await sp.reload();
      await sp.locator('[data-card="bead:ws-ready"]').waitFor({ state: 'attached' });
      assert.equal(await sp.locator('[data-work-search]').inputValue(), '', bad);
      assert.equal(await sp.locator('[data-work-count]').count(), 0, bad);
    }

    step(`${label}: a link to a card the filter hides still shows the card and its sheet`);
    await goBoard(sp, board, lane('ready'));
    await search('zebra');
    await sp.waitForFunction(() => !document.querySelector('[data-card]'));
    await sp.goto(`${fixture.url}#/~hub/work/lanes/ws-ready`);
    await titled(sp, 'Ready to start').waitFor();
    assert.equal(await sp.locator('[data-card="bead:ws-ready"][data-focused="true"]').count(), 1);
    assert.deepEqual(await keys(), ['bead:ws-ready']);
    await sp.getByRole('button', { name: 'Close details' }).click();
    await atBoard(sp, '#/~hub/work/lanes');

    if (phone) {
      step('phone: no sideways scroll, every control at least 44 px, the lane chip goes to the first lane with a match');
      await search('');
      await sp.locator('[data-filter="needs-you"]').click();
      await sp.locator('[data-filter-type="task"]').click();
      await search('ws');
      await noSideways(sp, 'Work filters at phone width');
      const small = await sp.evaluate(() => [...document.querySelectorAll('.wk-search input, .wk-search button, .wk-filters button, .wk-filters input, [data-work-count] button, [data-lane-chip]')]
        .filter(element => element.getClientRects().length).map(element => ({ what: element.getAttribute('aria-label') ?? element.textContent, h: element.getBoundingClientRect().height })).filter(item => item.h < 43.5));
      assert.deepEqual(small, [], 'Every control is at least 44 px tall.');
      assert.equal(await sp.locator('[data-lane-chip="blocked"]').getAttribute('aria-pressed'), 'true', 'Needs you starts in Blocked.');
      await clear();
      await sp.locator('[data-filter-type="feature"]').click();
      assert.equal(await sp.locator('[data-lane-chip="ready"]').getAttribute('aria-pressed'), 'true');
      await sp.locator('[data-lane-chip="done"]').click();
      assert.equal(await sp.locator('[data-lane-chip="done"]').getAttribute('aria-pressed'), 'true', 'A lane the person taps stays, even at 0.');
      if (process.env.BUW_SHOTS) await sp.screenshot({ path: `${process.env.BUW_SHOTS}-search-${label}.png` });
    } else if (process.env.BUW_SHOTS) {
      await clear();
      await search('quokka');
      await sp.locator('.wk-snip').waitFor();
      await sp.screenshot({ path: `${process.env.BUW_SHOTS}-search-${label}.png` });
    }
    await sp.close();
  }

  console.log('hub-work-sheet-ui: passed');
} finally {
  for (const context of contexts) await context.close().catch(() => {});
  await browser.close();
  await fixture?.close();
}
