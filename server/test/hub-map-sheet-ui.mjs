// Run after npm run build. The Roadmap item sheet through a real browser, over the hub fixture: what the work is
// (summary), the Library cards it names, its pull requests from Beads, how a done feature says it finished, and
// "Open in Needs you" only when Needs you has the item, and the owner's Mark done / No longer needed / Undo on a
// yellow task with no Ask or Inbox item. Desktop (1280x800) and phone (390x844).
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { ms } from './ui-timeouts.mjs';
import assert from 'node:assert/strict';
import { startHubFixture, askId } from './hub-fixture.mjs';
import { askJson, beadsIssue, checklistJson, minutesAgo, threeOptions } from '../../site/api/test/hub-fixtures.mjs';
import { closingEventPath, itemId } from '../../site/api/hub-sprints.mjs';
import { listenOnGoodPort } from '../listen.mjs';

const step = name => console.log(`- ${name}`);
const channel = process.env.BUW_TEST_BROWSER || 'msedge';
const PROJECT = 'sheetdev';
const BACKFILL = 'Backfilled 2026-10-26 from git, PRs and cards.';

// This test writes requests into the bucket by hand, so the map's 30-second request cache is off (HUB_MAP_REQUESTS_MS).
// The sweep that signs the next item of a sprint runs every second here, so the test need not wait a minute for it.
const fixture = await startHubFixture({ signing: true, env: { HUB_MAP_REQUESTS_MS: '0', HUB_SPRINT_SWEEP_MS: '1000' } });
const extra = (issue, more) => ({ ...issue, ...more });
const issues = [
  beadsIssue({ id: 'sd-m1', title: 'Sheet milestone', type: 'milestone', created: '2026-10-01T10:00:00Z' }),
  extra(beadsIssue({ id: 'sd-f-done', title: 'Finished feature', type: 'epic', parent: 'sd-m1', status: 'closed', closed: '2026-10-18T12:00:00Z', created: '2026-10-01T11:00:00Z', description: 'Everything the loader needs to stream chunks. It keeps memory flat.' }), { close_reason: 'done (backfilled)' }),
  extra(beadsIssue({ id: 'sd-t-done', title: 'Stream the chunks', parent: 'sd-f-done', status: 'closed', closed: '2026-10-17T12:00:00Z', created: '2026-10-01T12:00:00Z', description: `a62a2bb4\n\nPR: #138 merged\n${BACKFILL}` }), { external_ref: 'gh-138', close_reason: 'Merged in review' }),
  beadsIssue({ id: 'sd-f-open', title: 'Open feature', type: 'epic', parent: 'sd-m1', created: '2026-10-02T11:00:00Z', description: 'Show the hero a wall slide when they touch a <b>wall</b>. It reuses the grounded check.' }),
  extra(beadsIssue({ id: 'sd-t-said', title: 'Copy the backups', parent: 'sd-f-open', created: '2026-10-02T12:00:00Z', description: `Copy the weekly backups off the host, so one dead disk loses nothing. A second sentence follows here. A third is cut.\n\n${BACKFILL}` }), { metadata: { cards: 'sheetlib/2026-10-27_plan,nowhere/missing' } }),
  beadsIssue({ id: 'sd-t-hash', title: 'Hash only', parent: 'sd-f-open', created: '2026-10-02T13:00:00Z', description: `a62a2bb4\n\n${BACKFILL}` }),
  beadsIssue({ id: 'sd-t-label', title: 'Register the domain', parent: 'sd-f-open', labels: ['needs-owner'], created: '2026-10-02T14:00:00Z' }),
  beadsIssue({ id: 'sd-t-ask', title: 'Pick the arc', parent: 'sd-f-open', labels: ['needs-owner'], created: '2026-10-02T15:00:00Z' }),
  beadsIssue({ id: 'sd-f-chk', title: 'Checklist feature', type: 'epic', parent: 'sd-m1', created: '2026-10-02T16:00:00Z' }),
  beadsIssue({ id: 'sd-t-chk', title: 'Set up the bot', parent: 'sd-f-chk', created: '2026-10-02T17:00:00Z' }),
  beadsIssue({ id: 'sd-f-race', title: 'Race feature', type: 'epic', parent: 'sd-m1', created: '2026-10-03T11:00:00Z' }),
  beadsIssue({ id: 'sd-t-race-desktop', title: 'Race one', parent: 'sd-f-race', labels: ['needs-owner'], created: '2026-10-03T12:00:00Z' }),
  beadsIssue({ id: 'sd-t-race-phone', title: 'Race two', parent: 'sd-f-race', labels: ['needs-owner'], created: '2026-10-03T13:00:00Z' }),
  beadsIssue({ id: 'sd-f-do', title: 'Do-it feature', type: 'epic', parent: 'sd-m1', created: '2026-10-04T11:00:00Z' }),
  ...['desktop', 'phone'].map(label => extra(beadsIssue({ id: `sd-t-do-${label}`, title: `Wire the exit door ${label}`, parent: 'sd-f-do', created: '2026-10-04T12:00:00Z', description: 'Players need a door at the end of the level.\n\nIt opens when the key is held.' }), { acceptance_criteria: '- The door opens with the key\n- A test covers it' })),
];
fixture.seed.beads(PROJECT, issues, { pushedAt: minutesAgo(fixture.now, 5).toISOString(), host: 'pc.example.test', count: issues.length, repo: 'example/sheetdev' });
// Two projects that run on the PC, one per viewport: a sprint is one per project at a time.
const SPRINT_PROJECTS = { desktop: { id: 'magic-loops', prefix: 'ml' }, phone: { id: 'sprite-studio', prefix: 'ss' } };
for (const { id, prefix } of Object.values(SPRINT_PROJECTS)) {
  const sprintIssues = [
    beadsIssue({ id: `${prefix}-ms`, title: 'Sprint milestone', type: 'milestone', created: '2026-10-01T10:00:00Z' }),
    beadsIssue({ id: `${prefix}-ft`, title: 'Sprint feature', type: 'epic', parent: `${prefix}-ms`, created: '2026-10-01T10:01:00Z' }),
    extra(beadsIssue({ id: `${prefix}-a`, title: 'Read the level file', parent: `${prefix}-ft`, created: '2026-10-01T11:00:00Z', description: 'Parse the level file.\nKeep it small.' }), { acceptance_criteria: 'The level loads' }),
    beadsIssue({ id: `${prefix}-b`, title: 'Draw the door', parent: `${prefix}-ft`, created: '2026-10-01T11:01:00Z' }),
    beadsIssue({ id: `${prefix}-c`, title: 'Wire the door', parent: `${prefix}-ft`, blocks: [`${prefix}-b`], created: '2026-10-01T11:02:00Z' }),
    beadsIssue({ id: `${prefix}-owner`, title: 'Pick the door colour', parent: `${prefix}-ft`, labels: ['needs-owner'], created: '2026-10-01T11:03:00Z' }),
  ];
  fixture.seed.beads(id, sprintIssues, { pushedAt: minutesAgo(fixture.now, 5).toISOString(), host: 'pc.example.test', count: sprintIssues.length, repo: `example/${id}` });
  fixture.fake.seed(`sections/${id}/workspace.json`, JSON.stringify({ name: id, tracked: { repo: `example/${id}` }, entities: [] }), 'application/json');
}
fixture.fake.seed('sections/sheetlib/workspace.json', JSON.stringify({ name: 'Sheet library', entities: [{ id: 'mission', title: 'Mission control', folder: '2026-10-27_plan' }] }), 'application/json');
const ASK = askId('sheet-arc', 's1s1');
const CHECKLIST = `${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-sheetdev-set-up-the-bot-c1c1`;
fixture.seed.checklist(checklistJson({ id: CHECKLIST, project: PROJECT, bead: 'sd-t-chk', now: minutesAgo(fixture.now, 15) }));
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
fixture.seed.ask(askJson({ id: ASK, bead: 'sd-t-ask', now: minutesAgo(fixture.now, 10), options: threeOptions() }));

