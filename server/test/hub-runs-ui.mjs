// Run after npm run build. The run drawer through a real browser, over the fixture service with a throwaway signing key and
// the fake Hermes: a research request is approved, its drawer shows the text arriving and a tool line, then the card link;
// Stop on a held run ends in "Stopped"; the drawer is a bottom sheet at 375 px; a request signed by policy, a retried one and
// one that ended in a question read right on the request's page.
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { startHubFixture } from './hub-fixture.mjs';
import { minutesAgo } from '../../site/api/test/hub-fixtures.mjs';

const step = name => console.log(`- ${name}`);
const channel = process.env.BUW_TEST_BROWSER || 'msedge';
const browser = await chromium.launch({ headless: true, channel });
const contexts = [];
const fixtures = [];
const open = async (viewport, options = {}) => {
  const context = await browser.newContext({ viewport, serviceWorkers: 'block', reducedMotion: 'reduce', ...options });
  contexts.push(context);
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  page.on('pageerror', error => { throw error; });
  return page;
};
const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
const id = slug => `${day}-magic-loops-${slug}`;
const ids = { live: id('tug-research-a1a1'), hold: id('held-research-b2b2'), policy: id('by-policy-c3c3'), retry: id('retried-d4d4'), asking: id('asks-e5e5'), phone: id('phone-research-f6f6') };
const proposal = (now, name, text) => ({ id: ids[name], project: 'magic-loops', createdAt: minutesAgo(now, 20).toISOString(), by: 'hermes', text, preset: 'research', target: 'hermes', origin: { kind: 'agent', name: 'hermes' } });
try {
  step('a run streams: text arrives, a tool line shows, then the card link and the timeline');
  const live = await startHubFixture({
    signing: true, hermes: true,
    hermesOptions: { runScript: ['Reading sources. ', { tool: 'web_search', preview: 'tug-of-war card games' }, { wait: 1500 }, 'Found three games.'], endWith: 'Found three games.\nCARD: assistant/tug-games' },
  });
  fixtures.push(live);
  live.seed.request(proposal(live.now, 'live', 'Market research on tug-of-war card games'));
  live.seed.request({ ...proposal(live.now, 'asking', 'Which of the two games?'), project: 'magic-loops' });
  live.seed.put(`requests/${ids.asking}/approved.json`, { v: 1, request: ids.asking, project: 'magic-loops', repo: null, target: 'hermes', limits: { minutes: 30 }, expires: '2099-01-01T00:00:00.000Z', at: minutesAgo(live.now, 15).toISOString(), by: 'local', signature: 'x' });
  live.seed.put(`requests/${ids.asking}/hermes-run.json`, { runId: 'old-run', at: minutesAgo(live.now, 14).toISOString() });
  live.seed.put(`requests/${ids.asking}/result.json`, { v: 1, outcome: 'question', question: 'Which of the two games do you mean?', summary: 'Two matches.', by: 'hub', at: minutesAgo(live.now, 10).toISOString() });
  live.seed.request(proposal(live.now, 'policy', 'Research signed without a tap'));
  live.seed.put(`requests/${ids.policy}/approved.json`, { v: 1, request: ids.policy, project: 'magic-loops', repo: null, target: 'hermes', limits: { minutes: 30 }, expires: '2099-01-01T00:00:00.000Z', at: minutesAgo(live.now, 2).toISOString(), by: 'policy', signature: 'x' });
  live.seed.request(proposal(live.now, 'retry', 'Retried research'));
  live.seed.put(`requests/${ids.retry}/approved.json`, { v: 1, request: ids.retry, project: 'magic-loops', repo: null, target: 'hermes', limits: { minutes: 30 }, expires: '2099-01-01T00:00:00.000Z', at: minutesAgo(live.now, 30).toISOString(), by: 'local', signature: 'x' });
  live.seed.put(`requests/${ids.retry}/hermes-run.json`, { runId: 'r1', at: minutesAgo(live.now, 29).toISOString() });
  live.seed.put(`requests/${ids.retry}/hermes-retry.json`, { runId: 'r2', at: minutesAgo(live.now, 28).toISOString(), provider: 'anthropic', model: 'claude-sonnet-5-5', reason: 'quota' });
  live.seed.put(`requests/${ids.retry}/result.json`, { v: 1, outcome: 'card', card: 'assistant/retried', summary: 'Done on the retry.', usage: { input_tokens: 1200, output_tokens: 300 }, by: 'hub', at: minutesAgo(live.now, 20).toISOString() });
  await new Promise(resolve => setTimeout(resolve, 100));
  const page = await open({ width: 1280, height: 900 });
  await page.goto(`${live.url}#/~hub/needs`);
  await page.locator(`[data-need="approval-${ids.live}"] [data-approval-approve]`).click();
  await page.locator('[data-next-note]').waitFor();
  await page.goto(`${live.url}#/~hub/needs/requests`);
  await page.locator(`[data-request-open="${ids.live}"]`).click();
  const drawer = page.locator('[data-run-drawer]');
  await drawer.waitFor();
  assert.equal((await drawer.locator('[data-run-id]').innerText()).trim(), ids.live);
  assert.match(await drawer.locator('[data-run-preset]').innerText(), /research/);
  assert.equal(await drawer.locator('[data-run-state-chip]').count(), 1);
  await drawer.locator('[data-run-text]', { hasText: 'Reading sources.' }).waitFor();
  await drawer.locator('[data-run-tool]', { hasText: 'web_search' }).waitFor();
  assert.match(await drawer.locator('[data-run-tool]').innerText(), /tug-of-war card games/);
  await drawer.locator('[data-run-card]').waitFor();
  assert.equal(await drawer.locator('[data-run-card]').getAttribute('href'), '#/tug-games');
  assert.equal((await drawer.locator('[data-run-state-chip]').innerText()).trim(), 'Done');
  assert.match(await drawer.locator('[data-run-by]').innerText(), /Approved by local/);
  assert.ok(await drawer.locator('[data-step]').count() >= 3, 'The timeline lists approved, the result and who wrote it.');
  assert.equal(await drawer.locator('[data-run-stop]').count(), 0, 'A finished run has no Stop.');
  await page.keyboard.press('Escape');
  await drawer.waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-request-open')), ids.live, 'The focus went back to the row.');

  step('the request page shows the same view: a policy signature, a retry note, usage, and a question with Answer');
  await page.goto(`${live.url}#/~hub/request/${encodeURIComponent(ids.policy)}`);
  await page.locator('[data-run-by]', { hasText: 'Signed by policy' }).waitFor();
  await page.goto(`${live.url}#/~hub/request/${encodeURIComponent(ids.retry)}`);
  await page.locator('[data-run-retry]').waitFor();
  assert.equal(await page.locator('[data-run-retry]').innerText(), 'Codex quota reached; retried on Anthropic.');
  assert.match(await page.locator('[data-run-usage]').innerText(), /input tokens 1,200/);
  assert.equal(await page.locator('[data-run-card]').getAttribute('href'), '#/retried');
  await page.goto(`${live.url}#/~hub/request/${encodeURIComponent(ids.asking)}`);
  await page.locator('[data-run-asking]').waitFor();
  assert.match(await page.locator('[data-run-asking]').innerText(), /Which of the two games do you mean\?/);
  assert.equal((await page.locator('[data-run-state-chip]').innerText()).trim(), 'Asking you');
  assert.equal(await page.locator('[data-run-answer-link]').getAttribute('href'), '#/~hub/needs/question');

  step('phone: the drawer is a bottom sheet the width of the screen with no sideways scroll');
  live.seed.request(proposal(live.now, 'phone', 'Research for the phone'));
  const phone = await open({ width: 375, height: 812 }, { hasTouch: true, isMobile: true });
  await phone.goto(`${live.url}#/~hub/needs/requests`);
  await phone.locator(`[data-request-open="${ids.policy}"]`).click();
  await phone.locator('[data-run-drawer] [data-run-view]').waitFor();
  const box = await phone.locator('[data-run-drawer]').boundingBox();
  assert.equal(Math.round(box.x), 0);
  assert.equal(Math.round(box.width), 375);
  assert.ok(Math.round(box.y + box.height) >= 811, 'The drawer sits on the bottom edge.');
  assert.ok(box.y > 0, 'It is a sheet, not the whole screen.');
  const widths = await phone.evaluate(() => ({ scroll: document.querySelector('[data-run-drawer]').scrollWidth, inner: document.querySelector('[data-run-drawer]').clientWidth }));
  assert.ok(widths.scroll <= widths.inner, 'The drawer does not scroll sideways.');

  step('Stop on a held run: the request ends Stopped, with the stop in its timeline');
  const held = await startHubFixture({ signing: true, hermes: true, hermesOptions: { runScript: ['Working on it. ', { hold: true }] } });
  fixtures.push(held);
  held.seed.request(proposal(held.now, 'hold', 'A research that never ends'));
  await new Promise(resolve => setTimeout(resolve, 100));
  const stopper = await open({ width: 1280, height: 900 });
  await stopper.goto(`${held.url}#/~hub/needs`);
  await stopper.locator(`[data-need="approval-${ids.hold}"] [data-approval-approve]`).click();
  await stopper.locator('[data-next-note]').waitFor();
  // The first events connection drops before any data: the drawer opens it again and shows the text once.
  let eventCalls = 0;
  await stopper.route('**/api/hub/requests/*/events', async route => {
    eventCalls += 1;
    if (eventCalls === 1) await route.abort(); else await route.continue();
  });
  await stopper.goto(`${held.url}#/~hub/needs/requests`);
  await stopper.locator(`[data-request-open="${ids.hold}"]`).click();
  const heldDrawer = stopper.locator('[data-run-drawer]');
  await heldDrawer.locator('[data-run-text]', { hasText: 'Working on it.' }).waitFor();
  assert.ok(eventCalls >= 2, 'The drawer reconnected after the drop.');
  assert.equal(await heldDrawer.locator('[data-run-text]').count(), 1, 'The text is not doubled by the reconnect.');
  assert.equal((await heldDrawer.locator('[data-run-text]').innerText()).trim(), 'Working on it.');
  await heldDrawer.locator('[data-run-stop]').click();
  await heldDrawer.locator('[data-run-state-chip]', { hasText: /^(Stopping|Stopped)$/ }).waitFor();
  await heldDrawer.locator('[data-run-state-chip]', { hasText: 'Stopped' }).waitFor();
  assert.ok(held.fake.objects.has(`sections/inbox/requests/${ids.hold}/stop.json`), 'A signed stop was written.');
  assert.equal(await heldDrawer.locator('[data-run-stop]').count(), 0, 'A stopped run has no Stop.');

  console.log('hub-runs-ui: passed');
} finally {
  for (const context of contexts) await context.close().catch(() => {});
  await browser.close();
  for (const fixture of fixtures) await fixture.close();
}
