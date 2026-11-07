// Run after npm run build. The Roadmap through a real browser, over the hub fixture. Its two axes: vertical on a
// phone held upright, horizontal in landscape and on a desktop, the switch between them keeping the selection, and
// the desktop drawing unchanged from before the vertical layout existed. Where a project's work runs (the Runs on
// chip), which project the Roadmap opens on, and the Wayfinder row. Nested roadmaps (RoadmapRows, mapBranch): the Full map rows, a branch's own map, the bar,
// the saved view, and the phone's axis and sheet clearance with the bar in place.
import { chromium } from '@playwright/test';
import { ms } from './ui-timeouts.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { startHubFixture } from './hub-fixture.mjs';
import { beadsIssue, minutesAgo } from '../../site/api/test/hub-fixtures.mjs';

const step = name => console.log(`- ${name}`);
const channel = process.env.BUW_TEST_BROWSER || 'msedge';

const fixture = await startHubFixture();
// Two more copies so the order matters: `aardvark` sorts before Magic Loops alphabetically but is not in the project table; Discord bots is.
for (const [project, title] of [['aardvark', 'Aardvark milestone'], ['shadowdark', 'Bots milestone']]) {
  fixture.seed.beads(project, [beadsIssue({ id: `${project.slice(0, 2)}-m1`, title, type: 'milestone', created: '2026-10-01T10:00:00Z' })], { pushedAt: minutesAgo(fixture.now, 10).toISOString(), host: 'pc.example.test', count: 1, repo: `example/${project}` });
}
// A project with roadmaps (ws-im1.3.2), next to Aardvark: Hub work holds two rings and the roadmap Editing, whose one loose task is a pile; one old milestone is outside.
const ISO = '2026-10-01T10:00:00Z';
fixture.seed.beads('aardwolf', [
  beadsIssue({ id: 'aw-rm1', title: 'Hub work', type: 'epic', labels: ['roadmap'], created: ISO }),
  beadsIssue({ id: 'aw-f1', title: 'Alpha ring', type: 'feature', parent: 'aw-rm1', labels: ['roadmap'], created: '2026-10-01T10:01:00Z' }),
  beadsIssue({ id: 'aw-t1', title: 'Alpha one', parent: 'aw-f1', labels: ['roadmap'], status: 'closed', closed: '2026-10-02T10:00:00Z', created: '2026-10-01T10:02:00Z' }),
  beadsIssue({ id: 'aw-t2', title: 'Alpha two', parent: 'aw-f1', created: '2026-10-01T10:03:00Z' }),
  beadsIssue({ id: 'aw-f2', title: 'Beta ring', type: 'feature', parent: 'aw-rm1', created: '2026-10-01T10:04:00Z' }),
  beadsIssue({ id: 'aw-t3', title: 'Beta one', parent: 'aw-f2', created: '2026-10-01T10:05:00Z' }),
  beadsIssue({ id: 'aw-rm2', title: 'Editing', type: 'epic', parent: 'aw-rm1', labels: ['roadmap'], created: '2026-10-01T10:06:00Z' }),
  beadsIssue({ id: 'aw-t4', title: 'Zebra stripes', parent: 'aw-rm2', created: '2026-10-01T10:07:00Z' }),
  beadsIssue({ id: 'aw-m0', title: 'Old milestone', type: 'milestone', created: '2026-10-01T10:08:00Z' }),
  beadsIssue({ id: 'aw-t5', title: 'Old task', parent: 'aw-m0', created: '2026-10-01T10:09:00Z' }),
], { pushedAt: minutesAgo(fixture.now, 10).toISOString(), host: 'pc.example.test', count: 10, repo: 'example/aardwolf' });
const browser = await chromium.launch({ headless: true, channel });
const contexts = [];
const open = async (viewport, options = {}) => {
  const context = await browser.newContext({ viewport, reducedMotion: 'reduce', ...options });
  contexts.push(context);
  // These tests draw the whole map; the Roadmap's default filter (Open) is covered by hub-map-filter-ui.mjs.
  await context.addInitScript(() => { try { localStorage.setItem('hub-map-filter', JSON.stringify({ states: ['doing', 'you', 'next', 'later', 'done'], within: null, from: '', to: '' })); } catch { /* none */ } });
  const page = await context.newPage();
  page.setDefaultTimeout(ms(15000));
  page.on('pageerror', error => { throw error; });
  return page;
};
const noSideways = async (page, what) => {
  const widths = await page.evaluate(() => ({ scroll: document.scrollingElement.scrollWidth, inner: innerWidth, hub: document.querySelector('.hub')?.scrollWidth ?? 0, hubInner: document.querySelector('.hub')?.clientWidth ?? 0 }));
  assert.ok(widths.scroll <= widths.inner, `${what}: the page scrolls sideways (${widths.scroll} > ${widths.inner}).`);
  assert.ok(widths.hub <= widths.hubInner, `${what}: the Hub scrolls sideways (${widths.hub} > ${widths.hubInner}).`);
};
/** The "now" marker (dot, ring and pill) never meets a circle, a chevron, a mark or a label of the map: the bounding boxes of its parts do not intersect theirs. */
const nowClear = async (page, what) => {
  const hits = await page.evaluate(() => {
    const now = document.querySelector('.hub-map-nowg');
    if (!now) return ['no now marker'];
    const parts = [...now.children].map(child => child.getBoundingClientRect());
    return [...document.querySelectorAll('.hub-map-box svg [data-node] *')].filter(element => {
      const rect = element.getBoundingClientRect();
      if (!rect.width || !rect.height || element.closest('.hub-map-nowg')) return false;
      return parts.some(part => rect.left < part.right && rect.right > part.left && rect.top < part.bottom && rect.bottom > part.top);
    }).map(element => `${element.tagName} ${element.textContent.slice(0, 24)} of ${element.closest('[data-node]').dataset.node}`);
  });
  assert.deepEqual(hits, [], `${what}: "now" meets nothing.`);
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
  await page.waitForFunction(wanted => document.querySelector('.hub-map-box')?.dataset.axis === wanted, axis, { timeout: ms(5000) }).catch(() => {});
  assert.equal(await axisOf(page), axis, what);
  await page.waitForTimeout(300);
};
/** The part of the box the panel leaves free: the panel is at the right on a wide screen and a sheet below on a phone. */
const freeCentre = page => page.evaluate(() => {
  const box = document.querySelector('.hub-map-box').getBoundingClientRect();
  const panel = document.getElementById('hub-map-panel')?.getBoundingClientRect();
  if (!panel || !panel.width) return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  // Like the app: a part narrower or lower than 60 px is no room at all, and the node is centred in the box below the hint (a tall sheet under the control bar can leave less).
  const hint = document.querySelector('.hub-map-top')?.getBoundingClientRect();
  const lift = hint && hint.height ? Math.max(0, hint.bottom - box.top + 8) : 0;
  const whole = { x: box.left + box.width / 2, y: box.top + lift + (box.height - lift) / 2 };
  if (panel.width < innerWidth * 0.8) { const w = Math.min(Math.max(panel.left - box.left, 0), box.width); return w < 60 ? whole : { x: box.left + w / 2, y: box.top + box.height / 2 }; }
  const h = Math.min(Math.max(panel.top - box.top, 0), box.height);
  return h < 60 ? whole : { x: box.left + box.width / 2, y: box.top + h / 2 };
});

