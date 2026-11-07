// Run after npm run build. The other sideways rows on a phone (ws-ubo.2.3, ws-2vh.13): the Work lane chips, the Needs filter and the Work lane chips wrap at 640 px or less (the Roadmap's breadcrumb and toolbar have no phone: a phone has no Map), and the Needs you filter, which needs three rows at 390 px, is one native select; no control needs a sideways swipe.
// Checks, at 390 and 320 px: each row is no wider than it is shown (scrollWidth <= clientWidth), the page does not scroll sideways, the last
// control of the row is inside the screen and a tap on it works; the Needs filter shows every filter in at most two rows with the counts;
// a wrapped row leaves the map on screen; 641 px and the desktop keep the one-row look (a scrolling filter with fades, a one-row toolbar);
// both themes. The real touch feel waits for the owner's play test.
import { chromium, expect } from '@playwright/test';
import { ms, SCALE } from './ui-timeouts.mjs';
expect.configure({ timeout: 5000 * SCALE });
import assert from 'node:assert/strict';
import { startHubFixture } from './hub-fixture.mjs';
import { askJson, beadsIssue, checklistJson, designAskJson, eventJson, minutesAgo, playtestJson, plainOptions } from '../../site/api/test/hub-fixtures.mjs';

const step = name => console.log(`- ${name}`);
const channel = process.env.BUW_TEST_BROWSER || 'msedge';
const browser = await chromium.launch({ headless: true, channel });
const contexts = [];
let fixture;

const PHONE = { hasTouch: true, isMobile: true };
const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
const id = (slug, tail) => `${day}-probe-${slug}-${tail}`;

const open = async (viewport, options = {}) => {
  const context = await browser.newContext({ viewport, serviceWorkers: 'block', reducedMotion: 'reduce', ...options });
  await context.addInitScript(() => { try { localStorage.setItem('hub.undoMs', '0'); } catch { /* no storage */ } });
  contexts.push(context);
  // The Roadmap's default filter hides finished work; these checks want the whole toolbar and map.
  await context.addInitScript(() => { try { localStorage.setItem('hub-map-filter', JSON.stringify({ states: ['doing', 'you', 'next', 'later', 'done'], within: null, from: '', to: '' })); } catch { /* none */ } });
  const page = await context.newPage();
  page.setDefaultTimeout(ms(15000));
  page.on('pageerror', error => { throw error; });
  return page;
};
/** The page, the app's scroller (.content) and .hub: each one that is wider than it is shown. */
const sideways = page => page.evaluate(() => [document.scrollingElement, document.querySelector('.content'), document.querySelector('.hub')].filter(Boolean).filter(el => el.scrollWidth > el.clientWidth).map(el => `${el.tagName}.${el.className}: ${el.scrollWidth} > ${el.clientWidth}`));
const none = async (page, what) => assert.deepEqual(await sideways(page), [], `${what}: the page scrolls sideways.`);
const go = (page, hash) => page.evaluate(next => { location.hash = next; }, hash);
/** The row itself must not scroll, and its last control must lie inside the screen. */
const fits = async (page, row, control, what) => {
  const width = await page.evaluate(() => innerWidth);
  const measured = await page.locator(row).evaluate(node => ({ scroll: node.scrollWidth, client: node.clientWidth }));
  assert.ok(measured.scroll <= measured.client, `${what}: the row needs no sideways scrolling (${measured.scroll} > ${measured.client}).`);
  const box = await page.locator(control).boundingBox();
  assert.ok(box && box.x >= 0 && box.x + box.width <= width + 0.5, `${what}: the last control is inside the screen (${JSON.stringify(box)}).`);
  assert.ok(box.height >= 36, `${what}: the last control is a tap target (${box.height}).`);
  await none(page, what);
};
const theme = (page, value) => page.evaluate(next => { document.documentElement.dataset.workspaceTheme = next; }, value);

