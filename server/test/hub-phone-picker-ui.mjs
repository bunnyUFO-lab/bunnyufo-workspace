// Run after npm run build. The Hub's project picker on a phone (ws-ubo.2.1): with ten projects or fewer, 640 px or less is one native
// select on every screen that has the picker; 641 px and up keeps the chips; more than ten projects keeps the typeable list above 640 px
// only: a phone gets the select however many projects there are (ws-2vh.27).
// Checks: the field is 44 px high and inside the screen, nothing scrolls sideways (the page, .content and .hub), a pick changes the
// screen, the choice is kept across Work, the Roadmap and Project (Today keeps its own), "All" is reachable, an unknown project reads
// "Choose a project", Back restores the old project, rotation swaps the control with the choice intact, and both themes read.
// The real iOS and Android lists and the zoom behaviour cannot be checked here: they wait for the owner's play test.
import { chromium, expect } from '@playwright/test';
import { ms, SCALE } from './ui-timeouts.mjs';
expect.configure({ timeout: 5000 * SCALE });
import assert from 'node:assert/strict';
import { startHubFixture } from './hub-fixture.mjs';
import { beadsIssue, eventJson, minutesAgo } from '../../site/api/test/hub-fixtures.mjs';

const step = name => console.log(`- ${name}`);
const channel = process.env.BUW_TEST_BROWSER || 'msedge';
const browser = await chromium.launch({ headless: true, channel });
const contexts = [];
let fixture;
let many;

const TREES = ['alder', 'birch', 'cedar', 'dogwood', 'elm', 'fir', 'gum', 'hazel', 'ironwood', 'juniper', 'larch', 'maple'];
const DRAFT = '20261030-1200-phonepick';
const PHONE = { hasTouch: true, isMobile: true };

const open = async (viewport, options = {}) => {
  const context = await browser.newContext({ viewport, serviceWorkers: 'block', reducedMotion: 'reduce', ...options });
  contexts.push(context);
  const page = await context.newPage();
  page.setDefaultTimeout(ms(15000));
  page.on('pageerror', error => { throw error; });
  return page;
};
/** The page, the app's scroller (.content) and .hub: each one that is wider than it is shown. */
const sideways = page => page.evaluate(() => [document.scrollingElement, document.querySelector('.content'), document.querySelector('.hub')].filter(Boolean).filter(el => el.scrollWidth > el.clientWidth).map(el => `${el.tagName}.${el.className}: ${el.scrollWidth} > ${el.clientWidth}`));
const none = async (page, what) => assert.deepEqual(await sideways(page), [], `${what}: the page scrolls sideways.`);
const stored = (page, key) => page.evaluate(k => localStorage.getItem(k), key);
const go = (page, hash) => page.evaluate(next => { location.hash = next; }, hash);

const SCREENS = [
  { name: 'Today', hash: '#/~hub/today', scope: '[data-today-project]' },
  { name: 'Work', hash: '#/~hub/work', scope: '.work' },
  { name: 'Roadmap', hash: '#/~hub/map', scope: '.hub-map-chips' },
  { name: 'Project', hash: '#/~hub/project/magic-loops', scope: '.pp' },
  { name: 'Sketch', hash: `#/~hub/sketch/${DRAFT}`, scope: '[aria-label="Send to agent"]' },
  { name: 'Needs', hash: '#/~hub/needs', scope: '[data-needs-project]' },
  { name: 'Activity', hash: '#/~hub/activity', scope: '.hub-top' },
];
const field = (page, scope) => page.locator(scope).getByRole('combobox', { name: 'Project' });
/** The select on a screen once the project list has arrived. */
const ready = async (page, scope) => {
  const select = field(page, scope);
  await select.waitFor();
  await expect.poll(() => select.locator('option:not([hidden])').count()).toBeGreaterThan(1);
  return select;
};
const shown = select => select.evaluate(node => node.selectedOptions[0]?.textContent);