/** `svg.outerHTML` of the Roadmap of the fixture's magic-loops with Expand all and Sprints on at 1920x1080, SHA-256: the horizontal drawing as of ws-1kw (every ring says what it counts in words, with a done arc; an open milestone's count after its title, the chevron scaled by CSS; one-line labels, higher levels leave the spine further left, the toggle at the branch's elbow). */
const DESKTOP_EXPANDED = '3f9a7e2b0b496a072efde3249a1b923836e18aea49033dfdd23fb157cc3afa67';
const DESKTOP_EXPANDED_NO_SPRINTS = '4aa7d66def5b8dd3da5d065649bd5a440d79ec1f948467e6d4cac8c6f5e2bbf0';
const sha = text => createHash('sha256').update(text).digest('hex');

// The exact hashes above hold only on the machine that recorded them: the map is laid out from measured text widths, and a
// Linux runner's fonts measure differently, so every coordinate moves (ws-aql). So the test checks two things. The structure
// hash (STRUCTURE_*) is the same everywhere: it covers the tags, classes, data-* attributes, the style (the state colours) and label texts in order, and
// leaves out every number that comes from geometry (and the style's transform-origin, which is one). The exact hash is checked only where it was recorded (EXACT_ON).
const EXACT_ON = 'win32';
const GEOMETRY = new Set(['x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'width', 'height', 'd', 'points', 'transform', 'viewBox', 'dx', 'dy', 'textLength', 'font-size']);
/** The svg both ways: its raw markup, and as lines of tag, non-geometry attributes and own text, indented by depth. */
const svgForms = page => page.evaluate(geometry => {
  const skip = new Set(geometry);
  const lines = [];
  const walk = (element, depth) => {
    // `style` stays (it carries the state colours), minus the declarations that are positions: transform-origin is in px of the measured text.
    const value = attribute => (attribute.name === 'style' ? attribute.value.split(';').map(part => part.trim()).filter(part => part && !/^transform-origin\s*:/i.test(part)).join('; ') : attribute.value);
    const attributes = [...element.attributes].filter(attribute => !skip.has(attribute.name)).map(attribute => `${attribute.name}=${value(attribute)}`).sort();
    const own = [...element.childNodes].filter(node => node.nodeType === 3).map(node => node.textContent.trim()).filter(Boolean).join(' ');
    lines.push(`${' '.repeat(depth)}${element.tagName.toLowerCase()} ${attributes.join(' ')}${own ? ` "${own}"` : ''}`);
    for (const child of element.children) walk(child, depth + 1);
  };
  const svg = document.querySelector('.hub-map-box svg');
  walk(svg, 0);
  return { raw: svg.outerHTML, structure: lines.join(String.fromCharCode(10)) };
}, [...GEOMETRY]);
const STRUCTURE_EXPANDED = '6b316fc34a972674bc909b9da9619ff770ce1c685c99a2e1f6e2849b40b377da';
const STRUCTURE_EXPANDED_NO_SPRINTS = '7b45ae19c25525e24f22e6e751f39624a5b80d3d1a998b4638449b9c06ea5ebe';
/** Checks a drawing against its recorded hashes; a mismatch says the actual hash, so a recording is one copy away. */
const sameDrawing = (forms, structureHash, exactHash, what) => {
  assert.equal(sha(forms.structure), structureHash, `${what}: the structure of the svg changed (structure hash ${sha(forms.structure)}).`);
  if (process.platform === EXACT_ON) assert.equal(sha(forms.raw), exactHash, `${what}: the svg is the recorded drawing (hash ${sha(forms.raw)}).`);
};

// The Wayfinder row of the project just opened: waits for the map under it (they mount together), then requires exactly one row. A second row is a double mount, never a timing slip.
const wayfinder = async (page, what) => {
  await page.locator('.hub-map-wrap').waitFor();
  const rows = page.locator('.hub-wayfinder');
  await rows.first().waitFor();
  assert.equal(await rows.count(), 1, `${what}: the Wayfinder row is mounted once.`);
  // The owner's order: the project header and tabs (the page's), then the controls, then the Destination row, then the map.
  const order = await page.evaluate(() => ['.pp-tabs', '.hub-map-controls', '.hub-wayfinder', '.hub-map-wrap'].map(selector => Math.round(document.querySelector(selector).getBoundingClientRect().top)));
  assert.ok(order.every((top, k) => k === 0 || top >= order[k - 1]) && new Set(order).size === 4, `${what}: tabs, controls, Destination row, map in that order (${order}).`);
  return rows;
};

/** On a phone the rarely used buttons are in one overflow button. */
const more = async (page, name) => {
  await page.locator('.hub-map-controls [data-row-menu]').tap();
  await page.getByRole('menuitem', { name, exact: true }).tap();
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
  await nowClear(phone, 'upright, collapsed');

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
  assert.equal(await phone.locator('.hub-map-controls button:has-text("Expand all")').count(), 0, 'On a phone Expand all is in the overflow button.');
  await more(phone, 'Expand all');
  await phone.waitForTimeout(500);
  await noSideways(phone, 'Roadmap upright, expanded');
  await inside('upright, expanded');
  await nowClear(phone, 'upright, expanded');
  step('ws-744: every chevron is a 44 px target on touch with a name, an open milestone keeps its count, and the map clears the control bar');
  const chevrons = await phone.evaluate(() => [...document.querySelectorAll('[data-toggle]')].map(element => {
    const rect = element.querySelector('.hub-map-chev-hit').getBoundingClientRect();
    return { id: element.dataset.toggle, w: rect.width, h: rect.height, label: element.getAttribute('aria-label') };
  }));
  assert.ok(chevrons.length >= 4, 'Expanded, the milestones and features have chevrons.');
  for (const chevron of chevrons) {
    assert.ok(chevron.w >= 43.5 && chevron.h >= 43.5, `${chevron.id}: the touch target is at least 44 px (${chevron.w} x ${chevron.h}).`);
    assert.match(chevron.label ?? '', /^(Open|Close) \S/, `${chevron.id}: the chevron has a name.`);
  }
  assert.match(await phone.locator('[data-node="ml-m2"] .hub-map-count').last().textContent(), /^\d+ of \d+ done/, 'The open milestone still says what it counts: done of total.');
  const lowest = await phone.evaluate(() => {
    const bar = document.querySelector('.hub-map-controls').getBoundingClientRect().bottom;
    return { bar, top: Math.min(...[...document.querySelectorAll('.hub-map-box svg [data-node] text')].map(text => text.getBoundingClientRect().top)) };
  });
  assert.ok(lowest.top >= lowest.bar - 1, `After Expand all the first label (${lowest.top}) is below the control bar (${lowest.bar}).`);
  assert.ok(await phone.locator('[data-kind="t"]').count() >= 9, 'Every task is drawn.');
  await more(phone, 'Show sprints');
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
  // The map pans to the node with an animation; give a busy PC time to finish it before judging where it landed.
  let free = await freeCentre(turn);
  let landed = await centreOf(turn.locator('[data-node="ml-m2"] > circle').first());
  for (const end = Date.now() + ms(4000); Math.hypot(landed.x - free.x, landed.y - free.y) > 12 && Date.now() < end;) {
    await turn.waitForTimeout(150);
    free = await freeCentre(turn);
    landed = await centreOf(turn.locator('[data-node="ml-m2"] > circle').first());
  }
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
  // The middle of what the hint (top) leaves.
  const room = await bare.evaluate(() => ({ top: document.querySelector('.hub-map-top')?.getBoundingClientRect().bottom ?? 0, bottom: document.querySelector('.hub-map-box').getBoundingClientRect().bottom }));
  const roomMid = ((room.top ? room.top + 8 : box.y) + room.bottom) / 2;
  assert.ok(Math.hypot(nowAt.x - (box.x + box.width / 2), nowAt.y - roomMid) <= 12, `"Now" is centred (${nowAt.x},${nowAt.y} vs ${roomMid}).`);

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
  await wide.setViewportSize({ width: 600, height: 1200 });
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
  await nowClear(big, 'desktop, collapsed');
  await big.locator('button:has-text("Expand all")').click();
  step('ws-744: on a desktop a chevron is a 32 px target');
  await big.waitForTimeout(400);
  const bigHits = await big.evaluate(() => [...document.querySelectorAll('[data-toggle] .hub-map-chev-hit')].map(element => element.getBoundingClientRect().width));
  assert.ok(bigHits.length > 0 && bigHits.every(width => width >= 31.5), `Desktop chevron targets are at least 32 px (${bigHits.join(', ')}).`);
  await big.waitForTimeout(500);
  sameDrawing(await svgForms(big), STRUCTURE_EXPANDED_NO_SPRINTS, DESKTOP_EXPANDED_NO_SPRINTS, 'Expanded, without sprints');
  await big.locator('.hub-map-controls button:has-text("Sprints")').click();
  await big.waitForTimeout(500);
  sameDrawing(await svgForms(big), STRUCTURE_EXPANDED, DESKTOP_EXPANDED, 'Expanded, with sprints');
  await nowClear(big, 'desktop, expanded, with sprints');
  const laptop = await open({ width: 1280, height: 800 });
  await showMap(laptop);
  await nowClear(laptop, 'laptop, collapsed');
  await laptop.locator('button:has-text("Expand all")').click();
  await laptop.waitForTimeout(500);
  await nowClear(laptop, 'laptop, expanded');
  await noSideways(big, 'Roadmap at 1920');
}
{
  step('Magic Loops opens by address, with the project page around the map and no project picker');
  const desk = await open({ width: 1280, height: 800 }, { reducedMotion: 'reduce' });
  await desk.goto(`${fixture.url}#/~hub/map/magic-loops`);
  await desk.locator('.hub-map-wrap').waitFor();
  assert.equal(await desk.locator('[data-project-title]').innerText(), 'Magic Loops', 'The address names the project.');
  assert.equal(await desk.locator('.hub-map-chips, #hub-map-project').count(), 0, 'The picker is gone: the Projects list is beside the map.');
  assert.equal(await desk.locator('[data-roadmap-view="map"]').getAttribute('aria-pressed'), 'true');

  step('the Runs on chip: full text at desktop width, the rule as its title');
  const chip = desk.locator('.hub-runs');
  assert.equal(await chip.innerText(), 'Runs on: Gaming PC');
  assert.equal(await chip.getAttribute('title'), 'Work for this project runs on the PC by default.');
  await go(desk, '#/~hub/map/shadowdark');
  await desk.locator('[data-project-title]', { hasText: 'Discord bots' }).waitFor();
  assert.equal(await chip.innerText(), 'Runs on: cloud');
  assert.equal(await chip.getAttribute('title'), 'This project lives in a GitHub repository, so its work runs in the cloud.');
  await go(desk, '#/~hub/map/nosprint');
  await desk.locator('[data-project-title]', { hasText: 'Nosprint' }).waitFor();
  assert.equal(await desk.locator('.hub-runs').count(), 0, 'A project outside the table has no chip.');

  step('at phone width: short text, one line, nothing sideways');
  const phone = await open({ width: 390, height: 888 }, { hasTouch: true, isMobile: true });
  await phone.goto(`${fixture.url}#/~hub/map/magic-loops`);
  await phone.locator('.hub-map-wrap').waitFor();
  const shown = () => phone.locator('[data-project-title]').innerText();
  assert.equal(await shown(), 'Magic Loops');
  assert.equal(await phone.locator('.hub-runs').innerText(), 'Runs on PC');
  assert.equal(await phone.locator('.hub-runs').getAttribute('title'), 'Work for this project runs on the PC by default.');
  assert.match(await phone.locator('.hub-runs').getAttribute('aria-label'), /^Runs on: Gaming PC/);
  await noSideways(phone, 'Roadmap at 390');
  await go(phone, '#/~hub/map/shadowdark');
  await phone.locator('[data-project-title]', { hasText: 'Discord bots' }).waitFor();
  assert.equal(await phone.locator('.hub-runs').innerText(), 'Runs in cloud');
  await noSideways(phone, 'Roadmap at 390 with the longer chip');

  step('a tap on the Runs on chip shows the rule; a second tap, Escape and a tap outside hide it');
  await go(phone, '#/~hub/map/magic-loops');
  await phone.locator('[data-project-title]', { hasText: 'Magic Loops' }).waitFor();
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
  await go(phone, '#/~hub/map/shadowdark');
  await phone.locator('[data-project-title]', { hasText: 'Discord bots' }).waitFor();

  step('the Wayfinder row: destination, decisions and open questions at desktop width');
  await go(desk, '#/~hub/map/wayfind');
  await wayfinder(desk, 'Desktop');
  assert.equal(await desk.locator('.hub-wayfinder-dest').innerText(), 'A tidy Roadmap that tells the owner where to go next, and why, in one line.');
  assert.equal(await desk.locator('.hub-wayfinder-count').innerText(), '3 decisions');
  assert.equal(await desk.locator('.hub-wayfinder-toggle').getAttribute('aria-expanded'), 'true', 'The list starts open on a wide box.');
  const links = desk.locator('.hub-wayfinder-list a');
  assert.equal(await links.count(), 4);
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
  assert.equal(await phone.locator('.hub-wayfinder-list a').count(), 4);
  await fits('expanded');
  await noSideways(phone, 'Wayfinder row at 390 expanded');
  // Read the axis once the box has stopped changing size (two animation frames in a row with the same rect), not at a guess.
  await phone.waitForFunction(() => new Promise(resolve => {
    const rect = () => { const r = document.querySelector('.hub-map-box').getBoundingClientRect(); return `${r.width}x${r.height}`; };
    const first = rect();
    requestAnimationFrame(() => requestAnimationFrame(() => resolve(rect() === first)));
  }));
  const axis = await phone.locator('.hub-map-box').getAttribute('data-axis');
  if (axis !== null) assert.equal(axis, 'y', 'The row does not change the axis.');
  assert.equal(await phone.locator('.hub-map-search').isVisible(), false, 'The search row gives its height to the open Wayfinder list.');

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
  assert.equal(await phone.locator('.hub-wayfinder-list a').count(), 4, 'The questions show with it.');
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

{
  step('opening and closing a branch keeps the view still: the toggle and the map stay where they are, the scale does not change, and nothing glides');
  // A Sprint 2 shaped project: one milestone, four features with long titles.
  const features = [['Combat feel and runes', ['Hit stop and screen shake', 'Rune slot inventory', 'Rune effects pass one']], ['Hex map generator (pure C#)', ['Hex grid coordinates', 'Noise terrain pass', 'Region and biome assignment']], ['Enemy telegraphs', ['Wind-up animation set', 'Audio cue pass']], ['First contact encounter', ['Block out the arena', 'Spawn rules']]];
  const issues = [
    beadsIssue({ id: 'sp-m1', title: 'Sprint 1: moving', type: 'milestone', status: 'closed', closed: '2026-10-10T10:00:00Z', created: '2026-10-01T10:00:00Z' }),
    beadsIssue({ id: 'sp-m2', title: 'Sprint 2: feel, first contact', type: 'milestone', blocks: ['sp-m1'], created: '2026-10-02T10:00:00Z' }),
    beadsIssue({ id: 'sp-m3', title: 'Sprint 3: depth', type: 'milestone', blocks: ['sp-m2'], created: '2026-10-03T10:00:00Z' }),
  ];
  features.forEach(([title, tasks], i) => {
    issues.push(beadsIssue({ id: `sp-f${i}`, title, type: 'epic', parent: 'sp-m2', created: `2026-10-02T11:0${i}:00Z` }));
    tasks.forEach((name, j) => issues.push(beadsIssue({ id: `sp-f${i}-t${j}`, title: name, parent: `sp-f${i}`, created: `2026-10-02T12:${i}${j}:00Z` })));
  });
  fixture.seed.beads('sprint2', issues, { pushedAt: minutesAgo(fixture.now, 10).toISOString(), host: 'pc.example.test', count: issues.length, repo: 'example/sprint2' });
  const close = (a, b, what) => assert.ok(Math.hypot(a.x - b.x, a.y - b.y) <= 2, `${what}: ${a.x},${a.y} to ${b.x},${b.y}`);
  for (const [label, viewport, options] of [['desktop', { width: 1280, height: 800 }, {}], ['phone', { width: 390, height: 844 }, { hasTouch: true, isMobile: true }]]) {
    const page = await open(viewport, options);
    await showMap(page, '#/~hub/map/sprint2');
    const toggle = id => page.locator(`[data-toggle="${id}"]`);
    const press = async id => { await toggle(id).dispatchEvent('click'); await page.waitForTimeout(500); };
    const circle = id => centreOf(page.locator(`[data-node="${id}"] > circle`).first());
    const scale = async () => (await viewOf(page))[2];
    await press('sp-m2');
    const k = await scale();
    // The first milestone does not move when the second opens and closes; the toggle and the node being toggled stay put.
    for (const id of ['sp-f0', 'sp-f1', 'sp-m2']) {
      const anchor = await centreOf(toggle(id));
      const first = await circle('sp-m1');
      const second = await circle('sp-m2');
      await press(id);
      close(await centreOf(toggle(id)), anchor, `${label}: ${id} toggle after the first press`);
      close(await circle('sp-m1'), first, `${label}: the map did not move when ${id} changed`);
      if (id !== 'sp-m2') close(await circle('sp-m2'), second, `${label}: ${id}: milestone 2 stays`);
      assert.equal(await scale(), k, `${label}: ${id} did not zoom`);
      await press(id);
      close(await centreOf(toggle(id)), anchor, `${label}: ${id} toggle after the second press`);
      close(await circle('sp-m1'), first, `${label}: the map is back where it was after closing ${id}`);
      assert.equal(await scale(), k, `${label}: closing ${id} did not zoom`);
    }
  }
}

{
  // RoadmapRows and mapBranch (ws-im1.3.2): a project with roadmaps shows the Full map (rows) or one branch (the ordinary map); one without is unchanged.
  const RW = 'aardwolf';
  const rowsOnPage = page => page.locator('[data-roadmap-row]');
  const hashOf = page => page.evaluate(() => location.hash);
  const clean = async page => { await page.evaluate(() => { try { localStorage.removeItem('hub-map-branch'); localStorage.removeItem('hub-map-search'); } catch { /* none */ } }); };
  const settle = async (page, selector) => { await page.locator(selector).first().waitFor(); await page.waitForTimeout(400); };

  step('roadmaps: a project with no roadmap label has no bar and no rows');
  const plain = await open({ width: 1280, height: 800 });
  const answered = plain.waitForResponse(response => /\/map\/magic-loops$/.test(response.url()));
  await showMap(plain, '#/~hub/map/magic-loops');
  assert.equal(await plain.locator('.hub-map-branchbar').count(), 0, 'No bar.');
  assert.equal(await plain.locator('.rm-full').count(), 0, 'No rows.');
  assert.equal((await (await answered).json()).roadmaps, undefined, 'The server leaves roadmaps out.');

  step('roadmaps, desktop: Full map is nested rows with the bar above; a row opens only its milestones; the crumb, the toggle and Back return');
  const desk = await open({ width: 1280, height: 800 });
  await desk.goto(`${fixture.url}#/~hub/map/${RW}`);
  await settle(desk, '.rm-full');
  assert.deepEqual(await rowsOnPage(desk).evaluateAll(list => list.map(row => [row.dataset.roadmapRow, row.dataset.depth])), [['aw-rm1', '0'], ['aw-rm2', '1'], ['~unfiled', '0']], 'Nested rows, then the unfiled row.');
  assert.equal(await desk.locator('.hub-map-box').count(), 0, 'The full map draws no map.');
  const layout = await desk.evaluate(() => ({ chips: document.querySelector('.pp-switch').getBoundingClientRect().bottom, bar: document.querySelector('.hub-map-branchbar').getBoundingClientRect(), rows: document.querySelector('.rm-full').getBoundingClientRect(), scroll: document.scrollingElement.scrollHeight, inner: innerHeight, hubScroll: document.querySelector('.hub').scrollHeight, hubClient: document.querySelector('.hub').clientHeight }));
  assert.ok(layout.bar.top >= layout.chips - 1 && layout.rows.top >= layout.bar.bottom - 1, 'The project tabs and switch, then the bar, then the rows.');
  assert.ok(layout.scroll <= layout.inner && layout.hubScroll <= layout.hubClient, 'The Hub does not scroll.');
  assert.equal(await desk.locator('[data-roadmap-toggle="full"]').getAttribute('aria-current'), 'page');
  await desk.locator('[data-roadmap-row="aw-rm1"]').click();
  await settle(desk, '.hub-map-box svg');
  assert.equal(await hashOf(desk), `#/~hub/map/${RW}/aw-rm1`);
  assert.deepEqual(await desk.locator('[data-kind="m"]').evaluateAll(list => list.map(node => node.dataset.node)), ['aw-f1', 'aw-f2'], 'Only the roadmap\'s own milestones.');
  assert.equal(await desk.locator('[data-roadmap-toggle="branch"]').getAttribute('aria-current'), 'page');
  assert.equal(await desk.locator('[data-crumb="aw-rm1"]').count(), 1, 'The crumb names the branch.');
  assert.equal(await desk.locator('[data-inside="aw-rm2"]').count(), 1, 'The roadmap inside it is a link.');
  const above = await desk.evaluate(() => ({ bar: document.querySelector('.hub-map-branchbar').getBoundingClientRect().bottom, controls: document.querySelector('.hub-map-controls').getBoundingClientRect().top, boxTop: document.querySelector('.hub-map-box').getBoundingClientRect().top, boxBottom: document.querySelector('.hub-map-box').getBoundingClientRect().bottom, inner: innerHeight, scroll: document.scrollingElement.scrollHeight }));
  assert.ok(above.bar <= above.controls + 1 && above.scroll <= above.inner, 'The bar is above the controls and nothing scrolls.');
  assert.ok(above.boxBottom >= above.inner - 24, `The map fills the rest (${above.boxBottom} of ${above.inner}).`);
  await desk.locator('[data-roadmap-toggle="full"]').click();
  await settle(desk, '.rm-full');
  assert.equal(await desk.locator('[data-roadmap-row="aw-rm1"].from').count(), 1, 'The branch the viewer came from is marked.');
  await desk.goBack();
  await settle(desk, '.hub-map-box svg');
  assert.equal(await hashOf(desk), `#/~hub/map/${RW}/aw-rm1`, 'Back returns to the branch.');
  await desk.locator('[data-roadmap-toggle="full"]').click();
  await settle(desk, '.rm-full');
  await desk.locator('[data-roadmap-toggle="branch"]').click();
  await settle(desk, '.hub-map-box svg');
  assert.equal(await hashOf(desk), `#/~hub/map/${RW}/aw-rm1`, 'This branch goes back to the branch last in.');
  await desk.locator('[data-inside="aw-rm2"]').click();
  await settle(desk, '.hub-map-box svg');
  assert.deepEqual(await desk.locator('[data-kind="m"]').evaluateAll(list => list.map(node => node.dataset.node)), ['aw-rm2~tasks'], 'The loose tasks of a roadmap are one pile.');
  await desk.locator('[data-crumb="project"]').click();
  await desk.locator('[data-project-page]').waitFor();

  step('roadmaps: a link to a bead in another branch opens that branch with its panel; closing stays; a wrong id leaves the address; the view is kept across a reload');
  await desk.goto(`${fixture.url}#/~hub/map/${RW}/aw-rm1`);
  await settle(desk, '.hub-map-box svg');
  await desk.goto(`${fixture.url}#/~hub/map/${RW}/aw-t5`);
  await desk.locator('.hub-map-panel').waitFor();
  assert.deepEqual(await desk.locator('[data-kind="m"]').evaluateAll(list => list.map(node => node.dataset.node)), ['aw-m0'], 'The bead\'s own branch (not in a roadmap).');
  assert.equal(await desk.locator('[data-crumb="~unfiled"]').count(), 1);
  await desk.locator('.hub-map-panel-close').click();
  await desk.locator('.hub-map-panel').waitFor({ state: 'detached' });
  assert.equal(await hashOf(desk), `#/~hub/map/${RW}/~unfiled`, 'Closing the panel stays in the branch.');
  await desk.goto(`${fixture.url}#/~hub/map/${RW}/nonsense`);
  await settle(desk, '.hub-map-box svg');
  assert.equal(await hashOf(desk), `#/~hub/map/${RW}/nonsense`, 'A wrong id leaves the address alone.');
  assert.equal(await desk.locator('.hub-map-panel').count(), 0);
  await desk.goto(`${fixture.url}#/~hub/map/${RW}`);
  await desk.reload();
  await settle(desk, '.hub-map-box svg');
  assert.equal(await desk.locator('[data-kind="m"]').first().getAttribute('data-node'), 'aw-m0', 'A bare address opens what was last shown.');
  await desk.goto(`${fixture.url}#/~hub/map/${RW}/~full`);
  await desk.reload();
  await settle(desk, '.rm-full');
  await desk.goto(`${fixture.url}#/~hub/map/${RW}`);
  await desk.reload();
  await settle(desk, '.rm-full');
  await desk.goto(`${fixture.url}#/~hub/map/magic-loops`);
  await desk.reload();
  await settle(desk, '.hub-map-box svg');
  assert.equal(await desk.locator('.hub-map-branchbar').count(), 0, 'Another project has its own choice.');
  await desk.evaluate(() => localStorage.setItem('hub-map-branch', JSON.stringify({ aardwolf: { view: 'branch', branch: 'gone' } })));
  await desk.goto(`${fixture.url}#/~hub/map/${RW}`);
  await desk.reload();
  await settle(desk, '.rm-full');

  step('roadmaps: a word in a task of another branch is "No matches" with a link to the full map, whose search finds it and opens it in its branch');
  await clean(desk);
  await desk.goto(`${fixture.url}#/~hub/map/${RW}/aw-rm1`);
  await settle(desk, '.hub-map-box svg');
  await desk.locator('[data-map-search]').fill('zebra');
  await desk.locator('[data-map-count]', { hasText: 'No matches' }).waitFor();
  await desk.locator('[data-map-full]').click();
  await settle(desk, '.rm-full');
  assert.equal(await desk.locator('[data-roadmap-search]').inputValue(), 'zebra', 'The full map shares the search.');
  await desk.locator('[data-roadmap-hit="aw-t4"]').waitFor();
  await desk.locator('[data-roadmap-hit="aw-t4"]').click();
  await desk.locator('.hub-map-panel').waitFor();
  assert.equal(await hashOf(desk), `#/~hub/map/${RW}/aw-t4`);
  assert.equal(await desk.locator('[data-crumb="aw-rm2"]').count(), 1, 'It opened in its own branch.');
  await clean(desk);

  step('roadmaps, blocked storage for the Roadmap keys still renders');
  const blocked = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' });
  contexts.push(blocked);
  // The app shell itself needs storage; what is blocked here is the Roadmap's own keys (hub-map-*).
  await blocked.addInitScript(() => { for (const name of ['getItem', 'setItem', 'removeItem']) { const real = Storage.prototype[name]; Storage.prototype[name] = function guarded(key, ...rest) { if (String(key).startsWith('hub-map-')) throw new Error('blocked'); return real.call(this, key, ...rest); }; } });
  const stuck = await blocked.newPage();
  stuck.setDefaultTimeout(ms(15000));
  await stuck.goto(`${fixture.url}#/~hub/map/${RW}`);
  await settle(stuck, '.rm-full');
  await stuck.locator('[data-roadmap-row="aw-rm1"]').click();
  await settle(stuck, '.hub-map-box svg');

  step('roadmaps, phone: the box stays vertical at rest, after Full to branch and with a sheet; every control is 44 px');
  const phone = await open({ width: 390, height: 844 }, { hasTouch: true, isMobile: true });
  await phone.goto(`${fixture.url}#/~hub/map/${RW}`);
  await settle(phone, '.rm-full');
  const sized = async what => {
    const sizes = await phone.evaluate(() => ({ bar: document.querySelector('.hub-map-branchbar').getBoundingClientRect().height, toggles: [...document.querySelectorAll('.rm-toggle a')].map(item => item.getBoundingClientRect().height), rows: [...document.querySelectorAll('[data-roadmap-row]')].map(item => item.getBoundingClientRect().height) }));
    assert.ok(sizes.bar >= 44 && sizes.toggles.every(height => height >= 44) && sizes.rows.every(height => height >= 44), `${what}: bar, toggle and rows are at least 44 px (${JSON.stringify(sizes)}).`);
  };
  await sized('full map');
  await noSideways(phone, 'full map at 390');
  await phone.locator('[data-roadmap-row="aw-rm1"]').tap();
  await settle(phone, '.hub-map-box svg');
  await axisIs(phone, 'y', 'The box is vertical after Full map to a branch.');
  await sized('branch');
  await noSideways(phone, 'branch at 390');
  const fill = await phone.evaluate(() => ({ bottom: document.querySelector('.hub-map-box').getBoundingClientRect().bottom, tabs: document.querySelector('[data-tabs]')?.getBoundingClientRect().top ?? innerHeight }));
  assert.ok(Math.abs(fill.bottom - (fill.tabs - 8)) <= 10, `The box fills down to the tab bar (${fill.bottom} vs ${fill.tabs}).`);
  await phone.locator('[data-node="aw-f1"] > circle').first().tap({ force: true });
  const sheet = phone.locator('.hub-map-panel');
  await sheet.waitFor();
  await phone.waitForTimeout(400);
  await axisIs(phone, 'y', 'The box stays vertical with a sheet open.');
  const sheetBox = await sheet.boundingBox();
  const boxTop = (await phone.locator('.hub-map-box').boundingBox()).y;
  assert.ok(sheetBox.y - boxTop >= 100, `An open sheet leaves the map at least 100 px above it (${sheetBox.y - boxTop}).`);
  await noSideways(phone, 'branch with the sheet');
}


  console.log('hub-map-ui: passed');
} finally {
  for (const context of contexts) await context.close().catch(() => {});
  await browser.close();
  await fixture.close();
}
