// Run after npm run build. The Project page's tab row on a phone (ws-ubo.2.2): at 640 px or less the row is Roadmap, the current tab
// (Needs you when Roadmap is current) and a More button; the other two tabs, with their counts, are in the menu More opens.
// 641 px and up keeps the four tabs and has no More. Checks: nothing scrolls sideways at 320 and 390 (the page, .content, .hub and the
// tab row), the current tab is always in the row, every tab is reachable from every other, counts, the menu's roles, size and place,
// closing on a tap outside without a tap falling through to what is underneath, keyboard and focus, long labels and large text,
// the 640/641 boundary, rotation, and both themes. A real phone's tap feel and the iOS safe area wait for the owner's play test.
import { chromium, expect } from '@playwright/test';
import { ms, SCALE } from './ui-timeouts.mjs';
expect.configure({ timeout: 5000 * SCALE });
import assert from 'node:assert/strict';
import { startHubFixture } from './hub-fixture.mjs';

const step = name => console.log(`- ${name}`);
const channel = process.env.BUW_TEST_BROWSER || 'msedge';
const browser = await chromium.launch({ headless: true, channel });
const contexts = [];
let fixture;

const PHONE = { hasTouch: true, isMobile: true };
const TABS = ['roadmap', 'running', 'needs', 'library'];
const LABEL = { roadmap: 'Roadmap', running: 'Running', needs: 'Needs you', library: 'Library' };

const open = async (viewport, options = {}) => {
  const context = await browser.newContext({ viewport, serviceWorkers: 'block', reducedMotion: 'reduce', ...options });
  contexts.push(context);
  const page = await context.newPage();
  page.setDefaultTimeout(ms(15000));
  page.on('pageerror', error => { throw error; });
  return page;
};
/** The page, the app's scroller (.content), .hub and the tab row: each one that is wider than it is shown. */
const sideways = page => page.evaluate(() => [document.scrollingElement, document.querySelector('.content'), document.querySelector('.hub'), document.querySelector('.pp-tabs-row .pp-tabs')].filter(Boolean).filter(el => el.scrollWidth > el.clientWidth).map(el => `${el.tagName}.${el.className}: ${el.scrollWidth} > ${el.clientWidth}`));
const none = async (page, what) => assert.deepEqual(await sideways(page), [], `${what}: the page scrolls sideways.`);
const hash = page => page.evaluate(() => location.hash);
const go = (page, next) => page.evaluate(value => { location.hash = value; }, next);
const rowTabs = page => page.locator('.pp-tabs [data-project-tab]').evaluateAll(list => list.map(node => node.getAttribute('data-project-tab')));
const more = page => page.locator('.pp-more');
const items = page => page.locator('.item-menu [role="menuitem"]');
const ready = async (page, tab) => {
  await page.goto(`${fixture.url}#/~hub/project/probe/${tab}`);
  await page.locator(`[data-project-tab="${tab}"]`).waitFor();
  await page.locator('.pp-more').waitFor();
};
const panel = page => page.locator('.pp-main').getAttribute('aria-label');

