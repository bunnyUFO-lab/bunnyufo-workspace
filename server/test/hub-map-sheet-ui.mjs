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
import { listenOnGoodPort } from '../listen.mjs';

const step = name => console.log(`- ${name}`);
const channel = process.env.BUW_TEST_BROWSER || 'msedge';
const PROJECT = 'sheetdev';
const BACKFILL = 'Backfilled 2026-10-26 from git, PRs and cards.';

// This test writes requests into the bucket by hand, so the map's 30-second request cache is off (HUB_MAP_REQUESTS_MS).
const fixture = await startHubFixture({ signing: true, env: { HUB_MAP_REQUESTS_MS: '0' } });
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
const sheet = async (page, node) => {
  await page.goto(`${fixture.url}#/~hub/map/${PROJECT}/${node}`);
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
    assert.equal(await notNeeded.innerText(), 'No longer needed');
    assert.ok((await markDone.boundingBox()).height >= 43.5 && (await notNeeded.boundingBox()).height >= 43.5, 'The buttons are tall enough to tap.');
    assert.match(await panel.innerText(), /Unblock: it doesn't wait on you; agents may pick it up\./);
    assert.ok((await panel.locator('[data-mark-unblock]').boundingBox()).height >= 43.5, 'Unblock is tall enough to tap.');
    assert.equal(await panel.locator('a', { hasText: 'Open in Needs you' }).count(), 0);
    await markDone.click();
    assert.match(await panel.locator('[data-mark-confirm-first]').innerText(), /^This closes .+ in Beads. Undo stays here until a session applies it./, 'The first mark on a device says what it closes.');
    assert.equal(await panel.locator('[data-mark-pending]').count(), 0, 'Nothing is written before the confirmation.');
    await panel.locator('[data-mark-confirm-yes]').click();
    await panel.locator('[data-mark-pending]').waitFor();
    assert.match(await panel.locator('[data-mark-pending]').innerText(), /^You marked this done on \d{1,2} \w{3}\. A session in Sheetdev applies it when it starts there\.\s*Undo$/);
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
    assert.match(await panel.locator('[data-mark-pending]').innerText(), /^You marked this unblocked on \d{1,2} \w{3}\. A session in Sheetdev applies it when it starts there\.\s*Undo$/);
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
    const folder = mine[0].replace('request.json', '');
    fixture.fake.seed(`${folder}taken.json`, JSON.stringify({ v: 1, at: new Date().toISOString() }), 'application/json');
    fixture.fake.seed(`${folder}result.json`, JSON.stringify({ v: 1, outcome: 'failed', at: new Date().toISOString() }), 'application/json');
    panel = await sheet(page, doId);
    await panel.locator('[data-bead-do="build"]').waitFor();
    assert.equal(await panel.locator('[data-bead-run]').count(), 0);

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
      await guest.goto(`http://127.0.0.1:${stub.address().port}/one#/~hub/map/rodev/ro-t`);
      const panel = guest.locator('.hub-map-panel');
      await panel.waitFor();
      await panel.locator('[data-readonly-note]', { hasText: 'Sign in to mark this.' }).waitFor();
      assert.equal(await panel.locator('[data-mark-done]').count(), 0);
      assert.equal(await panel.locator('[data-bead-work]').count(), 0, 'A read-only host has no Do it block.');
      await guest.goto(`http://127.0.0.1:${stub.address().port}/one#/~hub/map/rodev/ro-marked`);
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
