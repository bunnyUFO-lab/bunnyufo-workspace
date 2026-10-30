// Run after npm run build. The Roadmap item sheet through a real browser, over the hub fixture: what the work is
// (summary), the Library cards it names, its pull requests from Beads, how a done feature says it finished, and
// "Open in Needs you" only when Needs you has the item. Desktop (1280x800) and phone (390x844).
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { startHubFixture, askId } from './hub-fixture.mjs';
import { askJson, beadsIssue, minutesAgo, threeOptions } from '../../site/api/test/hub-fixtures.mjs';

const step = name => console.log(`- ${name}`);
const channel = process.env.BUW_TEST_BROWSER || 'msedge';
const PROJECT = 'sheetdev';
const BACKFILL = 'Backfilled 2026-10-26 from git, PRs and cards.';

const fixture = await startHubFixture();
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
];
fixture.seed.beads(PROJECT, issues, { pushedAt: minutesAgo(fixture.now, 5).toISOString(), host: 'pc.example.test', count: issues.length, repo: 'example/sheetdev' });
fixture.fake.seed('sections/sheetlib/workspace.json', JSON.stringify({ name: 'Sheet library', entities: [{ id: 'mission', title: 'Mission control', folder: '2026-10-27_plan' }] }), 'application/json');
const ASK = askId('sheet-arc', 's1s1');
fixture.seed.ask(askJson({ id: ASK, bead: 'sd-t-ask', now: minutesAgo(fixture.now, 10), options: threeOptions() }));

const browser = await chromium.launch({ headless: true, channel });
const contexts = [];
const open = async (viewport, options = {}) => {
  const context = await browser.newContext({ viewport, reducedMotion: 'reduce', ...options });
  contexts.push(context);
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', error => errors.push(error));
  page.errors = errors;
  return page;
};
const sheet = async (page, node) => {
  await page.goto(`${fixture.url}#/~hub/map/${PROJECT}/${node}`);
  const panel = page.locator('.hub-map-panel');
  await panel.waitFor();
  await page.waitForFunction(id => document.querySelector('.hub-map-panel-heading')?.textContent?.includes(id), node);
  // The Needs you list loads beside the map; give it a moment so a button's absence means something.
  await page.waitForTimeout(500);
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

    step(`${label}: a needs-owner task with no Ask or Inbox item has no Open in Needs you`);
    panel = await sheet(page, 'sd-t-label');
    assert.equal(await panel.locator('a', { hasText: 'Open in Needs you' }).count(), 0);

    step(`${label}: a task with an Ask still has it, linking the Ask`);
    panel = await sheet(page, 'sd-t-ask');
    const button = panel.locator('a', { hasText: 'Open in Needs you' });
    assert.equal(await button.count(), 1);
    assert.equal(await button.getAttribute('href'), `#/~hub/ask/${ASK}`);

    step(`${label}: the feature's task list follows the same rule`);
    panel = await sheet(page, 'sd-f-open');
    const rows = panel.locator('.hub-map-panel-list li[data-state="you"]');
    assert.equal(await rows.count(), 2);
    assert.equal(await rows.filter({ hasText: 'Pick the arc' }).locator('a', { hasText: 'Open in Needs you' }).count(), 1);
    assert.equal(await rows.filter({ hasText: 'Register the domain' }).locator('a', { hasText: 'Open in Needs you' }).count(), 0);
    await noSideways(page, `${label} feature`);
    assert.deepEqual(page.errors, [], `${label}: no page errors`);
  }
  console.log('hub-map-sheet-ui: passed');
} finally {
  for (const context of contexts) await context.close().catch(() => {});
  await browser.close();
  await fixture.close();
}