try {
  fixture = await startHubFixture({ work: true });
  await new Promise(resolve => setTimeout(resolve, 100));

  for (const width of [390, 320]) {
    step(`At ${width} px each tab, opened by address, is in the row, selected and inside the screen, with nothing sideways`);
    const page = await open({ width, height: 844 }, PHONE);
    for (const tab of TABS) {
      await ready(page, tab);
      const current = page.locator(`[data-project-tab="${tab}"]`);
      await expect(current).toBeVisible();
      assert.equal(await current.getAttribute('aria-selected'), 'true', `${tab}: selected.`);
      assert.match(await current.getAttribute('class'), /\bon\b/, `${tab}: underlined.`);
      const box = await current.boundingBox();
      assert.ok(box.x >= 0 && box.x + box.width <= width, `${tab}: inside the screen (${JSON.stringify(box)}).`);
      assert.equal(await panel(page), LABEL[tab], `${tab}: its panel.`);
      await none(page, `${tab} at ${width}`);
      const inRow = await rowTabs(page);
      assert.equal(inRow.length, 2, `${tab}: two tabs in the row.`);
      assert.equal(inRow[0], 'roadmap', `${tab}: Roadmap first.`);
      const heights = await page.locator('.pp-tabs-row .wk-tab, .pp-more').evaluateAll(list => list.map(node => ({ h: node.getBoundingClientRect().height, top: Math.round(node.getBoundingClientRect().top) })));
      assert.ok(heights.every(item => item.h >= 44), `${tab}: every control is 44 px high (${JSON.stringify(heights)}).`);
      assert.equal(new Set(heights.map(item => item.top)).size, 1, `${tab}: the three controls share a row.`);
      await more(page).tap();
      await items(page).first().waitFor();
      const inMenu = (await items(page).allInnerTexts()).map(text => text.replace(/\s*\(\d+\)$/, ''));
      assert.deepEqual([...inRow.map(key => LABEL[key]), ...inMenu].sort(), Object.values(LABEL).sort(), `${tab}: row and menu hold all four once.`);
      assert.ok(!inMenu.includes(LABEL[tab]), `${tab}: the current tab is not in the menu.`);
      await page.keyboard.press('Escape');
      await items(page).first().waitFor({ state: 'detached' });
    }
    await page.context().close();
  }

  step('Every tab can be reached from every other; Back follows; the project select keeps the tab');
  {
    const page = await open({ width: 390, height: 844 }, PHONE);
    await ready(page, 'roadmap');
    for (const [from, target] of [['roadmap', 'library'], ['roadmap', 'running'], ['library', 'needs']]) {
      await go(page, `#/~hub/project/probe/${from}`);
      await page.waitForFunction(key => document.querySelector(`[data-project-tab="${key}"]`)?.getAttribute('aria-selected') === 'true', from);
      await more(page).tap();
      await page.getByRole('menuitem', { name: new RegExp(`^${LABEL[target]}`) }).tap();
      await page.waitForFunction(value => location.hash === `#/~hub/project/probe/${value}`, target);
      await items(page).first().waitFor({ state: 'detached' });
      await expect(page.locator(`[data-project-tab="${target}"]`)).toHaveClass(/\bon\b/);
      assert.equal(await panel(page), LABEL[target]);
      assert.ok((await rowTabs(page)).includes(target), `${target}: in the row after a pick.`);
    }
    await page.goBack();
    await page.waitForFunction(() => location.hash === '#/~hub/project/probe/library');
    await expect(page.locator('[data-project-tab="library"]')).toHaveClass(/\bon\b/);
    await go(page, '#/~hub/project/probe/library');
    await page.locator('[data-project-tab="library"].on').waitFor();
    await page.locator('[data-project-tab="roadmap"]').tap();
    await page.waitForFunction(() => /^#\/~hub\/project\/probe(\/roadmap)?$/.test(location.hash));
    await go(page, '#/~hub/project/probe/library');
    const select = page.locator('.pp').getByRole('combobox', { name: 'Project' });
    await expect.poll(() => select.locator('option:not([hidden])').count()).toBeGreaterThan(1);
    const other = (await select.locator('option:not([hidden])').evaluateAll(list => list.map(node => node.value))).find(value => value !== 'probe');
    await select.selectOption(other);
    await page.waitForFunction(id => location.hash === `#/~hub/project/${id}/library`, other);
    await page.context().close();
  }

  step('Counts: the row and the menu carry them, More shows the sum, and plain More until Today answers');
  {
    const page = await open({ width: 390, height: 844 }, PHONE);
    await ready(page, 'roadmap');
    await expect(page.locator('[data-project-tab="needs"]')).toHaveText(/Needs you \(4\)/);
    await go(page, '#/~hub/project/probe/library');
    await page.locator('[data-project-tab="library"].on').waitFor();
    await more(page).tap();
    await expect(items(page).filter({ hasText: 'Needs you (4)' })).toHaveCount(1);
    const numbers = (await items(page).allInnerTexts()).flatMap(text => [...text.matchAll(/\((\d+)\)/g)].map(match => Number(match[1])));
    const sum = numbers.reduce((total, value) => total + value, 0);
    await page.keyboard.press('Escape');
    assert.match(await more(page).innerText(), new RegExp(`More \\(${sum}\\)`), 'More shows the sum.');
    await page.context().close();

    const held = await open({ width: 390, height: 844 }, PHONE);
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    await held.route('**/api/hub/today*', async route => { await gate; await route.continue(); });
    await held.goto(`${fixture.url}#/~hub/project/probe/library`);
    await more(held).waitFor();
    assert.equal((await more(held).innerText()).replace(/\s+/g, ' ').trim(), 'More ▾', 'Plain More before Today answers.');
    release();
    await expect(more(held)).toContainText(/More \(\d+\)/);
    await held.context().close();
  }

  step('The menu: roles, aria-expanded, 44 px items, inside the screen, not under the bottom bar');
  for (const width of [390, 320]) {
    const page = await open({ width, height: 844 }, PHONE);
    await ready(page, 'library');
    const button = more(page);
    assert.equal(await button.getAttribute('aria-haspopup'), 'menu');
    assert.equal(await button.getAttribute('aria-expanded'), 'false');
    assert.match(await button.getAttribute('aria-label'), /^More project tabs: /, 'The label starts with More.');
    assert.equal(await page.locator('[role="tablist"] button').count(), 0, 'More is outside the tablist.');
    await button.tap();
    await expect(button).toHaveAttribute('aria-expanded', 'true');
    assert.equal(await page.locator('.item-menu').getAttribute('role'), 'menu');
    const heights = await items(page).evaluateAll(list => list.map(node => node.getBoundingClientRect().height));
    assert.ok(heights.length === 2 && heights.every(height => height >= 44), `${width}: items are 44 px or more (${heights}).`);
    const sheet = await page.locator('.item-menu').boundingBox();
    assert.ok(sheet.x >= 0 && sheet.x + sheet.width <= width && sheet.y >= 0 && sheet.y + sheet.height <= 844, `${width}: the sheet is inside the viewport (${JSON.stringify(sheet)}).`);
    const last = await items(page).last().boundingBox();
    assert.equal(await page.evaluate(({ x, y }) => !!document.elementFromPoint(x, y)?.closest('.item-menu'), { x: last.x + last.width / 2, y: last.y + last.height / 2 }), true, `${width}: the last item is on top.`);
    await page.context().close();
  }

  step('A tap outside closes the menu and does not fall through to the tab underneath');
  {
    const page = await open({ width: 390, height: 844 }, PHONE);
    await ready(page, 'library');
    const spot = await page.locator('[data-project-tab="roadmap"]').boundingBox();
    const at = { x: spot.x + spot.width / 2, y: spot.y + spot.height / 2 };
    await more(page).tap();
    await items(page).first().waitFor();
    // The scrim covers the page, so the Roadmap tab's point is the scrim now.
    assert.equal(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.className, at), 'item-menu-scrim');
    await page.touchscreen.tap(at.x, at.y);
    await items(page).first().waitFor({ state: 'detached' });
    await page.waitForTimeout(300);
    assert.equal(await hash(page), '#/~hub/project/probe/library', 'The tap did not reach the Roadmap tab.');
    await page.context().close();
  }

  step('Keyboard: Enter opens with the first item focused, arrows move, Escape returns to More, Enter on an item picks and keeps focus on More');
  {
    const page = await open({ width: 390, height: 844 }, PHONE);
    await ready(page, 'library');
    await more(page).focus();
    await page.keyboard.press('Enter');
    await expect(items(page).first()).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(items(page).nth(1)).toBeFocused();
    await page.keyboard.press('Escape');
    await items(page).first().waitFor({ state: 'detached' });
    await expect(more(page)).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(items(page).first()).toBeFocused();
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => location.hash !== '#/~hub/project/probe/library');
    await expect(more(page)).toBeFocused();
    await page.context().close();
  }

  step('At 320 px, 26 px text and long or unbroken labels do not overflow');
  {
    const page = await open({ width: 320, height: 844 }, PHONE);
    await ready(page, 'roadmap');
    await page.addStyleTag({ content: '.pp-tabs-row .wk-tab, .pp-more { font-size: 26px !important; }' });
    await none(page, 'big text');
    const edges = await page.locator('.pp-tabs-row .wk-tab, .pp-more').evaluateAll(list => list.map(node => Math.round(node.getBoundingClientRect().right)));
    assert.ok(edges.every(edge => edge <= 320), `Every control ends inside the screen (${edges}).`);
    for (const text of [['Fahrplan Übersichtsseite', 'Feuille de route détaillée'], ['A'.repeat(40), 'B'.repeat(40)]]) {
      await page.evaluate(([first, second]) => { const tabs = document.querySelectorAll('.pp-tabs [data-project-tab]'); tabs[0].textContent = first; tabs[1].textContent = second; }, text);
      await none(page, `labels ${text[0].slice(0, 12)}`);
    }
    await page.context().close();
  }

  step('Boundaries: 640 px has More; 641 and 1280 px have the four tabs, no More and no wrapper');
  for (const [width, phone] of [[640, true], [641, false], [1280, false]]) {
    const page = await open({ width, height: 800 });
    await page.goto(`${fixture.url}#/~hub/project/probe/running`);
    await page.locator('[data-project-tab="running"]').waitFor();
    assert.equal(await page.locator('.pp-more').count(), phone ? 1 : 0, `${width}: More ${phone ? 'is' : 'is not'} there.`);
    if (!phone) {
      assert.equal(await page.locator('[data-pp-tabs-row]').count(), 0, `${width}: no wrapper.`);
      assert.deepEqual(await rowTabs(page), TABS, `${width}: the four tabs in order.`);
      assert.equal(await page.locator('.pp-tabs > [data-project-tab]').count(), 4, `${width}: direct children of the tablist.`);
    }
    await page.context().close();
  }

  step('Rotating with the menu open: four tabs in landscape, More back in portrait, the same tab current');
  {
    const page = await open({ width: 390, height: 844 }, PHONE);
    await ready(page, 'library');
    await more(page).tap();
    await items(page).first().waitFor();
    await page.setViewportSize({ width: 844, height: 390 });
    await expect(page.locator('.pp-more')).toHaveCount(0);
    await expect(page.locator('.pp-tabs [data-project-tab]')).toHaveCount(4);
    await expect(page.locator('[data-project-tab="library"]')).toHaveClass(/\bon\b/);
    await page.setViewportSize({ width: 390, height: 844 });
    await more(page).waitFor();
    await expect(page.locator('[data-project-tab="library"]')).toHaveClass(/\bon\b/);
    await page.context().close();
  }

  step('Both themes at 390 px: More, the menu items and the sheet change colour');
  {
    const seen = {};
    for (const theme of ['dark', 'light']) {
      const page = await open({ width: 390, height: 844 }, PHONE);
      await ready(page, 'roadmap');
      // The fixture is a service host and keeps the theme in its settings: set the attribute the theme CSS keys on.
      await page.evaluate(value => { document.documentElement.dataset.workspaceTheme = value; }, theme);
      await more(page).tap();
      await items(page).first().waitFor();
      seen[theme] = await page.evaluate(() => ({
        more: getComputedStyle(document.querySelector('.pp-more')).color,
        item: getComputedStyle(document.querySelector('.item-menu button')).color,
        sheet: getComputedStyle(document.querySelector('.item-menu')).backgroundColor,
      }));
      await page.context().close();
    }
    for (const key of ['more', 'item', 'sheet']) assert.notEqual(seen.dark[key], seen.light[key], `${key} differs between themes.`);
  }
  console.log('hub-project-tabs-phone-ui: passed');
} finally {
  for (const context of contexts) await context.close().catch(() => {});
  await browser.close();
  await fixture?.close?.().catch(() => {});
}
