// Run after npm run build. Spawned runs on the dashboard (ws-ttz): a taken Hermes request shows in Working now with its
// runner badge, counts in Running and opens the run drawer; run started/finished events reach Since yesterday and
// Activity with links to the card or the run; the finished run's card link reaches the card in the assistant section;
// Spawn's toast after Approve links to the run. Desktop and phone. Data is the fixture's own fake S3.
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { startHubFixture } from './hub-fixture.mjs';
import { beadsIssue, iso, minutesAgo } from '../../site/api/test/hub-fixtures.mjs';

const step = name => console.log(`- ${name}`);
const channel = process.env.BUW_TEST_BROWSER || 'msedge';
const browser = await chromium.launch({ headless: true, channel });
const contexts = [];
const fixtures = [];
const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
const open = async viewport => {
  const context = await browser.newContext({ viewport, serviceWorkers: 'block', reducedMotion: 'reduce' });
  contexts.push(context);
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => { throw error; });
  return page;
};

try {
  const fx = await startHubFixture({ seedData: false });
  fixtures.push(fx);
  const live = `${day}-probe-help-me-make-a-deck-ab12`;
  const done = `${day}-probe-game-ideas-deck-cd34`;
  const run = (id, title, minutes, { runner = 'hermes', result } = {}) => {
    fx.seed.request({ id, project: 'probe', title, text: `Do ${title}`, preset: 'research', target: runner, createdAt: iso(minutesAgo(fx.now, minutes + 5)) });
    fx.seed.put(`requests/${id}/approved.json`, { target: runner, expires: iso(new Date(fx.now.getTime() + 3600000)), at: iso(minutesAgo(fx.now, minutes + 4)) });
    fx.seed.put(`requests/${id}/taken.json`, { runner, at: iso(minutesAgo(fx.now, minutes)) });
    if (result) fx.seed.put(`requests/${id}/result.json`, { at: iso(minutesAgo(fx.now, 1)), ...result });
  };
  run(live, 'Help me make a deck', 6);
  run(done, 'Game ideas deck', 40, { result: { outcome: 'card', card: 'assistant/2026-10-30_game-ideas-deck-consultant' } });
  fx.fake.seed('sections/assistant/workspace.json', JSON.stringify({ name: 'Assistant', entities: [{ id: 'game-ideas-deck-consultant', title: 'Game ideas deck', folder: '2026-10-30_game-ideas-deck-consultant', created: '2026-10-30' }] }), 'application/json');
  fx.seed.beads('magic-loops', [beadsIssue({ id: 'ml-1', title: 'A task' })], { pushedAt: minutesAgo(fx.now, 5).toISOString(), host: 'pc.example.test', count: 1, repo: 'example/magic-loops' });
  fx.fake.seed('sections/magic-loops/workspace.json', JSON.stringify({ name: 'magic-loops', tracked: { repo: 'example/magic-loops' }, entities: [] }), 'application/json');
  await new Promise(resolve => setTimeout(resolve, 100));

  for (const [label, viewport] of [['desktop', { width: 1280, height: 900 }], ['phone', { width: 390, height: 844 }]]) {
    const page = await open(viewport);
    await page.goto(`${fx.url}#/~hub/today`);
    const panel = page.locator('[aria-label="Working now"]');
    await panel.locator('[data-source="run"]').waitFor();

    step(`${label}: the Hermes run is in Working now with its runner, title, preset and elapsed time, and Running counts it`);
    const row = panel.locator('[data-source="run"]');
    assert.equal(await row.count(), 1);
    const text = await row.innerText();
    assert.match(text, /Help me make a deck/);
    assert.match(text, /Research/);
    assert.match(text, /Working/);
    assert.match(text, /for \d+ min/);
    assert.equal(await row.locator('[data-runner="hermes"]').innerText(), 'Hermes');
    assert.equal((await page.locator('[data-kpi="running"] .hub-kpi-v').innerText()).trim(), '1');
    const widths = await page.evaluate(() => ({ scroll: document.scrollingElement.scrollWidth, inner: innerWidth }));
    assert.ok(widths.scroll <= widths.inner, `${label}: the page scrolls sideways.`);

    step(`${label}: Since yesterday has the started and finished events`);
    const since = page.locator('[aria-label="Since yesterday"]');
    await since.locator('[data-run-event="run-finished"]').waitFor();
    assert.equal(await since.locator('[data-run-event="run-started"]').count(), 2);
    assert.match(await since.locator('[data-run-event="run-finished"]').innerText(), /Finished: Game ideas deck/);
    assert.equal(await since.locator('[data-run-card]').getAttribute('href'), '/assistant#/game-ideas-deck-consultant', 'The card link is the card id in the assistant section.');

    step(`${label}: Activity lists them under Agents`);
    await page.goto(`${fx.url}#/~hub/activity/agents`);
    await page.locator('[data-run-event="run-started"]').first().waitFor();
    assert.equal(await page.locator('[data-run-event]').count(), 3);

    step(`${label}: the Working now row opens the run drawer`);
    await page.goto(`${fx.url}#/~hub/today`);
    await page.locator('[aria-label="Working now"] [data-run-open]').click();
    await page.locator('dialog[data-run-drawer][open]').waitFor();
    await page.locator('dialog[data-run-drawer]', { hasText: 'Help me make a deck' }).waitFor();
    await page.keyboard.press('Escape');
  }

  step('the drawer of the finished run links to the card in the assistant section');
  const page = await open({ width: 1280, height: 900 });
  await page.goto(`${fx.url}#/~hub/today`);
  await page.locator('[aria-label="Since yesterday"] [data-run-event="run-finished"] [data-run-event-open]').click();
  await page.locator('[data-run-card]').waitFor();
  assert.equal(await page.locator('[data-run-card]').getAttribute('href'), '/assistant#/game-ideas-deck-consultant');

  step('Spawn: the toast after Approve names where the run is and opens it');
  const spawn = await open({ width: 1280, height: 900 });
  await spawn.route('**/api/capabilities', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...(await response.json()), approve: true } });
  });
  await spawn.route('**/api/hub/requests/*/approve', route => route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ state: 'approved', approved: {} }) }));
  await spawn.goto(`${fx.url}#/~hub/today`);
  await spawn.locator('[data-spawn-open]').click();
  await spawn.locator('[data-spawn-project]').selectOption('magic-loops');
  await spawn.locator('[data-preset="research"]').click();
  await spawn.locator('[data-spawn-text]').fill('Why do runs stall');
  await spawn.locator('[data-spawn-go]').click();
  const toast = spawn.locator('[data-spawn-toast]');
  await toast.waitFor();
  assert.match(await toast.innerText(), /Approved\. .*Working now/);
  await toast.locator('[data-spawn-toast-link="run"]').click();
  await spawn.locator('dialog[data-run-drawer][open]').waitFor();

  console.log('hub-runs-dash-ui: passed');
} finally {
  for (const context of contexts) await context.close().catch(() => {});
  await browser.close();
  for (const fixture of fixtures) await fixture.close();
}
