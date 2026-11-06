// Run after npm run build. Work starts its request together with /projects (the address's project, else the remembered one), and the
// project page and its Map start the map request with it (the address's project: no project is remembered for them any more). None
// shows anything of it until /projects confirms that project.
// /projects is held with a latch, never a timer, so the order is proved and not raced.
import { chromium } from '@playwright/test';
import { ms } from './ui-timeouts.mjs';
import assert from 'node:assert/strict';
import { startHubFixture } from './hub-fixture.mjs';

const channel = process.env.BUW_TEST_BROWSER || 'msedge';
const fixture = await startHubFixture({ pc: 'fresh', hermes: true });
const browser = await chromium.launch({ headless: true, channel });
const contexts = [];
const step = name => console.log(`- ${name}`);
const wait = time => new Promise(resolve => setTimeout(resolve, time));
const KEY = 'buw.hub.project';
const remembered = page => page.evaluate(key => localStorage.getItem(key), KEY);
const holdProjects = async page => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  await page.route('**/api/hub/projects', async route => { await gate; await route.continue().catch(() => {}); });
  return release;
};
// A fresh context per step: counts GETs by full URL and /projects answers, watches for anything that must never show.
const open = async remember => {
  const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  contexts.push(context);
  const page = await context.newPage();
  page.setDefaultTimeout(ms(15000));
  page.on('pageerror', error => { throw error; });
  const state = { gets: [], answers: 0 };
  page.on('request', request => { if (request.method() === 'GET' && request.url().includes('/api/hub/')) state.gets.push(request.url().split('/api/hub')[1]); });
  page.on('response', response => { if (new URL(response.url()).pathname === '/api/hub/projects') state.answers += 1; });
  await page.addInitScript(value => {
    try { if (value) localStorage.setItem('buw.hub.project', value); } catch { /* about:blank has none */ }
    const check = () => {
      if (document.querySelector('.hub-error, [data-hub-stale]') || document.body?.innerText.includes('No Beads copy yet')) window.__flash = true;
    };
    new MutationObserver(check).observe(document, { childList: true, subtree: true, characterData: true });
  }, remember ?? '');
  return { page, state };
};
const count = (state, url) => state.gets.filter(item => item === url).length;
const seen = (page, state, url) => page.waitForRequest(request => request.url().endsWith(url)).then(() => assert.equal(state.answers, 0, `${url} left before /projects answered.`));
const lanes = page => page.locator('.wk-lane');
const loading = page => page.locator('.hub-empty', { hasText: 'Loading…' });
const flash = page => page.evaluate(() => !!window.__flash);

