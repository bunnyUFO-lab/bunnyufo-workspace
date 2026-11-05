// Run after npm run build. The project pickers that became Comboboxes, through a real browser: the Roadmap, Work, Activity and
// Sketch project pickers over a list longer than ten projects, at desktop and phone width. Each one filters as you type, Enter
// or a tap picks, Escape puts the chosen project back, nothing scrolls sideways, and an open list closes when the field scrolls
// away. With ten projects or fewer the pickers are chips at desktop width and one native select at 640 px or less
// (ws-ubo.2.1; hub-phone-picker-ui.mjs covers that in depth). The Library's pickers (Move to workspace, Merge into) are in library-manage-ui.mjs.
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

const TREES = ['alder', 'birch', 'cedar', 'dogwood', 'elm', 'fir', 'gum', 'hazel', 'ironwood', 'juniper', 'larch', 'maple'];
const DRAFT = '20261030-1200-pickers';

const open = async (viewport, options = {}) => {
  const context = await browser.newContext({ viewport, serviceWorkers: 'block', reducedMotion: 'reduce', ...options });
  contexts.push(context);
  const page = await context.newPage();
  page.setDefaultTimeout(ms(15000));
  page.on('pageerror', error => { throw error; });
  return page;
};
const noSideways = async (page, what) => {
  const widths = await page.evaluate(() => ({ scroll: document.scrollingElement.scrollWidth, inner: innerWidth }));
  assert.ok(widths.scroll <= widths.inner, `${what}: the page scrolls sideways (${widths.scroll} > ${widths.inner}).`);
};

/** Where each picker lives: its address, the section that holds it, and how to tell `maple` was chosen. */
const PICKERS = [
  { name: 'Roadmap', hash: '#/~hub/map', scope: '.hub-map-chips', after: page => page.waitForFunction(() => location.hash.startsWith('#/~hub/map/maple')) },
  { name: 'Work', hash: '#/~hub/work', scope: '.work', after: page => page.waitForFunction(() => location.hash === '#/~hub/work/maple') },
  { name: 'Activity', hash: '#/~hub/activity', scope: '.hub-top', after: page => page.waitForFunction(() => document.querySelector('.hub-top [role="combobox"]').dataset.value === 'maple') },
  // Today does not change the address: the picker says which project it shows.
  { name: 'Today', hash: '#/~hub/today', scope: '[data-today-project]', after: page => page.waitForFunction(() => document.querySelector('[data-today-project] [role="combobox"]').dataset.value === 'maple') },
  { name: 'Sketch', hash: `#/~hub/sketch/${DRAFT}`, scope: '[aria-label="Send to agent"]', after: page => page.waitForFunction(() => document.querySelector('[aria-label="Send to agent"] [role="combobox"]').dataset.value === 'maple') },
];

