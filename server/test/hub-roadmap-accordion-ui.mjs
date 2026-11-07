// Run after npm run build. The Roadmap as an accordion (ws-cl0.16.7), through a real browser over the fixture service, at 360 and 1920 px:
// the status of every row at a glance with nothing open, the current milestone open, no sideways scroll, a task within three taps, what is
// remembered (a toggle, Expand all, Collapse all), a search that opens its matches and leaves the stored state alone, a sprint with its own
// memory, Hide completed, the keyboard, no Map on a phone, map addresses that land on the right row on a phone and in a rotated tablet, a
// long list that draws 20 tasks a page, and a childless feature that is a task. Nothing waits on a clock: every wait is on a state.
import { chromium } from '@playwright/test';
import { ms } from './ui-timeouts.mjs';
import assert from 'node:assert/strict';
import { startHubFixture } from './hub-fixture.mjs';
import { beadsIssue } from '../../site/api/test/hub-fixtures.mjs';

const step = name => console.log(`- ${name}`);
const channel = process.env.BUW_TEST_BROWSER || 'msedge';
const fixture = await startHubFixture({ seedData: false });
const browser = await chromium.launch({ headless: true, channel });
const contexts = [];
const PHONE = { hasTouch: true, isMobile: true };
const open = async (viewport, options = {}) => {
  const context = await browser.newContext({ viewport, serviceWorkers: 'block', reducedMotion: 'reduce', ...options });
  contexts.push(context);
  const page = await context.newPage();
  page.setDefaultTimeout(ms(15000));
  page.on('pageerror', error => { throw error; });
  return page;
};

const BIG = 306;
const OTHERS = 62;

