// Run after npm run build. Editing a Hermes job from its page (ws-eh2 G), through a real browser: the form on a phone, Save, Waiting, the host's answer,
// "Next run moved", Go back, and the page that says edits are not available yet. The host is played by the test (a seeded result and a newer export);
// every job, channel and id is made up and nothing touches a real host.
import { chromium } from '@playwright/test';
import { ms } from './ui-timeouts.mjs';
import assert from 'node:assert/strict';
import { startHubFixture } from './hub-fixture.mjs';
import { agentConfigJson, seedAgentConfig } from '../../site/api/test/hub-fixtures.mjs';

const step = name => console.log(`- ${name}`);
const channel = process.env.BUW_TEST_BROWSER || 'msedge';
const flat = text => text.replace(/\s+/g, ' ').trim();
const ref = (provider, name) => ({ provider, model: name });
const OPTIONS = { main: [ref('anthropic', 'claude-sonnet-5-5')], briefs: [ref('anthropic', 'claude-sonnet-5-5'), ref('anthropic', 'claude-haiku-5-5'), ref('deepseek', 'deepseek-flash')] };

const on = await startHubFixture({ agentConfig: 'schedules', jobEdits: true, signing: true });
const off = await startHubFixture({ agentConfig: 'schedules' });
const browser = await chromium.launch({ headless: true, channel });
const contexts = [];
const open = async (viewport, options = {}) => {
  const context = await browser.newContext({ viewport, reducedMotion: 'reduce', ...options });
  contexts.push(context);
  const page = await context.newPage();
  page.setDefaultTimeout(ms(15000));
  page.on('pageerror', error => { throw error; });
  return page;
};
const noSideways = async (page, what) => {
  const widths = await page.evaluate(() => ({ scroll: document.scrollingElement.scrollWidth, inner: innerWidth, panes: [...document.querySelectorAll('.ui-pane')].filter(pane => pane.offsetParent !== null).map(pane => ({ scroll: pane.scrollWidth, client: pane.clientWidth })) }));
  assert.ok(widths.scroll <= widths.inner, `${what}: the page scrolls sideways (${widths.scroll} > ${widths.inner}).`);
  for (const pane of widths.panes) assert.ok(pane.scroll <= pane.client, `${what}: a pane scrolls sideways.`);
};
const JOB = 'brief-weekly-report';

