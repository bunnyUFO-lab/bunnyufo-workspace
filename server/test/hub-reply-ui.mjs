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

  step('a PC job, a job not started and a taken one that no run is following show the box off, each with its reason');
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

  step('while it runs: a reply shows "You:" as sent, then read after the next tool, and the box clears');
  const steerIds = { read: id('steer-read-b1b1'), refused: id('steer-refused-b2b2'), stopped: id('steer-stopped-b3b3') };
  const slow = await startHubFixture({
    signing: true, hermes: true,
    hermesOptions: { runScript: ['Reading sources. ', { wait: 2500 }, { tool: 'web_search', preview: 'wooden tug games' }, { wait: 6000 }, 'Done.'], endWith: 'Done.\nCARD: assistant/tug-games' },
  });
  fixtures.push(slow);
  slow.seed.request(proposal(slow.now, 'failed', 'Research that can be steered', { id: steerIds.read }));
  await new Promise(resolve => setTimeout(resolve, 100));
  const steerer = await open({ width: 1280, height: 1000 });
  await steerer.goto(`${slow.url}#/~hub/needs`);
  await steerer.locator(`[data-need="approval-${steerIds.read}"] [data-approval-approve]`).click();
  await steerer.locator('[data-next-note]').waitFor();
  await steerer.goto(`${slow.url}#/~hub/request/${encodeURIComponent(steerIds.read)}`);
  const readView = steerer.locator(`[data-run-view="${steerIds.read}"]`);
  await readView.locator('[data-run-text]', { hasText: 'Reading sources.' }).waitFor();
  const steerBox = readView.locator(GATE);
  assert.equal(await steerBox.getAttribute('data-reply-off'), null, 'The box is on while it runs.');
  await steerBox.locator('[data-reply-input]').fill('Look at the wooden one too');
  await steerBox.locator('[data-reply-input]').press('Enter');
  const you = readView.locator('[data-run-you]');
  await you.waitFor();
  assert.match(await you.innerText(), /^You: Look at the wooden one too\s+sent$/);
  assert.equal(await you.getAttribute('data-run-you'), 'sent');
  assert.equal(await steerBox.locator('[data-reply-input]').inputValue(), '', 'The textarea cleared.');
  assert.equal(await steerer.evaluate(() => window.location.hash.includes('/request/')), true, 'The page stays on this run.');
  await readView.locator('[data-run-you="read"]').waitFor({ timeout: 20000 });
  assert.equal((await readView.locator('[data-run-you-state]').innerText()).trim(), 'read');
  assert.equal(slow.hermes.steers[0].input, 'Message from the owner while you work: Look at the wooden one too');
  await readView.locator('[data-run-state-chip]', { hasText: 'Done' }).waitFor({ timeout: 30000 });
  assert.match(await readView.locator('[data-step="reply"]').innerText(), /^You: Look at the wooden one too · sent$/);
  assert.equal(await readView.locator('[data-step="continued"]').count(), 0, 'It was read, so no second run.');

  step('Hermes cannot take it: the line says queued, and when the run completes it goes out as the next run, linked in the Timeline');
  const refuse = await startHubFixture({
    signing: true, hermes: true,
    hermesOptions: { refuseSteer: true, runScript: ['Reading sources. ', { wait: 3000 }, 'Done.'], endWith: 'Done.\nCARD: assistant/tug-games' },
  });
  fixtures.push(refuse);
  refuse.seed.request(proposal(refuse.now, 'failed', 'Research that Hermes refuses to steer', { id: steerIds.refused }));
  await new Promise(resolve => setTimeout(resolve, 100));
  const refused = await open({ width: 1280, height: 1000 });
  await refused.goto(`${refuse.url}#/~hub/needs`);
  await refused.locator(`[data-need="approval-${steerIds.refused}"] [data-approval-approve]`).click();
  await refused.locator('[data-next-note]').waitFor();
  await refused.goto(`${refuse.url}#/~hub/request/${encodeURIComponent(steerIds.refused)}`);
  const refusedView = refused.locator(`[data-run-view="${steerIds.refused}"]`);
  await refusedView.locator('[data-run-text]', { hasText: 'Reading sources.' }).waitFor();
  await refusedView.locator('[data-reply-input]').fill('Also compare prices');
  await refusedView.locator('[data-reply-send]').click();
  await refusedView.locator('[data-run-you="queued"]').waitFor();
  assert.match(await refusedView.locator('[data-reply-note]').innerText(), /goes out as the next run when this one ends/);
  const nextLink = refusedView.locator('[data-run-reply-to]');
  await nextLink.waitFor({ timeout: 30000 });
  assert.match(await refusedView.locator('[data-step="reply"]').innerText(), /^You: Also compare prices · sent as the next run → /);
  const nextRun = (await nextLink.innerText()).trim();
  assert.equal(refuse.fake.json(`sections/inbox/requests/${nextRun}/request.json`).continues.replies[0], 'Also compare prices');

  step('Stop: the reply is not sent on its own; it says "not sent: the run stopped" with Send it now, which continues it');
  const hold = await startHubFixture({ signing: true, hermes: true, hermesOptions: { runScript: ['Working. ', { hold: true }] } });
  fixtures.push(hold);
  hold.seed.request(proposal(hold.now, 'failed', 'Research that is stopped', { id: steerIds.stopped }));
  await new Promise(resolve => setTimeout(resolve, 100));
  const stopper = await open({ width: 1280, height: 1000 });
  await stopper.goto(`${hold.url}#/~hub/needs`);
  await stopper.locator(`[data-need="approval-${steerIds.stopped}"] [data-approval-approve]`).click();
  await stopper.locator('[data-next-note]').waitFor();
  await stopper.goto(`${hold.url}#/~hub/request/${encodeURIComponent(steerIds.stopped)}`);
  const held = stopper.locator(`[data-run-view="${steerIds.stopped}"]`);
  await held.locator('[data-run-text]', { hasText: 'Working.' }).waitFor();
  await held.locator('[data-reply-input]').fill('Only the cheap ones');
  await held.locator('[data-reply-send]').click();
  await held.locator('[data-run-you="sent"]').waitFor();
  await held.locator('[data-run-stop]').click();
  await held.locator('[data-run-state-chip]', { hasText: 'Stopped' }).waitFor();
  const queuedRow = held.locator('[data-step="reply"]');
  await queuedRow.locator('[data-run-reply-queued]').waitFor();
  assert.match(await queuedRow.innerText(), /^You: Only the cheap ones · not sent: the run stopped\s+Send it now$/);
  assert.equal(hold.fake.objects.has(`sections/inbox/requests/${steerIds.stopped}/continued.json`), false, 'Nothing went out on its own.');
  await queuedRow.locator('[data-run-send-now]').click();
  await stopper.waitForFunction(original => !decodeURIComponent(window.location.hash).includes(original), steerIds.stopped);
  await stopper.locator('[data-run-continues]').waitFor();
  assert.equal(hold.hermes.runs.length, 2, 'Send it now started the next run.');

  step('a run that ends asking takes the queued reply as the answer: the Timeline says "sent as the next run" and offers no Send it now');
  const askId = id('steer-asking-b4b4');
  const asking = await startHubFixture({
    signing: true, hermes: true,
    hermesOptions: { refuseSteer: true, runScript: ['Looking. ', { wait: 3000 }, 'Two games match.'], endWith: 'Two games match.\n\nWhich of the two games do you mean?' },
  });
  fixtures.push(asking);
  asking.seed.request(proposal(asking.now, 'failed', 'Research that ends with a question', { id: askId }));
  await new Promise(resolve => setTimeout(resolve, 100));
  const asker = await open({ width: 1280, height: 1000 });
  await asker.goto(`${asking.url}#/~hub/needs`);
  await asker.locator(`[data-need="approval-${askId}"] [data-approval-approve]`).click();
  await asker.locator('[data-next-note]').waitFor();
  await asker.goto(`${asking.url}#/~hub/request/${encodeURIComponent(askId)}`);
  const askView = asker.locator(`[data-run-view="${askId}"]`);
  await askView.locator('[data-run-text]', { hasText: 'Looking.' }).waitFor();
  await askView.locator('[data-reply-input]').fill('The wooden one');
  await askView.locator('[data-reply-send]').click();
  await askView.locator('[data-run-you="queued"]').waitFor();
  await askView.locator('[data-run-reply-to]').waitFor({ timeout: 30000 });
  assert.match(await askView.locator('[data-step="reply"]').innerText(), /^You: The wooden one · sent as the next run → /);
  assert.equal(await askView.locator('[data-run-send-now]').count(), 0, 'It was carried; there is nothing to send again.');
  const answerId = (await askView.locator('[data-run-reply-to]').innerText()).trim();
  assert.equal(asking.fake.json(`sections/inbox/requests/${answerId}/request.json`).followUp.answer, 'The wooden one');

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