try {
  fixture = await startHubFixture({ work: true });
  for (const tree of TREES) {
    fixture.seed.beads(tree, [beadsIssue({ id: `${tree.slice(0, 2)}-1`, title: `${tree} task`, created: '2026-10-01T10:00:00Z' })], { pushedAt: minutesAgo(fixture.now, 5).toISOString(), host: 'pc.example.test', count: 1, repo: `example/${tree}` });
  }
  fixture.fake.seed(`inbox/drawings/${DRAFT}/drawing.excalidraw`, JSON.stringify({ type: 'excalidraw', version: 2, elements: [], appState: {} }), 'application/json');
  await new Promise(resolve => setTimeout(resolve, 100));

  for (const [label, viewport, touch] of [['1280', { width: 1280, height: 800 }, false], ['390', { width: 390, height: 844 }, true]]) {
    for (const picker of PICKERS) {
      step(`${picker.name} at ${label}: the project list filters as you type, and a pick changes the project`);
      const page = await open(viewport, touch ? { hasTouch: true, isMobile: true } : {});
      await page.goto(`${fixture.url}${picker.hash}`);
      const field = page.locator(picker.scope).getByRole('combobox', { name: 'Project' });
      await field.waitFor();
      if (touch) await field.tap(); else await field.click();
      const options = page.locator(`${picker.scope} [role="option"]`);
      await options.first().waitFor();
      // The list opens before /projects has answered on a slow run: wait for the projects, not for the first row.
      await expect.poll(() => options.count(), { message: `${picker.name}: the list passes ten projects` }).toBeGreaterThan(10);
      await field.fill('MAP');
      assert.deepEqual(await options.evaluateAll(list => list.map(item => item.dataset.value)), ['maple'], `${picker.name}: typing filters.`);
      const box = await page.locator(`${picker.scope} [role="listbox"]`).boundingBox();
      assert.ok(box.x >= 0 && box.x + box.width <= viewport.width, `${picker.name}: the list fits the screen (${JSON.stringify(box)}).`);
      if (touch) await options.first().tap(); else await page.keyboard.press('Enter');
      await picker.after(page);
      // The screen may redraw for the new project: wait until the picker shows it before using it again.
      await expect(field).toHaveValue('Maple');
      await expect(field).toHaveAttribute('data-value', 'maple');
      assert.equal(await field.getAttribute('aria-expanded'), 'false', `${picker.name}: picking closes the list.`);
      await noSideways(page, `${picker.name} at ${label}`);
      await field.fill('zzz');
      assert.equal(await page.locator(`${picker.scope} .cb-none`).innerText(), 'No match');
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');
      const state = await page.evaluate(() => ({ active: document.activeElement?.outerHTML.slice(0, 80), hash: location.hash, value: document.querySelector('[role="combobox"][aria-label="Project"]')?.value }));
      assert.equal(await field.inputValue(), 'Maple', `${picker.name}: Escape puts the chosen project back. ${JSON.stringify(state)}`);
      await page.context().close();
    }
  }

  step('The chevron opens the roadmap list without the keyboard: the input is not focused');
  {
    const page = await open({ width: 390, height: 844 }, { hasTouch: true, isMobile: true });
    await page.goto(`${fixture.url}#/~hub/map`);
    await page.getByRole('combobox', { name: 'Project' }).waitFor();
    await page.getByRole('button', { name: 'Show projects' }).tap();
    await page.locator('.hub-map-chips [role="listbox"]').waitFor();
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('role') === 'combobox'), false);
    await page.context().close();
  }

  step('An open list closes when its field scrolls out of the page');
  {
    const page = await open({ width: 390, height: 600 }, { hasTouch: true, isMobile: true });
    await page.goto(`${fixture.url}#/~hub/work`);
    const field = page.locator('.work').getByRole('combobox', { name: 'Project' });
    await field.waitFor();
    await page.locator('.wk-lane:visible .wk-card').first().waitFor();
    await field.tap();
    await page.locator('.work [role="listbox"]').waitFor();
    await page.evaluate(() => {
      const spacer = document.createElement('div');
      spacer.style.height = '4000px';
      document.querySelector('.work').append(spacer);
      for (const node of [document.scrollingElement, ...document.querySelectorAll('*')]) {
        if (node === document.scrollingElement || (node.scrollHeight > node.clientHeight + 20 && getComputedStyle(node).overflowY !== 'visible')) node.scrollTop += 3000;
      }
    });
    const bottom = await field.evaluate(node => node.getBoundingClientRect().bottom);
    assert.ok(bottom < 0, `the test scrolled the field away (${bottom}).`);
    await page.locator('.work [role="listbox"]').waitFor({ state: 'detached' });
    await page.context().close();
  }
  // Ten or fewer projects: the same pickers stay chips (one tap each) at desktop width and are one native select at phone width.
  // Activity's filter was a dropdown already: its list at desktop width, the select at phone width.
  const small = await startHubFixture({ work: true });
  try {
    small.fake.seed(`inbox/drawings/${DRAFT}/drawing.excalidraw`, JSON.stringify({ type: 'excalidraw', version: 2, elements: [], appState: {} }), 'application/json');
    await new Promise(resolve => setTimeout(resolve, 100));
    for (const [label, viewport, touch] of [['1280', { width: 1280, height: 800 }, false], ['390', { width: 390, height: 844 }, true]]) {
      for (const picker of PICKERS.filter(item => item.name !== 'Activity')) {
        step(`${picker.name} at ${label} with ten projects or fewer: ${touch ? 'one native select' : 'chips, not a list'}`);
        const page = await open(viewport, touch ? { hasTouch: true, isMobile: true } : {});
        await page.goto(`${small.url}${picker.hash}`);
        if (touch) {
          // Phone width: one native select, picked with selectOption.
          const select = page.locator(picker.scope).getByRole('combobox', { name: 'Project' });
          await select.waitFor();
          assert.equal(await select.evaluate(node => node.tagName), 'SELECT', `${picker.name}: a native select at phone width.`);
          assert.equal(await page.locator(`${picker.scope} [aria-label="Project"].hub-chips`).count(), 0, `${picker.name}: no chips at phone width.`);
          const values = () => select.locator('option:not([hidden])').evaluateAll(list => list.map(item => item.value));
          await expect.poll(async () => (await values()).length, { message: `${picker.name}: the projects arrive` }).toBeGreaterThan(1);
          const chosen = await select.inputValue();
          const target = (await values()).find(value => value !== chosen && value !== 'all');
          await select.selectOption(target);
          await expect(select).toHaveValue(target);
          await expect(select).toHaveAttribute('data-value', target);
          await noSideways(page, `${picker.name} select at ${label}`);
          await page.context().close();
          continue;
        }
        const row = page.locator(`${picker.scope} [aria-label="Project"].hub-chips`);
        await row.waitFor();
        assert.equal(await page.locator(`${picker.scope} [role="combobox"][aria-label="Project"]`).count(), 0, `${picker.name}: no dropdown.`);
        const chips = row.locator('.hub-chip');
        await chips.nth(1).waitFor();
        // The row may be redrawn once while the project list settles (seen on CI at Work, 390); the count must be 2 to 11 once it has.
        await page.waitForFunction(selector => { const n = document.querySelectorAll(selector).length; return n >= 2 && n <= 11; }, `${picker.scope} [aria-label="Project"].hub-chips .hub-chip`, { timeout: ms(5000) }).catch(() => {});
        assert.ok(await chips.count() >= 2 && await chips.count() <= 11, `${picker.name}: chips (${await chips.count()}).`);
        assert.equal(await row.locator('.hub-chip.on').count(), 1);
        const other = chips.locator('xpath=self::*[not(contains(@class,"on")) and not(normalize-space()="All")]').first();
        const name = (await other.innerText()).trim();
        if (touch) await other.tap(); else await other.click();
        await row.locator('.hub-chip.on', { hasText: name }).waitFor();
        await noSideways(page, `${picker.name} chips at ${label}`);
        await page.context().close();
      }
      step(`Activity at ${label} with ten projects or fewer: a ${touch ? 'native select' : 'list'}`);
      const page = await open(viewport, touch ? { hasTouch: true, isMobile: true } : {});
      await page.goto(`${small.url}#/~hub/activity`);
      const filter = page.locator('.hub-top').getByRole('combobox', { name: 'Project' });
      await filter.waitFor();
      assert.equal(await filter.evaluate(node => node.tagName), touch ? 'SELECT' : 'INPUT', 'Activity: select at phone width, typeable list above it.');
      await page.context().close();
    }
  } finally { await small.close().catch(() => {}); }
  // Today's project filter (ws-im1.1.4): the panels, tiles and sentence narrow; the sidebar badge, Work and the Roadmap do not.
  const todaySmall = await startHubFixture({ work: true });
  try {
    // Four items wait in `probe`; one more, a blocked session, waits in `lanes`.
    todaySmall.seed.event(eventJson({ kind: 'blocked', ts: minutesAgo(todaySmall.now, 10), session: 'sess-lanes', project: 'lanes', title: 'Permission needed: run lanes' }));
    await new Promise(resolve => setTimeout(resolve, 100));
    for (const [label, viewport, touch] of [['1280', { width: 1280, height: 800 }, false], ['390', { width: 390, height: 844 }, true]]) {
      step(`Today at ${label}: a project narrows the screen, says what waits elsewhere, and is remembered`);
      const page = await open(viewport, touch ? { hasTouch: true, isMobile: true } : {});
      const press = locator => (touch ? locator.tap() : locator.click());
      await page.goto(`${todaySmall.url}#/~hub/today`);
      // At 1280 the project is a chip row; at 390 one native select (ws-ubo.2.1).
      const row = page.locator(touch ? '[data-today-project] select' : '[data-today-project] [aria-label="Project"].hub-chips');
      await row.waitFor();
      const shows = (id, name) => (touch ? expect(row).toHaveValue(id) : row.locator('.hub-chip.on', { hasText: name }).waitFor());
      const kpi = key => page.locator(`.hub-kpi[data-kpi="${key}"] .hub-kpi-v`);
      const stored = () => page.evaluate(() => { try { return localStorage.getItem('hub-today-project'); } catch { return 'blocked'; } });
      await expect(kpi('needs-you')).toHaveText('5');
      assert.equal(await stored(), null, 'At All nothing is stored.');
      assert.equal(await page.locator('[data-today-elsewhere]').count(), 0, 'At All there is no "elsewhere" line.');
      const badge = page.locator('[data-hub-badge]');
      const all = await badge.count() ? (await badge.innerText()).trim() : null;
      const lanes = row.locator('.hub-chip', { hasText: 'Lanes' });
      if (touch) await row.selectOption('lanes'); else { await lanes.waitFor(); await press(lanes); }
      await shows('lanes', 'Lanes');
      const waiting = 1;
      if (touch) assert.equal((await row.locator('option[value="lanes"]').textContent()).trim(), 'Lanes (1)', 'The option says where the waiting item is.');
      else assert.equal((await lanes.locator('.n').innerText()).trim(), '1', 'The chip says where the waiting item is.');
      await expect(kpi('needs-you')).toHaveText(String(waiting));
      await expect(page.locator('.today-head p').first()).toContainText('1 thing waits on you.');
      assert.equal(await page.locator('[data-nrow]').count(), Math.min(waiting, 3), 'Needs you lists only that project.');
      assert.equal(await stored(), 'lanes');
      assert.equal(await page.evaluate(() => localStorage.getItem('buw.hub.project')), null, 'Today does not write the project Work and the Roadmap share.');
      const elsewhere = page.locator('[data-today-elsewhere]');
      await expect(elsewhere).toContainText('4 more wait in other projects');
      if (all !== null) assert.equal((await badge.innerText()).trim(), all, 'The sidebar badge keeps the true count.');
      await noSideways(page, `Today on a project at ${label}`);
      if (touch) {
        const small = await page.locator('[data-today-project] select, [data-today-project] button, [data-today-project] a').evaluateAll(list => list.map(node => node.getBoundingClientRect()).filter(box => box.width > 0 && box.height < 44).length);
        assert.equal(small, 0, 'Targets are at least 44 px high.');
      }

      // "Open Needs you" lands on that project's list, with the same count.
      await press(page.locator('[data-today-open]'));
      await page.waitForFunction(() => location.hash === '#/~hub/needs/all/lanes');
      await page.waitForFunction(count => document.querySelectorAll('.ni').length === count, waiting);
      await page.goBack();
      await expect(kpi('needs-you')).toHaveText(String(waiting));

      // A reload keeps the choice; the Roadmap and Work keep their own.
      await page.reload();
      await shows('lanes', 'Lanes');
      await expect(kpi('needs-you')).toHaveText(String(waiting));

      // Show all goes back to All and clears the key.
      await press(page.locator('[data-today-elsewhere] button'));
      await shows('all', 'All');
      await expect(kpi('needs-you')).toHaveText('5');
      assert.equal(await stored(), null);

      // A saved project that is gone counts as All, and the key is cleared.
      await page.evaluate(() => localStorage.setItem('hub-today-project', 'vanished'));
      await page.reload();
      await shows('all', 'All');
      await expect(kpi('needs-you')).toHaveText('5');
      await page.waitForFunction(() => localStorage.getItem('hub-today-project') === null);

      // /projects fails: a remembered project is ignored for this view (no picker could undo it) and kept for the next one.
      await page.evaluate(() => localStorage.setItem('hub-today-project', 'lanes'));
      await page.route('**/api/hub/projects', route => route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"down"}' }));
      await page.reload();
      await expect(kpi('needs-you')).toHaveText('5');
      assert.equal(await page.locator('[data-today-elsewhere]').count(), 0, 'No "elsewhere" line while /projects fails.');
      assert.equal(await stored(), 'lanes', 'The remembered project is not erased.');
      await page.unroute('**/api/hub/projects');
      await page.context().close();
    }
  } finally { await todaySmall.close().catch(() => {}); }
  console.log('hub-project-pickers-ui: passed');
} finally {
  for (const context of contexts) await context.close().catch(() => {});
  await browser.close();
  await fixture?.close?.().catch(() => {});
}
