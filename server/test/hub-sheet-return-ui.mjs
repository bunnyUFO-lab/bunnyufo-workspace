// Run after npm run build. Leaving a milestone or a task that a Project page opened returns to the Project page (ws-2vh.28),
// through a real browser over the fixture service. The rows of the Roadmap tab open their details in place, as a Work card does:
// the address is #/~hub/project/<id>/roadmap/<node>, and X, the scrim, Escape and Back all return to the list (same tab, same scroll, one
// history step), a shared link closes onto the list, a task inside a milestone's sheet swaps the sheet, focus returns to the row,
// "Show on roadmap" still goes to the map, an unknown node shows no sheet. At 390 and 320 px the sheet is a bottom sheet, at 1280 a side
// panel with the list beside it. The Work board keeps returning to its lane with its filter intact (a guard: it passed before the change).
// A screen seen before shows its last answer at once and then refreshes, so every read waits for the state it expects.
import { chromium } from '@playwright/test';
import { ms } from './ui-timeouts.mjs';
import assert from 'node:assert/strict';
import { startHubFixture } from './hub-fixture.mjs';

const step = name => console.log(`- ${name}`);
const channel = process.env.BUW_TEST_BROWSER || 'msedge';
const browser = await chromium.launch({ headless: true, channel });
const contexts = [];
let fixture;

const open = async (viewport, options = {}) => {
  const context = await browser.newContext({ viewport, serviceWorkers: 'block', reducedMotion: 'reduce', ...options });
  contexts.push(context);
  const page = await context.newPage();
  page.setDefaultTimeout(ms(15000));
  page.on('pageerror', error => { throw error; });
  return page;
};
const PHONE = { hasTouch: true, isMobile: true };
const hashOf = page => page.evaluate(() => location.hash);
const panelOf = page => page.locator('dialog#hub-map-panel');
const noTabs = page => page.locator('[data-tabs]').count();
const list = '[data-project-page="lanes"] [data-pp-roadmap]';
const sheetUrl = id => `#/~hub/project/lanes/roadmap/${encodeURIComponent(id)}`;
/** The address settles on the list, the sheet is gone and the list shows. */
const backOnList = async (page, what) => {
  await page.waitForFunction(value => location.hash === value, '#/~hub/project/lanes').catch(async () => {
    assert.equal(await hashOf(page), '#/~hub/project/lanes', `${what}: the address.`);
  });
  await panelOf(page).waitFor({ state: 'detached' });
  await page.locator(list).waitFor();
};
/** The list, reached the way a person does it: from another screen, so one Back leaves the page. */
const toList = async (page, base) => {
  await page.goto(`${base}#/~hub/today`);
  await page.locator('.hub').waitFor();
  await page.evaluate(() => { location.hash = '#/~hub/project/lanes'; });
  await page.locator(list).waitFor();
  await page.evaluate(() => { document.querySelector('.hub').scrollTop = 40; });
  return page.evaluate(() => document.querySelector('.hub').scrollTop);
};
const leaveThePage = async page => {
  await page.goBack();
  await page.waitForFunction(() => location.hash === '#/~hub/today');
};
const noSideways = async (page, what) => {
  const wide = await page.evaluate(() => [document.scrollingElement, document.querySelector('.hub')].filter(Boolean).filter(el => el.scrollWidth > el.clientWidth).map(el => `${el.className}: ${el.scrollWidth} > ${el.clientWidth}`));
  assert.deepEqual(wide, [], `${what}: scrolls sideways.`);
};

