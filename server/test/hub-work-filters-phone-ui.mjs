// Run after npm run build. Work > Lanes on a phone (ws-ubo.2.4): at 640 px or less one row (project, Filters, Spawn) sits above the lane chips,
// and search, Needs you, Blocked, type, label and time open in a bottom sheet from the Filters button and apply at once. The button counts the
// filters that are on, remembered ones too. Checks: the height won (lane chips and first card), every filter from the sheet, the count, remembered
// filters before the board answers, Clear all, closing (a tap that falls through the scrim, a drag that ends on it, Escape, the label list's own
// Escape, Done and x), focus (no keyboard on open, back to the button), no scroll lock, the label list over the sheet, 44 px targets at 320 and 390,
// Spawn and the way to the project, the unchanged desktop DOM at 641 px and up, rotation, both themes.
// The real phone keyboard, iOS zoom, the safe area and the feel of a tap wait for the owner's play test. BUW_SHOTS=<prefix> also writes screenshots.
import { chromium } from '@playwright/test';
import { ms } from './ui-timeouts.mjs';
import assert from 'node:assert/strict';
import { startHubFixture } from './hub-fixture.mjs';

const step = name => console.log(`- ${name}`);
const channel = process.env.BUW_TEST_BROWSER || 'msedge';
const browser = await chromium.launch({ headless: true, channel });
const contexts = [];
let fixture;

const PHONE = { hasTouch: true, isMobile: true };
const KEY = 'hub-work-filter';
const open = async (viewport, { touch = true, storage } = {}) => {
  const context = await browser.newContext({ viewport, serviceWorkers: 'block', reducedMotion: 'reduce', ...(touch ? PHONE : {}) });
  contexts.push(context);
  if (storage !== undefined) await context.addInitScript(({ key, value }) => { try { if (!sessionStorage.getItem('seeded')) { localStorage.setItem(key, value); sessionStorage.setItem('seeded', '1'); } } catch { /* none */ } }, { key: KEY, value: storage });
  const page = await context.newPage();
  page.setDefaultTimeout(ms(15000));
  page.on('pageerror', error => { throw error; });
  return page;
};
const sideways = page => page.evaluate(() => [document.scrollingElement, document.querySelector('.content'), document.querySelector('.hub'), document.querySelector('.wk-filter-sheet')].filter(Boolean).filter(el => el.scrollWidth > el.clientWidth).map(el => `${el.tagName}.${el.className}: ${el.scrollWidth} > ${el.clientWidth}`));
const none = async (page, what) => assert.deepEqual(await sideways(page), [], `${what}: the page scrolls sideways.`);
const stored = page => page.evaluate(key => localStorage.getItem(key), KEY);
const keys = page => page.evaluate(() => [...document.querySelectorAll('[data-card]')].map(element => element.getAttribute('data-card')).sort());
const top = (page, selector) => page.evaluate(sel => { const node = [...document.querySelectorAll(sel)].find(item => item.getClientRects().length); return node ? node.getBoundingClientRect().top : null; }, selector);
const board = () => `${fixture.url}#/~hub/work/lanes`;
const go = async (page, url = board()) => { await page.goto(url); await page.locator('.wk-lane').first().waitFor({ state: 'attached' }); };
const sheet = page => page.locator('[data-work-filter-sheet]');
const button = page => page.locator('[data-work-filters]');
const openSheet = async page => { await button(page).tap(); await sheet(page).waitFor(); };
const headCount = page => page.locator('[data-work-sheet-count]').innerText();
const active = page => page.evaluate(() => { const node = document.activeElement; return node ? { tag: node.tagName, label: node.getAttribute('aria-label'), filters: node.hasAttribute('data-work-filters'), inSheet: !!node.closest('.wk-filter-sheet') } : null; });
const theme = async (page, value) => { await page.evaluate(next => { document.documentElement.dataset.workspaceTheme = next; }, value); await page.waitForTimeout(500); };
const shot = async (page, name) => { if (process.env.BUW_SHOTS) await page.screenshot({ path: `${process.env.BUW_SHOTS}-${name}.png` }); };

