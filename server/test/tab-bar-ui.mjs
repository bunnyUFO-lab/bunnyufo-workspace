// Run after npm run build. Isolated repository, registry and browser profile; the fixture
// workspace is the only thing written.
//
// A card's tab bar stays one row at every width. Tabs hidden past an edge show a fade there
// (and an arrow on a mouse), and the active tab is always scrolled into view.
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createService } from '../server.mjs';
import { addWorkspace } from '../workspaces.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
await mkdir(path.join(root, '.cache'), { recursive: true });
const base = await mkdtemp(path.join(root, '.cache/tab-bar-ui-'));
const today = new Date().toISOString().slice(0, 10);

// Most names are 6 to 14 characters; three are about 45 so they hit the 36ch cap.
const names = [
  'Overview', 'Goals', 'Timeline', 'Research', 'Interviews', 'Sketches', 'Wireframes',
  'A very long section name that needs an ellipsis', 'Prototype', 'Feedback', 'Decisions',
  'Another very long section name that gets clipped', 'Risks', 'Budget', 'Schedule', 'Handoff',
  'Yet another very long name that must be clipped', 'Launch', 'Review', 'Archive',
];
const stepsOf = list => list.map((name, i) => ({ name, path: `${String(i).padStart(2, '0')}.html` }));
const entity = (id, title, steps) => ({
  id, folder: id, title, description: 'A fixture card.', category: 'test',
  created: today, updated: today, status: 'active', steps,
});
const many = entity('many-tabs', 'Many tabs', stepsOf(names));
const few = entity('few-tabs', 'Few tabs', stepsOf(['One', 'Two', 'Three']));
const long = entity('long-card', 'Long card', [{ name: 'Long page', path: '00.md' }]);
const dir = path.join(base, 'ws');
for (const card of [many, few]) {
  await mkdir(path.join(dir, card.folder), { recursive: true });
  for (const [i, step] of card.steps.entries()) await writeFile(path.join(dir, card.folder, step.path), `<h1>Tab ${String(i).padStart(2, '0')}</h1>`);
}
await mkdir(path.join(dir, long.folder), { recursive: true });
await writeFile(path.join(dir, long.folder, '00.md'), Array.from({ length: 120 }, (_, i) => `Paragraph ${i} of a long page.`).join(String.fromCharCode(10, 10)));
await writeFile(path.join(dir, 'workspace.json'), JSON.stringify({ entities: [many, few, long] }, null, 2));
const repo = await mkdtemp(path.join(root, '.cache/tab-bar-ui-app-'));
for (const d of ['workspace', 'inbox', 'projects']) await mkdir(path.join(repo, d), { recursive: true });
await writeFile(path.join(repo, 'workspace/workspace.json'), JSON.stringify({ entities: [] }, null, 2));
const registryFile = path.join(base, 'registry/workspaces.json');
await mkdir(path.dirname(registryFile), { recursive: true });
await addWorkspace({ registryFile, path: dir, name: 'Fixture', activate: true });

