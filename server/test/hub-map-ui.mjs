// Run after npm run build. The Roadmap through a real browser, over the hub fixture. Its two axes: vertical on a
// phone held upright, horizontal in landscape and on a desktop, the switch between them keeping the selection, and
// the desktop drawing unchanged from before the vertical layout existed. Where a project's work runs (the Runs on
// chip), which project the Roadmap opens on, and the Wayfinder row.
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { startHubFixture } from './hub-fixture.mjs';
import { beadsIssue, minutesAgo } from '../../site/api/test/hub-fixtures.mjs';

const step = name => console.log(`- ${name}`);
const channel = process.env.BUW_TEST_BROWSER || 'msedge';

const fixture = await startHubFixture();
// Two more copies so the order matters: `aardvark` sorts before Magic Loops alphabetically but is not in the project table; Workspace app is.
for (const [project, title] of [['aardvark', 'Aardvark milestone'], ['workspace-app', 'App milestone']]) {
  fixture.seed.beads(project, [beadsIssue({ id: `${project.slice(0, 2)}-m1`, title, type: 'milestone', created: '2026-10-01T10:00:00Z' })], { pushedAt: minutesAgo(fixture.now, 10).toISOString(), host: 'pc.example.test', count: 1, repo: `example/${project}` });
}
const browser = await chromium.launch({ headless: true, channel });
const contexts = [];
const open = async (viewport, options = {}) => {
  const context = await browser.newContext({ viewport, reducedMotion: 'reduce', ...options });
  contexts.push(context);
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => { throw error; });
  return page;
};
const noSideways = async (page, what) => {
  const widths = await page.evaluate(() => ({ scroll: document.scrollingElement.scrollWidth, inner: innerWidth, hub: document.querySelector('.hub')?.scrollWidth ?? 0, hubInner: document.querySelector('.hub')?.clientWidth ?? 0 }));
  assert.ok(widths.scroll <= widths.inner, `${what}: the page scrolls sideways (${widths.scroll} > ${widths.inner}).`);
  assert.ok(widths.hub <= widths.hubInner, `${what}: the Hub scrolls sideways (${widths.hub} > ${widths.hubInner}).`);
};
const go = async (page, hash) => { await page.evaluate(value => { location.hash = value; }, hash); };
const viewOf = async page => (await page.locator('.hub-map-box').getAttribute('data-view')).split(',').map(Number);
const centreOf = async locator => { const rect = await locator.boundingBox(); return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }; };
const axisOf = page => page.locator('.hub-map-box').getAttribute('data-axis');
const showMap = async (page, hash = '#/~hub/map/magic-loops') => {
  await page.goto(`${fixture.url}${hash}`);
  await page.locator('.hub-map-box svg').waitFor();
  await page.waitForTimeout(400);
};
/** Waits until the box has the axis (the observer, the relayout and the view all take a frame or two). */
const axisIs = async (page, axis, what) => {
  await page.waitForFunction(wanted => document.querySelector('.hub-map-box')?.dataset.axis === wanted, axis, { timeout: 5000 }).catch(() => {});
  assert.equal(await axisOf(page), axis, what);
  await page.waitForTimeout(300);
};
/** The part of the box the panel leaves free: the panel is at the right on a wide screen and a sheet below on a phone. */
const freeCentre = page => page.evaluate(() => {
  const box = document.querySelector('.hub-map-box').getBoundingClientRect();
  const panel = document.getElementById('hub-map-panel')?.getBoundingClientRect();
  if (!panel || !panel.width) return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  if (panel.width < innerWidth * 0.8) { const w = Math.min(Math.max(panel.left - box.left, 0), box.width); return { x: box.left + w / 2, y: box.top + box.height / 2 }; }
  const h = Math.min(Math.max(panel.top - box.top, 0), box.height);
  return { x: box.left + box.width / 2, y: box.top + h / 2 };
});