let phone
try {
  {
  step('390: the job page has a folded "Change this job"; opening it shows cadence, model and prompt, with thumb-sized buttons and nothing sideways');
  phone = await open({ width: 390, height: 844 }, { hasTouch: true, isMobile: true });
  const posts = [];
  phone.on('request', request => { if (request.method() === 'POST' && request.url().includes('/job-change')) posts.push(JSON.parse(request.postData() ?? '{}')); });
  await phone.goto(`${on.url}#/~hub/team/schedules/hermes/${JOB}`);
  const fold = phone.locator('[data-fold="edit-job"] button.ui-fold-head');
  await fold.waitFor();
  assert.equal(await phone.locator('[data-job-form]').count(), 0, 'closed until asked');
  await fold.tap();
  await phone.locator(`[data-job-form="${JOB}"]`).waitFor();
  assert.equal(flat(await phone.locator('[data-cadence-words]').innerText()), '0 9 * * 1 Mondays at 09:00, Central (Hermes host time)');
  assert.equal(await phone.locator('[data-edit-save]').isDisabled(), true, 'nothing to save yet');
  assert.match(flat(await phone.locator('[data-edit-script-note]').innerText()), /reads a script's output before it runs/);
  for (const selector of ['[data-edit-save]', '[data-edit-toggle]', '[data-cadence-kind="daily"]']) assert.ok((await phone.locator(selector).boundingBox()).height >= 44, `${selector} is at least 44 px tall`);
  await noSideways(phone, 'the form at 390');

  step('390: Tuesday at 09:30 shows now and new, the words beneath, and Save sends one edit with only the schedule');
  await phone.locator('[data-cadence-kind="weekdays"]').tap();
  await phone.locator('[data-cadence-day="1"]').tap();
  await phone.locator('[data-cadence-day="2"]').tap();
  await phone.locator('[data-cadence-time]').fill('09:30');
  assert.equal(flat(await phone.locator('[data-cadence-words]').innerText()), '30 9 * * 2 Tuesdays at 09:30, Central (Hermes host time)');
  assert.match(flat(await phone.locator('[data-preview="Schedule"]').innerText()), /Schedule Now 0 9 \* \* 1 New 30 9 \* \* 2/);
  await noSideways(phone, 'the preview at 390');
  await phone.locator('[data-edit-save]').tap();
  await phone.locator('[data-job-change="waiting"]').waitFor();
  assert.equal(flat(await phone.locator('[data-job-change-line]').innerText()), 'Waiting for the Hermes host');
  const sent = posts[0];
  assert.deepEqual(Object.keys(sent).sort(), ['base', 'job', 'op', 'to']);
  assert.deepEqual([sent.op, sent.job, sent.to], ['edit', JOB, { schedule: '30 9 * * 2' }]);
  assert.match(sent.base, /^[0-9a-f]{64}$/);
  const approved = [...on.fake.objects.keys()].filter(name => name.endsWith('/approved.json') && name.includes('-job-briefs-'));
  assert.equal(approved.length, 1);
  const doc = on.fake.json(approved[0]);
  assert.deepEqual([doc.kind, doc.op, doc.job, doc.to], ['job-change', 'edit', JOB, { schedule: '30 9 * * 2' }]);
}

{
  // The same tab, reloaded: the waiting row and the form come back from the Hub, and the tab remembers the next run from before the press.
  await phone.reload();
  await phone.locator('[data-job-change="waiting"]').waitFor();
  const changeId = on.fake.json([...on.fake.objects.keys()].find(name => name.endsWith('/approved.json') && name.includes('-job-briefs-'))).change;
  await phone.locator('[data-fold="edit-job"] button.ui-fold-head').tap();
  assert.equal(await phone.locator('[data-edit-save]').isDisabled(), true, 'a second press waits for the first');
  assert.equal(await phone.locator('[data-edit-toggle]').isDisabled(), true);

  step('390: the host answers while the page is open: Running, then the next run moves and the page says where from and to');
  const resultAt = new Date();
  on.fake.seed(`sections/inbox/agent-config/changes/${changeId}/result.json`, JSON.stringify({ v: 1, change: changeId, outcome: 'applied', code: 'ok', rolledBack: false, at: resultAt.toISOString() }), 'application/json', { writer: 'hermes-config' });
  await phone.locator('[data-job-change="applied"]').waitFor({ timeout: ms(12000) });
  assert.match(flat(await phone.locator('[data-job-change-line]').innerText()), /^Running/);
  const exported = agentConfigJson({ now: new Date(resultAt.getTime() + 2000), exportedMinutesAgo: 0, schedules: true, jobEdits: true, modelOptions: OPTIONS });
  const job = exported.profiles.briefs.cron.find(item => item.name === JOB);
  const moved = new Date(Date.now() + 4 * 24 * 3600 * 1000 + 30 * 60 * 1000);
  Object.assign(job, { schedule: '30 9 * * 2', nextRunAt: moved.toISOString(), rev: 'a'.repeat(64) });
  seedAgentConfig(on.fake, exported);
  await phone.locator('[data-job-change="live"]').waitFor({ timeout: ms(12000) });
  const line = flat(await phone.locator('[data-job-change-line]').innerText());
  assert.match(line, /^Next run moved: \w+day \d+ \w+ \d\d:\d\d to \w+day \d+ \w+ \d\d:\d\d$/);
  assert.equal(await phone.locator('[data-job-undo]').innerText(), 'Go back to the schedule 0 9 * * 1');
  await noSideways(phone, 'the moved line at 390');

  step('390: Go back signs the old schedule from the signed record and the row waits again');
  const posts = [];
  phone.on('request', request => { if (request.method() === 'POST' && request.url().includes('/job-change')) posts.push(JSON.parse(request.postData() ?? '{}')); });
  await phone.locator('[data-job-undo]').tap();
  await phone.locator('[data-job-change="waiting"]').waitFor();
  assert.deepEqual([Object.keys(posts[0]).sort(), posts[0].undo, posts[0].base], [['base', 'undo'], changeId, 'a'.repeat(64)]);
  const back = on.fake.json([...on.fake.objects.keys()].filter(name => name.endsWith('/approved.json') && name.includes('-job-briefs-')).find(name => !name.includes(changeId)));
  assert.deepEqual([back.op, back.to, back.fromRev], ['edit', { schedule: '0 9 * * 1' }, 'a'.repeat(64)]);

}

{
  step('1280: the list shows "Add a job" with the places to post by label, and the job page sits beside the list');
  const desk = await open({ width: 1280, height: 900 });
  await desk.goto(`${on.url}#/~hub/team/schedules/hermes/brief-morning-digest`);
  await desk.locator('[data-fold="add-job"] button.ui-fold-head').tap().catch(() => {});
  await desk.locator('[data-fold="add-job"] button.ui-fold-head').click();
  await desk.locator('[data-add-form]').waitFor();
  assert.deepEqual((await desk.locator('[data-add-target] option').allInnerTexts()).map(flat), ['#fixture-digest', '#fixture-trends']);
  assert.equal(await desk.locator('[data-add-save]').isDisabled(), true);
  await desk.locator('[data-add-name]').fill('brief-new-one');
  await desk.locator('[data-add-prompt]').fill('A new job, made by the test.');
  assert.equal(await desk.locator('[data-add-save]').isEnabled(), true);
  await desk.locator('[data-add-name]').fill('Bad Name');
  assert.match(flat(await desk.locator('[data-add-problem]').innerText()), /lower case letters, digits and dashes/);
  await desk.locator('[data-add-name]').fill('brief-morning-digest');
  assert.match(flat(await desk.locator('[data-add-problem]').innerText()), /exists/);
  await desk.locator('[data-fold="edit-job"] button.ui-fold-head').click();
  await desk.locator('[data-fold="remove-job"] button.ui-fold-head').click();
  assert.equal(await desk.locator('[data-edit-remove]').isDisabled(), true, 'Remove asks for the name first');
  await desk.locator('[data-remove-name]').fill('brief-morning-digest');
  assert.equal(await desk.locator('[data-edit-remove]').isEnabled(), true);
  assert.equal(await desk.locator('[data-remove-script-note]').count(), 0, 'no script, no warning');

  step('390: a cron that runs every minute is refused on the page before anything is sent');
  const small = await open({ width: 390, height: 844 }, { hasTouch: true, isMobile: true });
  await small.goto(`${on.url}#/~hub/team/schedules/hermes/brief-morning-digest`);
  await small.locator('[data-fold="edit-job"] button.ui-fold-head').tap();
  await small.locator('[data-cadence-kind="custom"]').tap();
  await small.locator('[data-cadence-custom]').fill('* * * * *');
  assert.match(flat(await small.locator('[data-cadence-problem]').innerText()), /at most four times a day/);
  assert.equal(await small.locator('[data-edit-save]').isDisabled(), true);
  await small.locator('[data-fold="remove-job"] button.ui-fold-head').tap();
  assert.match(flat(await small.locator('[data-fold="remove-job"]').innerText()), /Type brief-morning-digest to remove it/);

  step('390: with the host not ready (no jobEdits) the job page says edits are not available yet and has no form');
  const none = await open({ width: 390, height: 844 }, { hasTouch: true, isMobile: true });
  await none.goto(`${off.url}#/~hub/team/schedules/hermes/${JOB}`);
  await none.locator('[data-edits-off]').waitFor();
  assert.equal(flat(await none.locator('[data-edits-off]').innerText()), 'Editing jobs is not available yet. The Hermes host needs an update first.');
  assert.equal(await none.locator('[data-fold="edit-job"]').count() + await none.locator('[data-fold="add-job"]').count(), 0);
  assert.equal(await none.locator('[data-job-prompt]').count(), 1, 'the page still shows the job');
}
} finally {
  for (const context of contexts) await context.close().catch(() => {});
  await browser.close();
  for (const fixture of [on, off]) await fixture.close();
}
