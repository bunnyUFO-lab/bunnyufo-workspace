// Run after npm run build. The new shell (rail, tabs, Back, redirects, motion) through a real browser, over the Hub fixture service
// with a fake Hermes (so Chat is offered) and over a stand-in for the signed-out site (a guest).
import { chromium } from '@playwright/test';
import { ms } from './ui-timeouts.mjs';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startHubFixture } from './hub-fixture.mjs';
import { hashOf, noSideways, openLibrary } from './shell-helpers.mjs';
import { listenOnGoodPort } from '../listen.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const step = name => console.log(`- ${name}`);
const channel = process.env.BUW_TEST_BROWSER || 'msedge';
const fixture = await startHubFixture({ hermes: true });
const browser = await chromium.launch({ headless: true, channel });
const contexts = [];
const open = async (viewport, options = {}) => {
  const context = await browser.newContext({ viewport, serviceWorkers: 'block', ...options });
  contexts.push(context);
  const page = await context.newPage();
  page.setDefaultTimeout(ms(15000));
  page.on('pageerror', error => { throw error; });
  return page;
};
const navs = (page, container) => page.locator(`${container} [data-nav]`).evaluateAll(list => list.map(item => item.getAttribute('data-nav')));
const tall = async (page, selector, what) => {
  const boxes = await page.locator(selector).evaluateAll(list => list.map(item => { const box = item.getBoundingClientRect(); return [box.width, box.height]; }));
  assert.ok(boxes.length > 0, `${what}: there is something to measure.`);
  for (const [width, height] of boxes) assert.ok(width >= 44 && height >= 44, `${what}: a target is ${width} x ${height}, under 44 px.`);
};

