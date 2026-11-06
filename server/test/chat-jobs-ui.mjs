// Run after npm run build. At phone width: a reply that names jobs shows them as their own block (apart from helpers), Read the job opens the
// text as plain text, one tap approves the ids on screen, the rows move through their states, and a finished job opens its card.
import { chromium } from '@playwright/test';
import { ms } from './ui-timeouts.mjs';
import assert from 'node:assert/strict';
import { startHubFixture } from './hub-fixture.mjs';
import { requestJson } from '../../site/api/test/hub-fixtures.mjs';

const step = name => console.log(`- ${name}`);
const channel = process.env.BUW_TEST_BROWSER || 'msedge';
const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
const id = (slug, tail) => `${day}-probe-${slug}-${tail}`;
const [ONE, TWO, DONE_CARD, DONE_DEV] = [id('research-one', 'a111'), id('research-two', 'a222'), id('finished-assistant', 'b111'), id('finished-project', 'b222')];
const agentJob = (jobId, title, text) => ({ ...requestJson({ id: jobId, project: 'probe', by: 'hermes-main', text, now: new Date() }), title, preset: 'research', target: 'hermes', origin: { kind: 'agent', name: 'hermes' } });
const GOAL = 'Check the two scenery cards for the same canvas size.';
const REPLY = `Two jobs, nothing runs until you approve.\n1. ${ONE}: Researcher, one assistant card\n2. ${TWO}: Researcher, one assistant card\n`;