try {
  step('Work, remembered magic-loops: the work request leaves before /projects answers, is held, shows on release, one GET');
  {
    const { page, state } = await open('magic-loops');
    const release = await holdProjects(page);
    const early = seen(page, state, '/work?project=magic-loops');
    const answered = page.waitForResponse(response => response.url().endsWith('/work?project=magic-loops'));
    await page.goto(`${fixture.url}#/~hub/work`);
    await early; await answered;
    assert.equal(await lanes(page).count(), 0, 'The held answer shows no lanes.');
    await loading(page).waitFor();
    release();
    await lanes(page).first().waitFor({ state: 'attached' });
    await wait(300);
    assert.equal(count(state, '/work?project=magic-loops'), 1, 'One GET for the work request.');
  }

  step('Map of magic-loops by address, another project remembered: the map request leaves with /projects, is held, one GET');
  {
    const { page, state } = await open('nosprint');
    const release = await holdProjects(page);
    const early = seen(page, state, '/map/magic-loops');
    await page.goto(`${fixture.url}#/~hub/map/magic-loops`);
    await early;
    assert.equal(await page.locator('.hub-map-box').count(), 0);
    release();
    await page.locator('.hub-map-box').waitFor();
    await wait(300);
    assert.equal(count(state, '/map/magic-loops'), 1, 'One GET for the map.');
  }

  step('Project page by address: same, and nothing remembered is fetched');
  {
    const { page, state } = await open('nosprint');
    const release = await holdProjects(page);
    const early = seen(page, state, '/map/magic-loops');
    await page.goto(`${fixture.url}#/~hub/project/magic-loops`);
    await early;
    assert.equal(await page.locator('[data-project-page="magic-loops"]').count(), 0);
    release();
    await page.locator('[data-project-page="magic-loops"]').waitFor();
    await wait(300);
    assert.equal(count(state, '/map/magic-loops'), 1, 'One GET for the map.');
    assert.equal(state.gets.filter(item => item.includes('nosprint')).length, 0, 'The remembered project was not fetched.');
  }

  step('Projects list with no id: no project and no map is asked for until /projects answers; then the first opens on the right');
  {
    const { page, state } = await open('nosprint');
    const release = await holdProjects(page);
    await page.goto(`${fixture.url}#/~hub/project`);
    await wait(500);
    assert.equal(state.gets.filter(item => item.startsWith('/map/')).length, 0, 'No map request before the list.');
    assert.equal(await page.locator('[data-project-page]').count(), 0, 'No project shown before the list.');
    release();
    await page.locator('[data-project-page]').waitFor();
    assert.ok(await page.locator('[data-project-page]').getAttribute('data-project-page'), 'A project is open on the right.');
    assert.equal(await flash(page), false, 'Nothing red or empty flashed.');
  }

  step('The address wins over the remembered project, which is never fetched');
  {
    const { page, state } = await open('magic-loops');
    const release = await holdProjects(page);
    const early = seen(page, state, '/work?project=nosprint');
    await page.goto(`${fixture.url}#/~hub/work/nosprint`);
    await early;
    release();
    await lanes(page).first().waitFor({ state: 'attached' });
    await wait(300);
    assert.equal(count(state, '/work?project=nosprint'), 1);
    assert.equal(state.gets.filter(item => item.includes('magic-loops')).length, 0, 'The remembered project was not fetched.');
    assert.equal(await remembered(page), 'nosprint');
  }

  step('A project that is gone: its answer never shows and the screen moves to the fallback');
  for (const screen of ['work']) {
    const { page, state } = await open('vanished');
    const release = await holdProjects(page);
    const url = screen === 'work' ? '/work?project=vanished' : '/map/vanished';
    const early = seen(page, state, url);
    const landed = page.waitForResponse(response => response.url().endsWith(url));
    await page.goto(`${fixture.url}#/~hub/${screen}`);
    await early; await landed;
    await wait(200);
    assert.equal(await lanes(page).count() + await page.locator('.hub-map-box').count(), 0, `The ${screen} answer for a gone project is held.`);
    release();
    await (screen === 'work' ? lanes(page).first() : page.locator('.hub-map-box')).waitFor({ state: 'attached' });
    const now = await remembered(page);
    assert.notEqual(now, 'vanished', 'The gone project is no longer remembered.');
    if (screen === 'work') assert.ok(count(state, `/work?project=${now}`) >= 1, 'The fallback was requested.');
    assert.equal(await flash(page), false, 'Nothing red or empty flashed.');
  }
  {
    step('The early answer lands after the list moved on: the fallback stays');
    const { page, state } = await open('vanished');
    const release = await holdProjects(page);
    let free; const gate = new Promise(resolve => { free = resolve; });
    await page.route('**/api/hub/work?project=vanished', async route => { await gate; await route.continue().catch(() => {}); });
    await page.goto(`${fixture.url}#/~hub/work`);
    await seen(page, state, '/work?project=vanished');
    release();
    await lanes(page).first().waitFor({ state: 'attached' });
    free();
    await wait(400);
    assert.ok(await lanes(page).count() > 0, 'The fallback lanes stay.');
    assert.equal(await flash(page), false);
  }
  {
    step('The early request failing with 404 never shows');
    const { page, state } = await open('vanished');
    const release = await holdProjects(page);
    await page.route('**/api/hub/work?project=vanished', route => route.fulfill({ status: 404, json: { error: 'no' } }));
    const landed = page.waitForResponse(response => response.url().endsWith('/work?project=vanished'));
    await page.goto(`${fixture.url}#/~hub/work`);
    await landed; await wait(200);
    assert.equal(await page.locator('.hub-error').count(), 0, 'No red line while the list is out.');
    release();
    await lanes(page).first().waitFor({ state: 'attached' });
    assert.equal(await flash(page), false);
    assert.ok(state.answers >= 1);
  }

  step('Project page with an unknown id: "No project called x", no flash');
  {
    const { page, state } = await open('magic-loops');
    const release = await holdProjects(page);
    const early = seen(page, state, '/map/vanished');
    await page.goto(`${fixture.url}#/~hub/project/vanished`);
    await early;
    release();
    await page.locator('[data-project-missing]').waitFor();
    assert.equal(await flash(page), false);
  }

  step('Map of a project that is gone: nothing of it shows, then "No project called"');
  {
    const { page, state } = await open('');
    const release = await holdProjects(page);
    const early = seen(page, state, '/map/vanished');
    const landed = page.waitForResponse(response => response.url().endsWith('/map/vanished'));
    await page.goto(`${fixture.url}#/~hub/map/vanished`);
    await early; await landed; await wait(200);
    assert.equal(await page.locator('.hub-map-box').count(), 0, 'The held answer shows no map.');
    release();
    await page.locator('[data-project-missing]').waitFor();
    assert.equal(await flash(page), false, 'Nothing red or empty flashed.');
  }

  step('Work with nothing remembered, nothing in the address: no early request, the first project comes from /projects');
  {
    const { page, state } = await open('');
    const release = await holdProjects(page);
    await page.goto(`${fixture.url}#/~hub/work`);
    await wait(500);
    assert.equal(state.gets.filter(item => item.startsWith('/work')).length, 0, 'No work request before the list.');
    release();
    await lanes(page).first().waitFor({ state: 'attached' });
    assert.ok(await remembered(page), 'A project is remembered now.');
  }

  step('/projects failing with a remembered project: the red line shows, never the early lanes; the retry brings them');
  {
    const { page } = await open('magic-loops');
    // The list answers 500 only once the early request has been answered, so the response cannot be aborted away.
    const landed = page.waitForResponse(response => response.url().endsWith('/work?project=magic-loops'));
    await page.route('**/api/hub/projects', async route => { await landed; await route.fulfill({ status: 500, json: { error: 'down' } }); });
    await page.goto(`${fixture.url}#/~hub/work`);
    await landed;
    await page.locator('.hub-error').first().waitFor();
    assert.equal(await lanes(page).count(), 0, 'No lanes while the list is failing.');
    await page.unroute('**/api/hub/projects');
    await lanes(page).first().waitFor({ state: 'attached', timeout: ms(20000) });
  }
  console.log('hub-project-early-ui: ok');
} finally {
  for (const context of contexts) await context.close();
  await browser.close();
  await fixture.close();
}
