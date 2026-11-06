// Run after npm run build. One project choice across Today, Needs you and Work (ws-ubo.2.5; the Roadmap and the project page left it in ws-cl0.6.9: a project is opened from the Projects list), at 390 and at 1280 px.
// A pick on any of the three shows on the others. All stays on Today and Needs you and carries between them; it leaves Work's
// project alone. An address wins on Needs you and writes nothing. Activity's filter is local. A pick of a project without a Beads copy
// shows on Today and Needs you but never paints a board on Work. How it feels on a real phone waits for the owner's play test.
import { chromium, expect } from '@playwright/test';
import { ms, SCALE } from './ui-timeouts.mjs';
expect.configure({ timeout: 5000 * SCALE });
import assert from 'node:assert/strict';
import { startHubFixture } from './hub-fixture.mjs';
import { eventJson, minutesAgo } from '../../site/api/test/hub-fixtures.mjs';

const step = name => console.log(`- ${name}`);
const channel = process.env.BUW_TEST_BROWSER || 'msedge';
const browser = await chromium.launch({ headless: true, channel });
const contexts = [];
let fixture;

const WIDTHS = [{ label: '390', width: 390, height: 844, phone: true }, { label: '1280', width: 1280, height: 800, phone: false }];
const SCOPE = { today: '[data-today-project]', work: '.work', needs: '[data-needs-project]', activity: '.hub-top' };
const HASH = { today: '#/~hub/today', work: '#/~hub/work', needs: '#/~hub/needs', activity: '#/~hub/activity' };
const NAME = { lanes: /^\s*lanes/i, 'magic-loops': /^\s*magic/i, probe: /^\s*probe/i, all: /^\s*all/i };
const KEYS = ['hub-today-project', 'buw.hub.project'];

const open = async view => {
  const context = await browser.newContext({ viewport: { width: view.width, height: view.height }, serviceWorkers: 'block', reducedMotion: 'reduce', ...(view.phone ? { hasTouch: true, isMobile: true } : {}) });
  contexts.push(context);
  const page = await context.newPage();
  page.setDefaultTimeout(ms(15000));
  page.on('pageerror', error => { throw error; });
  return page;
};
const stored = (page, key) => page.evaluate(k => localStorage.getItem(k), key);
const go = (page, hash) => page.evaluate(next => { location.hash = next; }, hash);
const picker = (page, screen) => page.locator(`${SCOPE[screen]} [aria-label="Project"][data-value]`).first();
/** The project a screen's picker shows. The wait is part of the check: a revisited screen shows its last answer first and then refreshes. */
const shows = async (page, screen, id) => {
  await expect(picker(page, screen), `${screen} shows ${id}`).toHaveAttribute('data-value', id);
};
const arrive = async (page, screen, hash = HASH[screen]) => {
  await page.goto(`${fixture.url}${hash}`);
  await picker(page, screen).waitFor();
};
/** A pick the way a person makes it: the native select on a phone; a chip or a list row at 1280. */
const pick = async (page, view, screen, id) => {
  const scope = page.locator(SCOPE[screen]);
  if (view.phone) { await scope.getByRole('combobox', { name: 'Project' }).selectOption(id); return; }
  const chips = scope.locator('.hub-chips[aria-label="Project"] .hub-chip');
  // Before /projects answers the chip row holds only All: wait for the list (more chips, or the typeable list) before choosing which to use.
  await expect.poll(async () => (await chips.count()) > 1 || (await scope.getByRole('combobox', { name: 'Project' }).count()) > 0, { message: `${screen} picker lists projects` }).toBe(true);
  const chip = chips.filter({ hasText: NAME[id] });
  if (await chip.count()) { await chip.first().click(); return; }
  await scope.getByRole('combobox', { name: 'Project' }).click();
  await scope.locator('[role="option"]', { hasText: NAME[id] }).first().click();
};
const waitHash = (page, hash) => page.waitForFunction(h => location.hash === h, hash);

