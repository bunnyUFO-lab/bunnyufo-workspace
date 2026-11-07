// Run after npm run build. Team's third half, Schedules, through a real browser: the Hermes jobs with every setting, the lists that do not report yet,
// the old-data line, the sign-in line, and the three tabs fitting a phone. Read only: no button changes anything.
import { chromium } from '@playwright/test';
import { ms } from './ui-timeouts.mjs';
import assert from 'node:assert/strict';
import { startHubFixture } from './hub-fixture.mjs';
import { eventJson, seeder } from '../../site/api/test/hub-fixtures.mjs';

const step = name => console.log(`- ${name}`);
const channel = process.env.BUW_TEST_BROWSER || 'msedge';
const flat = text => text.replace(/\s+/g, ' ').trim();

const fresh = await startHubFixture({ pc: 'fresh', hermes: true, agentConfig: 'schedules' });
const stale = await startHubFixture({ agentConfig: 'schedules-stale' });
const plain = await startHubFixture({ agentConfig: 'fresh' });
const bare = await startHubFixture({});
const other = await startHubFixture({ agentConfig: 'schedules', otherSchedules: 'fresh' });
const otherOld = await startHubFixture({ agentConfig: 'schedules', otherSchedules: 'old' });

// The alert the Hub writes when a prompt changed on the host: Today links it to the job's page.
seeder(fresh.fake).event(eventJson({ kind: 'alert', title: 'The prompt of brief-weekly-report changed on the Hermes host, not from Schedules. Check it.', source: 'hub', extra: { job: 'brief-weekly-report' } }));

const browser = await chromium.launch({ headless: true, channel });
const contexts = [];
const open = async (viewport, options = {}) => {
  const context = await browser.newContext({ viewport, ...options });
  contexts.push(context);
  const page = await context.newPage();
  page.setDefaultTimeout(ms(15000));
  page.on('pageerror', error => { throw error; });
  return page;
};
const noSideways = async (page, what) => {
  const widths = await page.evaluate(() => ({
    scroll: document.scrollingElement.scrollWidth, inner: innerWidth,
    panes: [...document.querySelectorAll('.ui-pane')].filter(pane => pane.offsetParent !== null).map(pane => ({ name: pane.className, scroll: pane.scrollWidth, client: pane.clientWidth })),
  }));
  assert.ok(widths.scroll <= widths.inner, `${what}: the page scrolls sideways (${widths.scroll} > ${widths.inner}).`);
  for (const pane of widths.panes) assert.ok(pane.scroll <= pane.client, `${what}: the pane "${pane.name}" scrolls sideways (${pane.scroll} > ${pane.client}).`);
};
const hashOf = page => page.evaluate(() => location.hash);
const sections = page => page.locator('[data-schedule-source]').evaluateAll(list => list.map(item => [item.getAttribute('data-schedule-source'), item.getAttribute('data-schedule-state')]));