let filing = async () => {};   // Hermes files the two jobs through the card API while the reply runs, dated now
const fixture = await startHubFixture({
  hermes: true, chatRuns: true, signing: true, seedData: false,
  hermesOptions: { runScripts: [[{ call: () => filing() }, REPLY, { delegate: { goals: [GOAL] } }], [{ hold: true }], [{ hold: true }]] },
});
const browser = await chromium.launch({ headless: true, channel });
try {
  const put = (request, files = {}) => {
    fixture.seed.request(request, { writer: 'agent' });
    for (const [name, body] of Object.entries(files)) fixture.seed.put(`requests/${request.id}/${name}`, body);
  };
  filing = async () => {
    put({ ...agentJob(ONE, 'Compare two roguelike run summaries', 'Research how two roguelikes show a run summary. The plan card is assistant/plan.'), createdAt: new Date().toISOString() });
    put({ ...agentJob(TWO, 'Market scan for tug-of-war card games', 'Market research on tug-of-war card games. The plan card is assistant/plan.'), createdAt: new Date().toISOString() });
  };
  // Two finished jobs, one with a card in assistant and one in a project section, in a conversation the fixture holds already.
  const finished = (jobId, title, card) => put({ ...agentJob(jobId, title, `Finished job: ${title}`), createdAt: new Date(Date.now() - 3_600_000).toISOString() }, {
    'approved.json': { v: 1, request: jobId, target: 'hermes', limits: { minutes: 30 }, expires: new Date(Date.now() + 3_600_000).toISOString(), at: new Date(Date.now() - 3_000_000).toISOString(), by: 'owner' },
    'taken.json': { runner: 'hermes', at: new Date(Date.now() - 2_900_000).toISOString() },
    'result.json': { outcome: 'card', card, at: new Date(Date.now() - 2_000_000).toISOString(), by: 'hermes', summary: 'Done.' },
  });
  finished(DONE_CARD, 'Research roguelike summaries', 'assistant/x');
  finished(DONE_DEV, 'Teardown of a card game', 'dev-proj/x');
  for (const section of ['assistant', 'dev-proj']) fixture.fake.seed(`sections/${section}/workspace.json`, JSON.stringify({ name: section, entities: [{ id: 'x', title: `A card in ${section}`, folder: 'x', created: '2026-11-01' }] }), 'application/json');
  const CHAT = `${day}-fin123`;
  fixture.fake.seed(`sections/inbox/chat/${CHAT}.jsonl`, `${[
    { role: 'user', text: 'What came of the jobs?', at: new Date(Date.now() - 3_700_000).toISOString() },
    { role: 'assistant', text: 'Both finished.', at: new Date(Date.now() - 3_600_000).toISOString(), jobs: [DONE_CARD, DONE_DEV] },
  ].map(line => JSON.stringify(line)).join('\n')}\n`, 'application/x-ndjson');

  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  page.setDefaultTimeout(ms(20000));
  page.on('pageerror', error => { throw error; });
  await page.goto(`${fixture.url}#/~hub/chat/new`);

  step('a reply that names two jobs and starts a helper shows two separate blocks');
  await page.locator('textarea[aria-label="Message"]').fill('Plan the scenery research');
  await page.keyboard.press('Enter');
  const card = page.locator('[data-chat-jobs]');
  await card.waitFor();
  const rows = card.locator('[data-job-row]');
  await rows.nth(1).waitFor();
  assert.equal(await rows.count(), 2);
  assert.deepEqual(await rows.evaluateAll(list => list.map(row => row.getAttribute('data-job-state'))), ['proposed', 'proposed']);
  assert.match(await card.locator('[data-jobs-written]').textContent(), /Written by hermes, not by you\. Read it before approving\./);
  assert.match(await rows.first().locator('[data-job-meta]').textContent(), /^Researcher · Hermes · /);
  const helpers = page.locator('[data-delegates]');
  await helpers.waitFor();
  assert.match(await helpers.locator('.hub-delegates-head').textContent(), /^Hermes started a helper$/);
  assert.match(await helpers.locator('[data-delegates-sub]').textContent(), /Inside this chat\. Not tracked as a job\./);
  assert.equal(await helpers.locator('[data-chat-jobs], [data-job-row]').count(), 0, 'Helpers and jobs never share a list.');
  assert.equal(await card.locator('[data-delegate]').count(), 0);
  assert.equal(await page.locator('[data-delegates] [data-delegate]').count(), 1);

  step('Read the job shows the text as plain text, and Change opens the approval page');
  await rows.first().locator('[data-job-read] summary').click();
  assert.match(await rows.first().locator('.hub-job-text').textContent(), /^Research how two roguelikes show a run summary\./);
  assert.equal(await rows.first().locator('[data-job-change]').getAttribute('href'), `#/~hub/request/${ONE}`);
  assert.equal(await rows.first().locator('[data-job-title]').getAttribute('href'), `#/~hub/request/${ONE}`);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false, 'Nothing runs off the phone screen.');

  step('one tap approves the ids on screen, and each row moves on by itself');
  const approve = card.locator('[data-jobs-approve]');
  assert.equal((await approve.textContent()).trim(), 'Approve all 2');
  assert.match(await card.locator('[data-jobs-estimate]').textContent(), /^Estimated for all 2: 1\.4–2\.2 M tokens · if Codex is paused it may use paid models$/, 'the cost is on screen before the tap');
  assert.match(await rows.first().locator('[data-job-facts]').textContent(), /^Project probe · Up to 30 minutes · Codex plan/, 'the facts the approval page shows');
  // Never broken inside a word: the label is one line, on a phone too, and the button is wide enough for it.
  const approveBox = await approve.evaluate(node => { const range = document.createRange(); range.selectNodeContents(node); return { label: range.getBoundingClientRect().height, line: parseFloat(getComputedStyle(node).lineHeight) || parseFloat(getComputedStyle(node).fontSize) * 1.3, width: node.getBoundingClientRect().width, wrap: getComputedStyle(node).whiteSpace }; });
  assert.ok(approveBox.label <= approveBox.line * 1.5, `Approve all 2 wraps (text ${approveBox.label} px high, a line is ${approveBox.line}).`);
  assert.equal(approveBox.wrap, 'nowrap');
  assert.ok(approveBox.width >= 120, `The button is ${approveBox.width} px wide.`);
  await approve.click();
  await rows.first().locator('[data-job-status]', { hasText: /^(Approved, waiting to start|Taken|Running)/ }).waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll('[data-chat-jobs] [data-job-row]')].every(row => row.getAttribute('data-job-state') !== 'proposed'));
  assert.equal(await card.locator('[data-jobs-approve]').count(), 0, 'Nothing is left to approve.');
  for (const jobId of [ONE, TWO]) assert.ok(fixture.fake.objects.has(`sections/inbox/requests/${jobId}/approved.json`), `${jobId} is signed`);
  await page.waitForFunction(() => [...document.querySelectorAll('[data-chat-jobs] [data-job-row]')].every(row => ['taken', 'running'].includes(row.getAttribute('data-job-state'))), null, { timeout: ms(60000) });

  step('more than 3 proposals get no one tap: each row has its own Approve');
  const FOUR = ['c111', 'c222', 'c333', 'c444'].map(tail => id('many', tail));
  FOUR.forEach((jobId, index) => put({ ...agentJob(jobId, `Many ${index + 1}`, `Research ${index + 1}.`), createdAt: new Date().toISOString() }));
  const MANY = `${day}-man123`;
  fixture.fake.seed(`sections/inbox/chat/${MANY}.jsonl`, `${[{ role: 'user', text: 'Many', at: new Date().toISOString() }, { role: 'assistant', text: `Four jobs: ${FOUR.join(' ')}`, at: new Date().toISOString(), jobs: FOUR }].map(line => JSON.stringify(line)).join('\n')}\n`, 'application/x-ndjson');
  await page.goto(`${fixture.url}#/~hub/chat/${MANY}`);
  await page.locator('[data-job-row]').nth(3).waitFor();
  assert.equal(await page.locator('[data-jobs-approve]').count(), 0);
  assert.equal(await page.locator('[data-job-approve]').count(), 4);
  assert.match(await page.locator('[data-jobs-many]').textContent(), /more than 3/);

  step('a finished job opens its card, in assistant and in a project section');
  await page.goto(`${fixture.url}#/~hub/chat/${CHAT}`);
  const finishedRows = page.locator('[data-chat-jobs] [data-job-row]');
  await finishedRows.nth(1).waitFor();
  assert.deepEqual(await finishedRows.evaluateAll(list => list.map(row => row.getAttribute('data-job-state'))), ['done', 'done']);
  assert.deepEqual(await finishedRows.locator('[data-job-card]').evaluateAll(list => list.map(link => link.getAttribute('href'))), ['/assistant#/x', '/dev-proj#/x']);
  assert.equal(await page.locator('[data-jobs-approve]').count(), 0);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
} finally {
  await browser.close();
  await fixture.close();
}
console.log('chat-jobs-ui: ok');