try {
  fixture = await startHubFixture({ work: true });
  // Four items wait in `probe`; one more, a blocked session, waits in `lanes`.
  fixture.seed.event(eventJson({ kind: 'blocked', ts: minutesAgo(fixture.now, 10), session: 'sess-lanes', project: 'lanes', title: 'Permission needed: run lanes' }));
  fixture.fake.seed(`inbox/drawings/${DRAFT}/drawing.excalidraw`, JSON.stringify({ type: 'excalidraw', version: 2, elements: [], appState: {} }), 'application/json');
  await new Promise(resolve => setTimeout(resolve, 100));

  for (const width of [390, 320]) {
    step(`At ${width} px every screen with the picker shows one select, 44 px high, with nothing sideways`);
    const page = await open({ width, height: 844 }, PHONE);
    for (const screen of SCREENS) {
      await page.goto(`${fixture.url}${screen.hash}`);
      const select = await ready(page, screen.scope);
      assert.equal(await select.evaluate(node => node.tagName), 'SELECT', `${screen.name}: a native select.`);
      assert.equal(await page.locator(`${screen.scope} input[role="combobox"][aria-label="Project"], ${screen.scope} [aria-label="Project"].hub-chips`).count(), 0, `${screen.name}: no list and no chips.`);
      const box = await select.boundingBox();
      assert.ok(box.height >= 44, `${screen.name}: the field is at least 44 px high (${box.height}).`);
      assert.ok(box.x >= 0 && box.x + box.width <= width, `${screen.name}: the field is inside the screen (${JSON.stringify(box)}).`);
      // `.hub select` must not win: full width, 16 px type (no iOS zoom).
      const style = await select.evaluate(node => { const css = getComputedStyle(node); return { font: css.fontSize, minHeight: css.minHeight }; });
      assert.deepEqual(style, { font: '16px', minHeight: '44px' }, `${screen.name}: the picker's own style wins over .hub select.`);
      await none(page, `${screen.name} at ${width}`);
    }
    if (width === 390) {
      // The check can fail: a wide child inside .hub is seen.
      await page.goto(`${fixture.url}#/~hub/work`);
      await ready(page, '.work');
      await page.evaluate(() => { const wide = document.createElement('div'); wide.id = 'wide'; wide.style.cssText = 'width:1000px;height:1px'; document.querySelector('.hub').append(wide); });
      assert.notDeepEqual(await sideways(page), [], 'The sideways check sees a 1000 px child.');
      await page.evaluate(() => document.getElementById('wide').remove());
      await none(page, 'Work after the probe');
    }
    await page.context().close();
  }

  step('A pick changes the screen: Work, the Roadmap and Project change the address, Today its project');
  {
    const page = await open({ width: 390, height: 844 }, PHONE);
    await page.goto(`${fixture.url}#/~hub/work`);
    let select = await ready(page, '.work');
    await select.selectOption('lanes');
    await page.waitForFunction(() => location.hash === '#/~hub/work/lanes');
    await none(page, 'Work after a pick');

    await go(page, '#/~hub/map');
    select = await ready(page, '.hub-map-chips');
    const values = await select.locator('option:not([hidden])').evaluateAll(list => list.map(item => item.value));
    const current = await select.inputValue();
    const other = values.find(value => value !== current);
    await select.selectOption(other);
    await page.waitForFunction(id => location.hash.startsWith(`#/~hub/map/${id}`), other);
    await none(page, 'Roadmap after a pick');

    await go(page, '#/~hub/project/magic-loops');
    select = await ready(page, '.pp');
    await select.selectOption('lanes');
    await page.waitForFunction(() => location.hash === '#/~hub/project/lanes');
    await go(page, '#/~hub/project/magic-loops/library');
    select = await ready(page, '.pp');
    await select.selectOption('lanes');
    await page.waitForFunction(() => location.hash === '#/~hub/project/lanes/library');
    await none(page, 'Project after a pick');

    await go(page, '#/~hub/today');
    select = await ready(page, '[data-today-project]');
    const kpi = page.locator('.hub-kpi[data-kpi="needs-you"] .hub-kpi-v');
    await expect(kpi).toHaveText('5');
    await select.selectOption('lanes');
    await expect(page.locator('[data-today-project] select')).toHaveAttribute('data-value', 'lanes');
    await expect(kpi).toHaveText('1');
    assert.equal((await select.locator('option[value="lanes"]').textContent()).trim(), 'Lanes (1)', 'Today says how many wait in a project.');
    await none(page, 'Today after a pick');
    await page.context().close();
  }

  step('The choice is kept on Work, the Roadmap and Project, and survives a reload; Today keeps its own');
  {
    const page = await open({ width: 390, height: 844 }, PHONE);
    await page.goto(`${fixture.url}#/~hub/work`);
    await (await ready(page, '.work')).selectOption('lanes');
    await page.waitForFunction(() => location.hash === '#/~hub/work/lanes');
    await go(page, '#/~hub/map');
    await expect(await ready(page, '.hub-map-chips')).toHaveValue('lanes');
    await go(page, '#/~hub/project');
    await expect(await ready(page, '.pp')).toHaveValue('lanes');
    assert.equal(await stored(page, 'buw.hub.project'), 'lanes');
    await page.reload();
    await expect(await ready(page, '.pp')).toHaveValue('lanes');

    await go(page, '#/~hub/today');
    const today = await ready(page, '[data-today-project]');
    await today.selectOption('probe');
    await expect(page.locator('[data-today-project] select')).toHaveAttribute('data-value', 'probe');
    assert.equal(await stored(page, 'hub-today-project'), 'probe');
    assert.equal(await stored(page, 'buw.hub.project'), 'lanes', 'Today does not write the shared key.');
    await page.reload();
    await expect(await ready(page, '[data-today-project]')).toHaveValue('probe');
    await go(page, '#/~hub/work');
    await expect(await ready(page, '.work')).toHaveValue('lanes');
    await go(page, '#/~hub/today');
    await expect(await ready(page, '[data-today-project]')).toHaveValue('probe');
    await page.context().close();
  }

  step('"All" is the first option on Today and Work, and Roadmap and Project have none');
  {
    const page = await open({ width: 390, height: 844 }, PHONE);
    await page.goto(`${fixture.url}#/~hub/today`);
    let select = await ready(page, '[data-today-project]');
    assert.equal(await select.locator('option').first().getAttribute('value'), 'all');
    await select.selectOption('lanes');
    await expect(page.locator('[data-today-project] select')).toHaveAttribute('data-value', 'lanes');
    await select.selectOption('all');
    await expect(page.locator('[data-today-project] select')).toHaveAttribute('data-value', 'all');

    await go(page, '#/~hub/work/lanes');
    select = await ready(page, '.work');
    assert.equal(await select.locator('option').first().getAttribute('value'), 'all');
    await select.selectOption('all');
    await page.waitForFunction(() => location.hash === '#/~hub/work/all');

    for (const [hash, scope] of [['#/~hub/map', '.hub-map-chips'], ['#/~hub/project/magic-loops', '.pp']]) {
      await go(page, hash);
      select = await ready(page, scope);
      assert.equal(await select.locator('option[value="all"]').count(), 0, `${scope}: no All.`);
    }
    await page.context().close();
  }

  step('A project that is not in the list reads "Choose a project", and a pick moves there');
  {
    const page = await open({ width: 390, height: 844 }, PHONE);
    await page.goto(`${fixture.url}#/~hub/project/no-such-thing`);
    await page.locator('[data-project-missing]').waitFor();
    const select = await ready(page, '.pp');
    assert.match(await page.locator('[data-project-missing]').innerText(), /No project called/);
    assert.equal(await shown(select), 'Choose a project');
    await select.selectOption('magic-loops');
    await page.waitForFunction(() => location.hash === '#/~hub/project/magic-loops');
    await expect(select).toHaveValue('magic-loops');
    await page.context().close();
  }

  step('Back after a pick on the Project page returns to the old project');
  {
    const page = await open({ width: 390, height: 844 }, PHONE);
    await page.goto(`${fixture.url}#/~hub/project/magic-loops`);
    const select = await ready(page, '.pp');
    await select.selectOption('lanes');
    await page.waitForFunction(() => location.hash === '#/~hub/project/lanes');
    await page.goBack();
    await page.waitForFunction(() => location.hash === '#/~hub/project/magic-loops');
    await expect(select).toHaveValue('magic-loops');
    await page.context().close();
  }

  step('Boundaries: 640 px is a select; 641 and 1280 px are chips, links on Work');
  for (const [width, native] of [[640, true], [641, false], [1280, false]]) {
    const page = await open({ width, height: 800 });
    await page.goto(`${fixture.url}#/~hub/work`);
    if (native) {
      await ready(page, '.work');
      assert.equal(await page.locator('.work select.hub-project-select').count(), 1, `${width}: a select.`);
    } else {
      await page.locator('.work [aria-label="Project"].hub-chips .hub-chip').nth(1).waitFor();
      assert.equal(await page.locator('select.hub-project-select').count(), 0, `${width}: no select.`);
      assert.equal(await page.locator('.work .hub-chips .hub-chip').evaluateAll(list => list.every(node => node.tagName === 'A')), true, `${width}: Work's chips are links.`);
    }
    await page.context().close();
  }

  step('Rotating swaps the control and keeps the chosen project');
  {
    const page = await open({ width: 390, height: 844 }, PHONE);
    await page.goto(`${fixture.url}#/~hub/work/lanes`);
    const select = await ready(page, '.work');
    await expect(select).toHaveValue('lanes');
    await page.setViewportSize({ width: 844, height: 390 });
    const chips = page.locator('.work [aria-label="Project"].hub-chips');
    await chips.waitFor();
    assert.equal(await page.locator('select.hub-project-select').count(), 0);
    assert.equal(await chips.getAttribute('data-value'), 'lanes');
    assert.equal(await chips.locator('.hub-chip.on').count(), 1);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(await ready(page, '.work')).toHaveValue('lanes');
    await page.context().close();
  }

  step('Both themes: the select reads in dark and in light');
  {
    const seen = {};
    for (const theme of ['dark', 'light']) {
      const page = await open({ width: 390, height: 844 }, PHONE);
      await page.goto(`${fixture.url}#/~hub/work`);
      const select = await ready(page, '.work');
      // The fixture is a service host, which keeps the theme in its settings and not in localStorage: set the attribute the theme CSS keys on.
      await page.evaluate(value => { document.documentElement.dataset.workspaceTheme = value; }, theme);
      seen[theme] = await select.evaluate(node => ({ color: getComputedStyle(node).color, background: getComputedStyle(node).backgroundColor, scheme: getComputedStyle(document.documentElement).colorScheme }));
      assert.equal(seen[theme].scheme, theme, `${theme}: color-scheme follows the theme.`);
      await page.context().close();
    }
    assert.notEqual(seen.dark.color, seen.light.color, 'The text colour differs between themes.');
    assert.notEqual(seen.dark.background, seen.light.background, 'The background differs between themes.');
  }

  // More than ten projects: a phone still gets the native select, 44 px high, holding every project.
  many = await startHubFixture({ work: true });
  for (const tree of TREES) {
    many.seed.beads(tree, [beadsIssue({ id: `${tree.slice(0, 2)}-1`, title: `${tree} task`, created: '2026-10-01T10:00:00Z' })], { pushedAt: minutesAgo(many.now, 5).toISOString(), host: 'pc.example.test', count: 1, repo: `example/${tree}` });
  }
  await new Promise(resolve => setTimeout(resolve, 100));
  step('Above ten projects at 390 px: still one native select, 44 px high, with every project');
  {
    const page = await open({ width: 390, height: 844 }, PHONE);
    await page.goto(`${many.url}#/~hub/map`);
    const select = await ready(page, '.hub-map-chips');
    assert.equal(await select.evaluate(node => node.tagName), 'SELECT', 'A select above ten projects.');
    assert.equal(await page.locator('.hub-map-chips input[role="combobox"]').count(), 0, 'No text field above ten projects.');
    await expect.poll(() => select.locator('option:not([hidden])').count()).toBeGreaterThan(11);
    const box = await select.boundingBox();
    assert.ok(box.height >= 44, `The field is at least 44 px high (${box.height}).`);
    await none(page, 'Roadmap above ten projects');
    await page.context().close();
  }
  console.log('hub-phone-picker-ui: passed');
} finally {
  for (const context of contexts) await context.close().catch(() => {});
  await browser.close();
  await fixture?.close?.().catch(() => {});
  await many?.close?.().catch(() => {});
}