try {
  step('390: three tabs fit on one row, Schedules opens from the tab and lists the four jobs, with nothing sideways');
  const phone = await open({ width: 390, height: 844 }, { hasTouch: true, isMobile: true });
  await phone.goto(`${fresh.url}#/~hub/team`);
  await phone.locator('[data-team-tab="schedules"]').waitFor();
  const tabs = await phone.locator('[data-team-tabs] a').evaluateAll(list => list.map(item => { const box = item.getBoundingClientRect(); return { top: Math.round(box.top), right: Math.round(box.right), tab: item.getAttribute('data-team-tab') }; }));
  assert.deepEqual(tabs.map(item => item.tab), ['agents', 'skills', 'schedules']);
  assert.ok(tabs.every(item => item.top === tabs[0].top && item.right <= 390), `The three tabs fit one row: ${JSON.stringify(tabs)}`);
  assert.equal(await phone.locator('[data-team-tab="schedules"]').getAttribute('href'), '#/~hub/team/schedules');
  const before = await phone.evaluate(() => history.length);
  await phone.locator('[data-team-tab="schedules"]').tap();
  await phone.locator('[data-job]').first().waitFor();
  assert.equal(await hashOf(phone), '#/~hub/team/schedules');
  assert.equal(await phone.evaluate(() => history.length), before + 1, 'One step into Schedules.');
  assert.equal(await phone.locator('[data-team-tab="schedules"]').getAttribute('aria-selected'), 'true');
  assert.deepEqual(await sections(phone), [['hermes-jobs', 'live'], ['hermes-timers', 'live'], ['site-timers', 'not-reporting'], ['pc-tasks', 'not-reporting'], ['github', 'not-reporting']]);
  assert.deepEqual(await phone.locator('[data-job]').evaluateAll(list => list.map(row => row.getAttribute('data-job'))), ['brief-morning-digest', 'brief-weekly-report', 'brief-trends-watch', 'brief-spend-summary']);
  await noSideways(phone, 'Schedules at 390');

  step('390: which copy is real, how old the list is, and every row says its cadence in words, on or paused, next and last run');
  assert.equal(flat(await phone.locator('[data-schedules-copy]').innerText()), 'These are the jobs the Hermes host runs now. The setup script in the homelab repo only adds a job that is missing, so changing it does not change a job that already exists.');
  assert.match(flat(await phone.locator('[data-schedule-source="hermes-jobs"] [data-schedule-from]').innerText()), /^Hermes host, (just now|\d+ minutes? ago)$/);
  const morning = phone.locator('[data-job="brief-morning-digest"]');
  assert.match(flat(await morning.innerText()), /^brief-morning-digest Every day at 08:00, Central 0 8 \* \* \* Next .* Last 10 hours ago: worked On$/);
  const weekly = phone.locator('[data-job="brief-weekly-report"]');
  assert.match(flat(await weekly.innerText()), /Mondays at 09:00, Central 0 9 \* \* 1/);
  assert.match(flat(await phone.locator('[data-job="brief-trends-watch"]').innerText()), /Weekdays at 06:30 and 18:30, Central/);
  const spend = phone.locator('[data-job="brief-spend-summary"]');
  assert.equal(await spend.locator('[data-job-state]').getAttribute('data-job-state'), 'paused');
  assert.doesNotMatch(flat(await spend.innerText()), /Next /, 'A paused job has no next run to promise.');
  assert.match(flat(await spend.innerText()), /No run yet/);

  step('390: a failed last run and a streak show in the list without opening the row');
  const trends = phone.locator('[data-job="brief-trends-watch"]');
  assert.equal(await trends.getAttribute('data-job-failed'), '');
  assert.equal(flat(await trends.locator('[data-job-result="failed"]').innerText()), 'Last run failed');
  assert.equal(flat(await trends.locator('[data-job-streak]').innerText()), '3 in a row');
  assert.equal(await morning.getAttribute('data-job-failed'), null);

  step('390: the other lists say they are not reporting yet, the Hermes timers are listed with no run times');
  for (const id of ['site-timers', 'pc-tasks', 'github']) assert.equal(flat(await phone.locator(`[data-schedule-source="${id}"] [data-schedule-empty]`).innerText()), 'Not reporting yet. This list arrives with a later update.');
  assert.deepEqual(await phone.locator('[data-timer]').evaluateAll(list => list.map(row => row.getAttribute('data-timer'))), ['fixture-export', 'fixture-history']);
  assert.doesNotMatch(flat(await phone.locator('[data-schedule-source="hermes-timers"]').innerText()), /Next|Last run/);

  step('390: a job opens as a page of its own with every setting, the whole prompt, and a way back');
  await trends.tap();
  await phone.locator('[data-job-page]').waitFor();
  assert.equal(await hashOf(phone), '#/~hub/team/schedules/hermes/brief-trends-watch');
  assert.equal(await phone.locator('[data-job]').first().isVisible(), false, 'On a phone the page replaces the list.');
  const fact = name => phone.locator(`[data-fact="${name}"] dd`);
  assert.equal(flat(await fact('posts').innerText()), 'Discord, #fixture-trends');
  assert.equal(flat(await fact('failures').innerText()), 'Discord, #fixture-alerts');
  assert.equal(flat(await fact('model').innerText()), 'Follows the profile: claude-haiku-5-5');
  assert.equal(flat(await fact('script').innerText()), 'None');
  assert.match(flat(await fact('schedule').innerText()), /^30 6,18 \* \* 1-5 in Central time \(America\/Chicago\)$/);
  assert.equal(flat(await fact('result').innerText()), 'Failed');
  assert.equal(flat(await fact('error').innerText()), 'The fixture feed did not answer in time. Delivery: Channel was archived.');
  assert.equal(flat(await fact('streak').innerText()), '3');
  assert.equal(flat(await fact('runs').innerText()), '88');
  assert.match(flat(await fact('next').innerText()), /^\w{3} \d+ \w{3} \d{2}:\d{2}/);
  assert.equal(flat(await phone.locator('[data-job-prompt]').innerText()), 'Look for new trends in the fixture feed.');
  assert.equal(await phone.locator('[data-job-prompt-note]').count(), 0);
  await noSideways(phone, 'A job page at 390');
  await phone.locator('[data-schedule-back]').tap();
  await phone.locator('[data-job]').first().waitFor({ state: 'visible' });
  assert.equal(await hashOf(phone), '#/~hub/team/schedules');

  step('390: a pinned model, a pre-run script and a multi-line prompt');
  await phone.locator('[data-job="brief-spend-summary"]').tap();
  await phone.locator('[data-job-page="brief-spend-summary"]').waitFor();
  assert.equal(flat(await fact('model').innerText()), 'Pinned: claude-sonnet-5-5 (anthropic)');
  await phone.goto(`${fresh.url}#/~hub/team/schedules/hermes/brief-weekly-report`);
  await phone.locator('[data-job-page="brief-weekly-report"]').waitFor();
  assert.match(flat(await fact('script').innerText()), /^collect-week\.sh runs first/);
  assert.equal(flat(await fact('failures').innerText()), 'No destination known');
  await phone.goto(`${fresh.url}#/~hub/team/schedules/hermes/brief-morning-digest`);
  await phone.locator('[data-job-page="brief-morning-digest"]').waitFor();
  assert.equal(await phone.locator('[data-job-prompt]').innerText(), 'Write the morning digest.\nKeep it to five lines.\n');
  await phone.goto(`${fresh.url}#/~hub/team/schedules/hermes/no-such-job`);
  await phone.locator('[data-job-gone]').waitFor();

  step('1280: the job page opens beside the list, the first job is shown, the other tabs still work');
  const desk = await open({ width: 1280, height: 800 });
  await desk.goto(`${fresh.url}#/~hub/team/schedules`);
  await desk.locator('[data-job-page]').waitFor();
  assert.equal(await desk.locator('[data-job-page]').getAttribute('data-job-page'), 'brief-morning-digest');
  assert.equal(await desk.locator('[data-job="brief-morning-digest"]').getAttribute('aria-current'), 'page');
  await desk.locator('[data-job="brief-weekly-report"]').click();
  await desk.locator('[data-job-page="brief-weekly-report"]').waitFor();
  assert.equal(await hashOf(desk), '#/~hub/team/schedules/hermes/brief-weekly-report');
  assert.equal(await desk.locator('[data-job]').count(), 4, 'The list stays beside the page.');
  assert.equal(await desk.locator('[data-schedule-back]').isVisible(), false);
  await noSideways(desk, 'Schedules at 1280');
  await desk.locator('[data-team-tab="skills"]').click();
  await desk.locator('[data-skill]').first().waitFor();
  assert.equal(await hashOf(desk), '#/~hub/team/skills');
  await desk.goto(`${fresh.url}#/~hub/team`);
  await desk.locator('[data-team-view="roster"]').click();
  await desk.locator('.team-row').first().waitFor();

  step('1280: Today lists the prompt alert and it links to the job page');
  await desk.goto(`${fresh.url}#/~hub/today`);
  await desk.locator('[data-alert-job]').waitFor();
  assert.equal(flat(await desk.locator('[data-alert-job]').innerText()), 'The prompt of brief-weekly-report changed on the Hermes host, not from Schedules. Check it.');
  await desk.locator('[data-alert-job]').click();
  await desk.locator('[data-job-page="brief-weekly-report"]').waitFor();
  assert.equal(await hashOf(desk), '#/~hub/team/schedules/hermes/brief-weekly-report');

  step('1280: the agent page links to all schedules');
  await desk.goto(`${fresh.url}#/~hub/agent/briefs`);
  await desk.locator('[data-all-schedules]').waitFor();
  assert.equal(await desk.locator('[data-all-schedules]').getAttribute('href'), '#/~hub/team/schedules');

  step('1280: an export from 9 hours ago keeps its rows and says it may be out of date');
  const old = await open({ width: 1280, height: 800 });
  await old.goto(`${stale.url}#/~hub/team/schedules`);
  await old.locator('[data-job]').first().waitFor();
  assert.equal(await old.locator('[data-schedule-source="hermes-jobs"]').getAttribute('data-schedule-state'), 'old');
  assert.equal(flat(await old.locator('[data-schedule-source="hermes-jobs"] [data-schedule-old]').innerText()), 'Last heard from 9 hours ago; these may be out of date.');
  assert.equal(await old.locator('[data-job]').count(), 4);

  step('1280: an export from before these fields: the jobs show what they have; the timers say they are not listed');
  const older = await open({ width: 1280, height: 800 });
  await older.goto(`${plain.url}#/~hub/team/schedules`);
  await older.locator('[data-job]').first().waitFor();
  assert.equal(await older.locator('[data-job]').count(), 1);
  assert.equal(flat(await older.locator('[data-schedule-source="hermes-timers"] [data-schedule-empty]').innerText()), 'The Hermes host does not list its timers yet.');
  await older.locator('[data-job-page]').waitFor();
  assert.equal(flat(await older.locator('[data-fact="posts"] dd').innerText()), 'Not reported');
  assert.equal(flat(await older.locator('[data-fact="next"] dd').innerText()), 'Not reported');

  step('1280: no export: the empty state, and the words on which copy is real stay');
  const none = await open({ width: 1280, height: 800 });
  await none.goto(`${bare.url}#/~hub/team/schedules`);
  await none.locator('[data-schedules-copy]').waitFor();
  assert.equal(flat(await none.locator('[data-schedule-source="hermes-jobs"] [data-schedule-empty]').innerText()), 'The Hermes host has not published its settings yet.');
  assert.equal(await none.locator('[data-job]').count(), 0);

  step('390: the site host, the PC and GitHub list what they report; the repo\'s tasks show, the others fold; nothing sideways');
  const full = await open({ width: 390, height: 844 }, { hasTouch: true, isMobile: true });
  await full.goto(`${other.url}#/~hub/team/schedules`);
  await full.locator('[data-timer="fixture-publish.timer"]').waitFor();
  assert.deepEqual(await sections(full), [['hermes-jobs', 'live'], ['hermes-timers', 'live'], ['site-timers', 'live'], ['pc-tasks', 'live'], ['github', 'live']]);
  assert.match(flat(await full.locator('[data-schedule-source="site-timers"] [data-schedule-from]').innerText()), /^Site host, \d+ minutes? ago$/);
  const publish = full.locator('[data-timer="fixture-publish.timer"]');
  assert.match(flat(await publish.innerText()), /^fixture-publish\.timer Publishes the fixture pages OnCalendar=\*:0\/15, OnBootSec=2min Next .* Last .* ago: Worked On$/);
  assert.match(flat(await full.locator('[data-timer="fixture-backup.timer"]').innerText()), /Failed \(exit-code\)/);
  assert.equal(await full.locator('[data-timer="fixture-backup.timer"]').evaluate(row => row.classList.contains('sc-bad')), true);
  assert.doesNotMatch(flat(await full.locator('[data-timer="fixture-idle.timer"]').innerText()), /Next /, 'A timer that is off promises no next run.');
  assert.deepEqual(await full.locator('[data-schedule-source="pc-tasks"] [data-task]').evaluateAll(list => list.map(row => row.getAttribute('data-task'))), ['Sample Report', 'Sample Nightly'], 'only the repo\'s own tasks show until the fold opens');
  assert.match(flat(await full.locator('[data-task="Sample Report"]').innerText()), /Mondays, Fridays at 08:00 Next .* Last .* ago: Worked Ready$/);
  assert.equal(flat(await full.locator('[data-task="Sample Nightly"] [data-task-state]').innerText()), 'Running');
  const fold = full.locator('[data-fold="other-tasks"]');
  assert.equal(flat(await fold.locator('.ui-fold-head').innerText()), "Other programs' tasks (2)");
  assert.equal(await fold.locator('.ui-fold-head').getAttribute('aria-expanded'), 'false');
  assert.equal(flat(await full.locator('[data-tasks-cut]').innerText()), 'Showing 4 of 7 tasks.');
  await fold.locator('.ui-fold-head').tap();
  assert.deepEqual(await full.locator('[data-schedule-source="pc-tasks"] [data-task]').evaluateAll(list => list.map(row => row.getAttribute('data-task'))), ['Sample Report', 'Sample Nightly', 'Example Updater', 'Example Helper']);
  assert.match(flat(await full.locator('[data-task="Example Updater"]').innerText()), /Failed \(error 0x80070002\)/);
  assert.equal(flat(await full.locator('[data-task="Example Helper"] [data-task-state]').innerText()), 'Off');
  assert.doesNotMatch(flat(await full.locator('[data-task="Example Helper"]').innerText()), /Next /);
  assert.equal(flat(await full.locator('[data-schedule-source="github"] [data-schedule-note]').innerText()), "GitHub's list comes through the PC, so it is as old as the PC's last report.");
  const ci = full.locator('[data-workflow="example-org/fixture-app/ci.yml"]');
  assert.match(flat(await ci.innerText()), /^ci\.yml example-org\/fixture-app Every day at 03:17, UTC 17 3 \* \* \* Last .* ago: Worked Active$/);
  assert.match(flat(await full.locator('[data-workflow="example-org/fixture-app/nightly.yml"]').innerText()), /Failed \(failure\) Off$/);
  assert.doesNotMatch(flat(await full.locator('[data-schedule-source="pc-tasks"]').innerText()), /exe|\.ps1|C:/i, 'no action, argument or path');
  await noSideways(full, 'Schedules with every list at 390');

  step('1280: a PC list 4 hours old and a host file 3 hours old are marked old and keep their rows');
  const later = await open({ width: 1280, height: 800 });
  await later.goto(`${otherOld.url}#/~hub/team/schedules`);
  await later.locator('[data-timer="fixture-publish.timer"]').waitFor();
  assert.deepEqual(await sections(later), [['hermes-jobs', 'live'], ['hermes-timers', 'live'], ['site-timers', 'old'], ['pc-tasks', 'old'], ['github', 'old']]);
  assert.equal(flat(await later.locator('[data-schedule-source="site-timers"] [data-schedule-old]').innerText()), 'Last heard from 3 hours ago; these may be out of date.');
  assert.equal(flat(await later.locator('[data-schedule-source="pc-tasks"] [data-schedule-old]').innerText()), 'Last heard from 4 hours ago; these may be out of date.');
  assert.equal(await later.locator('[data-workflow]').count(), 2);
  await noSideways(later, 'Schedules with old lists at 1280');

  step('signed out: the route answers 401, the tab shows the sign-in line, and Agents still shows');
  const guestContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  contexts.push(guestContext);
  await guestContext.route('**/api/hub/schedules', route => route.fulfill({ status: 401, json: { error: 'Sign in to see the schedules.' } }));
  const guest = await guestContext.newPage();
  guest.setDefaultTimeout(ms(15000));
  await guest.goto(`${fresh.url}#/~hub/team/schedules`);
  await guest.locator('[data-schedules-signin]').waitFor();
  assert.equal(flat(await guest.locator('[data-schedules-signin]').innerText()), 'Schedules need sign-in.');
  assert.equal(await guest.locator('[data-job]').count(), 0);
  await guest.locator('[data-team-tab="agents"]').click();
  await guest.locator('[data-room]').first().waitFor();

  console.log('hub-schedules-ui: passed');
} finally {
  for (const context of contexts) await context.close().catch(() => {});
  await browser.close();
  for (const fixture of [fresh, stale, plain, bare, other, otherOld]) await fixture.close();
}