try {
  fixture = await startHubFixture({ work: true });
  fixture.seed.event(eventJson({ kind: 'blocked', ts: minutesAgo(fixture.now, 10), session: 'sess-lanes', project: 'lanes', title: 'Permission needed: run lanes' }));
  await new Promise(resolve => setTimeout(resolve, 100));

  for (const view of WIDTHS) {
    const at = `at ${view.label} px`;

    step(`First visit ${at}: Today and bare Needs show All, also after Work`);
    {
      const page = await open(view);
      await arrive(page, 'today');
      await shows(page, 'today', 'all');
      assert.equal(await stored(page, 'hub-today-project'), null);
      await arrive(page, 'needs');
      await shows(page, 'needs', 'all');
      await arrive(page, 'work');
      await arrive(page, 'today');
      await shows(page, 'today', 'all');
      assert.equal(await stored(page, 'hub-today-project'), null, 'A visit to Work is not a pick.');
      await arrive(page, 'needs');
      await shows(page, 'needs', 'all');
      assert.equal(await page.evaluate(() => location.hash), '#/~hub/needs', 'Bare Needs stays bare on All.');
      await page.context().close();
    }

    step(`A pick on Work shows on Today and Needs; the bare address settles without a history entry ${at}`);
    {
      const page = await open(view);
      await arrive(page, 'work');
      await pick(page, view, 'work', 'lanes');
      await shows(page, 'work', 'lanes');
      await arrive(page, 'today');
      await shows(page, 'today', 'lanes');
      await arrive(page, 'work');
      const before = await page.evaluate(() => history.length);
      await go(page, HASH.needs);
      await waitHash(page, '#/~hub/needs/all/lanes');
      await shows(page, 'needs', 'lanes');
      assert.equal(await page.evaluate(() => history.length), before + 1, 'Only the navigation itself is an entry; settling adds none.');
      await page.context().close();
    }

    step(`A pick on Today reaches Work ${at}`);
    {
      const page = await open(view);
      await arrive(page, 'today');
      await pick(page, view, 'today', 'magic-loops');
      await shows(page, 'today', 'magic-loops');
      for (const screen of ['work']) { await arrive(page, screen); await shows(page, screen, 'magic-loops'); }
      await page.context().close();
    }

    step(`A pick on Needs reaches Today and Work ${at}`);
    {
      const page = await open(view);
      await arrive(page, 'needs');
      await pick(page, view, 'needs', 'lanes');
      await shows(page, 'needs', 'lanes');
      await arrive(page, 'today');
      await shows(page, 'today', 'lanes');
      await arrive(page, 'work');
      await shows(page, 'work', 'lanes');
      await page.context().close();
    }

    step(`All on Today carries to Needs and leaves Work alone; a later pick on Work narrows both ${at}`);
    {
      const page = await open(view);
      await arrive(page, 'work');
      await pick(page, view, 'work', 'lanes');
      await arrive(page, 'today');
      await pick(page, view, 'today', 'all');
      await shows(page, 'today', 'all');
      assert.equal(await stored(page, 'hub-today-project'), null);
      assert.equal(await stored(page, 'buw.hub.project'), 'lanes', 'All does not touch the last project.');
      await arrive(page, 'work');
      await shows(page, 'work', 'lanes');
      await arrive(page, 'needs');
      await shows(page, 'needs', 'all');
      await arrive(page, 'work');
      await pick(page, view, 'work', 'magic-loops');
      await arrive(page, 'today');
      await shows(page, 'today', 'magic-loops');
      await arrive(page, 'needs');
      await shows(page, 'needs', 'magic-loops');
      await page.context().close();
    }

    step(`All on Needs shows on Today ${at}`);
    {
      const page = await open(view);
      await arrive(page, 'needs');
      await pick(page, view, 'needs', 'lanes');
      await shows(page, 'needs', 'lanes');
      await pick(page, view, 'needs', 'all');
      await shows(page, 'needs', 'all');
      await arrive(page, 'today');
      await shows(page, 'today', 'all');
      assert.equal(await stored(page, 'buw.hub.project'), 'lanes');
      await page.context().close();
    }

    step(`All on Work counts as All for Today and Needs, and is not remembered there ${at}`);
    {
      const page = await open(view);
      await arrive(page, 'work');
      await pick(page, view, 'work', 'lanes');
      await arrive(page, 'work');
      await pick(page, view, 'work', 'all');
      await waitHash(page, '#/~hub/work/all');
      await arrive(page, 'today');
      await shows(page, 'today', 'all');
      assert.equal(await stored(page, 'hub-today-project'), null);
      await arrive(page, 'work');
      await shows(page, 'work', 'lanes');
      await page.context().close();
    }

    step(`A link wins on Needs and writes nothing; a filter address is All ${at}`);
    {
      const page = await open(view);
      await arrive(page, 'work');
      await pick(page, view, 'work', 'lanes');
      await arrive(page, 'needs');
      await go(page, '#/~hub/needs/question/magic-loops');
      await shows(page, 'needs', 'magic-loops');
      assert.equal(await stored(page, 'hub-today-project'), 'lanes', 'A link is a look, not a pick.');
      await go(page, '#/~hub/needs/question');
      await shows(page, 'needs', 'all');
      assert.equal(await stored(page, 'hub-today-project'), 'lanes');
      await arrive(page, 'today');
      await shows(page, 'today', 'lanes');
      await page.context().close();
    }

    step(`Back and Forward restore each entry with no loop ${at}`);
    {
      const page = await open(view);
      await arrive(page, 'work');
      await pick(page, view, 'work', 'lanes');
      await arrive(page, 'work');
      await go(page, HASH.needs);
      await waitHash(page, '#/~hub/needs/all/lanes');
      await shows(page, 'needs', 'lanes');
      await pick(page, view, 'needs', 'all');
      await waitHash(page, '#/~hub/needs/all');
      await shows(page, 'needs', 'all');
      assert.equal(await stored(page, 'hub-today-project'), null);
      await page.goBack();
      await waitHash(page, '#/~hub/needs/all/lanes');
      await shows(page, 'needs', 'lanes');
      assert.equal(await stored(page, 'hub-today-project'), null, 'Back writes nothing.');
      await page.goForward();
      await waitHash(page, '#/~hub/needs/all');
      await shows(page, 'needs', 'all');
      const changes = await page.evaluate(() => new Promise(resolve => { let n = 0; window.addEventListener('hashchange', () => { n += 1; }); setTimeout(() => resolve(n), 500); }));
      assert.equal(changes, 0, 'The address is settled: no further hashchange.');
      await page.context().close();
    }

    step(`A project that is gone reads as All and clears on Needs ${at}`);
    {
      const page = await open(view);
      await page.addInitScript(() => { try { localStorage.setItem('hub-today-project', 'vanished'); } catch { /* none */ } });
      await arrive(page, 'needs');
      await shows(page, 'needs', 'all');
      await page.waitForFunction(() => localStorage.getItem('hub-today-project') === null);
      await page.context().close();
    }

    step(`A project without a Beads copy stays on Today but never paints a board on Work ${at}`);
    {
      const page = await open(view);
      await arrive(page, 'today');
      await pick(page, view, 'today', 'probe');
      await shows(page, 'today', 'probe');
      // Reload on Work with /projects held: the remembered probe is asked for early, but nothing of it may show before the list answers.
      await go(page, HASH.work);
      await page.addInitScript(() => {
        const check = () => { if (document.querySelector('.work [data-value="probe"], .hub-error, [data-project-missing]') || document.body?.innerText.includes('No Beads copy yet')) window.__probe = true; };
        new MutationObserver(check).observe(document, { childList: true, subtree: true, characterData: true });
      });
      let release;
      const gate = new Promise(resolve => { release = resolve; });
      await page.route('**/api/hub/projects', async route => { await gate; await route.continue().catch(() => {}); });
      await page.reload();
      await page.waitForTimeout(ms(600));
      assert.equal(await page.evaluate(() => !!window.__probe), false, 'Probe never shows on Work while /projects is held.');
      release();
      await page.unroute('**/api/hub/projects');
      await picker(page, 'work').waitFor();
      const work = await picker(page, 'work').getAttribute('data-value');
      assert.notEqual(work, 'probe', 'Work lists only projects with a Beads copy.');
      await expect(page.locator('.wk-lane')).not.toHaveCount(0);
      assert.equal(await page.evaluate(() => !!window.__probe), false, 'Probe never showed on Work.');
      await go(page, HASH.today);
      await shows(page, 'today', 'probe');
      await page.context().close();
    }

    step(`The Activity filter is local ${at}`);
    {
      const page = await open(view);
      await arrive(page, 'activity');
      await pick(page, view, 'activity', 'lanes');
      await shows(page, 'activity', 'lanes');
      for (const key of KEYS) assert.equal(await stored(page, key), null, `${key} is untouched.`);
      await page.context().close();
    }
  }
  console.log('hub-shared-project-ui: passed');
} finally {
  for (const context of contexts) await context.close().catch(() => {});
  await browser.close().catch(() => {});
  await fixture?.close?.().catch(() => {});
}