try {
  const { seed, now } = fixture;
  const stamp = { created: '2026-10-01T10:00:00Z' };
  const closed = (id, title, parent) => ({ ...beadsIssue({ id, title, parent, status: 'closed', closed: '2026-10-05T10:00:00Z', ...stamp }) });
  const issues = [
    beadsIssue({ id: 'acc-r1', title: 'Platform', type: 'epic', labels: ['roadmap'], ...stamp }),
    beadsIssue({ id: 'acc-f1', title: 'Core', type: 'feature', parent: 'acc-r1', ...stamp }),
    closed('acc-t1', 'Set the scene', 'acc-f1'),
    { ...beadsIssue({ id: 'acc-t2', title: 'Wall jump', parent: 'acc-f1', status: 'in_progress', labels: ['sprint:s1'], ...stamp }) },
    beadsIssue({ id: 'acc-t3', title: 'Dash', parent: 'acc-f1', ...stamp }),
    beadsIssue({ id: 'acc-r2', title: 'Inner', type: 'epic', parent: 'acc-r1', labels: ['roadmap'], ...stamp }),
    beadsIssue({ id: 'acc-f2', title: 'Inner ring', type: 'feature', parent: 'acc-r2', ...stamp }),
    beadsIssue({ id: 'acc-t4', title: 'Slide', parent: 'acc-f2', labels: ['sprint:s1'], ...stamp }),
    beadsIssue({ id: 'acc-r3', title: 'Shipped', type: 'epic', labels: ['roadmap'], status: 'closed', closed: '2026-10-06T10:00:00Z', ...stamp }),
    beadsIssue({ id: 'acc-f3', title: 'Shipped ring', type: 'feature', parent: 'acc-r3', status: 'closed', closed: '2026-10-06T10:00:00Z', ...stamp }),
    closed('acc-t5', 'Shipped thing', 'acc-f3'),
    // Not in a roadmap: a milestone with one epic that holds a long list of tasks, and a feature with no children at all.
    beadsIssue({ id: 'acc-m9', title: 'Big', type: 'epic', ...stamp }),
    beadsIssue({ id: 'acc-fb', title: 'Bulk', type: 'epic', parent: 'acc-m9', ...stamp }),
    beadsIssue({ id: 'acc-solo', title: 'Solo feature', type: 'feature', parent: 'acc-m9', labels: ['sprint:s1'], ...stamp }),
  ];
  for (let index = 1; index <= BIG; index++) issues.push(beadsIssue({ id: `acc-b${String(index).padStart(3, '0')}`, title: `Bulk task ${index}`, parent: 'acc-fb', ...stamp }));
  // 368 tasks in all: 62 more in a second plain milestone.
  issues.push(beadsIssue({ id: 'acc-m8', title: 'Plain', type: 'epic', ...stamp }), beadsIssue({ id: 'acc-fp', title: 'Plain work', type: 'epic', parent: 'acc-m8', ...stamp }));
  for (let index = 1; index <= OTHERS - 5; index++) issues.push(beadsIssue({ id: `acc-p${String(index).padStart(2, '0')}`, title: `Plain task ${index}`, parent: 'acc-fp', ...stamp }));
  seed.beads('acc', issues, { pushedAt: new Date(now.getTime() - 5 * 60_000).toISOString(), host: 'pc.example.test', count: issues.length, repo: 'example/acc' });
  await new Promise(resolve => setTimeout(resolve, 100));

  const url = hash => `${fixture.url}${hash}`;
  const goList = async (page, hash = '#/~hub/project/acc') => { await page.goto(url(hash)); await page.locator('[data-pp-roadmap]').waitFor(); };
  const stored = (page, key = 'hub.roadmap.open.acc') => page.evaluate(name => localStorage.getItem(name), key);
  const sideways = page => page.evaluate(() => [document.scrollingElement, document.querySelector('.hub'), document.querySelector('.pp-body'), document.querySelector('.content')].filter(Boolean).filter(el => el.scrollWidth > el.clientWidth).map(el => `${el.className}: ${el.scrollWidth} > ${el.clientWidth}`));
  const head = (page, kind, id) => page.locator(kind === 'r' ? `[data-roadmap-row="${id}"] > .ui-fold-h button` : `[data-pp-milestone="${id}"] > .ui-fold-h button`);
  const openIds = page => page.locator('[data-pp-roadmap] .ui-fold[data-open="true"]').evaluateAll(list => list.map(item => item.dataset.roadmapRow ?? item.dataset.ppMilestone));

  for (const [label, viewport, options] of [['360', { width: 360, height: 780 }, PHONE], ['1920', { width: 1920, height: 1000 }, {}]]) {
    const phone = label === '360';
    const press = (_page, locator) => (phone ? locator.tap() : locator.click());
    const page = await open(viewport, options);
    await page.addInitScript(() => { try { if (!sessionStorage.getItem('acc-seen')) { localStorage.removeItem('hub.roadmap.open.acc'); localStorage.removeItem('buw.roadmap.hideDone'); sessionStorage.setItem('acc-seen', '1'); } } catch { /* no storage */ } });

    step(`${label}: every row shows its status with nothing open, the current milestone starts open, nothing scrolls sideways`);
    await goList(page);
    assert.deepEqual((await openIds(page)).sort(), ['acc-f1', 'acc-r1'], 'The current milestone and the roadmap above it.');
    await page.locator('[data-roadmap-collapse]').click();
    assert.deepEqual(await openIds(page), [], 'Collapse all closes everything.');
    const heads = await page.locator('[data-pp-roadmap] > .ui-fold > .ui-fold-h').allInnerTexts();
    assert.equal(heads.length, 3, 'Platform, Not in a roadmap (Big and Plain) and Shipped.');
    assert.ok(heads.every(text => /\d+ of \d+ done|no tasks yet/.test(text)), `Every row says how far it is (${JSON.stringify(heads)}).`);
    assert.deepEqual(await sideways(page), [], 'No sideways scroll.');
    assert.equal(await page.locator('[data-pp-task]').count(), 0, 'A closed row draws no tasks.');

    step(`${label}: a task is within three taps, and the sheet opens at its project address`);
    await press(page, head(page, 'r', 'acc-r1'));
    await press(page, head(page, 'm', 'acc-f1'));
    await press(page, page.locator('[data-pp-task="acc-t3"]'));
    await page.waitForFunction(() => location.hash === '#/~hub/project/acc/roadmap/acc-t3');
    await page.locator('dialog#hub-map-panel').waitFor();
    await page.goBack();
    await page.locator('[data-pp-roadmap]').waitFor();
    await page.waitForFunction(() => location.hash === '#/~hub/project/acc');

    step(`${label}: a toggle, Expand all and Collapse all are remembered through a reload`);
    await goList(page);
    await page.locator('[data-roadmap-collapse]').click();
    await press(page, head(page, 'r', 'acc-r3'));
    await page.locator('[data-pp-milestone="acc-f3"]').waitFor();
    assert.deepEqual(await openIds(page), ['acc-r3']);
    await page.reload();
    await page.locator('[data-pp-roadmap]').waitFor();
    assert.deepEqual(await openIds(page), ['acc-r3'], 'Reload keeps the one the person opened.');
    await page.locator('[data-roadmap-expand]').click();
    const everything = await openIds(page);
    assert.ok(everything.includes('acc-r1') && everything.includes('acc-m9') && everything.includes('acc-f2'), `Expand all opens every row (${everything}).`);
    await page.reload();
    await page.locator('[data-pp-roadmap]').waitFor();
    assert.deepEqual((await openIds(page)).sort(), [...everything].sort(), 'Expand all is remembered.');
    await page.locator('[data-roadmap-collapse]').click();
    await page.reload();
    await page.locator('[data-pp-roadmap]').waitFor();
    assert.deepEqual(await openIds(page), [], 'Collapse all is remembered.');
    const afterCollapse = await stored(page);

    step(`${label}: a search opens its matches and writes nothing; clearing it brings back the same open set`);
    await goList(page);
    const before = await openIds(page);
    await page.locator('[data-roadmap-list-search]').fill('Wall jump');
    await page.locator('[data-roadmap-list-count]').filter({ hasText: /^1 match$/ }).waitFor();
    assert.deepEqual(await page.locator('[data-pp-task]').evaluateAll(list => list.map(item => item.dataset.ppTask)), ['acc-t2'], 'Only the match, in its opened rows.');
    assert.equal(await page.locator('[data-roadmap-expand]').count(), 0, 'Expand all is hidden while searching.');
    assert.equal(await stored(page), afterCollapse, 'Search wrote nothing.');
    await page.locator('[data-roadmap-list-search]').press('Escape');
    await page.locator('[data-roadmap-expand]').waitFor();
    assert.deepEqual(await openIds(page), before, 'The same rows are open as before.');
    assert.equal(await stored(page), afterCollapse, 'Clearing wrote nothing.');
    await page.locator('[data-roadmap-list-search]').fill('zzzz nothing');
    await page.locator('[data-roadmap-list-count]').filter({ hasText: 'No matches' }).waitFor();
    await page.locator('[data-roadmap-list-search]').fill('');

    step(`${label}: a sprint opens everything under its own memory, and the project's memory is untouched`);
    await goList(page);
    const projectMemory = await stored(page);
    await goList(page, '#/~hub/project/acc?sprint=s1');
    await page.locator('[data-pp-milestone]').first().waitFor();
    assert.deepEqual(await page.locator('[data-roadmap-row]').count(), 0, 'A sprint is a flat list of milestones.');
    assert.deepEqual((await page.locator('[data-pp-roadmap] [data-pp-task]').evaluateAll(list => list.map(item => item.dataset.ppTask))).sort(), ['acc-solo', 'acc-t2', 'acc-t4'], 'The childless feature is a task in the sprint.');
    await press(page, head(page, 'm', 'acc-f1'));
    assert.ok(!(await openIds(page)).includes('acc-f1'), 'A fold of the sprint view closes.');
    assert.ok((await stored(page, 'hub.roadmap.open.acc.s1'))?.includes('m/acc-f1'), 'The sprint keeps its own memory.');
    assert.equal(await stored(page), projectMemory, "The project's memory is unchanged.");
    await press(page, page.locator('[data-pp-task="acc-t4"]'));
    await page.waitForFunction(() => location.hash === '#/~hub/project/acc/roadmap/acc-t4?sprint=s1');
    await page.goBack();
    await goList(page);
    assert.equal(await stored(page), projectMemory, 'Leaving the sprint keeps the project as it was.');

    step(`${label}: Hide completed leaves finished rows and done tasks out, and the tally still counts them; Enter and Space work on a head`);
    await goList(page);
    await page.locator('[data-roadmap-expand]').click();
    assert.ok(await page.locator('[data-roadmap-row="acc-r3"]').count() === 1 && await page.locator('[data-pp-task="acc-t1"]').count() === 1);
    await page.locator('[data-roadmap-hide-done]').click();
    await page.locator('[data-roadmap-row="acc-r3"]').waitFor({ state: 'detached' });
    assert.equal(await page.locator('[data-pp-task="acc-t1"]').count(), 0, 'The done task inside an open milestone is hidden too.');
    assert.match(await page.locator('[data-pp-milestone="acc-f1"] > .ui-fold-h').innerText(), /1 of 3 done/, 'The tally counts the hidden one.');
    await page.locator('[data-roadmap-hide-done]').click();
    await page.locator('[data-roadmap-row="acc-r3"]').waitFor();
    const keyed = head(page, 'r', 'acc-r3');
    await keyed.focus();
    const was = await keyed.getAttribute('aria-expanded');
    await page.keyboard.press('Enter');
    assert.notEqual(await keyed.getAttribute('aria-expanded'), was, 'Enter toggles.');
    await page.keyboard.press('Space');
    assert.equal(await keyed.getAttribute('aria-expanded'), was, 'Space toggles back.');
    await page.evaluate(() => localStorage.removeItem('hub.roadmap.open.acc'));

    step(`${label}: a long list draws 20 tasks a page: Show more adds exactly 20, Show all gives every one, a search finds one on the last page`);
    await goList(page);
    await page.locator('[data-roadmap-expand]').click();
    const counts = await page.locator('[data-pp-milestone]').evaluateAll(list => list.map(item => [item.dataset.ppMilestone, item.querySelectorAll('[data-pp-task]').length]));
    assert.ok(counts.every(([, n]) => n <= 20), `At most 20 tasks per milestone (${JSON.stringify(counts)}).`);
    const big = page.locator('[data-pp-milestone="acc-m9"]');
    assert.equal(await big.locator('[data-pp-task]').count(), 20);
    await big.locator('[data-pp-more]').click();
    assert.equal(await big.locator('[data-pp-task]').count(), 40, 'Show more adds exactly 20.');
    await big.locator('[data-pp-all]').click();
    assert.equal(await big.locator('[data-pp-task]').count(), BIG + 1, 'Show all gives every task: the bulk and the solo feature.');
    await page.reload();
    await page.locator('[data-pp-roadmap]').waitFor();
    assert.equal(await page.locator('[data-pp-milestone="acc-m9"] [data-pp-task]').count(), 20, 'A reload starts from the first page again.');
    await page.locator('[data-roadmap-list-search]').fill('Bulk task 300');
    await page.locator('[data-pp-task="acc-b300"]').waitFor();
    await page.locator('[data-roadmap-list-search]').fill('');
    await page.evaluate(() => localStorage.removeItem('hub.roadmap.open.acc'));

    if (phone) {
      step('360: no Map and no switch; the status is read from the list');
      await goList(page);
      assert.equal(await page.locator('[data-roadmap-switch]').count(), 0);
      assert.equal(await page.locator('.hub-map-box').count(), 0);
    } else {
      step('1920: the Map is one click away and each roadmap offers its own');
      await goList(page);
      assert.equal(await page.locator('[data-roadmap-switch]').count(), 1);
      await page.locator('[data-roadmap-collapse]').click();
      await head(page, 'r', 'acc-r1').click();
      assert.equal(await page.locator('[data-roadmap-map="acc-r1"]').getAttribute('href'), '#/~hub/map/acc/acc-r1');
    }
    await page.context().close();
  }

  // ---- Map addresses on a phone ----
  for (const sprint of ['', '?sprint=s1']) {
    const page = await open({ width: 360, height: 780 }, PHONE);
    const cases = [
      ['acc-t2', 'task'], ['acc-b250', 'a task past the first 20'], ['acc-f1', 'a milestone'], ['acc-r2', 'a roadmap'], ['~unfiled', 'the unfiled row'], ['acc-fp', 'a feature (shown on its milestone)'],
    ];
    for (const [node, what] of cases) {
      step(`360 phone: #/~hub/map/acc/${node}${sprint} lands on ${what}, in view, with no sheet and the address unchanged`);
      const hash = `#/~hub/map/acc/${node}${sprint}`;
      await page.goto(url(hash));
      if (sprint && ['acc-b250', 'acc-r2', '~unfiled', 'acc-fp'].includes(node)) {
        await page.locator('[data-roadmap-outside]').waitFor();
        assert.match(await page.locator('[data-roadmap-outside-link]').getAttribute('href'), /\/at\/|#\/~hub\/project\/acc\/at\//, 'It offers the whole roadmap at the same row.');
        continue;
      }
      const row = page.locator('[data-roadmap-at]');
      await row.waitFor();
      assert.equal(await row.getAttribute('aria-current'), 'true');
      const target = await row.evaluate(element => element.dataset.ppTask ?? element.dataset.ppMilestone ?? element.dataset.roadmapRow);
      assert.equal(target, node === 'acc-fp' ? 'acc-m8' : node, 'The right row.');
      const visible = await row.evaluate(element => { const rect = (element.matches('a') ? element : element.querySelector('.ui-fold-head')).getBoundingClientRect(); return { top: rect.top, bottom: rect.bottom, height: innerHeight }; });
      assert.ok(visible.top >= 0 && visible.bottom <= visible.height, `${node}: in view (${JSON.stringify(visible)}).`);
      assert.equal(await page.locator('dialog#hub-map-panel').count(), 0, 'No sheet.');
      assert.equal(await page.evaluate(() => location.hash), hash, 'The address did not change.');
      assert.equal(await page.locator('.hub-map-box').count(), 0);
    }
    for (const node of ['~full', 'nope']) {
      step(`360 phone: #/~hub/map/acc/${node}${sprint} is the plain list, with no error`);
      await page.goto(url(`#/~hub/map/acc/${node}${sprint}`));
      await page.locator('[data-pp-roadmap]').waitFor();
      assert.equal(await page.locator('[data-roadmap-at]').count(), 0);
      assert.equal(await page.locator('[role="alert"]').count(), 0);
    }
    await page.context().close();
  }

  step('a feature as a bead address: the list shows its milestone');
  {
    const page = await open({ width: 360, height: 780 }, PHONE);
    await page.goto(url('#/~hub/project/acc/at/acc-fb'));
    await page.locator('[data-roadmap-at]').waitFor();
    assert.equal(await page.locator('[data-roadmap-at]').getAttribute('data-pp-milestone'), 'acc-m9');
    await page.context().close();
  }

  step('a tablet turned upright shows the list and turned back the Map; the address and the history stay');
  {
    const page = await open({ width: 1024, height: 768 });
    await page.goto(url('#/~hub/map/acc/acc-r2'));
    await page.locator('.hub-map-box svg').waitFor();
    const depth = await page.evaluate(() => history.length);
    await page.setViewportSize({ width: 768, height: 1024 });
    await page.locator('[data-pp-roadmap]').waitFor();
    assert.equal(await page.locator('.hub-map-box').count(), 0);
    assert.equal(await page.evaluate(() => location.hash), '#/~hub/map/acc/acc-r2');
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.locator('.hub-map-box svg').waitFor();
    assert.equal(await page.evaluate(() => location.hash), '#/~hub/map/acc/acc-r2');
    assert.equal(await page.evaluate(() => history.length), depth, 'No history entry.');
    await page.context().close();
  }

  step('932 x 430, a large phone on its side: no Map');
  {
    const page = await open({ width: 932, height: 430 }, PHONE);
    await page.goto(url('#/~hub/project/acc'));
    await page.locator('[data-pp-roadmap]').waitFor();
    assert.equal(await page.locator('[data-roadmap-switch]').count(), 0);
    await page.goto(url('#/~hub/map/acc'));
    await page.locator('[data-pp-roadmap]').waitFor();
    assert.equal(await page.locator('.hub-map-box').count(), 0);
    await page.context().close();
  }

  console.log('hub-roadmap-accordion-ui: passed');
} finally {
  for (const context of contexts) await context.close().catch(() => {});
  await browser.close().catch(() => {});
  await fixture.close();
}