let stub;
try {
  step('phone: opening the site with no address shows Today, and the address says so');
  const phone = await open({ width: 390, height: 800 });
  await phone.goto(fixture.url);
  await phone.locator('.hub[data-screen="today"]').waitFor();
  assert.equal(await hashOf(phone), '#/~hub/today');

  step('phone: five tabs in order, each 44 px or more, the Needs count on Today, no More, no "...", no side bar to open');
  assert.deepEqual(await navs(phone, '[data-tabs]'), ['today', 'chat', 'library', 'project', 'search']);
  await tall(phone, '[data-tabs] [data-nav]', 'a tab');
  assert.equal(await phone.locator('[data-tabs] [data-hub-badge]').innerText(), '3');
  assert.equal(await phone.locator('[data-tabs] [data-nav="today"]').getAttribute('aria-current'), 'page');
  for (const gone of ['[data-hub-tab="more"]', '.rail-toggle', '.sidebar-reopen', '.sidebar', '[data-rail]', '.files-container']) assert.equal(await phone.locator(gone).count(), 0, `${gone} is not drawn on a phone.`);
  await noSideways(phone, 'Today at 390');

  step('phone: Work from Today has a Back button and no tabs, nothing lit; browser back returns to Today');
  await phone.locator('[aria-label="Delivered"] a.today-all').click();
  await phone.locator('.hub[data-screen="jobs"]').waitFor();
  assert.equal(await phone.locator('[data-tabs]').count(), 0, 'No tabs on Work.');
  await tall(phone, '[data-top="detail"] [data-back]', 'Back');
  await phone.goBack();
  await phone.locator('.hub[data-screen="today"]').waitFor();
  assert.equal(await hashOf(phone), '#/~hub/today');

  step('phone: old links are rewritten in place: inbox, board and roadmap');
  await phone.goto(`${fixture.url}#/~hub/inbox`);
  await phone.locator('.hub[data-screen="needs"]').waitFor();
  assert.equal(await hashOf(phone), '#/~hub/needs');
  await phone.goto(`${fixture.url}#/~hub/board`);
  await phone.locator('.hub[data-screen="work"]').waitFor();
  assert.equal(await hashOf(phone), '#/~hub/work');
  await phone.goto(`${fixture.url}#/~hub/roadmap/magic-loops`);
  await phone.locator('.pp[data-view="map"]').waitFor();
  assert.equal(await hashOf(phone), '#/~hub/map/magic-loops');
  await phone.goto(`${fixture.url}#/~hub/nonsense`);
  await phone.locator('.hub[data-screen="today"]').waitFor();
  assert.equal(await hashOf(phone), '#/~hub/today');

  step('phone: a card link shows the card with the tab bar (Library lit) and a Back button; Back goes to the Library and stays in the app');
  // A fresh tab: a link opened from somewhere else has nothing of ours behind it.
  const shared = await open({ width: 390, height: 800 });
  await shared.goto(`${fixture.url}#/hub`);
  await shared.locator('.buw-markdown h1', { hasText: 'The hub card' }).waitFor();
  assert.equal(await shared.locator('[data-tabs]').count(), 1, 'The tab bar stays on a card.');
  assert.equal(await shared.locator('[data-tabs] [data-nav="library"]').getAttribute('aria-current'), 'page', 'with the Library lit');
  await tall(shared, '.topbar [data-back]', 'The card page Back');
  await shared.locator('.topbar [data-back]').click();
  await shared.locator('[data-library]').waitFor();
  assert.equal(await hashOf(shared), '#/~hub/library');
  assert.equal(new URL(shared.url()).origin, new URL(fixture.url).origin, 'Back did not leave the app.');
  assert.equal(await shared.locator('[data-tabs] [data-nav="library"]').getAttribute('aria-current'), 'page');
  await noSideways(shared, 'Library at 390');

  step('phone: nothing scrolls sideways at 320, in the Library or on Today');
  await shared.setViewportSize({ width: 320, height: 700 });
  await noSideways(shared, 'Library at 320');
  await phone.setViewportSize({ width: 320, height: 700 });
  await phone.goto(`${fixture.url}#/~hub/today`);
  await phone.locator('.hub[data-screen="today"]').waitFor();
  await noSideways(phone, 'Today at 320');
  await phone.setViewportSize({ width: 390, height: 800 });

  step('nothing fades between screens: the motion is a 14 px slide, and no frame of it has an opacity');
  const motion = await phone.evaluate(() => {
    const rules = [...document.styleSheets].flatMap(sheet => { try { return [...sheet.cssRules]; } catch { return []; } }).filter(rule => rule.type === CSSRule.KEYFRAMES_RULE && /^ui-from-/.test(rule.name));
    return rules.map(rule => rule.cssText);
  });
  assert.equal(motion.length, 2, 'Both directions are defined.');
  for (const text of motion) { assert.match(text, /14px/); assert.doesNotMatch(text, /opacity/); }
  await phone.locator('[data-tabs] [data-nav="library"]').click();
  await phone.locator('[data-library]').waitFor();
  assert.match(await phone.evaluate(() => getComputedStyle(document.querySelector('.ui-screen')).animationName), /ui-from-(right|left)/);
  const calm = await open({ width: 390, height: 800 }, { reducedMotion: 'reduce' });
  await calm.goto(`${fixture.url}#/~hub/today`);
  await calm.locator('.hub[data-screen="today"]').waitFor();
  assert.equal(await calm.evaluate(() => getComputedStyle(document.querySelector('.ui-screen')).animationDuration), '1e-05s', 'Reduced motion switches the slide off.');

  step('desktop: the rail is in the mockup order with Today lit and the Needs count, and has no Operate, Plan or Know');
  const desk = await open({ width: 1280, height: 900 });
  // The local service restores the last route it saw, so a desktop that follows the phone above starts from an address.
  await desk.goto(`${fixture.url}#/~hub/today`);
  await desk.locator('.hub[data-screen="today"]').waitFor();
  assert.deepEqual(await navs(desk, '[data-rail]'), ['search', 'today', 'chat', 'library', 'project', 'work', 'team', 'sketch', 'settings']);
  assert.equal(await desk.locator('[data-rail] [data-nav="today"]').getAttribute('aria-current'), 'page');
  assert.equal(await desk.locator('[data-rail] [data-hub-badge]').innerText(), '3');
  const railText = await desk.locator('[data-rail]').innerText();
  for (const heading of ['Operate', 'Plan', 'Know']) assert.ok(!railText.includes(heading), `${heading} is gone.`);
  await tall(desk, '[data-rail] [data-nav]', 'A rail entry');
  assert.equal(await desk.locator('[data-tabs]').count(), 0, 'No tab bar on a desktop.');
  assert.equal(await desk.locator('.rail-toggle').count(), 0);

  step('desktop: the Library is the card list on the left with no Hub links in it; the rail lights Library');
  await openLibrary(desk);
  assert.equal(await desk.locator('[data-library] [data-hub-link], [data-library] [data-hub-group], [data-library] .sidebar-palette').count(), 0);
  assert.equal(await desk.locator('[data-rail] [data-nav="library"]').getAttribute('aria-current'), 'page');

  step('desktop at 1280: a card folds the list, with a Show list button that brings it back');
  await desk.goto(`${fixture.url}#/hub`);
  await desk.locator('.buw-markdown h1', { hasText: 'The hub card' }).waitFor();
  assert.equal(await desk.locator('[data-library]').count(), 0, 'The list is folded beside a card at 1280.');
  await desk.locator('[data-show-list]').click();
  await desk.locator('[data-library] .lib-scroll').waitFor();
  await desk.keyboard.press('[');
  await desk.locator('[data-library]').waitFor({ state: 'detached' });
  const wide = await open({ width: 1500, height: 900 });
  await wide.goto(`${fixture.url}#/hub`);
  await wide.locator('.buw-markdown h1', { hasText: 'The hub card' }).waitFor();
  await wide.locator('[data-library] .lib-scroll').waitFor();
  assert.equal(await wide.locator('[data-show-list]').count(), 0, 'At 1500 the list stays beside the card.');

  step('desktop: Ctrl+K and / open search, Esc closes it and you are where you were');
  await desk.goto(`${fixture.url}#/~hub/today`);
  await desk.locator('.hub[data-screen="today"]').waitFor();
  await desk.keyboard.press('Control+k');
  await desk.locator('dialog[data-search="dialog"]').waitFor();
  assert.equal(await hashOf(desk), '#/~hub/search');
  await desk.keyboard.press('Escape');
  await desk.locator('dialog[data-search="dialog"]').waitFor({ state: 'detached' });
  assert.equal(await hashOf(desk), '#/~hub/today');
  await desk.locator('.hub[data-screen="today"]').waitFor();
  await desk.locator('.hub').click({ position: { x: 5, y: 5 } });
  await desk.keyboard.press('/');
  await desk.locator('dialog[data-search="dialog"]').waitFor();
  await desk.keyboard.press('Control+k');
  await desk.locator('dialog[data-search="dialog"]').waitFor({ state: 'detached' });
  assert.equal(await hashOf(desk), '#/~hub/today');

  step('settings: theme, shortcuts and skill packs are in one screen, reached from the rail');
  await desk.locator('[data-rail] [data-nav="settings"]').click();
  await desk.locator('[data-settings]').waitFor();
  await desk.getByLabel('Workspace theme').waitFor();
  await desk.locator('[data-settings-shortcuts]').getByText('Open search').waitFor();
  assert.equal(await desk.locator('[data-rail] [data-nav="settings"]').getAttribute('aria-current'), 'page');
  await desk.keyboard.press('Control+h');
  await desk.locator('dialog.shortcuts').waitFor();
  await desk.keyboard.press('Escape');

  step('a guest: the same rail and tabs, Chat shows the sign-in line, no Sketch');
  const dist = path.join(root, 'dist');
  const canned = {
    '/api/capabilities': { write: false, create: false, cards: false, hub: true, chat: false, reason: 'Read-only here: sign in at https://site.example.test to change cards.' },
    '/api/card-state': { cards: {} },
    '/sites.json': [{ id: 'one', name: 'One', base: '/w/one' }],
    '/w/one/workspace.json': { entities: [] },
    '/api/hub/today': { counts: { needsYou: 0, running: 0, recent: 0, alerts: 0 }, needsYou: [], running: [], recent: [], alerts: [] },
  };
  stub = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://site');
    const send = (status, type, body) => { response.writeHead(status, { 'Content-Type': type }); response.end(body); };
    if (canned[url.pathname]) return send(200, 'application/json', JSON.stringify(canned[url.pathname]));
    if (url.pathname.startsWith('/api/')) return send(404, 'application/json', '{"error":"none"}');
    try {
      const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      return send(200, file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html', await readFile(path.join(dist, file)));
    } catch { return send(200, 'text/html', await readFile(path.join(dist, 'index.html'))); }
  });
  await listenOnGoodPort(stub, '127.0.0.1');
  const guestUrl = `http://127.0.0.1:${stub.address().port}/one`;
  const guest = await open({ width: 390, height: 800 });
  await guest.goto(`${guestUrl}#/~hub/today`);
  await guest.locator('.hub[data-screen="today"]').waitFor();
  assert.deepEqual(await navs(guest, '[data-tabs]'), ['today', 'chat', 'library', 'project', 'search'], 'A guest sees the same tabs.');
  await guest.locator('[data-tabs] [data-nav="chat"]').click();
  await guest.locator('[data-hub-chat-note]', { hasText: 'needs you to be signed in' }).waitFor();
  const guestDesk = await open({ width: 1280, height: 900 });
  await guestDesk.goto(`${guestUrl}#/~hub/today`);
  await guestDesk.locator('.hub[data-screen="today"]').waitFor();
  const guestRail = await navs(guestDesk, '[data-rail]');
  assert.ok(guestRail.includes('chat') && !guestRail.includes('sketch'), `A guest's rail has Chat and no Sketch (${guestRail}).`);
  console.log('shell-ui: passed');
} finally {
  for (const context of contexts) await context.close().catch(() => {});
  await browser.close();
  await new Promise(resolve => (stub ? stub.close(resolve) : resolve()));
  await fixture.close();
}
