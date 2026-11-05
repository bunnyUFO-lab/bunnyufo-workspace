// Run after npm run build. Today's project picker with more than ten projects (ws-2vh.27): on a phone it is one native select, the same
// as Work's, never a text field; on desktop its typeable list opens in place, on top of the tiles.
// Phone (390 and 320 px): Today's picker is a SELECT holding All and every project with its count; .today-project holds no input; a tap
// leaves no INPUT or TEXTAREA focused (no keyboard); a pick narrows Today and All brings it back; Work shows a select too.
// Desktop (1280 px, motion ON: other tests set reducedMotion, which hid the bug): the open list sits right under the field and the
// element at its centre is inside the list, not a tile. It fails when `.today .rise` fills `both` again, which keeps a transform on
// .today-project and moves the fixed list.
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
const PHONE = { hasTouch: true, isMobile: true };

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

try {
  fixture = await startHubFixture({ work: true });
  // Twelve projects with a Beads copy, and one waiting item in each, so every option carries a count.
  for (const tree of TREES) {
    fixture.seed.beads(tree, [beadsIssue({ id: `${tree.slice(0, 2)}-1`, title: `${tree} task`, created: '2026-10-01T10:00:00Z' })], { pushedAt: minutesAgo(fixture.now, 5).toISOString(), host: 'pc.example.test', count: 1, repo: `example/${tree}` });
    fixture.seed.event(eventJson({ kind: 'blocked', ts: minutesAgo(fixture.now, 10), session: `sess-${tree}`, project: tree, title: `Permission needed: run ${tree}` }));
  }
  await new Promise(resolve => setTimeout(resolve, 100));

  for (const width of [390, 320]) {
    const height = width === 390 ? 844 : 568;
    step(`At ${width} px Today's picker is one native select with every project and its count, and no text field`);
    const page = await open({ width, height }, PHONE);
    await page.goto(`${fixture.url}#/~hub/today`);
    const select = page.locator('[data-today-project]').getByRole('combobox', { name: 'Project' });
    await select.waitFor();
    assert.equal(await select.evaluate(node => node.tagName), 'SELECT', 'Today: a native select above ten projects.');
    await expect.poll(() => select.locator('option:not([hidden])').count()).toBeGreaterThan(11);
    const labels = await select.locator('option:not([hidden])').evaluateAll(list => list.map(item => ({ value: item.value, label: item.textContent.trim() })));
    assert.equal(labels[0].value, 'all', 'All comes first.');
    assert.match(labels[0].label, /^All \(\d+\)$/, 'All carries the total.');
    for (const tree of TREES) {
      const option = labels.find(item => item.value === tree);
      assert.ok(option, `${tree} is in the list.`);
      assert.match(option.label, /\(1\)$/, `${tree} carries its count (${option.label}).`);
    }
    assert.equal(await page.locator('[data-today-project] input, [data-today-project] textarea').count(), 0, 'No text field inside .today-project.');

    await select.tap();
    const active = await page.evaluate(() => document.activeElement?.tagName);
    assert.ok(active !== 'INPUT' && active !== 'TEXTAREA', `A tap on the picker focuses no text field (${active}).`);

    const kpi = page.locator('.hub-kpi[data-kpi="needs-you"] .hub-kpi-v');
    const total = labels[0].label.match(/\((\d+)\)/)[1];
    await expect(kpi).toHaveText(total);
    await select.selectOption('maple');
    await expect(select).toHaveAttribute('data-value', 'maple');
    await expect(kpi).toHaveText('1');
    await select.selectOption('all');
    await expect(select).toHaveAttribute('data-value', 'all');
    await expect(kpi).toHaveText(total);
    await noSideways(page, `Today at ${width}`);

    step(`At ${width} px Work shows a select too, with the same fixture`);
    await page.evaluate(() => { location.hash = '#/~hub/work'; });
    const work = page.locator('.work').getByRole('combobox', { name: 'Project' });
    await work.waitFor();
    assert.equal(await work.evaluate(node => node.tagName), 'SELECT', 'Work: a native select.');
    await noSideways(page, `Work at ${width}`);
    await page.context().close();
  }

  step('At 1280 px with motion on, Today\'s open list sits under the field and over the tiles');
  {
    const page = await open({ width: 1280, height: 800 }, { reducedMotion: 'no-preference' });
    await page.goto(`${fixture.url}#/~hub/today`);
    const field = page.locator('[data-today-project]').getByRole('combobox', { name: 'Project' });
    await field.waitFor();
    assert.equal(await field.evaluate(node => node.tagName), 'INPUT', 'Desktop keeps the typeable list.');
    // Let the rise animations finish: only a fill mode that keeps them applied leaves the transform behind.
    await page.waitForFunction(() => document.getAnimations().every(item => item.playState === 'finished' || item.effect?.getTiming().fill === 'none' || item.effect?.getTiming().fill === 'backwards'), null, { timeout: ms(5000) }).catch(() => {});
    await page.waitForTimeout(ms(800));
    await field.click();
    const list = page.locator('[data-today-project] [role="listbox"]');
    await list.waitFor();
    await expect.poll(() => list.locator('[role="option"]').count()).toBeGreaterThan(10);
    const where = await page.evaluate(() => {
      const input = document.querySelector('[data-today-project] [role="combobox"]').getBoundingClientRect();
      const box = document.querySelector('[data-today-project] [role="listbox"]').getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + Math.min(box.height / 2, 100));
      return { gap: box.top - input.bottom, insideList: !!hit?.closest('[role="listbox"]'), hit: hit ? `${hit.tagName}.${hit.className}` : null };
    });
    assert.ok(where.gap >= 0 && where.gap <= 12, `The list sits right under the field (${where.gap} px below it).`);
    assert.equal(where.insideList, true, `The centre of the list is in the list, not under a tile (${where.hit}).`);
    await page.context().close();
  }
  console.log('hub-today-picker-phone-ui: passed');
} finally {
  for (const context of contexts) await context.close().catch(() => {});
  await browser.close();
  await fixture?.close?.().catch(() => {});
}
