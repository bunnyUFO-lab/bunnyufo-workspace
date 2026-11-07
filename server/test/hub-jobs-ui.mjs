// Run after npm run build. Work > Jobs and a job's result page: Running and Finished, each pill, the project filter, every kind of
// deliverable opening, a job that delivered nothing, the log closed, and no sideways scroll at 360 px. Phone and desktop.
// Data is the fixture's own fake S3 and fake Hermes: no real bucket, Hermes or Beads.
import { chromium } from '@playwright/test';
import { ms } from './ui-timeouts.mjs';
import assert from 'node:assert/strict';
import { pickOption } from './combobox.mjs';
import { startHubFixture } from './hub-fixture.mjs';
import { askJson, checklistJson, eventJson, iso, minutesAgo } from '../../site/api/test/hub-fixtures.mjs';

const step = name => console.log(`- ${name}`);
const channel = process.env.BUW_TEST_BROWSER || 'msedge';
const browser = await chromium.launch({ headless: true, channel });
const contexts = [];
const fixtures = [];
const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
const id = (name, rand) => `${day}-${name}-${rand}`;
const open = async viewport => {
  const context = await browser.newContext({ viewport, serviceWorkers: 'block', reducedMotion: 'reduce' });
  contexts.push(context);
  const page = await context.newPage();
  page.setDefaultTimeout(ms(15000));
  page.on('pageerror', error => { throw error; });
  return page;
};

