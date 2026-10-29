// Run after npm run build. Today's Working now and Gaming PC tile through a real browser, over the fixture
// service with a PC status seeded: fresh (one busy and one idle session), with a blocked session, and 40
// minutes old (asleep or off, falls back to event rows). At 1920 x 1080 and 390 x 844.
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { startHubFixture } from './hub-fixture.mjs';
import { eventJson, minutesAgo } from '../../site/api/test/hub-fixtures.mjs';

const step = name => console.log(`- ${name}`);
const channel = process.env.BUW_TEST_BROWSER || 'msedge';

const browser = await chromium.launch({ headless: true, channel });
const contexts = [];
const fixtures = [];
const open = async (viewport, fixture) => {
  const context = await browser.newContext({ viewport, serviceWorkers: 'block', reducedMotion: 'reduce' });
  contexts.push(context);
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => { throw error; });
  await page.goto(`${fixture.url}#/~hub/today`);
  await page.locator('.today-head').waitFor();
  await page.locator('[aria-label="Working now"]').waitFor();
  return page;
};
const noSideways = async (page, what) => {
  const widths = await page.evaluate(() => ({ scroll: document.scrollingElement.scrollWidth, inner: innerWidth }));
  assert.ok(widths.scroll <= widths.inner, `${what}: the page scrolls sideways (${widths.scroll} > ${widths.inner}).`);
};

try {
  const fresh = await startHubFixture({ pc: 'fresh' });
  fixtures.push(fresh);
  await new Promise(resolve => setTimeout(resolve, 100));

  for (const [label, viewport] of [['desktop', { width: 1920, height: 1080 }], ['phone', { width: 390, height: 844 }]]) {
    step(`${label}: one Working row for the busy session, the idle one folded, the event session of another host beside it`);
    const page = await open(viewport, fresh);
    const panel = page.locator('[aria-label="Working now"]');
    const rows = panel.locator('> .wn-row');
    assert.equal(await rows.count(), 2, 'A busy PC session and the event session of another host show; the idle one is folded.');
    const pcRow = panel.locator('[data-source="pc"][data-working="working"]');
    assert.match(await pcRow.innerText(), /Wall-jump tutorial/);
    assert.match(await pcRow.innerText(), /magic-loops · sprint\/ml-wj-t2-wall-jump/);
    assert.match(await pcRow.innerText(), /for \d+ min/);
    assert.equal(await pcRow.locator('svg.px').count(), 1, 'The row carries the Claude Code sprite.');
    assert.equal(await panel.locator('[data-source="events"]').count(), 1);
    assert.equal(await panel.locator('[data-working-idle] summary').innerText(), '1 idle');
    assert.equal(await panel.locator('[data-working-idle]').getAttribute('open'), null, 'The idle fold starts shut.');
    await panel.locator('[data-working-idle] summary').click();
    assert.equal(await panel.locator('[data-working="idle"]').isVisible(), true, 'Tapping the fold shows the idle row.');

    step(`${label}: the Gaming PC tile`);
    const tile = page.locator('[aria-label="Gaming PC"]');
    assert.equal(await tile.getAttribute('data-pc'), 'on');
    assert.equal(await tile.locator('[data-pc-headline]').innerText(), 'On · in use');
    assert.match(await tile.locator('[data-pc-line="gpu"]').innerText(), /7 %\s*·\s*3\.9 \/ 24 GB/);
    assert.match(await tile.locator('[data-pc-line="comfy"]').innerText(), /idle/);
    assert.match(await tile.locator('[data-pc-line="unity"]').innerText(), /probe open/);
    assert.match(await tile.locator('[data-pc-line="sessions"]').innerText(), /1 busy, 1 idle/);
    assert.equal(await tile.locator('[data-pc-awake]').innerText(), 'Kept awake');
    assert.match(await tile.innerText(), /Updated \d+ (s|min) ago/);

    step(`${label}: the running tile counts the working sessions and says where from`);
    const kpi = page.locator('[data-kpi="running"]');
    assert.equal((await kpi.locator('.hub-kpi-v').innerText()).trim(), '2');
    assert.equal((await kpi.locator('.kpi-sub').innerText()).trim(), 'on the PC and in the cloud');
    await noSideways(page, `Today at ${label} width`);
  }

  step('a blocked PC session reads Needs you and links to its item');
  const blocked = await startHubFixture({ pc: 'fresh' });
  fixtures.push(blocked);
  blocked.seed.event(eventJson({ kind: 'blocked', ts: minutesAgo(blocked.now, 3), project: 'magic-loops', session: 'pc-sess-a', host: 'test-pc', title: 'Permission needed: run unity test' }));
  await new Promise(resolve => setTimeout(resolve, 100));
  const page = await open({ width: 1920, height: 1080 }, blocked);
  const needs = page.locator('[aria-label="Working now"] [data-working="needs-you"]');
  assert.equal(await needs.count(), 1);
  assert.match(await needs.innerText(), /Needs you/);
  assert.match(await needs.locator('b a').getAttribute('href'), /^#\/~hub\/needs\/.+/);

  step('a status 40 minutes old reads Asleep or off and the rows fall back to events');
  const stale = await startHubFixture({ pc: 'stale' });
  fixtures.push(stale);
  await new Promise(resolve => setTimeout(resolve, 100));
  for (const viewport of [{ width: 1920, height: 1080 }, { width: 390, height: 844 }]) {
    const old = await open(viewport, stale);
    const tile = old.locator('[aria-label="Gaming PC"]');
    assert.equal(await tile.getAttribute('data-pc'), 'asleep-or-off');
    assert.match(await tile.locator('[data-pc-headline]').innerText(), /^Asleep or off · last seen \d+ min ago$/);
    assert.equal(await tile.locator('[data-pc-line]').count(), 0, 'Old numbers are not shown.');
    assert.equal(await old.locator('[aria-label="Working now"] [data-source="pc"]').count(), 0);
    assert.equal(await old.locator('[aria-label="Working now"] [data-source="events"]').count(), 1);
    await noSideways(old, `the stale Today at ${viewport.width} px`);
  }

  step('a fixture with no PC status shows no tile and "Nothing is running."');
  const bare = await startHubFixture({ seedData: false });
  fixtures.push(bare);
  const none = await open({ width: 1280, height: 900 }, bare);
  assert.equal(await none.locator('[aria-label="Gaming PC"]').count(), 0);
  assert.equal(await none.locator('[aria-label="Working now"] .hub-empty').innerText(), 'Nothing is running.');

  console.log('hub-working-ui: passed');
} finally {
  for (const context of contexts) await context.close().catch(() => {});
  await browser.close();
  for (const fixture of fixtures) await fixture.close();
}