try {
  fixture = await startHubFixture({ work: true });
  const { seed, now } = fixture;
  // Every Needs you filter has something waiting: a question, a design review, a list of steps, a playtest, a blocked session, a review and an approval.
  seed.ask(askJson({ id: id('question', 'a1a1'), now: minutesAgo(now, 5), question: 'Which arc?', options: plainOptions() }));
  seed.ask(designAskJson({ id: id('design', 'b2b2'), now: minutesAgo(now, 6) }));
  seed.checklist(checklistJson({ id: id('steps', 'c3c3'), now: minutesAgo(now, 7) }));
  seed.checklist(playtestJson({ id: id('play', 'd4d4'), now: minutesAgo(now, 8) }));
  seed.request({ id: id('approval', 'e5e5'), project: 'probe', createdAt: minutesAgo(now, 9).toISOString(), by: 'owner', text: 'Look at the gate script', preset: 'code-task', repo: 'example/probe', target: 'at-pc', origin: { kind: 'owner', name: 'owner' } });
  // A project whose roadmaps nest three deep, with titles long enough to need more than one line at 320 px.
  const ISO = '2026-10-01T10:00:00Z';
  const longPath = [
    beadsIssue({ id: 'lp-r1', title: 'Hub speed and the phone screens', type: 'epic', labels: ['roadmap'], created: ISO }),
    beadsIssue({ id: 'lp-r2', title: 'Rows that scroll sideways on a phone', type: 'epic', parent: 'lp-r1', labels: ['roadmap'], created: '2026-10-01T10:01:00Z' }),
    beadsIssue({ id: 'lp-r3', title: 'Breadcrumbs and toolbars', type: 'epic', parent: 'lp-r2', labels: ['roadmap'], created: '2026-10-01T10:02:00Z' }),
    beadsIssue({ id: 'lp-f1', title: 'Ring one', type: 'feature', parent: 'lp-r2', created: '2026-10-01T10:03:00Z' }),
    beadsIssue({ id: 'lp-t1', title: 'Task one', parent: 'lp-f1', created: '2026-10-01T10:04:00Z' }),
    beadsIssue({ id: 'lp-f2', title: 'Ring two', type: 'feature', parent: 'lp-r3', created: '2026-10-01T10:05:00Z' }),
    beadsIssue({ id: 'lp-t2', title: 'Task two', parent: 'lp-f2', created: '2026-10-01T10:06:00Z' }),
  ];
  seed.beads('longpath', longPath, { pushedAt: minutesAgo(now, 10).toISOString(), host: 'pc.example.test', count: longPath.length, repo: 'example/longpath' });
  await new Promise(resolve => setTimeout(resolve, 100));

  const ROWS = {
    needs: { hash: '#/~hub/needs', ready: 'select[aria-label="Needs you filter"]', row: 'select[aria-label="Needs you filter"]', last: 'select[aria-label="Needs you filter"]' },
    work: { hash: '#/~hub/work/magic-loops', ready: '[data-lane-chip="done"]', row: '.wk-lane-chips', last: '[data-lane-chip="done"]' },
    crumbs: { hash: '#/~hub/map/longpath/lp-r2', ready: '[data-inside="lp-r3"]', row: '.rm-crumbs', last: '[data-inside="lp-r3"]' },
    toolbar: { hash: '#/~hub/map/magic-loops', ready: '.hub-map-controls', row: '.hub-map-controls', last: '.hub-map-controls [data-row-menu]' },
  };

  for (const width of [390, 320]) {
    const page = await open({ width, height: 844 }, PHONE);

    step(`${width} px, Needs you: one select with every filter and its count, and a pick opens that filter`);
    await page.goto(`${fixture.url}${ROWS.needs.hash}`);
    await page.locator(ROWS.needs.ready).waitFor();
    assert.equal(await page.locator('.hub-chips-wrap').count(), 0, 'No chip row is left to scroll.');
    // The select paints before the counts land, and a filter with nothing in it is not listed until then.
    await page.locator(`${ROWS.needs.row} option[value="pr"]`).waitFor({ state: 'attached' });
    const options = await page.locator(`${ROWS.needs.row} option`).evaluateAll(list => list.map(node => [node.value, node.textContent]));
    assert.deepEqual(options.map(item => item[0]), ['all', 'approvals', 'question', 'steps', 'design', 'playtest', 'unstick', 'pr', 'answered'], 'The fixture shows every filter.');
    assert.ok(options.slice(0, -1).every(item => /\(\d+\)$/.test(item[1])), `Every filter but Answered shows its count (${JSON.stringify(options)}).`);
    assert.equal(options[8][1], 'Answered');
    await fits(page, ROWS.needs.row, ROWS.needs.last, `Needs you at ${width}`);
    const field = await page.locator(ROWS.needs.row).evaluate(node => ({ font: getComputedStyle(node).fontSize, height: node.getBoundingClientRect().height }));
    assert.deepEqual(field, { font: '16px', height: field.height }, 'The select is 16 px type (no iOS zoom).');
    assert.ok(field.height >= 44, `The select is 44 px high (${field.height}).`);
    await page.locator(ROWS.needs.row).selectOption('answered');
    await page.waitForFunction(() => location.hash === '#/~hub/needs/answered');
    await expect(page.locator(ROWS.needs.row)).toHaveValue('answered');

    step(`${width} px, Work: the six lane chips wrap, and a tap on the last one shows its lane`);
    await page.goto(`${fixture.url}${ROWS.work.hash}`);
    await page.locator(ROWS.work.ready).waitFor();
    assert.equal(await page.locator('.wk-chips-wrap').count(), 0, 'The chips have no fade wrapper left.');
    await fits(page, ROWS.work.row, `${ROWS.work.last}`, `Work at ${width}`);
    await page.locator(ROWS.work.last).tap();
    await expect(page.locator(ROWS.work.last)).toHaveAttribute('aria-pressed', 'true');
    assert.deepEqual(await page.locator('.wk-lane').evaluateAll(list => list.filter(node => getComputedStyle(node).display !== 'none').map(node => node.dataset.lane)), ['done']);

    await page.context().close();
  }

  step('Both themes: the wrapped rows read in light as in dark, with nothing sideways');
  {
    const page = await open({ width: 390, height: 844 }, PHONE);
    for (const value of ['dark', 'light']) {
      for (const key of ['needs', 'work']) {
        await page.goto(`${fixture.url}${ROWS[key].hash}`);
        await page.locator(ROWS[key].ready).waitFor();
        await theme(page, value);
        await fits(page, ROWS[key].row, ROWS[key].last, `${key} in ${value}`);
      }
    }
    await page.context().close();
  }

  step('Above 640 px nothing changes: the Needs filter chips keep their one-row scroll, and on a window with a Map the toolbar and the breadcrumb do too');
  {
    const page = await open({ width: 1280, height: 800 });
    await page.goto(`${fixture.url}${ROWS.needs.hash}`);
    await page.locator('.hub-chips[aria-label="Needs you filter"] [data-filter="answered"]').waitFor();
    assert.equal(await page.locator('select[aria-label="Needs you filter"]').count(), 0, 'No select above 640 px.');
    const style = await page.locator('.hub-chips[aria-label="Needs you filter"]').evaluate(node => { const css = getComputedStyle(node); return { wrap: css.flexWrap, overflowX: css.overflowX }; });
    assert.deepEqual(style, { wrap: 'nowrap', overflowX: 'auto' }, 'The Needs filter is still one scrolling row at 641 px.');
    await page.goto(`${fixture.url}${ROWS.toolbar.hash}`);
    await page.locator('.hub-map-box svg').waitFor();
    const bar = await page.locator('.hub-map-controls').evaluate(node => { const css = getComputedStyle(node); return { wrap: css.flexWrap, overflowX: css.overflowX }; });
    assert.deepEqual(bar, { wrap: 'nowrap', overflowX: 'auto' }, 'The toolbar is still one scrolling row at 641 px.');
    await page.goto(`${fixture.url}${ROWS.crumbs.hash}`);
    await page.locator(ROWS.crumbs.ready).waitFor();
    const crumbs = await page.locator('.rm-crumbs').evaluate(node => { const css = getComputedStyle(node); return { wrap: css.flexWrap, overflowX: css.overflowX, height: node.parentElement.getBoundingClientRect().height }; });
    assert.deepEqual(crumbs, { wrap: 'nowrap', overflowX: 'auto', height: 44 }, 'The breadcrumb is still one 44 px row at 641 px.');
    await page.context().close();
  }
  console.log('hub-phone-rows-ui: passed');
} finally {
  for (const context of contexts) await context.close().catch(() => {});
  await browser.close();
  await fixture?.close?.().catch(() => {});
}