try {
  fixture = await startHubFixture({ work: true, workSide: true, workSearch: true, links: true });
  await new Promise(resolve => setTimeout(resolve, 100));

  for (const [label, viewport, options] of [['phone', { width: 390, height: 844 }, PHONE], ['desktop', { width: 1280, height: 800 }, {}]]) {
    const phone = label === 'phone';
    const page = await open(viewport, options);
    const press = locator => (phone ? locator.tap() : locator.click());
    const leaves = {
      X: () => press(page.getByRole('button', { name: 'Close details' })),
      [phone ? 'scrim' : 'Escape']: () => (phone ? page.mouse.click(viewport.width / 2, 30) : page.keyboard.press('Escape')),
      Back: () => page.goBack(),
    };
    for (const [kind, row] of [['milestone', '.pp-ms-title'], ['task', '[data-pp-task]']]) {
      for (const [how, leave] of Object.entries(leaves)) {
        step(`${label}: a ${kind}, left by ${how}, returns to the list with the scroll, the tab, one history step and the focus`);
        const scrolled = await toList(page, fixture.url);
        const opener = page.locator(row).first();
        const id = await opener.getAttribute('data-pp-node');
        await press(opener);
        await panelOf(page).locator('h3').waitFor();
        assert.equal(await hashOf(page), sheetUrl(id), `A ${kind} opens at its Project address.`);
        if (phone) assert.equal(await noTabs(page), 0, 'A project page has no tab bar while the sheet is open.');
        await leave();
        await backOnList(page, `${kind}, ${how}`);
        const after = await page.evaluate(() => document.querySelector('.hub').scrollTop);
        assert.ok(Math.abs(after - scrolled) <= 2, `The scroll holds (${scrolled} -> ${after}).`);
        if (phone) assert.equal(await noTabs(page), 0, 'Still no tab bar.');
        await page.waitForFunction(value => document.activeElement?.getAttribute('data-pp-node') === value, id);
        await leaveThePage(page);
      }
    }

    step(`${label}: a shared link opens the sheet and X lands on the list; a task inside the milestone's sheet swaps it, and one X returns`);
    await toList(page, fixture.url);
    const milestone = await page.locator('.pp-ms-title').first().getAttribute('data-pp-node');
    await page.goto(`${fixture.url}#/~hub/today`);
    await page.evaluate(value => { location.hash = value; }, sheetUrl(milestone));
    await panelOf(page).locator('h3').waitFor();
    await press(page.getByRole('button', { name: 'Close details' }));
    await backOnList(page, 'shared link');
    await leaveThePage(page);

    await toList(page, fixture.url);
    await press(page.locator('[data-pp-milestone]:has([data-pp-task]) .pp-ms-title').first());
    await panelOf(page).locator('h3').waitFor();
    const inner = panelOf(page).locator('.hub-map-panel-row-title').first();
    await inner.waitFor();
    await press(inner);
    await page.waitForFunction(value => location.hash !== value && location.hash.startsWith('#/~hub/project/lanes/roadmap/'), sheetUrl(milestone));
    await press(page.getByRole('button', { name: 'Close details' }));
    await backOnList(page, 'swapped sheet');
    await leaveThePage(page);

    step(`${label}: Show on roadmap goes to the map, Back returns to the sheet, X returns to the list; Open the Roadmap still goes to the map`);
    await toList(page, fixture.url);
    await press(page.locator('.pp-ms-title').first());
    await panelOf(page).locator('h3').waitFor();
    const show = panelOf(page).locator('[data-show-on-roadmap]');
    assert.equal(await show.getAttribute('href'), `#/~hub/map/lanes/${milestone}`);
    await press(show);
    await page.waitForFunction(value => location.hash === value, `#/~hub/map/lanes/${milestone}`);
    await page.goBack();
    await panelOf(page).locator('h3').waitFor();
    assert.equal(await hashOf(page), sheetUrl(milestone));
    await press(page.getByRole('button', { name: 'Close details' }));
    await backOnList(page, 'after the map');
    await page.locator('[data-pp-open-map]').scrollIntoViewIfNeeded();
    assert.equal(await page.locator('[data-pp-open-map]').getAttribute('href'), '#/~hub/map/lanes');
    await press(page.locator('[data-pp-open-map]'));
    await page.waitForFunction(() => location.hash === '#/~hub/map/lanes');

    step(`${label}: an unknown node shows the list, no sheet and no error`);
    await page.goto(`${fixture.url}#/~hub/today`);
    await page.evaluate(() => { location.hash = '#/~hub/project/lanes/roadmap/nope'; });
    await page.locator(list).waitFor();
    await page.waitForTimeout(300);
    assert.equal(await panelOf(page).count(), 0);
    assert.equal(await hashOf(page), '#/~hub/project/lanes/roadmap/nope');

    step(`${label}: the sheet ${phone ? 'is a bottom sheet, at most 76% tall, with no sideways scroll' : 'is a side panel with the list beside it'}`);
    await toList(page, fixture.url);
    await press(page.locator('.pp-ms-title').first());
    await panelOf(page).locator('h3').waitFor();
    await noSideways(page, label);
    const box = await panelOf(page).boundingBox();
    if (phone) {
      assert.ok(Math.abs(box.y + box.height - viewport.height) <= 1 && Math.abs(box.width - viewport.width) <= 1, `Across the bottom (${JSON.stringify(box)}).`);
      assert.ok(box.height <= viewport.height * 0.76, `At most 76% tall (${box.height}).`);
    } else {
      const listBox = await page.locator(list).boundingBox();
      assert.ok(listBox.x + listBox.width <= box.x + 1, `The list (${listBox.x + listBox.width}) ends before the panel (${box.x}).`);
    }
    await page.close();
  }

  step('phone at 320 x 568: the sheet fits, nothing scrolls sideways, X returns to the list');
  {
    const page = await open({ width: 320, height: 568 }, PHONE);
    await toList(page, fixture.url);
    await page.locator('[data-pp-task]').first().tap();
    await panelOf(page).locator('h3').waitFor();
    await noSideways(page, '320');
    const box = await panelOf(page).boundingBox();
    assert.ok(box.height <= 568 * 0.76 && box.width <= 320, `Fits (${JSON.stringify(box)}).`);
    await page.getByRole('button', { name: 'Close details' }).tap();
    await backOnList(page, '320');
    await page.close();
  }

  // The Work board: these passed before the change and stay as guards.
  for (const [label, viewport, options] of [['phone', { width: 390, height: 844 }, PHONE], ['desktop', { width: 1280, height: 800 }, {}]]) {
    const phone = label === 'phone';
    const page = await open(viewport, options);
    const press = locator => (phone ? locator.tap() : locator.click());
    const state = () => page.evaluate(() => ({
      hash: location.hash,
      // The lane chips are a phone's: on a desktop they are hidden and every lane shows.
      lanes: [...document.querySelectorAll('[data-lane-chip][aria-pressed="true"]')].filter(el => el.offsetParent).map(el => el.getAttribute('data-lane-chip')),
      count: document.querySelector('[data-work-count]')?.textContent ?? '',
      picker: [...document.querySelectorAll('.work .hub-chips .hub-chip.on')].map(el => el.textContent).concat([...document.querySelectorAll('.work select')].map(el => el.value)),
    }));
    for (const board of ['lanes', 'all']) {
      for (const how of phone ? ['X', 'scrim', 'Back'] : ['X', 'Escape', 'Back']) {
        step(`${label}: Work board ${board}, a card left by ${how} stays on the board with its lane, filter and picker`);
        await page.goto(`${fixture.url}#/~hub/work/${board}`);
        await page.locator('.wk-lane').first().waitFor({ state: 'attached' });
        // The filter is kept between visits: set Type task only when it is not set yet.
        if (phone) await page.locator('[data-work-filters]').tap();
        const type = page.locator('[data-filter-type="task"]');
        if ((await type.getAttribute('aria-pressed')) !== 'true') await press(type);
        if (phone) await page.getByRole('button', { name: 'Close filters' }).tap();
        await page.locator('[data-work-count]').waitFor();
        if (phone) {
          await page.locator('[data-lane-chip="ready"]').tap();
          await page.locator('[data-lane-chip="ready"][aria-pressed="true"]').waitFor();
        }
        await page.locator('[data-card="bead:ws-ready"]').waitFor();
        const before = await state();
        await press(page.locator('[data-card="bead:ws-ready"]'));
        await panelOf(page).locator('h3').waitFor();
        assert.equal(await hashOf(page), `#/~hub/work/${board}/ws-ready`);
        if (how === 'X') await press(page.getByRole('button', { name: 'Close details' }));
        else if (how === 'Back') await page.goBack();
        else if (phone) await page.mouse.click(viewport.width / 2, 30);
        else await page.keyboard.press('Escape');
        await panelOf(page).waitFor({ state: 'detached' });
        await page.waitForFunction(value => location.hash === value, before.hash);
        await page.locator('[data-work-count]').waitFor();
        assert.deepEqual(await state(), before, 'Same address, lane, count and picker.');
      }
    }
    step(`${label}: Work card, Show on roadmap, Back, X: back on the Ready lane`);
    await page.goto(`${fixture.url}#/~hub/work/lanes`);
    await page.locator('.wk-lane').first().waitFor({ state: 'attached' });
    if (phone) await page.locator('[data-lane-chip="ready"]').tap();
    await press(page.locator('[data-card="bead:ws-ready"]'));
    await panelOf(page).locator('h3').waitFor();
    await press(panelOf(page).locator('[data-show-on-roadmap]'));
    await page.waitForFunction(() => location.hash === '#/~hub/map/lanes/ws-ready');
    await page.goBack();
    await panelOf(page).locator('h3').waitFor();
    await press(page.getByRole('button', { name: 'Close details' }));
    await page.waitForFunction(() => location.hash === '#/~hub/work/lanes');
    await page.locator('[data-card="bead:ws-ready"]').waitFor();
    if (phone) assert.deepEqual((await state()).lanes, ['ready']);
    await page.close();
  }
} finally {
  for (const context of contexts) await context.close().catch(() => {});
  await browser.close().catch(() => {});
  await fixture?.close?.();
}