try {
  const fx = await startHubFixture({ seedData: false });
  fixtures.push(fx);
  const J = {
    card: id('sizes', 'aa11'), pr: id('crop', 'bb22'), asks: id('grill', 'cc33'), asking: id('palette', 'dd44'), nothing: id('tiles', 'ee55'),
    failed: id('broken', 'ff66'), stopped: id('halt', 'gg77'), empty: id('vague', 'hh88'), running: id('going', 'ii99'), silent: id('quiet', 'll22'), noStart: id('nostart', 'mm33'), other: id('else', 'jj00'), child: id('after', 'kk11'),
  };
  const put = (jobId, title, minutes, { project = 'probe', result, stop, session } = {}) => {
    fx.seed.request({ id: jobId, project, title, text: `Do ${title}`, preset: 'research', target: 'hermes', by: 'hermes', createdAt: iso(minutesAgo(fx.now, minutes + 5)) });
    fx.seed.put(`requests/${jobId}/approved.json`, { target: 'hermes', expires: iso(new Date(fx.now.getTime() + 3600000)), at: iso(minutesAgo(fx.now, minutes + 4)) });
    fx.seed.put(`requests/${jobId}/taken.json`, { runner: 'hermes', at: iso(minutesAgo(fx.now, minutes)), ...(session ? { session } : {}) });
    if (stop) fx.seed.put(`requests/${jobId}/stop.json`, { at: iso(minutesAgo(fx.now, 2)), reason: 'stopped', by: 'owner' });
    if (result) fx.seed.put(`requests/${jobId}/result.json`, { v: 1, by: 'hub', at: iso(minutesAgo(fx.now, 1)), ...result });
  };
  const question = id('q1', 'q1q1');
  const steps = id('steps', 's1s1');
  put(J.card, 'Measure the background sizes', 12, { session: 'sess-card', result: { outcome: 'card', card: 'assistant/2026-11-05_sizes', summary: 'The game screen is 640 x 360. Backgrounds should be 1280 x 360.' } });
  put(J.pr, 'Fix the battle screen crop', 60, { result: { outcome: 'pr', pr: 'https://github.com/example/probe/pull/7', summary: 'Opened a pull request.' } });
  put(J.asks, 'Grill the plan', 70, { result: { outcome: 'asks', asks: [question], summary: 'One question.' } });
  put(J.asking, 'Compare enemy palettes', 80, { result: { outcome: 'question', question: 'Which palette do you want?', summary: 'Which palette do you want?' } });
  put(J.nothing, 'Check the old tile import', 90, { result: { outcome: 'failed', reason: 'nothing-to-do', summary: 'Nothing needs changing.' } });
  put(J.failed, 'Broken run', 100, { result: { outcome: 'failed', summary: 'The run failed: boom' } });
  put(J.silent, 'Silent failure', 130, { result: { outcome: 'failed' } });
  put(J.noStart, 'Never started', 140, { result: { outcome: 'failed', reason: 'start-failed', summary: "Hermes did not start: Cannot read properties of undefined (reading 'model')" } });
  put(J.stopped, 'Halted run', 110, { stop: true, result: { outcome: 'failed', reason: 'stopped', summary: 'Stopped by you.' } });
  put(J.empty, 'Vague run', 120, { result: { outcome: 'unknown', summary: 'Hermes forgot this run.' } });
  put(J.running, 'Still going', 4);
  put(J.other, 'Other project job', 30, { project: 'other', result: { outcome: 'card', card: 'dev-proj/2026-11-05_sizes' } });
  // What the first job filed: an Ask, a list of steps, a follow-up job and a task its session touched.
  fx.seed.ask({ ...askJson({ id: question, project: 'probe', now: fx.now, question: 'Which size first?' }), from: { host: 'hermes', tool: 'hermes', request: J.asks } });
  fx.seed.ask({ ...askJson({ id: id('q2', 'q2q2'), project: 'probe', now: fx.now, question: 'Which palette?' }), from: { host: 'hermes', tool: 'hermes', request: J.card } });
  fx.seed.checklist({ ...checklistJson({ id: steps, project: 'probe', now: fx.now, title: 'Check the sizes' }), from: { host: 'hermes', tool: 'hermes', request: J.card } });
  fx.seed.request({ id: J.child, project: 'probe', title: 'Follow-up job', text: 'Do more', preset: 'research', target: 'hermes', by: 'hermes', origin: { kind: 'run', name: J.card }, createdAt: iso(fx.now) });
  fx.seed.event(eventJson({ kind: 'session-items', ts: fx.now, project: 'probe', session: 'sess-card', extra: { touched: { beads: [{ project: 'probe', id: 'pr-1a2' }], cards: [] } } }));
  fx.fake.seed('sections/assistant/workspace.json', JSON.stringify({ name: 'Assistant', entities: [{ id: 'sizes-card', title: 'Magic Loops background sizes', folder: '2026-11-05_sizes', created: '2026-11-05' }] }), 'application/json');
  fx.fake.seed('sections/dev-proj/workspace.json', JSON.stringify({ name: 'dev-proj', entities: [{ id: 'proj-card', title: 'Project card', folder: '2026-11-05_sizes', created: '2026-11-05' }] }), 'application/json');
  await new Promise(resolve => setTimeout(resolve, 100));

  for (const [label, viewport] of [['phone', { width: 390, height: 844 }], ['small phone', { width: 360, height: 800 }], ['desktop', { width: 1280, height: 900 }]]) {
    const page = await open(viewport);
    const noSideways = async what => {
      const widths = await page.evaluate(() => ({ scroll: document.scrollingElement.scrollWidth, inner: innerWidth }));
      assert.ok(widths.scroll <= widths.inner, `${label}: ${what} scrolls sideways (${widths.scroll} > ${widths.inner}).`);
    };

    step(`${label}: Work has Running and Delivered tabs, and with a job running the bare address opens on Running`);
    await page.goto(`${fx.url}#/~hub/work`);
    await page.locator('[data-work-tab="running"]').click();
    await page.locator('[data-jobs-list="running"]').waitFor();
    assert.equal(await page.locator('[data-work-tab][aria-selected="true"]').count(), 1);
    assert.equal(await page.locator('[data-work-tab="running"][aria-selected="true"]').count(), 1);
    assert.match(await page.locator('[data-work-tab="running"]').innerText(), /^Running\s*1$/);
    assert.equal(await page.locator('[data-work-tab]').count(), 4, 'Running, Delivered, Board, Activity.');
    const live = page.locator(`[data-job-row="${J.running}"]`);
    assert.match(await live.innerText(), /Still going[\s\S]*probe · Researcher · Hermes · \d+ min ago[\s\S]*Taken/, 'the row names its project and its age');
    assert.equal(await page.locator('[data-job-row]').count(), 1, 'Only the running one is on the Running tab.');
    await noSideways('Running');

    step(`${label}: Delivered lists each job with the pill for what it delivered or how it ended`);
    await page.locator('[data-work-tab="delivered"]').click();
    await page.locator('[data-jobs-list="finished"]').waitFor();
    const pills = async jobId => (await page.locator(`[data-job-row="${jobId}"] [data-job-pill]`).allInnerTexts()).join('|');
    assert.equal(await pills(J.card), 'Card|Ask|Checklist|Task|Job', 'The card job also filed an Ask, a list, a follow-up job and touched a task.');
    assert.equal(await pills(J.pr), 'PR');
    assert.equal(await pills(J.asks), 'Ask');
    assert.equal(await pills(J.asking), 'Asking you', 'The list says what the job page says.');
    assert.equal(await pills(J.nothing), 'Nothing to change');
    assert.equal(await pills(J.failed), 'Failed');
    assert.equal(await page.locator(`[data-job-row="${J.failed}"] [data-job-pill]`).evaluate(node => getComputedStyle(node).color), await page.locator(`[data-job-row="${J.failed}"]`).evaluate(node => { const probe = document.createElement('span'); probe.style.color = 'var(--red)'; node.append(probe); const color = getComputedStyle(probe).color; probe.remove(); return color; }), 'Failed uses the red of the job page.');
    assert.notEqual(await page.locator(`[data-job-row="${J.failed}"] [data-job-pill]`).evaluate(node => getComputedStyle(node).color), await page.locator(`[data-job-row="${J.asking}"] [data-job-pill]`).evaluate(node => getComputedStyle(node).color), 'Failed does not look like Asking you.');
    assert.equal(await pills(J.stopped), 'Stopped');
    assert.equal(await pills(J.empty), 'Nothing delivered');
    assert.match(await page.locator('[data-jobs-foot]').innerText(), /last two months/);
    assert.equal(await page.locator(`[data-job-row="${J.running}"]`).count(), 0, 'A running job is not under Finished.');
    await noSideways('Finished');

    step(`${label}: the whole row opens the job's page`);
    await page.locator(`[data-job-row="${J.pr}"]`).click();
    await page.locator('[data-run-view]').waitFor();
    assert.match(page.url(), new RegExp(`#/~hub/request/${J.pr}$`));
    await page.locator('[data-run-back]').click();
    await page.locator('[data-jobs-list="finished"]').waitFor();
    assert.match(page.url(), /#\/~hub\/jobs\/finished$/, 'Back returns to the list the row was in.');
  }

  const page = await open({ width: 1280, height: 900 });
  step('the project filter uses the job\'s project');
  await page.goto(`${fx.url}#/~hub/jobs/finished`);
  await page.locator('[data-jobs-list="finished"]').waitFor();
  const before = await page.locator('[data-job-row]').count();
  await pickOption(page.locator('#hub-jobs-project'), 'other');
  await page.locator(`[data-job-row="${J.other}"]`).waitFor();
  assert.equal(await page.locator('[data-job-row]').count(), 1);
  assert.ok(before > 1);
  await pickOption(page.locator('#hub-jobs-project'), 'all');
  await page.locator(`[data-job-row="${J.card}"]`).waitFor();

  step('empty states say so');
  const quiet = await startHubFixture({ seedData: false });
  fixtures.push(quiet);
  await page.goto(`${quiet.url}#/~hub/jobs`);
  await page.locator('[data-jobs-empty]').waitFor();
  assert.equal((await page.locator('[data-jobs-empty]').innerText()).trim(), 'No delivered jobs in the last two months.', 'With nothing running the page opens on Delivered.');
  await page.goto(`${quiet.url}#/~hub/jobs/running`);
  assert.equal((await page.locator('[data-jobs-empty]').innerText()).trim(), 'Nothing running.');

  for (const [label, viewport] of [['phone', { width: 390, height: 844 }], ['desktop', { width: 1280, height: 900 }]]) {
    const result = await open(viewport);
    step(`${label}: the result page leads with the summary and deliverables, and keeps the log closed`);
    await result.goto(`${fx.url}#/~hub/request/${J.card}`);
    await result.locator('[data-run-deliverables]').waitFor();
    assert.match(await result.locator('[data-run-result]').innerText(), /640 x 360/);
    assert.match(await result.locator('[data-run-agent]').innerText(), /Researcher · Hermes/);
    assert.equal(await result.locator('[data-run-did]').evaluate(node => node.open), false, 'The log is closed.');
    assert.equal(await result.locator('[data-run-did] [data-run-timeline]').isVisible(), false, 'Nothing of the log shows while it is closed.');
    const kinds = await result.locator('[data-run-deliverable]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-run-deliverable')));
    assert.deepEqual(kinds, ['card', 'ask', 'checklist', 'job', 'task']);
    const widths = await result.evaluate(() => ({ scroll: document.scrollingElement.scrollWidth, inner: innerWidth }));
    assert.ok(widths.scroll <= widths.inner, `${label}: the result page scrolls sideways.`);

    step(`${label}: each deliverable opens what it names`);
    const href = kind => result.locator(`[data-run-deliverable="${kind}"] a.hub-btn`).getAttribute('href');
    assert.equal(await href('card'), '/assistant#/sizes-card', 'A card in assistant opens by its id in its section.');
    assert.equal(await result.locator('[data-run-deliverable="card"]').innerText().then(text => /Card · assistant/.test(text)), true, 'The sub-line names the section.');
    assert.match(await href('ask'), /#\/~hub\/ask\//);
    assert.match(await href('checklist'), /#\/~hub\/checklist\//);
    assert.equal(await href('job'), `#/~hub/request/${J.child}`);
    assert.equal(await href('task'), '#/~hub/project/probe/roadmap/pr-1a2');

    step(`${label}: a task the job made or touched shows its id`);
    const task = result.locator('[data-run-deliverable="task"]');
    assert.equal(await task.getAttribute('data-task-id'), 'pr-1a2');
    assert.equal((await task.locator('[data-run-task-id]').innerText()).trim(), 'pr-1a2', 'A task row names its id: titles are not looked up.');

    step(`${label}: the log opens on demand and holds the timeline`);
    await result.locator('[data-run-did] summary').click();
    await result.locator('[data-run-did] [data-run-timeline]').waitFor();
    assert.ok(await result.locator('[data-run-did] [data-step]').count() >= 3);

    step(`${label}: a PR opens in a new tab; a card in a project section opens too`);
    await result.goto(`${fx.url}#/~hub/request/${J.pr}`);
    const pr = result.locator('[data-run-pr]');
    await pr.waitFor();
    assert.equal(await pr.getAttribute('href'), 'https://github.com/example/probe/pull/7');
    assert.equal(await pr.getAttribute('target'), '_blank');
    assert.match(await result.locator('[data-run-deliverable="pr"]').innerText(), /example\/probe #7/);
    await result.goto(`${fx.url}#/~hub/request/${J.other}`);
    await result.locator('[data-run-card]').waitFor();
    assert.equal(await result.locator('[data-run-card]').getAttribute('href'), '/dev-proj#/proj-card');
    // The local copy has no page at a site path: the click says so in the app instead of leaving for the service's raw error.
    const here = result.url();
    await result.locator('[data-run-card]').click();
    await result.locator('[data-hub-no-site]').waitFor();
    assert.match(await result.locator('[data-hub-no-site]').innerText(), /dev-proj.*cannot open/);
    assert.equal(result.url(), here, 'The page did not move.');

    step(`${label}: a job that delivered nothing says so, in each of the three ways`);
    await result.goto(`${fx.url}#/~hub/request/${J.empty}`);
    assert.equal((await result.locator('[data-run-no-deliverables]').innerText()).trim(), 'This job delivered nothing you can open.');
    await result.goto(`${fx.url}#/~hub/request/${J.nothing}`);
    assert.equal((await result.locator('[data-run-no-deliverables]').innerText()).trim(), 'Done, nothing to change.');
    step(`${label}: a failed job leads with why it failed, from the record, and reads unlike a finished job with nothing to open`);
    await result.goto(`${fx.url}#/~hub/request/${J.failed}`);
    await result.locator('[data-run-failure]').waitFor();
    assert.equal((await result.locator('[data-run-failure-text]').innerText()).trim(), 'The run failed: boom', 'The reason comes from the record.');
    assert.equal(await result.locator('[data-run-no-deliverables]').count(), 0, 'A failure is not "delivered nothing".');
    assert.equal(await result.locator('[data-run-deliverables]').count(), 0);
    assert.match(await result.locator('.rd .rd-h').first().innerText(), /why it failed/i, 'The failure comes first.');
    step(`${label}: "Live log" is not shown when nothing is under it`);
    for (const empty of [J.nothing, J.failed, J.stopped, J.silent]) {
      await result.goto(`${fx.url}#/~hub/request/${empty}`);
      await result.locator('.rd').waitFor();
      assert.equal(await result.locator('[data-run-did]').count(), 0, `${empty}: no empty "Live log"`);
      assert.equal(await result.getByText('Live log', { exact: true }).count(), 0);
    }
    await result.goto(`${fx.url}#/~hub/request/${J.noStart}`);
    await result.locator('[data-run-failure]').waitFor();
    assert.equal((await result.locator('[data-run-failure-text]').innerText()).trim(), 'The run could not start.');
    assert.equal(await result.locator('[data-run-failure-detail]').isVisible(), false, 'The raw error is not on the page until Live log is opened.');
    await result.locator('[data-run-did] summary').click();
    assert.match(await result.locator('[data-run-failure-detail]').innerText(), /Cannot read properties/);
    await result.goto(`${fx.url}#/~hub/request/${J.silent}`);
    await result.locator('[data-run-failure]').waitFor();
    assert.equal((await result.locator('[data-run-failure-text]').innerText()).trim(), 'Hermes gave no reason.', 'With no reason on record the page says so.');
    assert.equal(await result.locator('[data-run-no-deliverables]').count(), 0);

    step(`${label}: a job that asked a question keeps the question block`);
    await result.goto(`${fx.url}#/~hub/request/${J.asking}`);
    await result.locator('[data-run-asking]').waitFor();
    assert.match(await result.locator('[data-run-asking]').innerText(), /Which palette do you want/);
    assert.equal((await result.locator('[data-run-stop]').innerText()).trim(), 'Stop this job', 'Stopping a question that waits closes the job: the button says so.');

    step(`${label}: a job still running keeps the old layout, with its timeline in view`);
    await result.goto(`${fx.url}#/~hub/request/${J.running}`);
    await result.locator('[data-run-timeline]').waitFor();
    assert.equal(await result.locator('[data-run-did]').count(), 0);

    step(`${label}: Stop asks first, and Keep going leaves the job alone`);
    assert.equal(await result.locator('[data-run-stop-ask]').count(), 0);
    await result.locator('[data-run-stop]').click();
    await result.locator('[data-run-stop-ask]').waitFor();
    assert.equal(await result.locator('[data-run-stop]').count(), 0, 'The question replaces the button.');
    await result.locator('[data-run-stop-cancel]').click();
    await result.locator('[data-run-stop]').waitFor();
    assert.equal(await result.locator('[data-run-stop-ask]').count(), 0);
    assert.equal(await result.locator('[data-run-state]').getAttribute('data-run-state'), 'taken', 'Nothing was stopped.');
  }

  step('a visitor who cannot write sees the same pages without Stop, Approve again or New job');
  const guestContext = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  contexts.push(guestContext);
  await guestContext.route('**/api/capabilities', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...(await response.json()), write: false } });
  });
  const guest = await guestContext.newPage();
  guest.setDefaultTimeout(ms(15000));
  await guest.goto(`${fx.url}#/~hub/jobs/running`);
  await guest.locator('[data-job-row]').first().waitFor();
  assert.equal(await guest.locator('[data-work-tab]').count(), 4, 'The same four tabs.');
  assert.equal(await guest.locator('[data-spawn-open]').count(), 0, 'No New job.');
  for (const job of [J.running, J.failed, J.card]) {
    await guest.goto(`${fx.url}#/~hub/request/${job}`);
    await guest.locator('[data-run-view]').waitFor();
    assert.equal(await guest.locator('[data-run-stop], [data-run-again], [data-run-fire-retry]').count(), 0, `${job}: no action`);
  }
  console.log('hub-jobs-ui: ok');
} finally {
  for (const context of contexts) await context.close().catch(() => {});
  await browser.close().catch(() => {});
  for (const fixture of fixtures) await fixture.close().catch(() => {});
}