/** `svg.outerHTML` of the Roadmap of the fixture's magic-loops with Expand all and Sprints on at 1920x1080, SHA-256, as drawn by origin/main (407b036), before the vertical layout. */
const DESKTOP_EXPANDED = '67b5f7049a9278bbe20b96a1965930506b3f47be60bb20261b29420291dfacc4';
const DESKTOP_EXPANDED_NO_SPRINTS = '850cea9062b44b20e07c0196d481e4ff266643764352d44c887fe24e77d46ccc';
const sha = text => createHash('sha256').update(text).digest('hex');

// The Wayfinder row of the project just opened: waits for the map under it (they mount together), then requires exactly one row. A second row is a double mount, never a timing slip.
const wayfinder = async (page, what) => {
  await page.locator('.hub-map-wrap').waitFor();
  const rows = page.locator('.hub-wayfinder');
  await rows.first().waitFor();
  assert.equal(await rows.count(), 1, `${what}: the Wayfinder row is mounted once.`);
  return rows;
};

try {
{
  step('a phone held upright reads top to bottom: the box is vertical and "now" is below the first milestone');
  const phone = await open({ width: 390, height: 844 }, { hasTouch: true, isMobile: true });
  await showMap(phone);
  assert.equal(await axisOf(phone), 'y', 'The box is vertical.');
  const [first, now] = await Promise.all([centreOf(phone.locator('[data-node="ml-m1"] > circle').first()), centreOf(phone.locator('.hub-map-now'))]);
  assert.ok(now.y > first.y, `"Now" is below Milestone 1 (${now.y} vs ${first.y}).`);
  await noSideways(phone, 'Roadmap upright');
  const inside = async what => {
    const box = await phone.locator('.hub-map-box').boundingBox();
    const past = await phone.evaluate(({ left, right }) => [...document.querySelectorAll('.hub-map-box svg text')].filter(text => {
      const rect = text.getBoundingClientRect();
      return rect.width && (rect.right > right + 1 || rect.left < left - 1);
    }).map(text => text.textContent), { left: box.x, right: box.x + box.width });
    assert.deepEqual(past, [], `${what}: no text lies outside the box.`);
  };
  await inside('upright, collapsed');

  step('a pinch on Milestone 2 opens it and keeps it between the fingers');
  await phone.locator('button:has-text("Fit")').tap();
  await phone.waitForTimeout(200);
  const pinchStart = (await viewOf(phone))[2];
  const m2Dot = phone.locator('[data-node="ml-m2"] > circle').first();
  const mid = await centreOf(m2Dot);
  const cdp = await phone.context().newCDPSession(phone);
  const fingers = gap => [{ x: mid.x, y: mid.y - gap, id: 0 }, { x: mid.x, y: mid.y + gap, id: 1 }];
  const gap = 20 * (1.8 / pinchStart);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: fingers(20) });
  for (let at = 1; at <= 12; at += 1) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: fingers(20 + (at / 12) * (gap - 20)) });
    await phone.waitForTimeout(30);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await phone.waitForTimeout(400);
  assert.ok((await viewOf(phone))[2] >= 1.6, `The pinch reached the opening scale (${pinchStart} to ${(await viewOf(phone))[2]}).`);
  assert.equal(await phone.locator('[data-kind="f"]').count(), 1, 'Wall-jump is drawn.');
  const end = await centreOf(m2Dot);
  assert.ok(Math.hypot(end.x - mid.x, end.y - mid.y) <= 6, `Milestone 2 stayed within 6 px (${mid.x},${mid.y} to ${end.x},${end.y}).`);
  assert.equal(await axisOf(phone), 'y', 'Zooming does not change the axis.');

  step('Expand all: still no sideways scroll, and no text past the box');
  await phone.locator('button:has-text("Expand all")').tap();
  await phone.waitForTimeout(500);
  await noSideways(phone, 'Roadmap upright, expanded');
  await inside('upright, expanded');
  assert.ok(await phone.locator('[data-kind="t"]').count() >= 9, 'Every task is drawn.');
  await phone.locator('.hub-map-controls button:has-text("Sprints")').tap();
  await phone.waitForTimeout(500);
  assert.equal(await phone.locator('[data-band="sprint-3"]').count(), 1, 'The sprint bar is drawn.');
  await noSideways(phone, 'Roadmap upright, expanded, with sprints');
  await inside('upright, expanded, with sprints');

  step('turning the phone to landscape goes left to right, and the selected node stays centred in what the panel leaves free');
  const turn = await open({ width: 390, height: 844 }, { hasTouch: true, isMobile: true });
  await showMap(turn, '#/~hub/map/magic-loops/ml-m2');
  await turn.locator('.hub-map-panel').waitFor();
  await turn.waitForTimeout(500);
  assert.equal(await axisOf(turn), 'y');
  await turn.setViewportSize({ width: 844, height: 390 });
  await axisIs(turn, 'x', 'Landscape is horizontal.');
  await turn.waitForTimeout(400);
  assert.equal(await turn.locator('.hub-map-panel').count(), 1, 'The panel is still open.');
  assert.equal(await turn.locator('[data-node="ml-m2"].selected').count(), 1, 'Milestone 2 is still selected.');
  const free = await freeCentre(turn);
  const landed = await centreOf(turn.locator('[data-node="ml-m2"] > circle').first());
  assert.ok(Math.hypot(landed.x - free.x, landed.y - free.y) <= 12, `Milestone 2 is centred (${landed.x},${landed.y} vs ${free.x},${free.y}).`);
  await turn.setViewportSize({ width: 390, height: 844 });
  await axisIs(turn, 'y', 'Back upright it is vertical again.');
  assert.equal(await turn.locator('[data-node="ml-m2"].selected').count(), 1, 'Still selected.');
  const back = await centreOf(turn.locator('[data-node="ml-m2"] > circle').first());
  const freeBack = await freeCentre(turn);
  assert.ok(Math.hypot(back.x - freeBack.x, back.y - freeBack.y) <= 12, `And still centred (${back.x},${back.y} vs ${freeBack.x},${freeBack.y}).`);
  assert.equal(await turn.locator('.hub-map-panel').count(), 1, 'With the panel open.');

  step('with nothing selected, a switch centres "now"');
  const bare = await open({ width: 390, height: 844 }, { hasTouch: true, isMobile: true });
  await showMap(bare);
  await bare.setViewportSize({ width: 844, height: 390 });
  await axisIs(bare, 'x', 'Landscape is horizontal.');
  const box = await bare.locator('.hub-map-box').boundingBox();
  const nowAt = await centreOf(bare.locator('.hub-map-now'));
  assert.ok(Math.hypot(nowAt.x - (box.x + box.width / 2), nowAt.y - (box.y + box.height / 2)) <= 12, `"Now" is centred (${nowAt.x},${nowAt.y}).`);

  step('a window between the thresholds keeps the axis it had');
  const between = async (page, what) => {
    // Resize in one jump to a window whose map frame is about 1.07 times as tall as wide: between 1.0 and 1.15.
    for (let tries = 0; tries < 3; tries += 1) {
      const now = await page.evaluate(() => { const wrap = document.querySelector('.hub-map-wrap'); return { w: wrap.clientWidth, h: wrap.clientHeight, vw: innerWidth, vh: innerHeight }; });
      if (now.h / now.w > 1.02 && now.h / now.w < 1.12) return now.h / now.w;
      const frameW = 700;
      await page.setViewportSize({ width: now.vw - now.w + frameW, height: Math.round(now.vh - now.h + 1.07 * frameW) });
      await page.waitForTimeout(400);
    }
    assert.fail(`${what}: no window with a frame between the thresholds.`);
    return 0;
  };
  const wide = await open({ width: 1280, height: 800 });
  await showMap(wide);
  assert.equal(await axisOf(wide), 'x');
  await between(wide, 'from horizontal');
  await wide.waitForTimeout(300);
  assert.equal(await axisOf(wide), 'x', 'A near-square window stays horizontal.');
  await wide.setViewportSize({ width: 600, height: 1000 });
  await axisIs(wide, 'y', 'A tall window is vertical.');
  const ratio = await between(wide, 'from vertical');
  await wide.waitForTimeout(300);
  assert.equal(await axisOf(wide), 'y', `A near-square window (${ratio.toFixed(2)}) stays vertical.`);
  await wide.setViewportSize({ width: 1280, height: 800 });
  await axisIs(wide, 'x', 'A wide window is horizontal again.');

  step('a desktop is horizontal, and its drawing is the one from before');
  const big = await open({ width: 1920, height: 1080 });
  await showMap(big);
  assert.equal(await axisOf(big), 'x');
  await big.locator('button:has-text("Expand all")').click();
  await big.waitForTimeout(500);
  const plain = await big.evaluate(() => document.querySelector('.hub-map-box svg').outerHTML);
  assert.equal(sha(plain), DESKTOP_EXPANDED_NO_SPRINTS, 'Expanded, without sprints, the svg is what main drew.');
  await big.locator('.hub-map-controls button:has-text("Sprints")').click();
  await big.waitForTimeout(500);
  const withSprints = await big.evaluate(() => document.querySelector('.hub-map-box svg').outerHTML);
  assert.equal(sha(withSprints), DESKTOP_EXPANDED, 'Expanded, with sprints, the svg is what main drew.');
  await noSideways(big, 'Roadmap at 1920');
}
{
  step('a first visit opens Magic Loops, and the chips follow the table order');
  const desk = await open({ width: 1280, height: 800 }, { reducedMotion: 'reduce' });
  await desk.goto(`${fixture.url}#/~hub/map`);
  await desk.locator('.hub-map-wrap').waitFor();
  assert.equal(await desk.locator('.hub-chip.on').innerText(), 'Magic Loops', 'A first visit opens the first project in table order.');
  const names = await desk.locator('.hub-map-chips .hub-chip').allInnerTexts();
  assert.deepEqual(names, ['Magic Loops', 'Workspace app', 'Aardvark', 'Nosprint', 'Wayfind']);

  step('the Runs on chip: full text at desktop width, the rule as its title');
  const chip = desk.locator('.hub-runs');
  assert.equal(await chip.innerText(), 'Runs on: Gaming PC');
  assert.equal(await chip.getAttribute('title'), 'Work for this project runs on the PC by default.');
  await desk.locator('.hub-chip', { hasText: 'Workspace app' }).click();
  await desk.locator('.hub-chip.on', { hasText: 'Workspace app' }).waitFor();
  assert.equal(await chip.innerText(), 'Runs on: cloud');
  assert.equal(await chip.getAttribute('title'), 'This project lives in a GitHub repository, so its work runs in the cloud.');
  await desk.locator('.hub-chip', { hasText: 'Nosprint' }).click();
  await desk.locator('.hub-chip.on', { hasText: 'Nosprint' }).waitFor();
  assert.equal(await desk.locator('.hub-runs').count(), 0, 'A project outside the table has no chip.');

  step('at phone width: short text, one line, nothing sideways');
  const phone = await open({ width: 390, height: 844 }, { hasTouch: true, isMobile: true });
  await phone.goto(`${fixture.url}#/~hub/map`);
  await phone.locator('.hub-map-wrap').waitFor();
  assert.equal(await phone.locator('.hub-chip.on').innerText(), 'Magic Loops');
  assert.equal(await phone.locator('.hub-runs').innerText(), 'Runs on PC');
  assert.equal(await phone.locator('.hub-runs').getAttribute('title'), 'Work for this project runs on the PC by default.');
  assert.match(await phone.locator('.hub-runs').getAttribute('aria-label'), /^Runs on: Gaming PC/);
  await noSideways(phone, 'Roadmap at 390');
  const heights = await phone.evaluate(() => ({ row: document.querySelector('.hub-map-chips').getBoundingClientRect().height, chips: document.querySelector('.hub-map-chips .hub-chips-wrap').getBoundingClientRect().height }));
  console.log(`  chips row height at 390: ${heights.row} (the project chips alone, as on main: ${heights.chips})`);
  assert.ok(heights.row <= heights.chips + 0.5, `The chips row is no taller than on main (${heights.row} > ${heights.chips}).`);
  await phone.locator('.hub-chip', { hasText: 'Workspace app' }).click();
  await phone.locator('.hub-chip.on', { hasText: 'Workspace app' }).waitFor();
  assert.equal(await phone.locator('.hub-runs').innerText(), 'Runs in cloud');
  await noSideways(phone, 'Roadmap at 390 with the longer chip');

  step('a tap on the Runs on chip shows the rule; a second tap, Escape and a tap outside hide it');
  await phone.locator('.hub-chip', { hasText: 'Magic Loops' }).click();
  await phone.locator('.hub-chip.on', { hasText: 'Magic Loops' }).waitFor();
  const ruleText = 'Work for this project runs on the PC by default.';
  const rule = phone.locator('.hub-runs-rule');
  assert.equal(await rule.count(), 0);
  await phone.locator('.hub-runs').tap();
  assert.equal(await rule.innerText(), ruleText);
  assert.equal(await phone.locator('.hub-runs').getAttribute('aria-expanded'), 'true');
  const ruleBox = await rule.boundingBox();
  assert.ok(ruleBox.x >= 0 && ruleBox.x + ruleBox.width <= 390, 'The rule lies inside the screen.');
  await phone.locator('.hub-runs').tap();
  assert.equal(await rule.count(), 0, 'A second tap hides it.');
  await phone.locator('.hub-runs').tap();
  await phone.keyboard.press('Escape');
  assert.equal(await rule.count(), 0, 'Escape hides it.');
  await phone.locator('.hub-runs').tap();
  await phone.touchscreen.tap(20, 600);
  assert.equal(await rule.count(), 0, 'A tap outside hides it.');
  await phone.locator('.hub-chip', { hasText: 'Workspace app' }).click();
  await phone.locator('.hub-chip.on', { hasText: 'Workspace app' }).waitFor();

  step('the Wayfinder row: destination, decisions and open questions at desktop width');
  await go(desk, '#/~hub/map/wayfind');
  await wayfinder(desk, 'Desktop');
  assert.equal(await desk.locator('.hub-wayfinder-dest').innerText(), 'A tidy Roadmap that tells the owner where to go next, and why, in one line.');
  assert.equal(await desk.locator('.hub-wayfinder-count').innerText(), '3 decisions');
  assert.equal(await desk.locator('.hub-wayfinder-toggle').getAttribute('aria-expanded'), 'true', 'The list starts open on a wide box.');
  const links = desk.locator('.hub-wayfinder-list a');
  assert.equal(await links.count(), 2);
  assert.equal(await desk.locator('.hub-runs').count(), 0, 'The Runs on chip is not repeated in this row, and wayfind is not in the table.');
  await links.first().click();
  await desk.locator('.hub-map-panel').waitFor();
  assert.match(await desk.locator('.hub-map-panel').innerText(), /Which project comes first\?/);
  await go(desk, '#/~hub/map/magic-loops');
  await desk.locator('.hub-map-wrap').waitFor();
  assert.equal(await desk.locator('.hub-wayfinder').count(), 0, 'A project without a map issue has no row.');

  step('the Wayfinder row at phone width: one line, collapsed, the map keeps the rest');
  await go(phone, '#/~hub/map/wayfind');
  const rows = await wayfinder(phone, 'Phone');
  const row = () => rows.boundingBox();
  assert.equal(await phone.locator('.hub-wayfinder-toggle').getAttribute('aria-expanded'), 'false');
  assert.equal(await phone.locator('.hub-wayfinder-list').count(), 0);
  const collapsed = await row();
  assert.ok(collapsed.height < 62, `The collapsed row is one line (a 44 px tap target) (${collapsed.height}).`);
  const fits = async what => {
    const view = await phone.evaluate(() => ({ box: document.querySelector('.hub-map-box').getBoundingClientRect().bottom, bar: document.querySelector('.hub').getBoundingClientRect().bottom }));
    assert.ok(Math.abs(view.box - (view.bar - 8)) <= 10, `${what}: the map box still reaches the bottom (${view.box} vs ${view.bar}).`);
  };
  await fits('collapsed');
  await noSideways(phone, 'Wayfinder row at 390 collapsed');
  await phone.locator('.hub-wayfinder-toggle').click();
  assert.equal(await phone.locator('.hub-wayfinder-list a').count(), 2);
  await fits('expanded');
  await noSideways(phone, 'Wayfinder row at 390 expanded');
  const axis = await phone.locator('.hub-map-box').getAttribute('data-axis');
  if (axis !== null) assert.equal(axis, 'y', 'The row does not change the axis.');

  step('the destination itself is the toggle: tap to read it all, tap again to clamp it');
  await showMap(phone, '#/~hub/map/wayfind');
  await wayfinder(phone, 'Phone');
  const text = phone.locator('button.hub-wayfinder-text');
  const dest = phone.locator('.hub-wayfinder-dest');
  const clipped = () => dest.evaluate(node => ({ clipped: node.scrollWidth > node.clientWidth, height: node.getBoundingClientRect().height }));
  const before = await clipped();
  assert.ok(before.clipped, 'The destination is clamped.');
  assert.equal(await text.getAttribute('aria-expanded'), 'false');
  assert.match(await text.innerText(), /More/);
  assert.ok((await text.boundingBox()).height >= 44, 'The tap target is at least 44 px high.');
  await text.tap();
  const after = await clipped();
  assert.equal(await text.getAttribute('aria-expanded'), 'true');
  assert.ok(!after.clipped && after.height > before.height, 'It wraps in full.');
  assert.equal(await phone.locator('.hub-wayfinder-list a').count(), 2, 'The questions show with it.');
  await fits('destination expanded');
  await noSideways(phone, 'destination expanded at 390');
  await text.tap();
  assert.ok((await clipped()).clipped, 'It is clamped again.');
  assert.equal(await phone.locator('.hub-wayfinder-list').count(), 0);
  await phone.locator('.hub-wayfinder-toggle').tap();
  assert.equal(await text.getAttribute('aria-expanded'), 'true', 'The questions button toggles the same state.');
  assert.equal(await phone.locator('.hub-wayfinder-toggle').getAttribute('aria-expanded'), 'true');
  assert.equal(await phone.locator('.hub-map-box').getAttribute('data-axis'), 'y');

  step('with no open questions the destination is still a button that expands');
  fixture.seed.beads('calm', [
    beadsIssue({ id: 'ca-map', title: 'Calm map', type: 'epic', labels: ['wayfinder:map'], created: '2026-10-01T09:00:00Z', updated: '2026-10-20T10:00:00Z', description: '## Destination\n\nA destination long enough to be cut short on a phone, so that the only way to read all of it is to tap the text itself.' }),
    beadsIssue({ id: 'ca-d1', title: 'Decision one', parent: 'ca-map', status: 'closed', closed: '2026-10-10T10:00:00Z', labels: ['wayfinder:decision'], created: '2026-10-02T10:00:00Z' }),
  ], { pushedAt: minutesAgo(fixture.now, 8).toISOString(), host: 'pc.example.test', count: 2, repo: 'example/calm' });
  await showMap(phone, '#/~hub/map/calm');
  await wayfinder(phone, 'Phone, no questions');
  assert.equal(await phone.locator('.hub-wayfinder-toggle').count(), 0, 'There is no Open questions button.');
  const calm = await clipped();
  assert.ok(calm.clipped);
  await text.tap();
  const calmOpen = await clipped();
  assert.ok(!calmOpen.clipped && calmOpen.height > calm.height, 'It expands.');
  assert.equal(await phone.locator('.hub-wayfinder-list').count(), 0);
}

  console.log('hub-map-ui: passed');
} finally {
  for (const context of contexts) await context.close().catch(() => {});
  await browser.close();
  await fixture.close();
}
