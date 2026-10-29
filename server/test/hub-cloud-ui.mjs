// Run after npm run build. Cloud runs through a real browser, over the fixture service with a throwaway signing key and a fake
// routine in place of the real one: the drawer says where each cloud request stands (starting, waiting at the cap or the usage
// limit, started with a session link, could not start with Retry, fired but not started), a refused approval is a red alert,
// Today counts the day's cloud runs, the dry run says nothing was sent, and no routine address, token or repo key reaches the
// page. With BUW_SHOTS=<dir> it also saves a screenshot per state (for a pull request).
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { startHubFixture } from './hub-fixture.mjs';
import { createFakeRoutine } from '../../site/api/test/fake-routine.mjs';
import { markStamp } from '../../site/api/hub-model.mjs';
import { minutesAgo } from '../../site/api/test/hub-fixtures.mjs';

const step = name => console.log(`- ${name}`);
const channel = process.env.BUW_TEST_BROWSER || 'msedge';
const browser = await chromium.launch({ headless: true, channel });
const contexts = [];
const fixtures = [];
const shots = process.env.BUW_SHOTS;
if (shots) await mkdir(shots, { recursive: true });
const open = async (viewport, options = {}) => {
  const context = await browser.newContext({ viewport, serviceWorkers: 'block', reducedMotion: 'reduce', ...options });
  contexts.push(context);
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  page.on('pageerror', error => { throw error; });
  return page;
};
const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
const id = (slug, tail) => `${day}-magic-loops-${slug}-${tail}`;
const SECRET_URL = 'https://routine.example.test/v1/fire/SECRETURL123';
const SECRET_TOKEN = 'tok-SECRETTOKEN456';
const ENV = { CLAUDE_ROUTINE_MAGIC_LOOPS_URL: SECRET_URL, CLAUDE_ROUTINE_MAGIC_LOOPS_TOKEN: SECRET_TOKEN, CLAUDE_ROUTINE_MAGIC_LOOPS_REPO: 'example/magic-loops' };
const NEVER = '2099-01-01T00:00:00.000Z';
const proposal = (now, ident, text) => ({ id: ident, project: 'magic-loops', createdAt: minutesAgo(now, 20).toISOString(), by: 'owner', text, preset: 'code-task', repo: 'example/magic-loops', target: 'cloud', origin: { kind: 'owner', name: 'owner' } });
const shot = async (page, name) => { if (shots) await page.screenshot({ path: path.join(shots, `${name}.png`) }); };

/** Approve a proposal from Needs you and wait for the note that says what comes next. */
async function approve(page, fixture, ident) {
  await page.goto(`${fixture.url}#/~hub/needs`);
  await page.locator(`[data-need="approval-${ident}"] [data-approval-approve]`).click();
  await page.locator('[data-next-note]').waitFor();
}
const noSecrets = async page => {
  const text = await page.evaluate(() => document.body.innerText + document.documentElement.outerHTML);
  for (const secret of ['SECRETURL123', 'SECRETTOKEN456', 'routine.example.test', 'MAGIC_LOOPS']) assert.ok(!text.includes(secret), `The page shows ${secret}.`);
};
const noSideScroll = async (page, selector) => {
  const widths = await page.evaluate(selector_ => ({ scroll: document.querySelector(selector_).scrollWidth, inner: document.querySelector(selector_).clientWidth }), selector);
  assert.ok(widths.scroll <= widths.inner, `${selector} scrolls sideways.`);
};