const browser = await chromium.launch({ headless: true, channel });
const contexts = [];
const open = async (viewport, options = {}) => {
  const context = await browser.newContext({ viewport, reducedMotion: 'reduce', ...options });
  await context.addInitScript(() => { try { localStorage.setItem('hub.undoMs', '0'); } catch { /* no storage */ } });
  contexts.push(context);
  // These tests draw the whole map; the Roadmap's default filter (Open) is covered by hub-map-filter-ui.mjs.
  await context.addInitScript(() => {
    const real = window.fetch.bind(window);
    window.__hubPending = 0;
    window.fetch = (input, init) => {
      const hub = String(input?.url ?? input).includes('/api/hub/');
      if (hub) window.__hubPending += 1;
      const result = real(input, init);
      if (hub) result.then(() => { window.__hubPending -= 1; }, () => { window.__hubPending -= 1; });
      return result;
    };
  });
  await context.addInitScript(() => { try { localStorage.setItem('hub-map-filter', JSON.stringify({ states: ['doing', 'you', 'next', 'later', 'done'], within: null, from: '', to: '' })); } catch { /* none */ } });
  const page = await context.newPage();
  page.setDefaultTimeout(ms(15000));
  const errors = [];
  page.on('pageerror', error => errors.push(error));
  page.errors = errors;
  // `window.__hubPending` counts the page's own Hub fetches that have not settled, so a test can wait until the page has what it asked for.
  // (Playwright's request events are not used: a request answered through the shared route in ui-timeouts.mjs can leave one unfinished.)
  page.hubQuiet = async () => {
    const frames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await frames();
    await page.waitForFunction(() => !window.__hubPending);
    await frames();
  };
  return page;
};
const sheet = async (page, node, project = PROJECT) => {
  // A phone has no Map, so its sheet is opened at the project address; a desktop keeps the map address, as coverage of the sheet over the Map.
  const narrow = page.viewportSize().width < 900;
  await page.goto(`${fixture.url}${narrow ? `#/~hub/project/${project}/roadmap/${node}` : `#/~hub/map/${project}/${node}`}`);
  const panel = page.locator('.hub-map-panel');
  await panel.waitFor();
  await page.waitForFunction(id => document.querySelector('.hub-map-panel-heading')?.textContent?.includes(id), node);
  // The Needs you list and the project names load beside the map: wait until they have, so a button's absence means something.
  await page.hubQuiet();
  return panel;
};
const noSideways = async (page, what) => {
  const widths = await page.evaluate(() => {
    const panel = document.querySelector('.hub-map-panel');
    return { scroll: document.scrollingElement.scrollWidth, inner: innerWidth, panel: panel.scrollWidth, panelBox: panel.clientWidth };
  });
  assert.ok(widths.scroll <= widths.inner, `${what}: the page scrolls sideways (${widths.scroll} > ${widths.inner}).`);
  assert.ok(widths.panel <= widths.panelBox, `${what}: the sheet scrolls sideways (${widths.panel} > ${widths.panelBox}).`);
};

try {
  for (const [label, viewport, options] of [['desktop', { width: 1280, height: 800 }, {}], ['phone', { width: 390, height: 844 }, { hasTouch: true, isMobile: true }]]) {
    const page = await open(viewport, options);

    step(`${label}: a task with a description shows two sentences and its Library card`);
    let panel = await sheet(page, 'sd-t-said');
    assert.equal(await panel.locator('[data-summary]').innerText(), 'Copy the weekly backups off the host, so one dead disk loses nothing. A second sentence follows here.');
    const cards = panel.locator('[data-cards] a');
    assert.deepEqual(await cards.allInnerTexts(), ['Mission control'], 'The card that resolves is linked, the one that does not is dropped.');
    assert.equal(await cards.first().getAttribute('href'), '/sheetlib#/mission');
    assert.equal(await cards.first().getAttribute('target'), null, 'It opens in the same tab.');
    // The panel's colours settle after its opening transition, which a busy PC stretches; read them once they have.
    await cards.first().evaluate(link => new Promise(resolve => { const end = Date.now() + 5000; const check = () => { const same = getComputedStyle(link).color === getComputedStyle(link.closest('.hub-map-panel')).color; if (!same || Date.now() > end) resolve(); else setTimeout(check, 50); }; check(); }));
    const look = await cards.first().evaluate(link => { const style = getComputedStyle(link); return { color: style.color, line: style.textDecorationLine, text: getComputedStyle(link.closest('.hub-map-panel')).color }; });
    assert.notEqual(look.color, look.text, 'A Library link is coloured, not the text colour.');
    assert.match(look.line, /underline/, 'And underlined.');
    await cards.first().focus();
    assert.notEqual(await cards.first().evaluate(link => getComputedStyle(link).boxShadow), 'none', 'A focused link shows a ring.');
    assert.match(await panel.innerText(), /No pull requests yet\./);
    await noSideways(page, `${label} summary`);

    step(`${label}: a hash-only task says there is no description, and has no Library block`);
    panel = await sheet(page, 'sd-t-hash');
    assert.equal(await panel.locator('[data-summary]').innerText(), 'No description yet.');
    assert.equal(await panel.locator('[data-cards]').count(), 0);
    step(`${label}: an open task that waits on nobody has Mark done and No longer needed, and no Unblock or What's needed`);
    assert.equal(await panel.locator('[data-mark-open] [data-mark-done]').count(), 1);
    assert.equal(await panel.locator('[data-mark-open] [data-mark-done].pri').count(), 0, 'Mark done is not the main action on a task nobody waits on.');
    assert.equal(await panel.locator('[data-mark-open] [data-mark-not-needed]').count(), 1);
    assert.equal(await panel.locator('[data-mark-unblock]').count(), 0, 'Unblock is for a task that waits on the owner.');
    assert.equal(await panel.locator('h4', { hasText: "What's needed" }).count(), 0);
    await noSideways(page, `${label} open task marks`);
    if (process.env.BUW_SHOTS) await page.screenshot({ path: `${process.env.BUW_SHOTS}/open-task-marks-${label}.png` });

    step(`${label}: a done feature says when it finished, not that nothing happened`);
    panel = await sheet(page, 'sd-f-done');
    const text = await panel.innerText();
    assert.match(text, /Finished 18 Oct\./);
    assert.doesNotMatch(text, /No sessions, PRs or deploys yet/);
    assert.equal(await panel.locator('[data-summary]').innerText(), 'Everything the loader needs to stream chunks. It keeps memory flat.');
    assert.match(text, /#138 · merged/, 'The PR from Beads shows in the feature.');
    panel = await sheet(page, 'sd-f-open');
    assert.doesNotMatch(await panel.innerText(), /Finished/, 'An open feature does not say it finished.');
    assert.equal(await panel.locator('[data-summary]').innerText(), 'Show the hero a wall slide when they touch a <b>wall</b>. It reuses the grounded check.', 'Angle brackets show as text.');
    assert.equal(await panel.locator('[data-summary] b').count(), 0);

    step(`${label}: a done task shows its Beads PR with an Open PR link, its commit and when it closed`);
    panel = await sheet(page, 'sd-t-done');
    const row = panel.locator('[data-prs] li');
    assert.equal(await row.count(), 1);
    assert.match(await row.innerText(), /#138 · merged/);
    const link = row.locator('a', { hasText: 'Open PR' });
    assert.equal(await link.getAttribute('href'), 'https://github.com/example/sheetdev/pull/138');
    assert.match(await panel.locator('[data-commits]').innerText(), /^Commits: a62a2bb4/);
    const commit = await panel.locator('[data-commits] a').first().evaluate(link => ({ color: getComputedStyle(link).color, line: getComputedStyle(link).textDecorationLine, text: getComputedStyle(link.closest('.hub-map-panel')).color }));
    assert.notEqual(commit.color, commit.text, 'A commit link is coloured.');
    assert.match(commit.line, /underline/);
    assert.match(await panel.locator('[data-closed]').innerText(), /^Closed 17 Oct · Merged in review$/);
    assert.ok((await link.boundingBox()).height >= 43.5, 'The Open PR button is tall enough to tap.');
    await noSideways(page, `${label} done task`);

    const three = async what => {
      for (const name of ['done', 'not-needed', 'unblock']) assert.equal(await panel.locator(`[data-mark-${name}]`).count(), 1, `${what}: ${name} button`);
    };
    step(`${label}: a needs-owner task with nothing asked says so, and still has the three buttons`);
    panel = await sheet(page, 'sd-t-label');
    assert.equal(await panel.locator('a', { hasText: 'Open in Needs you' }).count(), 0);
    assert.equal(await panel.locator('h4', { hasText: "What's needed" }).count(), 1);
    assert.match(await panel.locator('[data-nothing-asked]').innerText(), /Nothing asked yet: no Ask or checklist says what you need to do\./);
    await three('label-only');
    await noSideways(page, `${label} what's needed`);

    step(`${label}: a task with an Ask links the Ask and has the three buttons`);
    panel = await sheet(page, 'sd-t-ask');
    const button = panel.locator('[data-whats-needed] a', { hasText: 'Open the Ask' });
    assert.equal(await button.count(), 1);
    assert.equal(await button.getAttribute('href'), `#/~hub/ask/${ASK}`);
    assert.equal(await panel.locator('[data-nothing-asked]').count(), 0);
    await three('ask');

    step(`${label}: a task with a checklist links the checklist and has the three buttons`);
    panel = await sheet(page, 'sd-t-chk');
    const listLink = panel.locator('[data-whats-needed] a', { hasText: 'Open the checklist' });
    assert.equal(await listLink.getAttribute('href'), `#/~hub/checklist/${CHECKLIST}`);
    await three('checklist');

    step(`${label}: Unblock on a task that waits only through a checklist is refused with what to do instead, and writes nothing`);
    await panel.locator('[data-mark-unblock]').click();
    const refusal = panel.locator('[role="alert"].hub-error');
    await refusal.waitFor();
    assert.match(await refusal.innerText(), /^Unblock changes nothing here: this task has no needs-owner label and is not blocked, it waits only through an Ask or a checklist\. Answer or cancel that Ask, or use Mark done or Not needed\.$/);
    assert.equal(await panel.locator('[data-mark-pending]').count(), 0, 'Nothing is pending.');
    await three('checklist after the refusal');
    await noSideways(page, `${label} refusal`);

    step(`${label}: the feature's task list follows the same rule`);
    panel = await sheet(page, 'sd-f-open');
    const rows = panel.locator('.hub-map-panel-list li[data-state="you"]');
    assert.equal(await rows.count(), 2);
    assert.equal(await rows.filter({ hasText: 'Pick the arc' }).locator('a', { hasText: 'Open in Needs you' }).count(), 1);
    assert.equal(await rows.filter({ hasText: 'Register the domain' }).locator('a', { hasText: 'Open in Needs you' }).count(), 0);
    await noSideways(page, `${label} feature`);

    step(`${label}: Mark done shows at once, survives a reload, and Undo brings the buttons back`);
    panel = await sheet(page, 'sd-t-label');
    const markDone = panel.locator('[data-mark-done]');
    const notNeeded = panel.locator('[data-mark-not-needed]');
    assert.equal(await markDone.innerText(), 'Mark done');
    assert.equal(await markDone.evaluate(node => node.classList.contains('pri')), true, 'On a task that waits on the owner it is the main action.');
    assert.equal(await notNeeded.innerText(), 'No longer needed');
    assert.ok((await markDone.boundingBox()).height >= 43.5 && (await notNeeded.boundingBox()).height >= 43.5, 'The buttons are tall enough to tap.');
    assert.match(await panel.innerText(), /Unblock: it doesn't wait on you; agents may pick it up\./);
    assert.ok((await panel.locator('[data-mark-unblock]').boundingBox()).height >= 43.5, 'Unblock is tall enough to tap.');
    assert.equal(await panel.locator('a', { hasText: 'Open in Needs you' }).count(), 0);
    await markDone.click();
    assert.match(await panel.locator('[data-mark-confirm-first]').innerText(), /^This closes .+ in Beads. Undo stays here until the PC applies it, within minutes./, 'The first mark on a device says what it closes.');
    assert.equal(await panel.locator('[data-mark-pending]').count(), 0, 'Nothing is written before the confirmation.');
    await panel.locator('[data-mark-confirm-yes]').click();
    await panel.locator('[data-mark-pending]').waitFor();
    assert.match(await panel.locator('[data-mark-pending]').innerText(), /^You marked this done on \d{1,2} \w{3}\. The PC applies it in Sheetdev within minutes.\s*Undo$/);
    assert.equal(await panel.locator('[data-mark-pending]').getAttribute('data-mark-verdict'), 'done');
    assert.match(await panel.locator('.hub-map-panel-heading').innerText(), /sd-t-label · done/);
    assert.equal(await panel.locator('[data-mark-done]').count(), 0);
    await page.reload();
    await panel.locator('[data-mark-pending]').waitFor();
    assert.match(await panel.locator('.hub-map-panel-heading').innerText(), /done/, 'A reload keeps it.');
    await noSideways(page, `${label} pending`);
    await panel.locator('[data-mark-undo]').click();
    await panel.locator('[data-mark-done]').waitFor();
    assert.match(await panel.locator('.hub-map-panel-heading').innerText(), /needs you/);

    step(`${label}: Unblock shows pending with its own words, the task leaves yellow, and Undo brings the buttons back`);
    await panel.locator('[data-mark-unblock]').click();
    await panel.locator('[data-mark-pending]').waitFor();
    assert.equal(await panel.locator('[data-mark-pending]').getAttribute('data-mark-verdict'), 'unblock');
    assert.match(await panel.locator('[data-mark-pending]').innerText(), /^You marked this unblocked on \d{1,2} \w{3}\. The PC applies it in Sheetdev within minutes.\s*Undo$/);
    assert.match(await panel.locator('.hub-map-panel-heading').innerText(), /sd-t-label · next up/, 'It is next, not yellow and not closed.');
    assert.equal(await panel.locator('[data-mark-unblock]').count(), 0);
    await noSideways(page, `${label} unblock pending`);
    await panel.locator('[data-mark-undo]').click();
    await panel.locator('[data-mark-unblock]').waitFor();
    assert.match(await panel.locator('.hub-map-panel-heading').innerText(), /needs you/);

    step(`${label}: No longer needed asks for a reason, then says it was marked not needed`);
    await notNeeded.click();
    const reason = panel.locator('.hub-map-panel-reason input');
    assert.equal(await reason.getAttribute('placeholder'), 'Why (optional)');
    assert.equal(await reason.getAttribute('maxlength'), '200');
    await panel.locator('.hub-map-panel-reason button', { hasText: 'Cancel' }).click();
    assert.equal(await reason.count(), 0);
    await notNeeded.click();
    await reason.fill('The domain is not needed any more');
    await panel.locator('[data-mark-confirm]').click();
    await panel.locator('[data-mark-pending]').waitFor();
    assert.match(await panel.locator('[data-mark-pending]').innerText(), /^You marked this not needed on /);
    await panel.locator('[data-mark-undo]').click();
    await panel.locator('[data-mark-done]').waitFor();

    step(`${label}: a refusal from the Hub shows in an alert (Beads closed it meanwhile), and the buttons give way`);
    const race = `sd-t-race-${label}`;
    panel = await sheet(page, race);
    await panel.locator('[data-mark-done]').waitFor();
    // Beads closes it while the sheet is open (a newer push of the same copy).
    const closedIssues = issues.map(issue => (issue.id === race ? { ...issue, status: 'closed', closed_at: new Date().toISOString(), updated_at: new Date(Date.now() + 60000).toISOString() } : issue));
    fixture.seed.beads(PROJECT, closedIssues, { pushedAt: new Date().toISOString(), host: 'pc.example.test', count: closedIssues.length, repo: 'example/sheetdev' });
    await panel.locator('[data-mark-done]').click();
    const alert = panel.locator('[role="alert"]');
    await alert.waitFor();
    assert.equal(await alert.innerText(), 'Already closed in Beads.');
    await panel.locator('[data-mark-done]').waitFor({ state: 'detached' });
    assert.equal(await alert.count(), 1, 'The message stays when the sheet learns it is closed.');

    // ws-im1.2.1: the "Do it" block on an open task's sheet, and Spawn filled from the bead.
    step(`${label}: an open task has Build it, Mock it up and Research it; a done task and a read-only host have none`);
    const doId = `sd-t-do-${label}`;
    panel = await sheet(page, doId);
    const doBlock = panel.locator('[data-bead-work]');
    await doBlock.waitFor();
    assert.deepEqual(await doBlock.locator('[data-bead-do]').evaluateAll(buttons => buttons.map(button => button.getAttribute('data-bead-do'))), ['build', 'mockup', 'research']);
    assert.equal(await doBlock.locator('[data-bead-do="build"] small').innerText(), 'Claude · opens a PR');
    const boxes = await doBlock.locator('[data-bead-do]').evaluateAll(buttons => buttons.map(button => { const box = button.getBoundingClientRect(); return { h: box.height, left: Math.round(box.left), right: box.right }; }));
    for (const box of boxes) assert.ok(box.h >= 44, `${label}: a Do it button is ${box.h}px tall.`);
    assert.equal(new Set(boxes.map(box => box.left)).size, 1, 'The buttons are stacked.');
    await noSideways(page, `${label} Do it block`);
    panel = await sheet(page, 'sd-t-done');
    assert.equal(await panel.locator('[data-bead-work]').count(), 0, 'A done task has no Do it block.');

    step(`${label}: Mock it up opens Spawn on the Mockup preset, filled from the bead, with no Done when`);
    panel = await sheet(page, doId);
    await panel.locator('[data-bead-do="mockup"]').click();
    const spawn = page.locator('[data-spawn-sheet]');
    await spawn.locator('[data-spawn-bead]').waitFor();
    assert.equal(await spawn.locator('[data-spawn-bead]').innerText(), `From bead ${doId}`);
    assert.equal(await spawn.locator('[data-preset="mockup"]').getAttribute('aria-pressed'), 'true');
    assert.equal(await spawn.locator('[data-spawn-done]').inputValue(), '');
    await spawn.locator('[data-spawn-machine]', { hasText: 'Hermes' }).waitFor();
    await page.keyboard.press('Escape');
    await spawn.waitFor({ state: 'detached' });

    step(`${label}: Build it fills Spawn from the bead and one Approve makes and signs one request`);
    panel = await sheet(page, doId);
    await panel.locator('[data-bead-do="build"]').click();
    await spawn.locator('[data-spawn-bead]').waitFor();
    assert.equal(await spawn.locator('[data-preset="code-task"]').getAttribute('aria-pressed'), 'true');
    const filled = await spawn.locator('[data-spawn-text]').inputValue();
    assert.match(filled, new RegExp(`Bead ${doId}: Wire the exit door ${label}`));
    assert.match(filled, /It opens when the key is held\./);
    assert.equal(await spawn.locator('[data-spawn-done]').inputValue(), '- The door opens with the key - A test covers it');
    await spawn.locator('[data-spawn-machine]').waitFor();
    const goButton = spawn.locator('[data-spawn-go]');
    await page.waitForFunction(() => !document.querySelector('[data-spawn-go]').disabled);
    await goButton.click();
    await page.locator('[data-spawn-toast]').waitFor();
    const mine = [...fixture.fake.objects.keys()].filter(key => /sections\/inbox\/requests\/[^/]+\/request\.json$/.test(key) && fixture.fake.json(key).bead === doId);
    assert.equal(mine.length, 1, 'One request was made from the bead.');
    const stored = fixture.fake.json(mine[0]);
    assert.deepEqual([stored.preset, stored.project, stored.origin.kind, stored.textOrigin, stored.title], ['code-task', PROJECT, 'owner', { kind: 'agent', name: 'Beads' }, `${doId} Wire the exit door ${label}`]);
    const approvedKey = mine[0].replace('request.json', 'approved.json');
    assert.ok(fixture.fake.objects.has(approvedKey), 'It was signed by the Approve tap.');
    assert.match(fixture.fake.json(approvedKey).run.brief, new RegExp(`Bead: ${doId}\. Put this id in the pull request`));

    step(`${label}: while the run is on the bead the sheet says so and links to it; once it fails the buttons return`);
    panel = await sheet(page, doId);
    const live = panel.locator('[data-bead-run]');
    await live.waitFor();
    assert.equal(await panel.locator('[data-bead-do]').count(), 0, 'No second run is offered.');
    assert.match(await live.innerText(), /· Open the run$/);
    const requestId = mine[0].split('/').at(-2);
    assert.equal(await live.locator('a').getAttribute('href'), `#/~hub/request/${encodeURIComponent(requestId)}`);
    await noSideways(page, `${label} run line`);
    step(`${label}: marking a task with a run on it keeps the run line and says the run keeps going; Undo brings the marks back`);
    await panel.locator('[data-mark-done]').click();
    const confirmYes = panel.locator('[data-mark-confirm-yes]');
    if (await confirmYes.count()) { assert.match(await panel.locator('[data-mark-confirm-first]').innerText(), /A run is on it and keeps going\./); await confirmYes.click(); }
    await panel.locator('[data-mark-pending]').waitFor();
    assert.equal(await panel.locator('[data-bead-run]').count(), 1, 'The run line stays on a marked task.');
    assert.equal(await panel.locator('[data-bead-run] a').getAttribute('href'), `#/~hub/request/${encodeURIComponent(requestId)}`);
    assert.match(await panel.locator('[data-mark-pending]').innerText(), /The run keeps going\. Open it to stop it\./);
    assert.equal(await panel.locator('[data-bead-do]').count(), 0, 'No build buttons on a marked task.');
    await panel.locator('[data-mark-undo]').click();
    await panel.locator('[data-mark-pending]').waitFor({ state: 'detached' });
    const folder = mine[0].replace('request.json', '');
    fixture.fake.seed(`${folder}taken.json`, JSON.stringify({ v: 1, at: new Date().toISOString() }), 'application/json');
    fixture.fake.seed(`${folder}result.json`, JSON.stringify({ v: 1, outcome: 'failed', at: new Date().toISOString() }), 'application/json');
    panel = await sheet(page, doId);
    await panel.locator('[data-bead-do="build"]').waitFor();
    assert.equal(await panel.locator('[data-bead-run]').count(), 0);


    // ws-im1.2.2: "Run a sprint" on a milestone's sheet.
    step(`${label}: a project with no PC runs says so and offers no sprint`);
    panel = await sheet(page, 'sd-m1');
    await panel.locator('[data-sprint-not-pc]').waitFor();
    assert.equal(await panel.locator('[data-sprint-not-pc]').innerText(), 'Sprints run on the PC. sheetdev has no PC runs.');
    assert.equal(await panel.locator('[data-sprint-start], [data-sprint-chip]').count(), 0);

    step(`${label}: the sheet shows the timebox chips (4h on), the beads in order and the ones left out with why`);
    const { id: sprintProject, prefix } = SPRINT_PROJECTS[label];
    panel = await sheet(page, `${prefix}-ms`, sprintProject);
    const sprintBlock = panel.locator('[data-sprint]');
    await sprintBlock.locator('[data-sprint-plan]').waitFor();
    assert.match(await sprintBlock.innerText(), /run a sprint/i, 'The heading may be set in capitals.');
    assert.match(await sprintBlock.innerText(), /Claude · stacked PRs, questions come to Needs you/);
    assert.deepEqual(await sprintBlock.locator('[data-sprint-chip]').allInnerTexts(), ['90m', '4h', 'until done']);
    assert.equal(await sprintBlock.locator('[data-sprint-chip="240"]').getAttribute('aria-pressed'), 'true', '4h is the default.');
    assert.equal(await sprintBlock.locator('[data-sprint-chip="90"]').getAttribute('aria-pressed'), 'false');
    assert.deepEqual(await sprintBlock.locator('[data-sprint-plan] .hub-sprint-title').allInnerTexts(), ['Read the level file', 'Draw the door', 'Wire the door']);
    assert.deepEqual(await sprintBlock.locator('[data-sprint-left-out] li').allInnerTexts().then(rows => rows.map(row => row.replace(/\s+/g, ' ').trim())), ['Pick the door colour waits for you']);
    for (const box of await sprintBlock.locator('[data-sprint-chip], [data-sprint-start]').evaluateAll(buttons => buttons.map(button => button.getBoundingClientRect().height))) assert.ok(box >= 43.5, `${label}: a sprint button is ${box}px tall.`);
    await noSideways(page, `${label} sprint offer`);

    step(`${label}: Start asks once, listing the beads; Cancel leaves nothing started`);
    await sprintBlock.locator('[data-sprint-chip="90"]').click();
    assert.equal(await sprintBlock.locator('[data-sprint-chip="90"]').getAttribute('aria-pressed'), 'true');
    await sprintBlock.locator('[data-sprint-start]').click();
    const confirm = sprintBlock.locator('[data-sprint-confirm]');
    await confirm.waitFor();
    assert.match(await confirm.innerText(), /^Run 3 beads one after the other, for 90 minutes\./);
    assert.deepEqual(await confirm.locator('[data-sprint-confirm-items] .hub-sprint-title').allInnerTexts(), ['Read the level file', 'Draw the door', 'Wire the door']);
    await noSideways(page, `${label} sprint confirm`);
    await confirm.locator('[data-sprint-cancel]').click();
    await confirm.waitFor({ state: 'detached' });
    assert.equal([...fixture.fake.objects.keys()].filter(key => key.endsWith('/sprint.json') && fixture.fake.json(key).project === sprintProject).length, 0, 'Cancel starts nothing.');

    step(`${label}: Confirm starts it: item 1 of 3 with the time left, signed with no after`);
    await sprintBlock.locator('[data-sprint-start]').click();
    await sprintBlock.locator('[data-sprint-go]').click();
    await sprintBlock.locator('[data-sprint-progress]').waitFor();
    assert.match(await sprintBlock.locator('[data-sprint-progress]').innerText(), /^Item 1 of 3 · (1 h \d+ min|\d+ min) left$/);
    assert.deepEqual(await sprintBlock.locator('[data-sprint-state]').allInnerTexts(), ['Queued', 'Waiting', 'Waiting']);
    assert.equal(await sprintBlock.locator('[data-sprint-start]').count(), 0, 'Nothing to start while it goes.');
    const sprintKeys = [...fixture.fake.objects.keys()].filter(key => key.endsWith('/sprint.json') && fixture.fake.json(key).project === sprintProject);
    assert.equal(sprintKeys.length, 1);
    const head = sprintKeys[0].split('/').at(-2);
    const sprintFolder = `sections/inbox/requests/${head}/`;
    const approvedOne = fixture.fake.json(`${sprintFolder}approved.json`);
    assert.deepEqual([approvedOne.run.sprint.seq, approvedOne.run.sprint.of, approvedOne.run.sprint.after, approvedOne.limits.minutes], [1, 3, null, 90]);
    assert.ok(approvedOne.run.brief.includes('Never merge') && approvedOne.run.brief.includes('<<<DATA'), 'The brief has the fence and the rule.');
    assert.ok(await sprintBlock.locator('[data-sprint-stop]').isVisible());
    await noSideways(page, `${label} sprint progress`);

    step(`${label}: when item 1 opens a PR, item 2 is signed on top of it and the sheet shows both`);
    const pcFinish = (id, outcome, extraBody = {}) => {
      fixture.fake.seed(`sections/inbox/requests/${id}/taken.json`, JSON.stringify({ v: 1, runner: 'pc', session: 's1', at: new Date().toISOString() }), 'application/json');
      fixture.fake.seed(`sections/inbox/requests/${id}/result.json`, JSON.stringify({ v: 1, outcome, at: new Date().toISOString(), ...extraBody }), 'application/json');
    };
    pcFinish(head, 'pr', { pr: 'https://example.test/example/pull/41' });
    const two = itemId(head, 2);
    for (let waited = 0; !fixture.fake.objects.has(`sections/inbox/requests/${two}/approved.json`); waited += 100) {
      assert.ok(waited < ms(15000), 'The sweep signed item 2.');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(fixture.fake.json(`sections/inbox/requests/${two}/approved.json`).run.sprint.after, head, 'Item 2 stacks on item 1.');
    panel = await sheet(page, `${prefix}-ms`, sprintProject);
    const progress = panel.locator('[data-sprint-progress]');
    await progress.waitFor();
    assert.match(await progress.innerText(), /^Item 2 of 3 · /);
    assert.deepEqual(await panel.locator('[data-sprint-state]').allInnerTexts(), ['Done', 'Queued', 'Waiting']);
    const prLink = panel.locator('[data-sprint-pr]');
    assert.equal(await prLink.count(), 1);
    assert.equal(await prLink.getAttribute('href'), 'https://example.test/example/pull/41');
    await noSideways(page, `${label} sprint, item 2`);

    step(`${label}: Stop ends the sprint at once and starts no item 3`);
    await panel.locator('[data-sprint-stop]').click();
    await panel.locator('[data-sprint-ended]').waitFor({ timeout: ms(20000) });
    assert.equal(await panel.locator('[data-sprint-ended]').innerText(), 'Sprint ended. 1 of 3 PRs open. Stopped: you stopped it');
    assert.equal(await panel.locator('[data-sprint-stop]').count(), 0);
    assert.equal(fixture.fake.objects.has(`sections/inbox/requests/${itemId(head, 3)}/request.json`), false, 'No item 3.');
    assert.equal(fixture.fake.objects.has(`${sprintFolder}sprint-end.json`), true);
    assert.equal(await panel.locator('[data-sprint-start]').count(), 1, 'A new sprint can be started once the last one ended.');
    await noSideways(page, `${label} sprint ended`);

    step(`${label}: the ended sprint has one item in Needs you, and its page has the closing prompt`);
    const { rel: closingRel, file: closingFile } = closingEventPath(head, fixture.fake.json(`${sprintFolder}sprint-end.json`).at);
    assert.equal(fixture.fake.objects.has(`sections/inbox/${closingRel}`), true, 'The closing item is filed.');

    await page.goto(`${fixture.url}#/~hub/review/${encodeURIComponent(closingFile)}`);
    const closing = page.locator('[data-section="closing"]');
    await closing.waitFor({ timeout: ms(20000) });
    assert.ok(await closing.isVisible());
    const promptText = await closing.locator('pre').innerText();
    assert.match(promptText, /There are no pull requests/);
    assert.doesNotMatch(promptText, /Retarget every PR/, 'The sprint has no pull request, so no merge step.');
    const copy = closing.locator('[data-copy]');
    assert.ok((await copy.boundingBox()).height >= 44, 'Copy is at least 44 px high.');
    await copy.click();
    await page.waitForFunction(() => /^(Copied|Press and hold to copy)/.test(document.querySelector('[data-section="closing"] [data-copy]')?.textContent ?? ''));
    if (viewport.width < 600) {
      const box = await copy.boundingBox();
      const pre = await closing.locator('pre').boundingBox();
      assert.ok(box.y < pre.y, 'On a phone Copy sits above the prompt.');
    }
    assert.ok(await page.evaluate(() => document.scrollingElement.scrollWidth <= innerWidth), `${label}: the closing page scrolls sideways.`);

    assert.deepEqual(page.errors, [], `${label}: no page errors`);
  }

  // A read-only copy of the site: no capability to write, so the sheet says so and sends nothing.
  for (const [label, viewport, options] of [['desktop', { width: 1280, height: 800 }, {}], ['phone', { width: 390, height: 844 }, { hasTouch: true, isMobile: true }]]) {
    step(`${label}: a read-only copy says "Sign in to mark this." and sends nothing`);
    const model = {
      project: 'rodev', ageMinutes: 1, sprints: [], wayfinder: null, meta: { pushedAt: new Date().toISOString(), host: 'h', count: 3, repo: 'example/rodev' },
      milestones: [{ id: 'ro-m', title: 'Read-only milestone', state: 'you', features: [{ id: 'ro-f', title: 'Read-only feature', state: 'you', tasks: [
        { id: 'ro-t', title: 'Waits on you', state: 'you', you: 'label', status: 'open', signs: [], sprints: [], deps: [] },
        { id: 'ro-marked', title: 'Already marked', state: 'done', status: 'closed', signs: [], sprints: [], deps: [], mark: { verdict: 'done', at: new Date().toISOString(), pending: true } },
      ] }] }],
    };
    const canned = {
      '/api/capabilities': { write: false, create: false, cards: false, hub: true, chat: false, reason: 'Read-only here.' },
      '/api/card-state': { cards: {} },
      '/sites.json': [{ id: 'one', name: 'One', base: '/w/one' }],
      '/w/one/workspace.json': { entities: [] },
      '/api/hub/today': { counts: { needsYou: 0, running: 0, recent: 0, alerts: 0 }, needsYou: [], running: [], recent: [], alerts: [], at: new Date().toISOString() },
      '/api/hub/projects': { projects: [{ id: 'rodev', name: 'Read-only dev', beads: true }] },
      '/api/hub/map/rodev': model,
      '/api/hub/map/rodev/sprint/ro-m': { allowed: true, max: 8, items: [{ id: 'ro-t', title: 'Waits on you' }], left: [], active: null },
      '/api/hub/inbox': { items: [], counts: {}, at: new Date().toISOString() },
    };
    const writes = [];
    const stub = http.createServer(async (request, response) => {
      const url = new URL(request.url, 'http://site');
      const send = (status, type, body) => { response.writeHead(status, { 'Content-Type': type }); response.end(body); };
      if (request.method !== 'GET') { writes.push(`${request.method} ${url.pathname}`); return send(403, 'application/json', '{"error":"read-only"}'); }
      if (canned[url.pathname]) return send(200, 'application/json', JSON.stringify(canned[url.pathname]));
      if (url.pathname.startsWith('/api/')) return send(404, 'application/json', '{"error":"none"}');
      try {
        const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
        return send(200, name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html', await readFile(path.join(root, 'dist', name)));
      } catch { return send(200, 'text/html', await readFile(path.join(root, 'dist', 'index.html'))); }
    });
    await listenOnGoodPort(stub, '127.0.0.1');
    try {
      const guest = await open(viewport, options);
      // A phone has no Map, so it opens the sheet at the project address.
      const at = node => `http://127.0.0.1:${stub.address().port}/one#/~hub/${viewport.width < 900 ? 'project/rodev/roadmap' : 'map/rodev'}/${node}`;
      await guest.goto(at('ro-t'));
      const panel = guest.locator('.hub-map-panel');
      await panel.waitFor();
      await panel.locator('[data-readonly-note]', { hasText: 'Sign in to mark this.' }).waitFor();
      assert.equal(await panel.locator('[data-mark-done]').count(), 0);
      assert.equal(await panel.locator('[data-bead-work]').count(), 0, 'A read-only host has no Do it block.');
      await guest.goto(at('ro-m'));
      await panel.locator('h4', { hasText: 'Sprint' }).first().waitFor();
      await guest.waitForTimeout(ms(500));
      assert.equal(await panel.locator('[data-sprint], [data-sprint-start], [data-sprint-chip]').count(), 0, 'A read-only host has no way to start a sprint.');
      await guest.goto(at('ro-marked'));
      await panel.locator('[data-mark-pending]').waitFor();
      assert.equal(await panel.locator('button').filter({ hasText: /Undo|Mark done|No longer needed/ }).count(), 0, 'A marked task has no buttons on a read-only copy.');
      await panel.locator('[data-readonly-note]', { hasText: 'Sign in to undo this.' }).waitFor();
      assert.deepEqual(writes, [], 'Nothing was sent.');
    } finally { stub.close(); }
  }
  console.log('hub-map-sheet-ui: passed');
} finally {
  for (const context of contexts) await context.close().catch(() => {});
  await browser.close();
  await fixture.close();
}