try {
  fixture = await startHubFixture({ work: true, workSide: true, workSearch: true, links: true });
  await new Promise(resolve => setTimeout(resolve, 100));

  step('1. height at 390 and 320: the row is one line, the chips and the first card are high on the screen');
  {
    const page = await open({ width: 390, height: 844 });
    await go(page);
    const chip = await top(page, '[data-lane-chip]');
    const card = await top(page, '.wk-card');
    console.log(`  390 x 844: lane chips top ${chip}, first card top ${card}`);
    assert.ok(chip <= 240, `Lane chips top (${chip}).`);
    assert.ok(card <= 390, `First card top (${card}).`);
    await page.locator('[data-lane-chip="backlog"]').tap();
    const above = await page.evaluate(() => { const tabs = innerHeight; return [...document.querySelectorAll('.wk-lane')].filter(lane => getComputedStyle(lane).display !== 'none').flatMap(lane => [...lane.querySelectorAll('.wk-card')]).filter(node => node.getBoundingClientRect().bottom <= tabs).length; });
    assert.ok(above >= 4, `At least 4 cards lie wholly above the bottom bar (${above}).`);
    assert.equal(await page.locator('.wk-search, .wk-filters').count(), 0, 'The fields are not in the page.');
    const bar = await page.locator('[data-work-bar]').evaluate(node => [...node.children].map(child => { const box = child.getBoundingClientRect(); return { tag: child.tagName, top: Math.round(box.top), height: box.height, left: box.left, right: box.right }; }));
    assert.equal(bar.length, 3, 'The project select, Filters and Spawn.');
    assert.equal(bar[0].tag, 'SELECT');
    assert.ok(bar.every(item => item.top === bar[0].top && item.height >= 44 && item.left >= 0 && item.right <= 390), `One row, 44 px, inside the screen (${JSON.stringify(bar)}).`);
    await button(page).waitFor();
    await page.locator('[data-spawn-open]').waitFor();
    await none(page, 'Work at 390');
    await shot(page, 'after-390');
    await page.close();
    const narrow = await open({ width: 320, height: 844 });
    await go(narrow);
    const first = await top(narrow, '.wk-card');
    console.log(`  320 x 844: lane chips top ${await top(narrow, '[data-lane-chip]')}, first card top ${first}`);
    assert.ok(first <= 440, `First card top at 320 (${first}).`);
    await none(narrow, 'Work at 320');
    await narrow.close();
  }

  step('2. every filter works from the sheet and applies at once');
  {
    const page = await open({ width: 390, height: 844 });
    await go(page);
    await page.locator('[data-lane-chip="ready"]').tap();
    const shownAll = (await keys(page)).length;
    await openSheet(page);
    // The header counts every card on the board; the page folds Backlog and Done past ten cards until a filter is on.
    const all = Number((await headCount(page)).match(/^All (\d+) on the board shown$/)[1]);
    assert.ok(all >= shownAll);
    await page.locator('[data-work-search]').fill('quokka');
    await page.locator('.wk-snip').waitFor();
    assert.deepEqual(await keys(page), ['bead:ws-rare']);
    assert.equal(await headCount(page), `1 of ${all} on the board shown`);
    assert.equal(await button(page).innerText(), 'Filters (1)');
    await page.locator('[data-work-clear-all]').tap();
    const only = async (selector, expected, what) => {
      await page.locator(selector).tap();
      await page.waitForFunction(count => document.querySelectorAll('[data-card]').length !== count, shownAll);
      assert.deepEqual(await keys(page), expected.map(id => `bead:${id}`).sort(), what);
      assert.equal(await headCount(page), `${expected.length} of ${all} on the board shown`, what);
      assert.equal(await button(page).innerText(), 'Filters (1)', what);
      await page.locator('[data-work-clear-all]').tap();
      await page.waitForFunction(count => document.querySelectorAll('[data-card]').length === count, shownAll);
    };
    await only('[data-filter="needs-you"]', ['ws-ask', 'ws-owner'], 'Needs you');
    await only('[data-filter="blocked"]', ['ws-stuck', 'ws-wait'], 'Blocked');
    await only('[data-filter-type="feature"]', ['ws-feat'], 'Type feature');
    await only('[data-filter-type="question"]', ['ws-ques'], 'Type question');
    await page.locator('[data-filter-type="task"]').tap();
    await page.waitForFunction(count => document.querySelectorAll('[data-card]').length !== count, shownAll);
    assert.ok((await keys(page)).length > 0 && (await keys(page)).length < all, 'Type task narrows the board.');
    await page.locator('[data-work-clear-all]').tap();
    await page.locator('[data-filter-label]').tap();
    await page.getByRole('option', { name: 'area:feel' }).tap();
    await page.waitForFunction(() => document.querySelectorAll('[data-card]').length === 1);
    assert.deepEqual(await keys(page), ['bead:ws-feat'], 'Label');
    await page.locator('[data-work-clear-all]').tap();
    await page.locator('[data-filter-within="7d"]').tap();
    await page.waitForFunction(count => document.querySelectorAll('[data-card]').length !== count, shownAll);
    const recent = await keys(page);
    assert.ok(recent.includes('bead:ws-rare') && recent.includes('bead:ws-fresh') && !recent.includes('bead:ws-ready') && !recent.includes('bead:ws-ask'), 'Updated in 7 days.');
    assert.equal(await button(page).innerText(), 'Filters (1)');
    await page.close();
  }

  step('3. the count: six filters, one off, a search of spaces');
  {
    const page = await open({ width: 390, height: 844 });
    await go(page);
    await openSheet(page);
    await page.locator('[data-work-search]').fill('ws');
    await page.locator('[data-filter="needs-you"]').tap();
    await page.locator('[data-filter="blocked"]').tap();
    await page.locator('[data-filter-type="task"]').tap();
    await page.locator('[data-filter-within="30d"]').tap();
    await page.locator('[data-filter-label]').tap();
    await page.locator('.cb-list [role="option"]').nth(1).tap();
    await page.locator('[data-work-clear-all]').waitFor();
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.querySelector('[data-work-filters]')?.textContent === 'Filters (6)');
    assert.equal(await button(page).getAttribute('aria-label'), 'Filters, 6 on');
    assert.ok(await button(page).evaluate(node => node.classList.contains('on')));
    await openSheet(page);
    await page.locator('[data-filter="blocked"]').tap();
    assert.equal(await button(page).innerText(), 'Filters (5)');
    await page.locator('[data-work-clear-all]').tap();
    await page.locator('[data-work-search]').fill('   ');
    assert.equal(await button(page).innerText(), 'Filters');
    assert.equal(await button(page).getAttribute('aria-label'), null);
    assert.equal(await button(page).evaluate(node => node.classList.contains('on')), false);
    await page.close();
  }

  step('4. remembered filters count before the board answers; a bad value is plain Filters');
  {
    const remembered = JSON.stringify({ needsYou: true, type: 'task', within: 7, q: '', blocked: false, label: '' });
    const page = await open({ width: 390, height: 844 }, { storage: remembered });
    let release;
    const held = new Promise(resolve => { release = resolve; });
    await page.route('**/api/hub/work*', async route => { await held; await route.continue(); });
    const errors = [];
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.goto(board());
    await button(page).waitFor();
    assert.equal(await button(page).innerText(), 'Filters (3)');
    assert.equal(await button(page).isDisabled(), true, 'Disabled while the board loads.');
    assert.equal(await sheet(page).count(), 0);
    release();
    await page.waitForFunction(() => !document.querySelector('[data-work-filters]')?.disabled);
    await page.locator('[data-work-count]').waitFor();
    assert.equal(await sheet(page).count(), 0, 'The line shows with the sheet closed.');
    const chips = await page.locator('[data-lane-chip] .n').allInnerTexts();
    const total = chips.reduce((sum, value) => sum + Number(value), 0);
    assert.match(await page.locator('[data-work-count]').innerText(), new RegExp(`^${total} of \\d+ on the board shown`));
    await openSheet(page);
    await page.locator('[data-filter-label]').tap();
    await page.getByRole('option', { name: 'area:feel' }).tap();
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await page.locator('[data-lane-chip][aria-pressed="true"]').waitFor();
    assert.match(await page.locator('.wk-lane .hub-empty').first().innerText(), /No match/);
    assert.equal(await button(page).innerText(), 'Filters (4)');
    await page.locator('[data-work-count] .wk-clear').tap();
    await page.locator('[data-work-count]').waitFor({ state: 'detached' });
    assert.equal(await button(page).innerText(), 'Filters');
    assert.equal(await stored(page), null);
    assert.deepEqual(errors.filter(text => !/Failed to load resource/.test(text)), []);
    await page.close();
    const bad = await open({ width: 390, height: 844 }, { storage: '{not json' });
    await go(bad);
    assert.equal(await button(bad).innerText(), 'Filters');
    await bad.close();
  }

  step('5. Clear all keeps the sheet open, empties the key and keeps the focus inside');
  {
    const page = await open({ width: 390, height: 844 }, { storage: JSON.stringify({ needsYou: true, type: 'task', within: 7, q: 'ws', blocked: true, label: '' }) });
    await go(page);
    await openSheet(page);
    assert.match(await headCount(page), /^\d+ of \d+ on the board shown$/);
    await page.locator('[data-work-clear-all]').tap();
    await page.waitForFunction(() => /^All \d+ on/.test(document.querySelector('[data-work-sheet-count]').textContent));
    assert.equal(await stored(page), null);
    assert.equal(await sheet(page).count(), 1);
    assert.equal(await page.locator('[data-filter="needs-you"]').getAttribute('aria-pressed'), 'false');
    assert.equal(await page.locator('[data-work-search]').inputValue(), '');
    assert.equal((await active(page)).inSheet, true);
    await page.close();
  }

  step('6. closing: the tap does not fall through, a drag ending on the scrim keeps it, Escape, the label list, Done and x');
  {
    const page = await open({ width: 390, height: 844 });
    await go(page);
    const before = await page.evaluate(() => location.hash);
    await openSheet(page);
    const chip = await page.locator('[data-lane-chip="done"]').boundingBox();
    await page.touchscreen.tap(chip.x + chip.width / 2, chip.y + chip.height / 2);
    await sheet(page).waitFor({ state: 'detached' });
    await page.waitForTimeout(300);
    assert.equal(await page.locator('[data-lane-chip="done"]').getAttribute('aria-pressed'), 'false', 'The tap did not reach the chip under the scrim.');
    assert.equal(await page.evaluate(() => location.hash), before);
    await openSheet(page);
    const box = await page.locator('.lib-dialog').boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + 20);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, 30);
    await page.mouse.up();
    assert.equal(await sheet(page).count(), 1, 'A press inside and a release on the scrim keeps it open.');
    await page.keyboard.press('Escape');
    await sheet(page).waitFor({ state: 'detached' });
    assert.equal((await active(page)).filters, true);
    await openSheet(page);
    await page.locator('[data-filter-label]').tap();
    await page.locator('.cb-list').waitFor();
    await page.keyboard.press('Escape');
    await page.locator('.cb-list').waitFor({ state: 'detached' });
    assert.equal(await sheet(page).count(), 1, 'The first Escape closes the list only.');
    await page.keyboard.press('Escape');
    await sheet(page).waitFor({ state: 'detached' });
    await openSheet(page);
    await page.getByRole('button', { name: 'Done', exact: true }).tap();
    await sheet(page).waitFor({ state: 'detached' });
    assert.equal((await active(page)).filters, true, 'Done returns the focus.');
    await openSheet(page);
    await page.getByRole('button', { name: 'Close filters' }).tap();
    await sheet(page).waitFor({ state: 'detached' });
    assert.equal((await active(page)).filters, true, 'x returns the focus.');
    assert.equal(await button(page).getAttribute('aria-expanded'), 'false');
    await page.close();
  }

  step('7. focus and roles: the x first (no keyboard), a dialog named Filters');
  {
    const page = await open({ width: 390, height: 844 });
    await go(page);
    assert.equal(await button(page).getAttribute('aria-expanded'), 'false');
    await openSheet(page);
    assert.equal(await button(page).getAttribute('aria-expanded'), 'true');
    assert.deepEqual(await active(page), { tag: 'BUTTON', label: 'Close filters', filters: false, inSheet: true });
    const dialog = page.getByRole('dialog', { name: 'Filters' });
    assert.equal(await dialog.count(), 1);
    assert.equal(await dialog.getAttribute('aria-modal'), 'true');
    await page.close();
  }

  step('8. not trapped: the page keeps its scroll; a short landscape sheet scrolls inside');
  {
    const page = await open({ width: 390, height: 844 });
    await go(page);
    await page.locator('[data-lane-chip="backlog"]').tap();
    const scrolled = await page.evaluate(() => { const hub = document.querySelector('.hub'); hub.scrollTop = 120; return hub.scrollTop; });
    assert.ok(scrolled > 0, `The Hub scrolls (${scrolled}).`);
    // A script click: a tap would scroll the button into view first, which is Playwright's doing and not the sheet's.
    await button(page).evaluate(node => node.click());
    await sheet(page).waitFor();
    await page.getByRole('button', { name: 'Done', exact: true }).tap();
    await sheet(page).waitFor({ state: 'detached' });
    assert.equal(await page.evaluate(() => document.querySelector('.hub').scrollTop), scrolled, 'The position is kept.');
    assert.equal(await page.evaluate(() => { const hub = document.querySelector('.hub'); hub.scrollTop = 40; return hub.scrollTop; }), 40);
    await page.close();
    const land = await open({ width: 568, height: 320 });
    await go(land);
    await openSheet(land);
    const dialog = land.locator('.lib-dialog');
    assert.ok(await dialog.evaluate(node => node.scrollHeight > node.clientHeight), 'The sheet scrolls inside.');
    await land.getByRole('button', { name: 'Done', exact: true }).scrollIntoViewIfNeeded();
    const done = await land.getByRole('button', { name: 'Done', exact: true }).boundingBox();
    assert.ok(done.y + done.height <= 320, `Done can be brought into view (${done.y}).`);
    await land.close();
  }

  step('9. the label list lies over the sheet at 390 x 844 and 320 x 568');
  for (const [width, height] of [[390, 844], [320, 568]]) {
    const page = await open({ width, height });
    await go(page);
    await openSheet(page);
    await page.locator('.wk-filter-sheet .cb-chev').tap();
    await page.locator('.cb-list').waitFor();
    const result = await page.evaluate(() => {
      const list = document.querySelector('.cb-list').getBoundingClientRect();
      const option = document.querySelector('.cb-list [role="option"]').getBoundingClientRect();
      const hit = document.elementFromPoint(option.left + option.width / 2, option.top + option.height / 2);
      return { inside: list.top >= 0 && list.bottom <= innerHeight && list.left >= 0 && list.right <= innerWidth, option: !!hit?.closest('[role="option"]') };
    });
    assert.deepEqual(result, { inside: true, option: true }, `${width} x ${height}`);
    await page.close();
  }

  step('10. layout at 320 x 568 and 390 x 844, in the sheet');
  for (const [width, height] of [[320, 568], [390, 844]]) {
    const page = await open({ width, height });
    await go(page);
    await none(page, `closed at ${width}`);
    await openSheet(page);
    await none(page, `open at ${width}`);
    const measured = await page.evaluate(() => {
      const dialog = document.querySelector('.lib-dialog').getBoundingClientRect();
      const small = [...document.querySelectorAll('.wk-filter-sheet button, .wk-filter-sheet input')].filter(node => node.getClientRects().length).map(node => ({ what: node.getAttribute('aria-label') ?? node.textContent, h: node.getBoundingClientRect().height })).filter(item => item.h < 43.5);
      const done = [...document.querySelectorAll('.wk-filter-sheet button')].find(node => node.textContent === 'Done');
      const box = done.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      const search = document.querySelector('.wk-filter-sheet [data-work-search]');
      return { inside: dialog.left >= 0 && dialog.right <= innerWidth && dialog.top >= 0 && dialog.bottom <= innerHeight, small, doneHit: hit === done, font: getComputedStyle(search).fontSize, searchTop: search.getBoundingClientRect().top, chipBox: getComputedStyle(document.querySelector('.wk-filter-sheet .hub-chip')).boxSizing };
    });
    assert.equal(measured.inside, true, `The sheet is inside the screen at ${width}.`);
    assert.deepEqual(measured.small, [], `Every control is 44 px at ${width}.`);
    assert.equal(measured.doneHit, true, `Done is not under the bottom bar at ${width}.`);
    assert.equal(measured.font, '16px');
    assert.equal(measured.chipBox, 'border-box');
    if (height === 568) assert.ok(measured.searchTop < 300, `The search box is high enough for a keyboard (${measured.searchTop}).`);
    if (width === 390) await shot(page, 'sheet-390-dark');
    if (width === 320) await shot(page, 'sheet-320');
    await page.close();
  }

  step('11. Spawn opens its sheet and gets the focus back; All has no Spawn; More > Project is the same project');
  {
    const page = await open({ width: 390, height: 844 });
    await go(page);
    const spawn = page.locator('[data-spawn-open]');
    assert.equal((await spawn.innerText()).trim(), 'New job');
    assert.equal(await page.getByRole('button', { name: 'New job' }).count(), 1);
    await spawn.tap();
    await page.locator('[data-spawn-sheet]').waitFor();
    await page.keyboard.press('Escape');
    await page.locator('[data-spawn-sheet]').waitFor({ state: 'hidden' });
    assert.equal(await page.evaluate(() => document.activeElement?.hasAttribute('data-spawn-open')), true, 'The focus returns to Spawn.');
    assert.equal(await page.locator('.work-spawn').count(), 0);
    await page.evaluate(() => { location.hash = '#/~hub/project'; });
    await page.waitForFunction(() => location.hash.startsWith('#/~hub/project'));
    await page.waitForFunction(() => /lanes/i.test(document.body.innerText));
    await go(page, `${fixture.url}#/~hub/work/all`);
    assert.equal(await page.locator('[data-spawn-open]').count(), 0, 'No Spawn on All.');
    assert.equal(await page.locator('.work-spawn').count(), 0);
    await none(page, 'All');
    await page.close();
  }

  step('12. desktop and the boundaries: 640 has the bar; 641 and 1280 keep today\'s children; rotation drops the sheet');
  {
    const baseChildren = ['hub-chips-wrap', 'wk-search', 'wk-filters', 'work-spawn', 'wk-lane-chips', 'wk-lanes-wrap'];
    const at640 = await open({ width: 640, height: 800 }, { touch: false });
    await go(at640);
    assert.equal(await at640.locator('[data-work-bar]').count(), 1);
    await at640.close();
    for (const width of [641, 1280]) {
      const page = await open({ width, height: 800 }, { touch: false });
      await go(page);
      assert.equal(await page.locator('[data-work-bar], [data-work-filters]').count(), 0, `No bar at ${width}.`);
      assert.deepEqual(await page.locator('.work').evaluate(node => [...node.children].map(child => child.className)), baseChildren, `The children of .work at ${width} are the base branch's.`);
      assert.equal((await page.locator('[data-spawn-open]').innerText()).trim(), 'New job');
      assert.match(await page.locator('.work-spawn').innerText(), /Project/);
      assert.equal(await page.locator('[role="dialog"]').count(), 0);
      await page.close();
    }
    const page = await open({ width: 390, height: 844 }, { storage: JSON.stringify({ needsYou: true, q: '', blocked: false, type: null, label: '', within: null }) });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await go(page);
    await openSheet(page);
    await page.setViewportSize({ width: 844, height: 390 });
    await sheet(page).waitFor({ state: 'detached' });
    assert.equal(await page.locator('.wk-filters [data-filter="needs-you"]').getAttribute('aria-pressed'), 'true', 'The inline filters show the same values.');
    await page.setViewportSize({ width: 390, height: 844 });
    await button(page).waitFor();
    assert.equal(await sheet(page).count(), 0, 'The sheet is closed when the phone comes back.');
    assert.deepEqual(errors, []);
    await page.close();
  }

  step('13. both themes: the sheet and the button differ, and the button looks unlike Spawn');
  {
    const page = await open({ width: 390, height: 844 }, { storage: JSON.stringify({ needsYou: true, type: 'task', within: 7, q: '', blocked: false, label: '' }) });
    await go(page);
    const read = () => page.evaluate(() => {
      const css = (selector, prop) => getComputedStyle(document.querySelector(selector))[prop];
      return { dialog: css('.lib-dialog', 'backgroundColor'), head: css('.wk-filter-head p', 'color'), chip: css('.wk-filter-sheet .hub-chip', 'color'), on: css('[data-work-filters]', 'color'), onBorder: css('[data-work-filters]', 'borderTopColor'), spawn: css('[data-spawn-open]', 'backgroundColor'), filtersBg: css('[data-work-filters]', 'backgroundColor') };
    });
    await shot(page, 'filters-on-390');
    await openSheet(page);
    await theme(page, 'dark');
    const dark = await read();
    await shot(page, 'sheet-390-dark-on');
    await theme(page, 'light');
    const light = await read();
    await shot(page, 'sheet-390-light');
    for (const key of ['dialog', 'head', 'chip', 'on']) assert.notEqual(dark[key], light[key], `${key} differs between themes.`);
    for (const mode of [dark, light]) assert.notEqual(mode.filtersBg, mode.spawn, 'The Filters button is not filled like Spawn.');
    await theme(page, 'light');
    await page.getByRole('button', { name: 'Done', exact: true }).tap();
    await shot(page, 'filters-on-390-light');
    await page.close();
  }

  console.log('hub-work-filters-phone-ui: passed');
} finally {
  for (const context of contexts) await context.close().catch(() => {});
  await browser.close();
  await fixture?.close?.().catch(() => {});
}