try {
  const routine = createFakeRoutine({ status: 401 });
  const ids = { fail: id('fire-refused', 'a1a1'), queued: id('just-approved', 'b2b2'), stuck: id('fired-and-quiet', 'c3c3'), done: id('finished-pr', 'd4d4'), refused: id('forged-approval', 'e5e5'), limit: id('over-the-limit', 'f6f6') };
  const fixture = await startHubFixture({ signing: true, env: ENV, fetchImpl: routine.fetchImpl });
  fixtures.push(fixture);
  const { seed, now, fake } = fixture;
  const page = await open({ width: 1280, height: 900 });
  const put = (ident, file, body) => seed.put(`requests/${ident}/${file}`, body);
  const approvedFile = (ident, minutes = 40) => ({ v: 1, request: ident, project: 'magic-loops', repo: 'example/magic-loops', target: 'cloud', limits: { minutes: 120 }, expires: NEVER, at: minutesAgo(now, minutes).toISOString(), by: 'owner', signature: 'x' });
  const fireFile = (ident, minutes, body = {}) => seed.put(`requests/${ident}/fire-${markStamp(minutesAgo(now, minutes))}-f001.json`, { v: 1, at: minutesAgo(now, minutes).toISOString(), routine: 'MAGIC_LOOPS', ok: true, status: 200, by: 'hub', session: 'https://claude.ai/code/session_seeded', ...body });

  step('a fire the routine refuses: "Could not start in the cloud" with the reason in words and Retry; Today has the alert and its own Retry');
  seed.request(proposal(now, ids.fail, 'Fix the tab order on the settings sheet'));
  await new Promise(resolve => setTimeout(resolve, 100));
  await approve(page, fixture, ids.fail);
  assert.equal(routine.calls.length, 1, 'Approve fired once.');
  await page.goto(`${fixture.url}#/~hub/request/${encodeURIComponent(ids.fail)}`);
  const line = page.locator('[data-run-cloud="fire-failed"]');
  await line.waitFor();
  assert.match(await line.innerText(), /Could not start in the cloud: the routine refused the request/);
  assert.equal(await line.locator('[data-run-fire-retry]').count(), 1);
  assert.equal(await page.locator('[data-step="fire"]').count(), 1, 'The failed fire is in the timeline.');
  await shot(page, 'cloud-fire-failed');
  await page.goto(`${fixture.url}#/~hub/today`);
  await page.locator('[data-today-cloud]').waitFor();
  assert.equal((await page.locator('[data-today-cloud]').innerText()).trim(), 'Cloud: 0 of 10 today');
  const alert = page.locator('[data-alert]', { hasText: 'Cloud run could not be fired' });
  await alert.waitFor();
  assert.equal(await alert.locator('[data-alert-retry]').count(), 1);

  step('Retry from the drawer calls the routine once; the line turns into "Started in the cloud" with the session link');
  routine.set({ status: 200 });
  await page.goto(`${fixture.url}#/~hub/request/${encodeURIComponent(ids.fail)}`);
  await page.locator('[data-run-fire-retry]').click();
  await page.locator('[data-run-cloud="fired"]').waitFor();
  assert.equal(routine.calls.length, 2, 'Retry fired once.');
  assert.match(await page.locator('[data-run-cloud]').innerText(), /^Started in the cloud at \d\d:\d\d(?: [AP]M)?/);
  assert.match(await page.locator('[data-run-session]').getAttribute('href'), /^https:\/\/claude\.ai\/code\/session_fake2$/);
  assert.equal(await page.locator('[data-run-dry]').count(), 0, 'A real fire does not say dry.');
  assert.equal(await page.locator('[data-step="fire"]').count(), 2);
  assert.equal(await page.locator('[data-run-fire-retry]').count(), 0);
  await shot(page, 'cloud-fired');
  await page.goto(`${fixture.url}#/~hub/today`);
  await page.locator('[data-today-cloud]', { hasText: 'Cloud: 1 of 10 today' }).waitFor();

  step('queued, fired but not started (with Retry and Open session), and a finished run with its PR');
  seed.request(proposal(now, ids.queued, 'Rename the dash constants'));
  put(ids.queued, 'approved.json', approvedFile(ids.queued, 1));
  seed.request(proposal(now, ids.stuck, 'Add a test for the wall slide'));
  put(ids.stuck, 'approved.json', approvedFile(ids.stuck, 45));
  fireFile(ids.stuck, 30);
  seed.request(proposal(now, ids.done, 'Fix a typo in the getting started page'));
  put(ids.done, 'approved.json', approvedFile(ids.done, 90));
  fireFile(ids.done, 85);
  put(ids.done, 'taken.json', { v: 1, runner: 'cloud', host: 'cloud', at: minutesAgo(now, 84).toISOString() });
  put(ids.done, `run-${markStamp(minutesAgo(now, 60))}-r001.json`, { v: 1, state: 'running', lastAction: 'editing docs', at: minutesAgo(now, 60).toISOString() });
  put(ids.done, 'result.json', { v: 1, outcome: 'pr', pr: 'https://github.com/example/magic-loops/pull/7', summary: 'Fixed the typo.', by: 'cloud', at: minutesAgo(now, 50).toISOString() });
  await page.goto(`${fixture.url}#/~hub/request/${encodeURIComponent(ids.queued)}`);
  await page.locator('[data-run-cloud="queued"]').waitFor();
  assert.equal((await page.locator('[data-run-cloud]').innerText()).trim(), 'Starting in the cloud…');
  await shot(page, 'cloud-queued');
  await page.goto(`${fixture.url}#/~hub/request/${encodeURIComponent(ids.stuck)}`);
  const quiet = page.locator('[data-run-cloud="not-started"]');
  await quiet.waitFor();
  assert.match(await quiet.innerText(), /^Fired at \d\d:\d\d(?: [AP]M)? but the run has not started\./);
  assert.equal(await quiet.locator('[data-run-session]').getAttribute('href'), 'https://claude.ai/code/session_seeded');
  assert.equal(await quiet.locator('[data-run-fire-retry]').count(), 1);
  await shot(page, 'cloud-not-started');
  await page.goto(`${fixture.url}#/~hub/request/${encodeURIComponent(ids.done)}`);
  await page.locator('[data-run-pr]').waitFor();
  assert.equal(await page.locator('[data-run-pr]').getAttribute('href'), 'https://github.com/example/magic-loops/pull/7');
  assert.equal(await page.locator('[data-run-cloud]').count(), 0, 'A finished run has no cloud line.');
  assert.ok(await page.locator('[data-step="fire"]').count() === 1 && await page.locator('[data-step="taken"]').count() === 1, 'The timeline keeps the fire and the claim.');
  await shot(page, 'cloud-done');

  step('Today: the not-started alert has Retry, and Retry on an approval the server cannot check says so');
  await page.goto(`${fixture.url}#/~hub/today`);
  const stuckAlert = page.locator('[data-alert]', { hasText: 'Cloud run did not start' });
  await stuckAlert.waitFor();
  await stuckAlert.locator('[data-alert-retry]').click();
  await stuckAlert.locator('[data-alert-retry-error]').waitFor();
  assert.match(await stuckAlert.locator('[data-alert-retry-error]').innerText(), /failed the server's check/);
  await shot(page, 'cloud-today');

  step('a refused approval is a red alert on Today linked to its request');
  seed.request(proposal(now, ids.refused, 'A task with a forged approval'));
  put(ids.refused, 'approved.json', approvedFile(ids.refused, 30));
  put(ids.refused, 'taken.json', { v: 1, runner: 'cloud', host: 'cloud', at: minutesAgo(now, 29).toISOString() });
  put(ids.refused, 'result.json', { v: 1, outcome: 'failed', reason: 'approval-refused', summary: 'approval refused: bad signature', by: 'cloud', at: minutesAgo(now, 28).toISOString() });
  await page.goto(`${fixture.url}#/~hub/today`);
  await page.reload();
  const refusedAlert = page.locator('[data-alert]', { hasText: 'Cloud run refused the approval' });
  await refusedAlert.waitFor();
  assert.equal(await refusedAlert.locator('[data-alert-run]').getAttribute('data-alert-run'), ids.refused);
  assert.equal(await refusedAlert.locator('[data-alert-retry]').count(), 0, 'A refused approval is not retried.');

  step('a usage limit: the request waits and says when it tries again');
  routine.set({ status: 429 });
  seed.request(proposal(now, ids.limit, 'Work that meets the usage limit'));
  await approve(page, fixture, ids.limit);
  await page.goto(`${fixture.url}#/~hub/request/${encodeURIComponent(ids.limit)}`);
  const limit = page.locator('[data-run-cloud="waiting"]');
  await limit.waitFor();
  assert.match(await limit.innerText(), /^Waiting: cloud usage limit\. Tries again at \d\d:\d\d(?: [AP]M)?\./);
  assert.equal(await limit.getAttribute('data-cloud-reason'), 'usage-limit');
  assert.equal(await limit.locator('[data-run-fire-retry]').count(), 0);
  await shot(page, 'cloud-waiting-usage');
  await noSecrets(page);
  await page.goto(`${fixture.url}#/~hub/today`);
  await page.locator('[data-today-cloud]').waitFor();
  await noSecrets(page);
  assert.ok(fake.objects.size > 0);

  step('the cap and the dry run: the first fire says nothing was sent, the second waits at the cap');
  const capped = await startHubFixture({ signing: true, env: { ...ENV, HUB_CLOUD_DAILY: '1', HUB_ROUTINE_DRY_RUN: '1' } });
  fixtures.push(capped);
  const one = id('first-in-the-day', 'a7a7');
  const two = id('second-in-the-day', 'b8b8');
  capped.seed.request(proposal(capped.now, one, 'The first run of the day'));
  capped.seed.request(proposal(capped.now, two, 'The second run of the day'));
  await new Promise(resolve => setTimeout(resolve, 100));
  const phone = await open({ width: 375, height: 812 }, { hasTouch: true, isMobile: true });
  await approve(phone, capped, one);
  await phone.goto(`${capped.url}#/~hub/request/${encodeURIComponent(one)}`);
  const dry = phone.locator('[data-run-cloud="fired"]');
  await dry.waitFor();
  assert.match(await dry.innerText(), /Started in the cloud at \d\d:\d\d(?: [AP]M)? \(dev: nothing was sent\)/);
  assert.equal(await dry.locator('[data-run-session]').count(), 0, 'Nothing was sent, so there is no session.');
  await shot(phone, 'cloud-dry-run-phone');
  await approve(phone, capped, two);
  await phone.goto(`${capped.url}#/~hub/request/${encodeURIComponent(two)}`);
  const cap = phone.locator('[data-run-cloud="waiting"]');
  await cap.waitFor();
  assert.match(await cap.innerText(), /^Waiting: 1 cloud run today\. Starts at (\d\d:\d\d(?: [AP]M)?|\w{3} \d\d:\d\d(?: [AP]M)?)\./);
  assert.equal(await cap.getAttribute('data-cloud-reason'), 'daily-cap');
  await shot(phone, 'cloud-waiting-cap-phone');
  await noSideScroll(phone, '#root');
  await phone.goto(`${capped.url}#/~hub/needs/requests`);
  await phone.locator(`[data-request-open="${two}"]`).click();
  await phone.locator('[data-run-drawer] [data-run-cloud="waiting"]').waitFor();
  await noSideScroll(phone, '[data-run-drawer]');
  await shot(phone, 'cloud-drawer-phone');
  await phone.goto(`${capped.url}#/~hub/today`);
  await phone.locator('[data-today-cloud]', { hasText: 'Cloud: 1 of 1 today' }).waitFor();
  await noSideScroll(phone, '#root');
  await shot(phone, 'cloud-today-phone');

  console.log('hub-cloud-ui: passed');
} finally {
  for (const context of contexts) await context.close().catch(() => {});
  await browser.close();
  for (const fixture of fixtures) await fixture.close();
}