const oneRow = async (page, label) => {
  const tops = await page.$$eval('.step-tab', tabs => tabs.map(tab => tab.offsetTop));
  assert.ok(tops.length > 0, `${label}: tabs render`);
  assert.equal(new Set(tops).size, 1, `${label}: every tab sits on one row (${[...new Set(tops)]})`);
};
const noSideways = async (page, label) => {
  const m = await page.evaluate(() => ({
    page: document.scrollingElement.scrollWidth, inner: innerWidth,
    bar: document.querySelector('.topbar').scrollWidth, barClient: document.querySelector('.topbar').clientWidth,
  }));
  assert.ok(m.page <= m.inner, `${label}: the page does not scroll sideways (${m.page} > ${m.inner})`);
  assert.ok(m.bar <= m.barClient, `${label}: the topbar does not overflow (${m.bar} > ${m.barClient})`);
};
const activeInView = async (page, label) => {
  const m = await page.evaluate(() => {
    const a = document.querySelector('.step-tab.active')?.getBoundingClientRect();
    const t = document.querySelector('.step-tabs').getBoundingClientRect();
    return a && { aLeft: a.left, aRight: a.right, tLeft: t.left, tRight: t.right };
  });
  assert.ok(m, `${label}: there is an active tab`);
  assert.ok(m.aLeft >= m.tLeft - 1 && m.aRight <= m.tRight + 1, `${label}: the active tab is inside the bar (${JSON.stringify(m)})`);
};
const cue = page => page.evaluate(() => {
  const wrap = document.querySelector('.step-tabs-wrap');
  const list = document.querySelector('.step-tabs');
  if (!list) return { overflow: undefined, mask: 'none', arrows: [] };
  const style = getComputedStyle(list);
  const arrows = [...document.querySelectorAll('.step-tabs-arrow')]
    .filter(a => { const r = a.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(a).visibility !== 'hidden'; })
    .map(a => a.dataset.edge);
  return { overflow: wrap?.dataset.overflow, mask: style.maskImage || style.webkitMaskImage || 'none', arrows };
});
// The round buttons beside the tabs keep their size however many tabs there are.
const buttonsKeepSize = async (page, label) => {
  const widths = await page.$$eval('.open-ext', els => els.map(el => Math.round(el.getBoundingClientRect().width)));
  assert.ok(widths.length > 0, `${label}: the round buttons render`);
  assert.deepEqual(widths.filter(w => w !== 28), [], `${label}: every round button stays 28 px wide (${widths})`);
};
const scrollLeft = page => page.$eval('.step-tabs', el => el.scrollLeft);
// Smooth scrolling takes a moment: wait until two reads in a row agree.
const settled = async page => {
  let last = -1;
  for (let tries = 0; tries < 60; tries++) {
    const now = await scrollLeft(page);
    if (now === last) return now;
    last = now;
    await page.waitForTimeout(150);
  }
  return last;
};
const untilOverflow = async (page, expected, label) => {
  let got;
  for (let tries = 0; tries < 50; tries++) {
    got = (await cue(page)).overflow;
    if (got === expected) return;
    await page.waitForTimeout(100);
  }
  assert.equal(got, expected, `${label}: overflow`);
};

