// Run after npm run build. A task's details in a window (ws-b24), through a real browser over the fixture service, at 1280, 1920 and 2560 px
// (a window 680 px wide, centred over the dimmed screen) and at 390 and 320 px (the bottom sheet): from a link as Needs you gives it, from the
// Roadmap, the Map and the Work board. The box is measured with boundingBox once the dialog is there; nothing waits on a clock.
import { chromium } from '@playwright/test';
import { ms } from './ui-timeouts.mjs';
import assert from 'node:assert/strict';
import { startHubFixture } from './hub-fixture.mjs';
import { beadsIssue, minutesAgo } from '../../site/api/test/hub-fixtures.mjs';

const step = name => console.log(`- ${name}`);
const channel = process.env.BUW_TEST_BROWSER || 'msedge';
const fixture = await startHubFixture({ seedData: false, signing: true, env: { HUB_MAP_REQUESTS_MS: '0' } });
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

try {
  const stamp = { created: '2026-10-01T10:00:00Z' };
  const LONG = 'A task with a title that is long enough to wrap onto several lines inside the window and must never make the window scroll sideways at any width';
  const issues = [
    beadsIssue({ id: 'win-m1', title: 'Window milestone', type: 'milestone', ...stamp }),
    beadsIssue({ id: 'win-f1', title: 'Window feature', type: 'epic', parent: 'win-m1', ...stamp }),
    beadsIssue({ id: 'win-t1', title: LONG, parent: 'win-f1', labels: ['sprint:s1'], description: 'Show the details of a task in a window that can be read. It has a second sentence too.', ...stamp }),
    { ...beadsIssue({ id: 'win-t2', title: 'Wire the exit door', parent: 'win-f1', description: 'Players need a door that opens when the key is held.', ...stamp }), acceptance_criteria: '- The door opens with the key' },
    beadsIssue({ id: 'win-solo', title: 'A feature with nothing under it', type: 'feature', parent: 'win-m1', labels: ['sprint:s1'], ...stamp }),
  ];
  fixture.seed.beads('win', issues, { pushedAt: minutesAgo(fixture.now, 5).toISOString(), host: 'pc.example.test', count: issues.length, repo: 'example/win' });
  fixture.fake.seed('sections/win/workspace.json', JSON.stringify({ name: 'Win', tracked: { repo: 'example/win' }, entities: [] }), 'application/json');
  await new Promise(resolve => setTimeout(resolve, 100));

  const url = hash => `${fixture.url}${hash}`;
  const hashOf = page => page.evaluate(() => location.hash);
  const dialogOf = page => page.locator('dialog#hub-map-panel');
  const tops = page => page.evaluate(() => ({ page: document.scrollingElement.scrollTop, hub: document.querySelector('.hub')?.scrollTop ?? 0, body: document.querySelector('.pp-body')?.scrollTop ?? 0 }));

  /** The window is 680 px wide (less on a narrow screen), centred on both axes within 1 px, inside the viewport, and its title fits. */
  const readable = async (page, viewport, what) => {
    const dialog = dialogOf(page);
    await dialog.locator('[data-show-links]').waitFor();
    const box = await dialog.boundingBox();
    assert.ok(Math.abs(box.width - Math.min(680, viewport.width - 48)) <= 1, `${what}: 680 wide (${box.width}).`);
    assert.ok(Math.abs(box.x + box.width / 2 - viewport.width / 2) <= 1, `${what}: centred across (${box.x + box.width / 2} vs ${viewport.width / 2}).`);
    assert.ok(Math.abs(box.y + box.height / 2 - viewport.height / 2) <= 1, `${what}: centred down (${box.y + box.height / 2} vs ${viewport.height / 2}).`);
    assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width && box.y + box.height <= viewport.height, `${what}: inside the screen.`);
    const title = await dialog.locator('h3').evaluate(node => ({ scroll: node.scrollWidth, client: node.clientWidth }));
    assert.ok(title.scroll <= title.client, `${what}: the title fits (${title.scroll} > ${title.client}).`);
    const inside = await dialog.evaluate(node => node.scrollWidth <= node.clientWidth);
    assert.ok(inside, `${what}: no sideways scroll in the window.`);
  };

  for (const viewport of [{ width: 1280, height: 800 }, { width: 1920, height: 1080 }, { width: 2560, height: 1440 }]) {
    const tag = `${viewport.width}`;
    const page = await open(viewport);

    step(`${tag}: from a link as Needs you gives it, the task opens centred, readable, with no Map behind it`);
    await page.goto(url('#/~hub/project/win/roadmap/win-t1'));
    await readable(page, viewport, 'cold link');
    assert.equal(await page.locator('.hub-map-box').count(), 0, 'No empty map behind the window.');
    assert.match(await dialogOf(page).locator('[data-sheet-status]').innerText(), /win-t1 · next up · Sprint: s1/, 'The status line at the top.');

    step(`${tag}: a long body scrolls inside the window, the page does not, and the head stays in reach`);
    const before = await tops(page);
    await dialogOf(page).evaluate(node => { const filler = document.createElement('div'); filler.dataset.filler = ''; filler.style.height = '3000px'; node.append(filler); node.scrollTop = 600; });
    const dialogBox = await dialogOf(page).boundingBox();
    assert.ok(await dialogOf(page).evaluate(node => node.scrollTop > 0 && node.scrollHeight > node.clientHeight), 'The window scrolls.');
    assert.deepEqual(await tops(page), before, 'The page behind did not move.');
    const headBox = await dialogOf(page).locator('.hub-map-panel-head').boundingBox();
    assert.ok(Math.abs(headBox.y - dialogBox.y) <= 3, `The head stays at the top of the window (${headBox.y} vs ${dialogBox.y}).`);
    await dialogOf(page).locator('[data-filler]').evaluate(node => node.remove());

    step(`${tag}: Tab and Shift+Tab loop inside the window`);
    for (let k = 0; k < 40; k++) {
      await page.keyboard.press('Tab');
      assert.equal(await dialogOf(page).evaluate(node => node.contains(document.activeElement)), true, `Tab ${k} stays inside.`);
    }
    for (let k = 0; k < 6; k++) {
      await page.keyboard.press('Shift+Tab');
      assert.equal(await dialogOf(page).evaluate(node => node.contains(document.activeElement)), true, `Shift+Tab ${k} stays inside.`);
    }

    // ---- the three screens ----
    const screens = [
      { name: 'Roadmap', hash: '#/~hub/project/win', opener: '[data-pp-task="win-t1"]', card: false },
      { name: 'Work board', hash: '#/~hub/work/win', opener: '[data-card="bead:win-t1"]', card: true },
    ];
    for (const screen of screens) {
      for (const how of ['X', 'scrim', 'Escape', 'Back']) {
        step(`${tag}: ${screen.name}, left by ${how}, returns to the same screen with the focus on the opener`);
        await page.goto(url('#/~hub/today'));
        await page.locator('.hub').waitFor();
        await page.evaluate(next => { location.hash = next; }, screen.hash);
        const opener = page.locator(screen.opener);
        await opener.waitFor();
        const scrolled = await tops(page);
        await opener.click();
        await readable(page, viewport, `${screen.name} window`);
        assert.equal(await page.locator('.hub-map-box').count(), 0);
        if (how === 'X') await page.getByRole('button', { name: 'Close details' }).click();
        else if (how === 'scrim') await page.mouse.click(5, 5);
        else if (how === 'Escape') await page.keyboard.press('Escape');
        else await page.goBack();
        await dialogOf(page).waitFor({ state: 'detached' });
        await page.waitForFunction(value => location.hash === value, screen.hash);
        assert.deepEqual(await tops(page), scrolled, 'The scroll holds.');
        await page.waitForFunction(selector => document.activeElement === document.querySelector(selector), screen.opener);
        await page.goBack();
        await page.waitForFunction(() => location.hash === '#/~hub/today');
      }
    }

    step(`${tag}: the Map's window is centred too, and X returns to the Map`);
    await page.goto(url('#/~hub/map/win'));
    await page.locator('.hub-map-box svg').waitFor();
    await page.goto(url('#/~hub/map/win/win-t1'));
    await readable(page, viewport, 'Map window');
    assert.equal(await page.locator('[data-show-on-map]').count(), 0, 'The Map needs no link to itself.');
    await page.getByRole('button', { name: 'Close details' }).click();
    await dialogOf(page).waitFor({ state: 'detached' });
    await page.waitForFunction(() => location.hash === '#/~hub/map/win');

    step(`${tag}: Spawn from Do it opens above the window, and Escape closes Spawn first`);
    await page.goto(url('#/~hub/project/win/roadmap/win-t2'));
    await dialogOf(page).locator('[data-bead-do="mockup"]').click();
    const spawn = page.locator('[data-spawn-sheet]');
    await spawn.locator('[data-spawn-bead]').waitFor();
    const topmost = await spawn.evaluate(node => { const rect = node.getBoundingClientRect(); const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + 20); return !!hit && node.contains(hit); });
    assert.ok(topmost, 'Spawn lies above the window.');
    await page.keyboard.press('Escape');
    await spawn.waitFor({ state: 'detached' });
    assert.equal(await dialogOf(page).count(), 1, 'The window is still there.');
    await page.getByRole('button', { name: 'Close details' }).click();
    await dialogOf(page).waitFor({ state: 'detached' });

    step(`${tag}: Show on roadmap and Show on Work board, from the Roadmap and from the board, keep ?sprint= and Back returns to the screen`);
    const sprint = '?sprint=s1';
    const fromRoadmap = `#/~hub/project/win${sprint}`;
    await page.goto(url('#/~hub/today'));
    await page.evaluate(next => { location.hash = next; }, fromRoadmap);
    await page.locator('[data-pp-task="win-t1"]').click();
    await dialogOf(page).locator('[data-show-on-work]').waitFor();
    assert.equal(await dialogOf(page).locator('[data-show-on-roadmap]').getAttribute('href'), `#/~hub/project/win/at/win-t1${sprint}`);
    assert.equal(await dialogOf(page).locator('[data-show-on-work]').getAttribute('href'), `#/~hub/work/win/at/win-t1${sprint}`);
    await dialogOf(page).locator('[data-show-on-work]').click();
    await page.waitForFunction(value => location.hash === value, `#/~hub/work/win/at/win-t1${sprint}`);
    await page.locator('[data-card="bead:win-t1"][data-focused="true"]').waitFor();
    assert.equal(await dialogOf(page).count(), 0, 'No window over the marked card.');
    await page.goBack();
    await page.waitForFunction(value => location.hash === value, fromRoadmap);
    assert.equal(await dialogOf(page).count(), 0, 'Back returns to the screen, not the window.');
    await page.goto(url('#/~hub/today'));
    await page.evaluate(() => { location.hash = '#/~hub/work/win'; });
    await page.locator('[data-card="bead:win-t1"]').click();
    await dialogOf(page).locator('[data-show-on-roadmap]').click();
    await page.waitForFunction(() => location.hash === '#/~hub/project/win/at/win-t1');
    await page.locator('[data-roadmap-at]').waitFor();
    assert.equal(await dialogOf(page).count(), 0);
    await page.goBack();
    await page.waitForFunction(() => location.hash === '#/~hub/work/win');
    assert.equal(await dialogOf(page).count(), 0, 'Back returns to the board.');

    step(`${tag}: a Ctrl-click on a Show link leaves this page alone`);
    await page.goto(url('#/~hub/project/win/roadmap/win-t1'));
    await dialogOf(page).locator('[data-show-on-work]').waitFor();
    const popup = page.context().waitForEvent('page');
    await dialogOf(page).locator('[data-show-on-work]').click({ modifiers: ['Control'] });
    (await popup).close().catch(() => {});
    assert.equal(await hashOf(page), '#/~hub/project/win/roadmap/win-t1', 'The window and its address stay.');
    assert.equal(await dialogOf(page).count(), 1);

    step(`${tag}: a feature with nothing under it is a task: it names its sprint and says no "0 of 0"`);
    await page.goto(url('#/~hub/project/win/roadmap/win-solo'));
    await dialogOf(page).locator('h3').waitFor();
    const solo = await dialogOf(page).innerText();
    assert.match(solo, /Sprint: s1/);
    assert.doesNotMatch(solo, /0 of 0/);
    assert.equal(await dialogOf(page).locator('[data-show-on-work]').count(), 1, 'It has a card on the board.');

    step(`${tag}: a milestone has no Work link, and a feature of it opens from the window`);
    await page.goto(url('#/~hub/project/win/roadmap/win-m1'));
    await dialogOf(page).locator('h3').waitFor();
    assert.equal(await dialogOf(page).locator('[data-show-on-work]').count(), 0, 'Milestones have no card.');
    await dialogOf(page).locator('[data-open-feature="win-f1"]').click();
    await page.waitForFunction(() => location.hash === '#/~hub/project/win/roadmap/win-f1');
    await page.context().close();
  }

  for (const width of [390, 320]) {
    const viewport = { width, height: width === 390 ? 844 : 568 };
    step(`${width}: the bottom sheet, at most 76% tall, with both links`);
    const page = await open(viewport, PHONE);
    await page.goto(url('#/~hub/project/win/roadmap/win-t1'));
    const dialog = dialogOf(page);
    await dialog.locator('h3').waitFor();
    await dialog.locator('[data-show-on-work]').waitFor();
    const box = await dialog.boundingBox();
    assert.ok(Math.abs(box.y + box.height - viewport.height) <= 1 && Math.abs(box.width - viewport.width) <= 1, `Across the bottom (${JSON.stringify(box)}).`);
    assert.ok(box.height <= viewport.height * 0.76, `At most 76% tall (${box.height}).`);
    assert.equal(await dialog.locator('[data-show-on-roadmap]').isVisible(), true);
    assert.equal(await dialog.locator('[data-show-on-map]').count(), 0, 'A phone has no Map.');
    assert.ok(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth), 'No sideways scroll.');
    await page.getByRole('button', { name: 'Close details' }).tap();
    await dialog.waitFor({ state: 'detached' });
    await page.context().close();
  }

  console.log('hub-task-window-ui: passed');
} finally {
  for (const context of contexts) await context.close().catch(() => {});
  await browser.close().catch(() => {});
  await fixture.close();
}
