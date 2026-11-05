// Run after npm run build. At phone width: what delegate_task started shows in the chat, and a reply whose stream broke arrives by itself.
import { chromium } from '@playwright/test';
import { ms } from './ui-timeouts.mjs';
import assert from 'node:assert/strict';
import { startHubFixture } from './hub-fixture.mjs';

const step = name => console.log(`- ${name}`);
const channel = process.env.BUW_TEST_BROWSER || 'msedge';
const GOALS = ['Read the mood board cards and list the canvas sizes.', 'Read the scenery cards and list what is built and what is only proposed.'];
const BATCH = `[ASYNC DELEGATION BATCH COMPLETE — deleg_fake]
A background fan-out unit you dispatched earlier — 2 subagent(s) — has finished.

--- ✓ TASK 1/2: ${GOALS[0]}  (status=completed, api_calls=9, 64.2s) ---
The battle canvas is 640 by 360.

--- ✗ TASK 2/2: ${GOALS[1]}  (status=error, 11s) ---
(error: the card was gone)`;

const fixture = await startHubFixture({ hermes: true, chatRuns: true, hermesOptions: { runScript: ['I started two reviews. ', { delegate: { goals: GOALS } }, { hold: true }] } });
const browser = await chromium.launch({ headless: true, channel });
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  page.setDefaultTimeout(ms(15000));
  page.on('pageerror', error => { throw error; });
  // window.__cutStream() breaks the reply stream the way a dropped connection does; the Hub on the other side goes on.
  await page.addInitScript(() => {
    const real = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const answer = await real(input, init);
      if (!(String(input).endsWith('/api/hub/chat') && init?.method === 'POST' && answer.body)) return answer;
      const reader = answer.body.getReader();
      return new Response(new ReadableStream({
        start(controller) {
          window.__cutStream = () => { reader.cancel().catch(() => {}); controller.error(new TypeError('network error')); };
          const pump = () => reader.read().then(({ done, value }) => { if (done) controller.close(); else { controller.enqueue(value); pump(); } }).catch(() => {});
          pump();
        },
      }), { status: answer.status, headers: answer.headers });
    };
  });
  await page.goto(`${fixture.url}#/~hub/chat`);

  step('a delegate shows its goal and that it is running, not a tool name');
  await page.locator('textarea[aria-label="Message"]').fill('Plan the backgrounds');
  await page.keyboard.press('Enter');
  const cards = page.locator('[data-pending] [data-delegate]');
  await cards.nth(1).waitFor();
  assert.deepEqual(await cards.locator('[data-delegate-goal]').allTextContents(), GOALS);
  assert.equal(await page.locator('[data-pending] .hub-delegates-head').textContent(), 'Hermes started 2 helpers');
  assert.equal(await page.locator('[data-pending] [data-delegates-sub]').textContent(), 'Inside this chat. Not tracked as a job.');
  assert.deepEqual(await cards.locator('[data-delegate-state]').allTextContents(), ['Running', 'Running']);
  assert.equal(await page.locator('[data-pending] [data-tool="delegate_task"]').count(), 0, 'The bare tool line is gone.');
  const wide = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  assert.equal(wide, false, 'Nothing runs off the phone screen.');

  step('a cut stream says Hermes goes on, keeps the question and the delegates, and shows no error');
  await page.evaluate(() => window.__cutStream());
  await page.locator('[data-chat-note]', { hasText: 'The connection dropped' }).waitFor();
  assert.equal(await page.locator('.hub-error').count(), 0);
  await page.locator('.hub-bubble.user', { hasText: 'Plan the backgrounds' }).waitFor();
  assert.equal(await cards.count(), 2);
  await page.getByRole('button', { name: 'Stop' }).waitFor();

  step('when Hermes finishes, the saved reply takes its place without reopening the chat');
  const run = fixture.hermes.runs[0];
  fixture.hermes.release(run.id, 'I started two reviews.');
  const reply = page.locator('.hub-bubble.assistant:not([data-pending])', { hasText: 'I started two reviews.' });
  await reply.waitFor();
  assert.ok(!(await reply.textContent()).includes('[interrupted]'));
  await page.locator('[data-chat-note]').waitFor({ state: 'detached' });
  assert.equal(await page.locator('.hub-error').count(), 0);
  await page.waitForURL(/~hub\/chat\/\d{8}-/);
  await page.getByRole('button', { name: 'Send' }).waitFor();

  step('delegates that outlive the reply stay running, and their results arrive after the run');
  const saved = page.locator('.hub-bubble.assistant [data-delegate]');
  await saved.nth(1).waitFor();
  assert.deepEqual(await saved.locator('[data-delegate-state]').allTextContents(), ['Running', 'Running']);
  fixture.hermes.deliver(run.id, BATCH);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));   // as when the phone brings the page back
  await saved.first().locator('[data-delegate-state]', { hasText: 'Finished · 1 min 4 s' }).waitFor();
  await saved.nth(1).locator('[data-delegate-state]', { hasText: 'Failed · 11 s' }).waitFor();
  await saved.first().locator('[data-delegate-result] summary').click();
  await saved.first().getByText('The battle canvas is 640 by 360.').waitFor();

  step('the results are saved: a reopened chat shows them');
  await page.reload();
  await page.locator('.hub-bubble.assistant [data-delegate-state]', { hasText: 'Finished' }).waitFor();

  step('a chat opened while its reply is still coming waits for it');
  await page.locator('textarea[aria-label="Message"]').fill('One more');
  await page.keyboard.press('Enter');
  await page.locator('[data-pending]').waitFor();
  while (fixture.hermes.runs.length < 2) await page.waitForTimeout(50);
  await page.waitForFunction(() => typeof window.__cutStream === 'function');
  await page.reload();
  // The page follows the running turn live now, so its question shows at once, with no waiting note.
  await page.locator('.hub-bubble.user', { hasText: 'One more' }).waitFor();
  await page.locator('[data-pending]').waitFor();
  assert.equal(await page.locator('[data-chat-note]').count(), 0, 'Following a turn live needs no note.');
  fixture.hermes.release(fixture.hermes.runs[1].id);
  await page.locator('.hub-bubble.user', { hasText: 'One more' }).waitFor();   // the turn's lines come from the saved chat
  await page.locator('.hub-bubble.assistant:not([data-pending])').nth(1).waitFor();
  await page.locator('[data-chat-note]').waitFor({ state: 'detached' });

  console.log('ok');
} finally {
  await browser.close();
  await fixture.close();
}
