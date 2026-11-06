// Run after npm run build. Ways to resolve a Roadmap question (ws-qdh.1), through a real browser over the fixture service: the Destination
// row shows a main button by kind with its cost, blocked questions wait ("After: ..."), "Prepare all" counts the ready ones, the main button
// opens Spawn prefilled and files nothing, the ⋯ menu offers the other ways (and closes on Escape and on an outside tap), the side sheet
// has a Resolve block, and "Answer here" records the owner's decision as a mark that the Roadmap shows at once and Undo takes back.
// Desktop (1280x800) and phone (390x844). Set BUW_SHOTS=<folder> to save the PR screenshots.
import { chromium } from '@playwright/test';
import { ms } from './ui-timeouts.mjs';
import assert from 'node:assert/strict';
import { startHubFixture, askId } from './hub-fixture.mjs';
import { closeChatSheet, openChatSheet } from './shell-helpers.mjs';
import { askJson, minutesAgo } from '../../site/api/test/hub-fixtures.mjs';

const step = name => console.log(`- ${name}`);
const channel = process.env.BUW_TEST_BROWSER || 'msedge';
const shots = process.env.BUW_SHOTS;
const browser = await chromium.launch({ headless: true, channel });
const contexts = [];
const fixtures = [];
const open = async (viewport, options = {}) => {
  const context = await browser.newContext({ viewport, serviceWorkers: 'block', reducedMotion: 'reduce', ...options });
  contexts.push(context);
  // The Roadmap's default filter (Open) hides done work; these tests need to see the decided question too.
  await context.addInitScript(() => { try { localStorage.setItem('hub-map-filter', JSON.stringify({ states: ['doing', 'you', 'next', 'later', 'done'], within: null, from: '', to: '' })); } catch { /* none */ } });
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
const tall = async (locator, what, min = 44) => {
  const box = await locator.boundingBox();
  assert.ok(box && box.height >= min - 0.5 && box.width >= min - 0.5, `${what} is at least ${min} px square-ish (${box?.width} x ${box?.height}).`);
};

try {
  const fx = await startHubFixture({ hermes: true, chatRuns: true });
  fixtures.push(fx);
  const writes = [];
  const watch = page => page.on('request', request => { if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method()) && request.url().startsWith(fx.url)) writes.push(`${request.method()} ${new URL(request.url()).pathname}`); });
  const marksIn = () => [...fx.fake.objects.keys()].filter(key => key.includes('/bead-marks/wayfind/'));
  const requestsIn = () => [...fx.fake.objects.keys()].filter(key => /sections\/inbox\/requests\//.test(key));
  const row = (page, id) => page.locator(`[data-q-row="${id}"]`);
  const showRow = async (page, hash = '#/~hub/map/wayfind') => {
    await page.goto(`${fx.url}${hash}`);
    await page.locator('.hub-map-wrap').waitFor();
    await page.locator('.hub-wayfinder').first().waitFor();
    if (await page.locator('.hub-wayfinder-toggle').getAttribute('aria-expanded') !== 'true') await page.locator('.hub-wayfinder-toggle').click();
    await page.locator('[data-q-row]').first().waitFor();
  };

  const desk = await open({ width: 1280, height: 800 }, { permissions: ['clipboard-read', 'clipboard-write'] });
  watch(desk);

  step('desktop: each question has the main button of its kind with its cost; blocked ones say what they wait for');
  await showRow(desk);
  assert.equal(await desk.locator('[data-q-row]').count(), 4);
  const one = row(desk, 'wf-q1');
  assert.equal((await one.locator('[data-q-main]').innerText()).trim(), 'Prepare a decision');
  assert.equal(await one.locator('[data-q-main]').getAttribute('data-q-main'), 'prepare');
  assert.equal((await one.locator('[data-q-cost]').first().innerText()).trim(), 'Hermes · about 0.3 M plan tokens');
  const two = row(desk, 'wf-q2');
  assert.equal((await two.locator('[data-q-main]').innerText()).trim(), 'Research it');
  assert.equal((await two.locator('[data-q-cost]').first().innerText()).trim(), 'Hermes · 0.7–1.1 M plan tokens');
  assert.match(await two.locator('[data-q-note]').innerText(), /Needs the repo\? Use Copy prompt for Claude Code\./);
  for (const [id, after] of [['wf-q3', 'After: Which project comes first?'], ['wf-q4', 'After: Which project comes first?, Where does the chip go?']]) {
    assert.equal(await row(desk, id).locator('[data-q-main]').count(), 0, `${id} has no main button.`);
    assert.equal((await row(desk, id).locator('[data-q-after]').innerText()).trim(), after);
    assert.equal(await row(desk, id).locator('[data-q-menu]').count(), 1, `${id} keeps its menu.`);
  }
  assert.equal((await desk.locator('[data-q-all]').innerText()).trim(), 'Prepare all · 1');
  assert.equal((await desk.locator('[data-q-all-cost]').innerText()).trim(), 'about 0.4 M plan tokens');
  await shot(desk, 'destination-row-desktop');

  step('desktop: the main button opens Spawn prefilled with the question preset and files nothing');
  await one.locator('[data-q-main]').click();
  await desk.locator('[data-spawn-sheet] [data-preset]').first().waitFor();
  assert.equal(await desk.locator('[data-preset="question"]').getAttribute('aria-pressed'), 'true');
  const seed = await desk.locator('[data-spawn-text]').inputValue();
  assert.match(seed, /^Resolve question wf-q1 \(grilling\)\nMode: grilling\nProject: wayfind\nMap: wf-map/);
  assert.match(seed, /<<<DATA\nTitle: Which project comes first\?\nQuestion: Which project should the next sprint start with, and why\?/);
  assert.ok(seed.length < 4000);
  await desk.locator('[data-spawn-machine]', { hasText: 'Hermes' }).waitFor();
  assert.match(await desk.locator('[data-spawn-agent]').innerText(), /Researcher/);
  assert.match(await desk.locator('[data-spawn-estimate]').innerText(), /0\.3 M tokens/);
  await shot(desk, 'spawn-question-desktop');
  await desk.keyboard.press('Escape');
  await desk.locator('[data-spawn-sheet]').waitFor({ state: 'detached' });
  assert.deepEqual(requestsIn(), [], 'Nothing was filed or approved.');

  step('desktop: Research it opens the same preset in research mode; Prepare all covers the ready questions');
  await two.locator('[data-q-main]').click();
  await desk.locator('[data-spawn-sheet] [data-preset]').first().waitFor();
  assert.match(await desk.locator('[data-spawn-text]').inputValue(), /^Resolve question wf-q2 \(research\)\nMode: research/);
  await desk.keyboard.press('Escape');
  await desk.locator('[data-spawn-sheet]').waitFor({ state: 'detached' });
  await desk.locator('[data-q-all]').click();
  await desk.locator('[data-spawn-sheet] [data-preset]').first().waitFor();
  assert.match(await desk.locator('[data-spawn-text]').inputValue(), /^Resolve question wf-q1 \(grilling\)\nMode: grilling/, 'One ready question: the same text as its own button.');
  await desk.keyboard.press('Escape');
  await desk.locator('[data-spawn-sheet]').waitFor({ state: 'detached' });

  step('desktop: the ⋯ menu lists the other ways, with costs, and closes on Escape and on an outside click');
  await one.locator('[data-q-menu]').click();
  const menu = desk.locator('[data-q-menu-list]');
  await menu.waitFor();
  assert.deepEqual(await menu.locator('[role="menuitem"]').evaluateAll(items => items.map(item => item.innerText.replace(/\s+/g, ' ').trim())), [
    'Answer here Free', 'Talk it through in Hermes Chat Chat · plan tokens per message', 'Copy prompt for Claude Code Your Max plan', 'Copy prompt for Codex Your ChatGPT plan',
  ]);
  assert.equal(await one.locator('[data-q-menu]').getAttribute('aria-expanded'), 'true');
  await shot(desk, 'question-menu-desktop');
  await desk.keyboard.press('Escape');
  await menu.waitFor({ state: 'detached' });
  assert.equal(await desk.evaluate(() => document.activeElement?.matches('[data-q-menu]')), true, 'The focus goes back to the menu button.');
  await one.locator('[data-q-menu]').click();
  await menu.waitFor();
  await desk.locator('.hub-map-wrap').click({ position: { x: 5, y: 5 } });
  await menu.waitFor({ state: 'detached' });

  step('desktop: Copy prompt for Claude Code copies the wayfinder prompt for the ticket; Talk it through opens Chat with an unsent draft');
  await one.locator('[data-q-menu]').click();
  await desk.locator('[data-q-item-action="claude"]').click();
  assert.match(await desk.locator('[data-q-copied]').innerText(), /Copied the prompt for Claude Code/);
  const copied = await desk.evaluate(() => navigator.clipboard.readText().catch(() => ''));
  if (copied) assert.match(copied, /^In the Wayfind repo, use the wayfinder skill to work ticket wf-q1 on map wf-map \(Beads\)\. It is a grilling ticket\./i);
  await two.locator('[data-q-menu]').click();
  await desk.locator('[data-q-item-action="chat"]').click();
  await desk.waitForURL(/#\/~hub\/chat$/);
  await desk.locator('textarea[aria-label="Message"]').waitFor();
  await openChatSheet(desk);
  assert.equal(await desk.locator('[data-chat-persona]').inputValue(), 'hermes', 'Plain Hermes, not a persona.');
  const draft = await desk.locator('textarea[aria-label="Message"]').inputValue();
  assert.match(draft, /Question wf-q2 \(research\)/);
  assert.match(draft, /Grill me on this one question at a time\. When we agree, file one Ask on bead wf-q2 \(kind decision\) with our conclusion as the recommended option\.$/);
  assert.equal(await desk.locator('.hub-bubble').count(), 0, 'Nothing was sent.');
  assert.deepEqual(writes.filter(line => !/\/chat(\/|$)/.test(line)), [], 'Nothing was written but the page loading.');

  step('desktop: the side sheet of a question has a Resolve block with the same choices');
  await desk.goto(`${fx.url}#/~hub/map/wayfind/wf-q1`);
  const panel = desk.locator('.hub-map-panel');
  await panel.waitFor();
  const resolve = panel.locator('[data-resolve]');
  await resolve.waitFor();
  assert.match(await resolve.locator('h4').innerText(), /resolve/i);
  assert.equal((await resolve.locator('[data-q-main]').innerText()).trim(), 'Prepare a decision');
  assert.equal(await resolve.locator('[data-q-item-action]').count(), 4);
  await shot(desk, 'side-sheet-resolve-desktop');
  await panel.locator('[aria-label="Close details"]').click();

  step('phone: the row starts closed; opened, each question is a block with a full-width button, a cost line and a 44 px menu button');
  const phone = await open({ width: 390, height: 844 }, { hasTouch: true, isMobile: true });
  watch(phone);
  await phone.goto(`${fx.url}#/~hub/map/wayfind`);
  await phone.locator('.hub-wayfinder').first().waitFor();
  assert.equal(await phone.locator('.hub-wayfinder-toggle').getAttribute('aria-expanded'), 'false');
  assert.equal(await phone.locator('[data-q-row]').count(), 0);
  await phone.locator('.hub-wayfinder-toggle').tap();
  await phone.locator('[data-q-row]').first().waitFor();
  await noSideways(phone, 'questions at 390');
  const pone = row(phone, 'wf-q1');
  const mainBox = await pone.locator('[data-q-main]').boundingBox();
  const menuBox = await pone.locator('[data-q-menu]').boundingBox();
  await tall(pone.locator('[data-q-main]'), 'the main button', 44);
  await tall(pone.locator('[data-q-menu]'), 'the menu button', 44);
  assert.ok(mainBox.width > 390 - 16 - 44 - 40, `The main button fills the line next to the menu button (${mainBox.width}).`);
  assert.ok(Math.abs(mainBox.y - menuBox.y) < 8, 'The button and the menu button share a line.');
  const costBox = await pone.locator('[data-q-cost]').first().boundingBox();
  assert.ok(costBox.y >= mainBox.y + mainBox.height - 2, 'The cost line is under the button.');
  assert.equal((await phone.locator('[data-q-all]').innerText()).trim(), 'Prepare all · 1');
  await tall(phone.locator('[data-q-all]'), 'Prepare all', 44);
  await tall(row(phone, 'wf-q3').locator('[data-q-menu]'), 'a blocked question\'s menu button', 44);
  assert.equal(await row(phone, 'wf-q3').locator('[data-q-main]').count(), 0);
  await shot(phone, 'destination-row-phone');

  step('phone: the ⋯ menu is a bottom sheet, every item is 44 px, it closes on Escape and on an outside tap');
  await pone.locator('[data-q-menu]').tap();
  const pmenu = phone.locator('[data-q-menu-list]');
  await pmenu.waitFor();
  const sheetBox = await pmenu.boundingBox();
  assert.ok(Math.abs(sheetBox.y + sheetBox.height - 844) <= 2 && sheetBox.width >= 388, `It sits at the bottom edge, full width (${JSON.stringify(sheetBox)}).`);
  for (const item of await pmenu.locator('[role="menuitem"]').all()) await tall(item, 'a menu item', 44);
  await noSideways(phone, 'menu at 390');
  await shot(phone, 'question-menu-phone');
  await phone.keyboard.press('Escape');
  await pmenu.waitFor({ state: 'detached' });
  await pone.locator('[data-q-menu]').tap();
  await pmenu.waitFor();
  await phone.locator('.hub-wayfinder-eyebrow, .hub-map-chips').first().tap({ position: { x: 4, y: 4 }, force: true }).catch(() => {});
  await phone.touchscreen.tap(195, 120);
  await pmenu.waitFor({ state: 'detached' });

  step('desktop: Answer here records the decision as a mark, the question leaves the open ones at once and what it blocked is unlocked');
  await showRow(desk);
  await one.locator('[data-q-menu]').click();
  await desk.locator('[data-q-item-action="answer"]').click();
  const form = one.locator('[data-q-answer]');
  await form.waitFor();
  assert.equal(await form.locator('[data-q-record]').isDisabled(), true, 'An empty decision cannot be recorded.');
  assert.equal(await form.locator('[data-q-text]').getAttribute('maxlength'), '500');
  await shot(desk, 'answer-here-desktop');
  await form.locator('[data-q-text]').fill('Start with the small version.');
  await form.locator('[data-q-record]').click();
  await row(desk, 'wf-q1').waitFor({ state: 'detached' });
  assert.equal((await desk.locator('.hub-wayfinder-count').innerText()).trim(), '4 decisions');
  assert.equal(marksIn().length, 1, 'One mark file.');
  assert.deepEqual([fx.fake.json(marksIn()[0]).verdict, fx.fake.json(marksIn()[0]).reason, fx.fake.json(marksIn()[0]).bead], ['done', 'Start with the small version.', 'wf-q1']);
  assert.equal((await row(desk, 'wf-q3').locator('[data-q-main]').innerText()).trim(), 'Prepare a decision', 'The question it blocked has its button now.');
  assert.equal((await row(desk, 'wf-q4').locator('[data-q-after]').innerText()).trim(), 'After: Where does the chip go?');

  step('desktop: the side sheet says what was decided and Undo takes it back');
  await desk.goto(`${fx.url}#/~hub/map/wayfind/wf-q1`);
  await desk.locator('[data-decided]').waitFor();
  assert.match(await desk.locator('[data-decided]').innerText(), /^Decided: Start with the small version\. · the PC applies it within minutes/);
  assert.equal(await desk.locator('[data-resolve]').count(), 0, 'A decided question has no Resolve block.');
  await shot(desk, 'side-sheet-decided-desktop');
  await desk.locator('[data-mark-undo]').click();
  await desk.locator('[data-resolve]').waitFor();
  assert.equal((await desk.locator('[data-resolve] [data-q-main]').innerText()).trim(), 'Prepare a decision');
  assert.equal(marksIn().length, 2, 'The undo is a second mark file; nothing was deleted.');

  step('desktop: a decision Ask on the question says what its answer decides (the title from Beads) and answering it decides the question');
  const ask = askId('decide-q3', 'q3q3');
  fx.seed.ask(askJson({
    id: ask, project: 'wayfind', bead: 'wf-q3', kind: 'decision', now: minutesAgo(fx.now, 5), allowDrawing: false, question: 'Is the card text in or out of the next sprint?',
    context: 'The card text is the biggest open item. Leaving it out keeps the sprint small; putting it in finishes the feature.',
    options: [{ id: 'a', label: 'Out (recommended)' }, { id: 'b', label: 'In' }],
  }));
  await desk.goto(`${fx.url}#/~hub/ask/${ask}`);
  const decides = desk.locator('[data-ask-decides]');
  await decides.waitFor();
  assert.equal((await decides.innerText()).trim(), 'Your answer decides Is the card text in or out? on the Roadmap.');
  await shot(desk, 'ask-decides-desktop');
  await desk.locator('.hub-option-pick', { hasText: 'Out (recommended)' }).click();
  await desk.locator('[data-send]').click();
  // Answering moves on to the next item in Needs you, so wait for what the answer wrote rather than for a screen.
  const answerKey = `sections/inbox/asks/${ask}/answer.json`;
  for (let tries = 0; tries < 100 && !fx.fake.objects.has(answerKey); tries += 1) await desk.waitForTimeout(100);
  assert.ok(fx.fake.objects.has(answerKey), 'The answer was written.');
  await desk.goto(`${fx.url}#/~hub/map/wayfind`);
  await desk.locator('.hub-wayfinder').first().waitFor();
  await row(desk, 'wf-q3').waitFor({ state: 'detached' });
  assert.deepEqual(marksIn().map(key => fx.fake.json(key)).filter(mark => mark.bead === 'wf-q3').map(mark => [mark.verdict, mark.reason]), [['done', 'Out (recommended)']]);

  console.log('hub-map-questions-ui: passed');
} finally {
  for (const context of contexts) await context.close().catch(() => {});
  await browser.close();
  for (const fixture of fixtures) await fixture.close().catch(() => {});
}
