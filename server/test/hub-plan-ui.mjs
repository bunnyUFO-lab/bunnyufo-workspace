// Run after npm run build. Plan in Hermes (ws-qdh.3), through a real browser over the fixture service with Hermes on: "Plan in Hermes" on the
// Roadmap opens Chat with the Planner and a draft that names the project and the node, and sends nothing; a change-list Ask shows as a
// Design review with one row per change (approve, change, skip), takes only a verdict per row, and the answer is stored per row.
// Desktop (1280x800) and phone (390x844). Set BUW_SHOTS=<folder> to save the PR screenshots.
import { chromium } from '@playwright/test';
import { ms } from './ui-timeouts.mjs';
import assert from 'node:assert/strict';
import { startHubFixture, askId } from './hub-fixture.mjs';
import { askJson, minutesAgo } from '../../site/api/test/hub-fixtures.mjs';

const step = name => console.log(`- ${name}`);
const channel = process.env.BUW_TEST_BROWSER || 'msedge';
const shots = process.env.BUW_SHOTS;
const browser = await chromium.launch({ headless: true, channel });
const contexts = [];
const fixtures = [];
const open = async (viewport, options = {}) => {
  const context = await browser.newContext({ viewport, serviceWorkers: 'block', reducedMotion: 'reduce', ...options });
  await context.addInitScript(() => { try { localStorage.setItem('hub.undoMs', '0'); } catch { /* no storage */ } });
  contexts.push(context);
  const page = await context.newPage();
  page.setDefaultTimeout(ms(15000));
  page.on('pageerror', error => { throw error; });
  return page;
};
const shot = async (page, name) => { if (shots) await page.screenshot({ path: `${shots}/${name}.png` }); };
const noSideways = async (page, what) => {
  const widths = await page.evaluate(() => ({ scroll: document.scrollingElement.scrollWidth, inner: innerWidth }));
  assert.ok(widths.scroll <= widths.inner, `${what}: the page scrolls sideways (${widths.scroll} > ${widths.inner}).`);
};

const CHANGES = [
  { op: 'create', title: 'Sprint 4', type: 'epic', labels: ['milestone'], description: 'The next sprint: wall-jump polish and the tuning pass.' },
  { op: 'create', title: 'Wall-jump polish', parent: '#1', description: 'Coyote time and a landing sound.' },
  { op: 'dep', bead: '#2', blocks: 'wf-q3' },
  { op: 'close', bead: 'wf-q4', reason: 'Covered by the Sprint 4 plan.' },
  { op: 'label', bead: 'wf-q3', add: ['later'] },
];

