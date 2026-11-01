// Run after npm run build. Replying to a Hermes job that has ended, through a real browser over the fixture service with a throwaway
// signing key and the fake Hermes: a done research request shows the reply box; Enter sends and the page opens the continuation,
// which says "Continues <- id"; the original says "Continued as -> id" and its box is off with the reason; a PC job, a job Hermes has
// not started and a job still going show the box off with their reasons; a phone shows the box without sideways scroll.
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
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => { throw error; });
  return page;
};
const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
const id = slug => `${day}-magic-loops-${slug}`;
const ids = { done: id('tug-research-a1a1'), pc: id('fix-the-tab-order-b2b2'), waiting: id('not-started-c3c3'), going: id('still-going-d4d4'), failed: id('failed-research-e5e5') };
const proposal = (now, name, text, extra = {}) => ({ id: ids[name], project: 'magic-loops', createdAt: minutesAgo(now, 20).toISOString(), by: 'owner', text, preset: 'research', target: 'hermes', origin: { kind: 'owner', name: 'owner' }, ...extra });
const approvedFile = (request, target, now) => ({ v: 1, request, project: 'magic-loops', repo: null, target, limits: { minutes: 30 }, expires: '2099-01-01T00:00:00.000Z', at: minutesAgo(now, 15).toISOString(), by: 'local', signature: 'x' });
const GATE = '[data-run-reply]';