const service = await createService({ repo, uiDir: path.join(root, 'dist'), registryFile });
let browser;
try {
  browser = await chromium.launch({ headless: true, channel: process.env.BUW_TEST_BROWSER || 'msedge' });
  const errors = [];
  const open = async (context, hash) => {
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(service.urls.workspace + hash);
    await page.locator('.step-tab').first().waitFor();
    await page.waitForTimeout(400);
    return page;
  };

  // 1. Desktop, the last tab named: it is active and in view. (With no step a card opens on its first tab.)
  const desktop = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  let page = await open(desktop, `#/many-tabs/${names.length - 1}`);
  await oneRow(page, '1280 many');
  const height = await page.$eval('.step-tabs', el => el.getBoundingClientRect().height);
  assert.ok(height < 40, `the tab row is under 40 px tall (${height})`);
  await activeInView(page, '1280 last tab');
  let c = await cue(page);
  assert.equal(c.overflow, 'start', 'only the start edge hides tabs');
  assert.notEqual(c.mask, 'none', 'the fade is drawn');
  assert.deepEqual(c.arrows, ['start'], 'only the start arrow shows');
  await noSideways(page, '1280 many');
  await buttonsKeepSize(page, '1280 many');

  // 2. Arrow right wraps to the first tab.
  const slide = await page.evaluate(() => new Promise(resolve => {
    const list = document.querySelector('.step-tabs');
    const seen = [];
    const t0 = performance.now();
    const tick = () => { seen.push(Math.round(list.scrollLeft)); if (performance.now() - t0 < 600) requestAnimationFrame(tick); else resolve(seen); };
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    requestAnimationFrame(tick);
  }));
  assert.ok(new Set(slide.filter(v => v > 0)).size > 2, `changing tab slides instead of jumping (${[...new Set(slide)]})`);
  await page.waitForFunction(() => document.querySelector('.step-tab.active')?.textContent === 'Overview');
  assert.equal(await settled(page), 0, 'scrolled back to the start');
  await activeInView(page, 'wrapped to first');
  await untilOverflow(page, 'end', 'wrapped to first');

  // 3. The end arrow scrolls the bar.
  await page.locator('.step-tabs-arrow[data-edge="end"]').click();
  const moved = await settled(page);
  assert.ok(moved > 0, `the end arrow scrolled the bar (${moved})`);
  assert.match((await cue(page)).overflow, /start/, 'the start edge now hides tabs too');

  // 4. A step in the hash.
  await page.goto(service.urls.workspace + '#/many-tabs/10');
  await page.reload();
  await page.locator('.step-tab.active').waitFor();
  await page.waitForTimeout(400);
  await activeInView(page, 'step 10');
  await untilOverflow(page, 'start end', 'step 10');

  // 5. A short card needs no cue.
  await page.goto(service.urls.workspace + '#/few-tabs/0');
  await untilOverflow(page, '', 'few tabs');
  c = await cue(page);
  assert.equal(c.mask, 'none', 'no fade on a short card');
  assert.deepEqual(c.arrows, [], 'no arrows on a short card');
  await desktop.close();

  // 6. A phone, the last tab named.
  const phone = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });
  page = await open(phone, `#/many-tabs/${names.length - 1}`);
  await oneRow(page, '375 many');
  await activeInView(page, '375 last tab');
  await noSideways(page, '375 many');
  await buttonsKeepSize(page, '375 many');
  c = await cue(page);
  assert.notEqual(c.mask, 'none', '375: the fade is drawn');
  assert.deepEqual(c.arrows, [], '375: no arrows on touch');
  await page.$eval('.step-tabs', el => { el.scrollLeft = 0; });
  await untilOverflow(page, 'end', '375 scrolled to start');
  await phone.close();

  // 7. A 390 px phone on the first tab.
  const phone2 = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  page = await open(phone2, '#/many-tabs/0');
  await oneRow(page, '390 many');
  await activeInView(page, '390 first tab');
  await noSideways(page, '390 many');
  await phone2.close();

  // 8. A phone at the bottom of a long page: the header hides and shows with the scroll
  // direction, and the page growing under it must not read as a scroll up (it would flip forever).
  const reader = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  page = await reader.newPage();
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(service.urls.workspace + '#/long-card');
  await page.locator('.markdown-reader').waitFor();
  await page.waitForTimeout(500);
  const scrollTo = y => page.evaluate(top => document.querySelector('.markdown-reader').scrollTo(0, top), y);
  const max = () => page.evaluate(() => { const r = document.querySelector('.markdown-reader'); return r.scrollHeight - r.clientHeight; });
  const hiddenNow = () => page.evaluate(() => document.documentElement.dataset.chromeHidden !== undefined);
  // Read down to the bottom in flicks, up a little (the header shows), then down to the bottom again.
  for (let y = 0; y < 6000; y += 150) { await scrollTo(y); await page.waitForTimeout(16); }
  await page.waitForTimeout(300);
  assert.equal(await hiddenNow(), true, 'reading down hides the header');
  await scrollTo((await max()) - 40);
  await page.waitForTimeout(300);
  assert.equal(await hiddenNow(), false, 'a flick up shows the header');
  for (let y = (await page.evaluate(() => document.querySelector('.markdown-reader').scrollTop)); y < 6000; y += 30) { await scrollTo(y); await page.waitForTimeout(16); }
  const samples = [];
  for (let i = 0; i < 40; i++) { samples.push(await page.evaluate(() => [document.documentElement.dataset.chromeHidden !== undefined, Math.round(document.querySelector('.topbar').getBoundingClientRect().top), Math.round(document.querySelector('.markdown-reader').scrollTop)].join())); await page.waitForTimeout(50); }
  assert.equal(new Set(samples).size, 1, `the header and the scroll position hold still at the bottom (${[...new Set(samples)]})`);
  await reader.close();

  // 9.
  assert.deepEqual(errors, [], 'no page errors');
  console.log('tab-bar-ui: ok');
} finally { await browser?.close(); await service.close(); }