try {
  const fx = await startHubFixture({ hermes: true, chatRuns: true });
  fixtures.push(fx);
  fx.fake.seed('sections/magic-loops/workspace.json', JSON.stringify({ name: 'magic-loops', tracked: { repo: 'example/magic-loops' }, entities: [] }), 'application/json');
  const writes = [];
  const watch = page => page.on('request', request => { if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method()) && request.url().startsWith(fx.url)) writes.push(`${request.method()} ${new URL(request.url()).pathname}`); });
  const ask = askId('plan-sprint-4', 'p4p4');
  fx.seed.ask({
    ...askJson({ id: ask, project: 'wayfind', now: minutesAgo(fx.now, 5), kind: 'decision', allowDrawing: false, question: 'Apply the Sprint 4 plan to the Roadmap?', context: 'The plan adds one epic with one task, orders them, and closes a question the plan makes moot. Five changes in all.' }),
    changes: CHANGES,
  });

  const desk = await open({ width: 1280, height: 800 });
  watch(desk);

  step('desktop: the Roadmap of a project with a map has Plan in Hermes in its Destination row; opening it starts Chat with the Planner and an unsent draft');
  await desk.goto(`${fx.url}#/~hub/map/wayfind`);
  await desk.locator('.hub-wayfinder').first().waitFor();
  const button = desk.locator('.hub-wayfinder-row [data-plan-in-hermes]');
  await button.waitFor();
  assert.equal((await button.innerText()).trim(), 'Plan in Hermes');
  await shot(desk, 'plan-in-hermes-roadmap-desktop');
  await button.click();
  await desk.waitForURL(/#\/~hub\/chat$/);
  await desk.locator('[data-chat-persona]').waitFor();
  assert.equal(await desk.locator('[data-chat-persona]').inputValue(), 'planner');
  const draft = await desk.locator('textarea[aria-label="Message"]').inputValue();
  assert.match(draft, /^I want to plan work on the .* Roadmap \(project wayfind\)\./);
  assert.match(draft, /cards beads show --project wayfind --open/);
  assert.doesNotMatch(draft, /looking at/, 'No node was selected.');
  assert.equal(await desk.locator('.hub-bubble').count(), 0, 'Nothing was sent.');
  assert.equal(await desk.locator('[data-chat-model] option:checked').innerText(), 'Codex 6.1 Sol');
  assert.deepEqual(writes, [], 'Opening it wrote nothing.');
  await shot(desk, 'chat-planner-desktop');

  step('desktop: with a node open the draft names it; a project without a map has the button above the map');
  await desk.goto(`${fx.url}#/~hub/map/wayfind/wf-q1`);
  await desk.locator('.hub-map-panel').waitFor();
  await desk.locator('.hub-wayfinder-row [data-plan-in-hermes]').click();
  await desk.waitForURL(/#\/~hub\/chat$/);
  await desk.locator('[data-chat-persona]').waitFor();
  assert.match(await desk.locator('textarea[aria-label="Message"]').inputValue(), /I am looking at "Which project comes first\?" \(wf-q1\)\./);
  await desk.goto(`${fx.url}#/~hub/map/magic-loops`);
  await desk.locator('.hub-map-wrap').waitFor();
  assert.equal(await desk.locator('.hub-wayfinder').count(), 0);
  await desk.locator('.hub-plan-row [data-plan-in-hermes]').waitFor();
  assert.equal(await desk.locator('[data-plan-in-hermes]').count(), 1);

  step('desktop: a change-list Ask is a Design review: one row per change, each with approve, change and skip, and no options');
  await desk.goto(`${fx.url}#/~hub/ask/${ask}`);
  await desk.locator('[data-decision]').first().waitFor();
  assert.equal(await desk.locator('[data-decision]').count(), 5);
  assert.deepEqual(await desk.locator('[data-decision] .dr-text').allInnerTexts(), [
    'Add epic "Sprint 4"', 'Add task "Wall-jump polish" under new item 1', 'new item 2 must be done before wf-q3', 'Close wf-q4', 'Labels on wf-q3',
  ]);
  assert.match(await desk.locator('[data-decision="d4"] .dr-detail').innerText(), /Reason: Covered by the Sprint 4 plan\./);
  assert.equal(await desk.locator('[data-decision="d1"] [data-verdict-btn]').count(), 3);
  assert.equal(await desk.locator('.hub-option').count(), 0, 'There is nothing to pick but a verdict per row.');
  assert.equal(await desk.locator('[data-annotate], .hub-option-draw').count(), 0, 'No drawing on a change list.');
  assert.equal(await desk.locator('[data-send]').isDisabled(), true, 'Send waits for a verdict on every row.');
  await shot(desk, 'change-list-ask-desktop');

  step('desktop: approve, change (with the owner\'s words), skip: the answer holds one verdict per row and the list on file is untouched');
  const verdicts = { d1: 'approve', d2: 'change', d3: 'approve', d4: 'skip', d5: 'approve' };
  for (const [id, verdict] of Object.entries(verdicts)) await desk.locator(`[data-decision="${id}"] [data-verdict-btn="${verdict}"]`).click();
  await desk.locator('[data-decision="d2"] .dr-note').fill('Coyote time only, no sound.');
  await shot(desk, 'change-list-ask-answered-desktop');
  await desk.locator('[data-send]').click();
  const answerKey = `sections/inbox/asks/${ask}/answer.json`;
  for (let tries = 0; tries < 100 && !fx.fake.objects.has(answerKey); tries += 1) await desk.waitForTimeout(100);
  const stored = fx.fake.json(answerKey);
  assert.deepEqual(stored.decisions, { d1: { verdict: 'approve' }, d2: { verdict: 'change', note: 'Coyote time only, no sound.' }, d3: { verdict: 'approve' }, d4: { verdict: 'skip' }, d5: { verdict: 'approve' } });
  assert.deepEqual(fx.fake.json(`sections/inbox/asks/${ask}/ask.json`).changes, CHANGES);
  assert.deepEqual(writes.filter(line => !/\/(chat|asks\/[^/]+\/answer)/.test(line)), [], 'Nothing else was written: no mark, no request.');
  assert.deepEqual([...fx.fake.objects.keys()].filter(key => key.includes('/bead-marks/')), [], 'A plan decides no Roadmap question by itself.');

  step('desktop: an answered plan says it waits for the PC, then when it was applied (ws-im1.2.3)');
  await desk.goto(`${fx.url}#/~hub/ask/${ask}`);
  await desk.locator('[data-plan-state="waiting"]').waitFor();
  assert.equal(await desk.locator('[data-plan-state="waiting"]').innerText(), "Approved. It's applied within a minute or two, and the PC doesn't need to be on.");
  await desk.locator('[data-plan-state="waiting"]').scrollIntoViewIfNeeded();
  await shot(desk, 'plan-waiting-desktop');
  fx.fake.seed(`sections/inbox/asks/${ask}/pickup.json`, JSON.stringify({ at: new Date().toISOString(), host: 'pc' }), 'application/json');
  await desk.reload();
  await desk.locator('[data-plan-state="applied"]').waitFor();
  assert.match(await desk.locator('[data-plan-state="applied"]').innerText(), /^Applied .+\.$/);
  assert.equal(await desk.locator('[data-plan-state="waiting"]').count(), 0);
  await desk.locator('[data-plan-state="applied"]').scrollIntoViewIfNeeded();
  await shot(desk, 'plan-applied-desktop');

  step('phone: Plan in Hermes and the change list fit, every control is 44 px, nothing scrolls sideways');
  const second = askId('plan-sprint-5', 'p5p5');
  fx.seed.ask({ ...askJson({ id: second, project: 'wayfind', now: minutesAgo(fx.now, 4), kind: 'decision', allowDrawing: false, question: 'Apply the Sprint 5 plan to the Roadmap?', context: 'One epic and one closed question.' }), changes: CHANGES.slice(0, 4) });
  const phone = await open({ width: 390, height: 844 }, { hasTouch: true, isMobile: true });
  watch(phone);
  await phone.goto(`${fx.url}#/~hub/map/wayfind`);
  await phone.locator('.hub-wayfinder').first().waitFor();
  assert.equal(await phone.locator('.hub-wayfinder-toggle').getAttribute('aria-expanded'), 'false');
  const plan = phone.locator('[data-plan-in-hermes]');
  await plan.waitFor();
  assert.ok((await plan.boundingBox()).height >= 44, 'Plan in Hermes is at least 44 px high.');
  await noSideways(phone, 'Roadmap at 390');
  await shot(phone, 'plan-in-hermes-roadmap-phone');
  await phone.goto(`${fx.url}#/~hub/ask/${second}`);
  await phone.locator('[data-decision]').first().waitFor();
  assert.equal(await phone.locator('[data-decision]').count(), 4);
  await noSideways(phone, 'change list at 390');
  for (const button of await phone.locator('[data-decision="d1"] [data-verdict-btn]').all()) assert.ok((await button.boundingBox()).height >= 44, 'A verdict button is at least 44 px high.');
  await shot(phone, 'change-list-ask-phone');
  await phone.goto(`${fx.url}#/~hub/map/wayfind`);
  await phone.locator('[data-plan-in-hermes]').tap();
  await phone.waitForURL(/#\/~hub\/chat$/);
  await phone.locator('[data-chat-persona]').waitFor();
  assert.equal(await phone.locator('[data-chat-persona]').inputValue(), 'planner');
  await noSideways(phone, 'Chat with the Planner at 390');
  await shot(phone, 'chat-planner-phone');

  console.log('hub-plan-ui: passed');
} finally {
  for (const context of contexts) await context.close().catch(() => {});
  await browser.close();
  for (const fixture of fixtures) await fixture.close().catch(() => {});
}