try {
  const live = await startHubFixture({
    signing: true, hermes: true,
    hermesOptions: { runScript: ['Reading sources. ', 'Found three games.'], endWith: 'Found three games.\nCARD: assistant/tug-games' },
  });
  fixtures.push(live);
  const { seed, now, fake } = live;
  seed.request(proposal(now, 'done', 'Market research on tug-of-war card games'));
  // A PC job that finished with a PR.
  seed.request({ ...proposal(now, 'pc', 'Fix the tab order on the settings sheet', { preset: 'code-task', target: 'pc', repo: 'example/magic-loops' }) });
  seed.put(`requests/${ids.pc}/approved.json`, approvedFile(ids.pc, 'pc', now));
  seed.put(`requests/${ids.pc}/taken.json`, { runner: 'pc', host: 'test-pc', at: minutesAgo(now, 10).toISOString() });
  seed.put(`requests/${ids.pc}/result.json`, { v: 1, outcome: 'pr', pr: 'https://github.com/example/magic-loops/pull/3', summary: 'Fixed.', by: 'pc', at: minutesAgo(now, 5).toISOString() });
  // A Hermes job approved and not started, and one with a run that has not ended: on a service with no Hermes, so nothing starts or ends them.
  const idle = await startHubFixture({ signing: true });
  fixtures.push(idle);
  idle.seed.request(proposal(idle.now, 'waiting', 'Research that waits for Hermes'));
  idle.seed.put(`requests/${ids.waiting}/approved.json`, approvedFile(ids.waiting, 'hermes', idle.now));
  idle.seed.request(proposal(idle.now, 'going', 'Research that is going'));
  idle.seed.put(`requests/${ids.going}/approved.json`, approvedFile(ids.going, 'hermes', idle.now));
  idle.seed.put(`requests/${ids.going}/taken.json`, { runner: 'hermes', host: 'hub', at: minutesAgo(idle.now, 3).toISOString() });
  idle.seed.put(`requests/${ids.going}/hermes-run.json`, { runId: 'r-going', at: minutesAgo(idle.now, 3).toISOString() });
  await new Promise(resolve => setTimeout(resolve, 100));
  const json = (name, file) => fake.json(`sections/inbox/requests/${name}/${file}`);

  step('a run is approved and ends: the request page has a reply box, off until there is text');
  const page = await open({ width: 1280, height: 1000 });
  await page.goto(`${live.url}#/~hub/needs`);
  await page.locator(`[data-need="approval-${ids.done}"] [data-approval-approve]`).click();
  await page.locator('[data-next-note]').waitFor();
  await page.goto(`${live.url}#/~hub/request/${encodeURIComponent(ids.done)}`);
  await page.locator('[data-run-state-chip]', { hasText: 'Done' }).waitFor({ timeout: 30000 });
  const box = page.locator(GATE);
  await box.waitFor();
  assert.equal(await box.getAttribute('data-reply-off'), null, 'A done Hermes job takes a reply.');
  assert.equal(await box.locator('[data-reply-input]').getAttribute('placeholder'), 'Reply to Hermes');
  assert.equal(await box.locator('[data-reply-input]').getAttribute('maxlength'), '2000');
  assert.equal(await box.locator('[data-reply-send]').isDisabled(), true);
  assert.equal(await box.locator('.hub-compose').count(), 1, 'It reuses the Chat composer markup.');
  assert.equal(await page.locator('[data-run-continued]').count(), 0);

  step('Shift+Enter is a new line; Enter sends and the page opens the continuation, which says what it continues');
  await box.locator('[data-reply-input]').fill('Go deeper on the wooden one.');
  await box.locator('[data-reply-input]').press('Shift+Enter');
  await box.locator('[data-reply-input]').pressSequentially('Skip prices.');
  assert.equal(await box.locator('[data-reply-input]').inputValue(), 'Go deeper on the wooden one.\nSkip prices.');
  assert.equal(await box.locator('[data-reply-send]').isDisabled(), false);
  let replies = 0;
  page.on('request', request => { if (request.url().endsWith('/reply') && request.method() === 'POST') replies += 1; });
  await box.locator('[data-reply-input]').press('Enter');
  await page.waitForFunction(original => !decodeURIComponent(window.location.hash).includes(original), ids.done);
  const next = decodeURIComponent(page.url().split('/request/')[1]);
  assert.notEqual(next, ids.done);
  assert.equal(replies, 1, 'One Enter, one reply.');
  const link = page.locator('[data-run-continues]');
  await link.waitFor();
  assert.equal((await link.innerText()).trim(), ids.done);
  assert.match(await page.locator('[data-step="continues"]').innerText(), /Continues ← /);
  assert.deepEqual(json(next, 'request.json').continues, { from: ids.done, replies: ['Go deeper on the wooden one.\nSkip prices.'] });
  const brief = json(next, 'approved.json').run.brief;
  assert.match(brief, /> Found three games\./);
  assert.match(brief, /The owner replied: Go deeper on the wooden one\. Skip prices\./);

  step('the original says it was continued, links there, and its box is off with the reason');
  await link.click();
  await page.locator('[data-run-continued]').waitFor();
  assert.equal((await page.locator('[data-run-continued]').innerText()).trim(), next);
  assert.match(await page.locator('[data-step="continued"]').innerText(), /Continued as → /);
  const off = page.locator(GATE);
  assert.equal(await off.getAttribute('data-reply-off'), '');
  assert.equal(await off.locator('[data-reply-input]').isDisabled(), true);
  assert.equal(await off.locator('[data-reply-send]').isDisabled(), true);
  assert.equal((await off.locator('[data-reply-reason]').innerText()).trim(), `Continued as ${next}. Reply there.`);
  await off.locator('[data-reply-continued]').click();
  await page.locator('[data-run-continues]').waitFor();
  assert.equal((await page.locator('[data-run-view] [data-run-state-chip]').first().innerText()).trim().length > 0, true);

  step('a PC job, a job not started and a job still going show the box off, each with its reason');
  const reasons = [
    [live.url, ids.pc, /^Replies go to Hermes jobs\. A PC or cloud run can’t take a message yet\.$/],
    [idle.url, ids.waiting, /^You can reply once Hermes has started\.$/],
    [idle.url, ids.going, /^You can reply once the run has ended\.$/],
  ];
  for (const [url, request, pattern] of reasons) {
    await page.goto(`${url}#/~hub/request/${encodeURIComponent(request)}`);
    const gate = page.locator(`[data-run-view="${request}"] ${GATE}`);
    await gate.waitFor();
    assert.equal(await gate.getAttribute('data-reply-off'), '', request);
    assert.equal(await gate.locator('[data-reply-input]').isDisabled(), true, request);
    assert.match((await gate.locator('[data-reply-reason]').innerText()).trim(), pattern, request);
  }

  step('an agent-written proposal has no reply box (Approve covers it)');
  seed.request({ ...proposal(now, 'failed', 'A proposal'), origin: { kind: 'agent', name: 'hermes' }, by: 'hermes' });
  await page.goto(`${live.url}#/~hub/needs`);
  await page.locator(`[data-need="approval-${ids.failed}"]`).waitFor();
  assert.equal(await page.locator(GATE).count(), 0);

  step('a refused reply shows its error and keeps the text');
  seed.request({ ...proposal(now, 'failed', 'x'), id: id('refused-f6f6') });
  const refusedId = id('refused-f6f6');
  seed.put(`requests/${refusedId}/approved.json`, approvedFile(refusedId, 'hermes', now));
  seed.put(`requests/${refusedId}/taken.json`, { runner: 'hermes', host: 'hub', at: minutesAgo(now, 9).toISOString() });
  seed.put(`requests/${refusedId}/hermes-run.json`, { runId: 'r-refused', at: minutesAgo(now, 9).toISOString() });
  seed.put(`requests/${refusedId}/result.json`, { v: 1, outcome: 'failed', summary: 'It broke.', reason: 'hermes-error', by: 'hub', at: minutesAgo(now, 5).toISOString() });
  await page.route('**/api/hub/requests/*/reply', route => route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'Already continued as somewhere-else; reply there.' }) }));
  await page.goto(`${live.url}#/~hub/request/${encodeURIComponent(refusedId)}`);
  const failedBox = page.locator(`[data-run-view="${refusedId}"] ${GATE}`);
  await failedBox.waitFor();
  assert.equal(await failedBox.getAttribute('data-reply-off'), null, 'A failed job takes a reply.');
  assert.equal(await page.locator(`[data-run-view="${refusedId}"] [data-run-again]`).count(), 1, 'Approve again stays beside it.');
  await failedBox.locator('[data-reply-input]').fill('Try another angle');
  await failedBox.locator('[data-reply-send]').click();
  await failedBox.locator('[data-reply-error]').waitFor();
  assert.match(await failedBox.locator('[data-reply-error]').innerText(), /Already continued as somewhere-else/);
  assert.equal(await failedBox.locator('[data-reply-input]').inputValue(), 'Try another angle');
  await page.unroute('**/api/hub/requests/*/reply');

  step('a Hermes job that failed before it started has no box (nothing to continue); Approve again stays');
  const never = id('never-started-a9a9');
  idle.seed.request(proposal(idle.now, 'failed', 'Research that never started', { id: never }));
  idle.seed.put(`requests/${never}/approved.json`, approvedFile(never, 'hermes', idle.now));
  idle.seed.put(`requests/${never}/taken.json`, { runner: 'hermes', host: 'hub', at: minutesAgo(idle.now, 9).toISOString() });
  idle.seed.put(`requests/${never}/result.json`, { v: 1, outcome: 'failed', summary: 'Hermes could not start it.', reason: 'start-failed', by: 'hub', at: minutesAgo(idle.now, 8).toISOString() });
  await page.goto(`${idle.url}#/~hub/request/${encodeURIComponent(never)}`);
  await page.locator(`[data-run-view="${never}"] [data-run-state-chip]`, { hasText: 'Failed' }).waitFor();
  assert.equal(await page.locator(`[data-run-view="${never}"] [data-run-again]`).count(), 1);
  assert.equal(await page.locator(`[data-run-view="${never}"] ${GATE}`).count(), 0, 'No reply box without a Hermes run.');

  step('phone: the box fits the screen with no sideways scroll, on the request page');
  const phone = await open({ width: 390, height: 844 }, { hasTouch: true, isMobile: true });
  await phone.goto(`${live.url}#/~hub/request/${encodeURIComponent(ids.pc)}`);
  await phone.locator(`[data-run-view="${ids.pc}"] ${GATE}`).waitFor();
  const widths = await phone.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: document.documentElement.clientWidth }));
  assert.ok(widths.scroll <= widths.inner, 'The page does not scroll sideways.');
  const rect = await phone.locator(`[data-run-view="${ids.pc}"] ${GATE} .hub-compose`).boundingBox();
  assert.ok(rect.x >= 0 && rect.x + rect.width <= 390, 'The compose row is inside the screen.');
  assert.ok(rect.height >= 44);

  console.log('hub-reply-ui: passed');
} finally {
  for (const context of contexts) await context.close().catch(() => {});
  await browser.close();
  for (const fixture of fixtures) await fixture.close();
}
