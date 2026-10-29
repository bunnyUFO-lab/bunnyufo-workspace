// Run after npm run build. The Needs you list through a real browser, over the fixture service (one Ask with three
// options, a checklist, a review, a blocked session, and a second, submitted checklist): the chips and their counts, the old
// filter names, the four cells, an Ask answered where it stands, a step ticked in place, Snooze, Mark done on a review
// and a blocked session, the Today row that opens on its item, 44 px targets and no sideways scroll at 375 px, and no
// collapse animation with reduced motion. Nothing is ever overwritten: the bucket only gains files.
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { FIXTURE_ASK, FIXTURE_CHECKLIST, askId, startHubFixture } from './hub-fixture.mjs';
import { askJson, eventJson, threeOptions } from '../../site/api/test/hub-fixtures.mjs';

const step = name => console.log(`- ${name}`);
const channel = process.env.BUW_TEST_BROWSER || 'msedge';

const fixture = await startHubFixture({ checklists: true });
const browser = await chromium.launch({ headless: true, channel });
const contexts = [];
const open = async (viewport, options = {}) => {
  const context = await browser.newContext({ viewport, serviceWorkers: 'block', ...options });
  contexts.push(context);
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => { throw error; });
  return page;
};
const noSideways = async (page, what) => {
  const widths = await page.evaluate(() => ({ scroll: document.scrollingElement.scrollWidth, inner: innerWidth, hub: document.querySelector('.hub')?.scrollWidth ?? 0, hubInner: document.querySelector('.hub')?.clientWidth ?? 0 }));
  assert.ok(widths.scroll <= widths.inner, `${what}: the page scrolls sideways (${widths.scroll} > ${widths.inner}).`);
  assert.ok(widths.hub <= widths.hubInner, `${what}: the Hub scrolls sideways (${widths.hub} > ${widths.hubInner}).`);
};
const go = async (page, hash) => { await page.evaluate(value => { location.hash = value; }, hash); };
const tall = async (locator, what) => {
  const count = await locator.count();
  assert.ok(count > 0, `${what}: there is something to measure.`);
  for (let index = 0; index < count; index += 1) {
    const box = await locator.nth(index).boundingBox();
    assert.ok(box && box.height >= 44, `${what} #${index} is ${box?.height} px tall, under 44.`);
  }
};
const chips = page => page.locator('.hub-chips .hub-chip').evaluateAll(list => list.map(item => [item.getAttribute('data-filter'), item.querySelector('.n')?.textContent ?? null]));
const answerOf = id => fixture.fake.json(`sections/inbox/asks/${id}/answer.json`);
const files = prefix => [...fixture.fake.objects.keys()].filter(key => key.startsWith(prefix));

try {
  const page = await open({ width: 1280, height: 800 }, { reducedMotion: 'reduce' });
  await page.goto(`${fixture.url}#/~hub/needs`);
  await page.locator('.hub[data-screen="needs"] .ni').first().waitFor();

  step('the header, and the chips with their counts: kinds with nothing in them hide, Answered has no count');
  assert.equal(await page.locator('.needs-eyebrow').textContent(), 'Review queue');
  assert.equal(await page.locator('.hub h2').first().innerText(), 'Needs you');
  assert.match(await page.locator('.needs-head p').innerText(), /^Everything that waits on you, in one place\./);
  await page.locator('.hub-chip[data-filter="steps"] .n').waitFor();
  assert.deepEqual(await chips(page), [['all', '4'], ['question', '1'], ['steps', '1'], ['unstick', '1'], ['pr', '1'], ['answered', null]]);
  assert.equal(await page.locator('.hub-chip.on').getAttribute('data-filter'), 'all');
  assert.deepEqual(await page.locator('.ni').evaluateAll(list => list.map(item => item.getAttribute('data-kind'))), ['question', 'steps', 'pr', 'unstick'], 'Open Asks first, then lists, reviews and blocked sessions.');

  step('each card has the four cells, and they say plain things');
  const ask = page.locator('.ni[data-kind="question"]');
  assert.deepEqual(await ask.locator('.four dt').allTextContents(), ['What', 'State', 'Next action', 'Blocker']);
  assert.deepEqual(await ask.locator('.four dd').allInnerTexts(), ['A question from bead bd-7f3c', 'Waiting for your answer', 'Pick an option or write a note', 'Your answer']);
  const steps = page.locator('.ni[data-kind="steps"]');
  assert.deepEqual(await steps.locator('.four dd').allInnerTexts(), ['Steps only you can do', '1 of 4 done', 'Tick each step, then Submit', 'Your hands']);
  assert.deepEqual(await page.locator('.ni[data-kind="pr"] .four dd').allInnerTexts(), ['A pull request ready for you', 'Ready for review', 'Open it or mark it done', 'Merging stays yours']);
  assert.deepEqual(await page.locator('.ni[data-kind="unstick"] .four dd').allInnerTexts(), ['A session waiting on you', 'Paused at a prompt', 'Open the session', 'Your answer in the session']);
  assert.match(await ask.locator('.ni-meta').innerText(), /^Question\s*claude-code · [^\n]+\s*asked \d+ min ago\s*bd-7f3c/);
  assert.equal(await ask.locator('.hub-option').count(), 3, 'The options are in the card.');
  assert.equal(await steps.locator('[data-item]').count(), 4, 'The steps are in the card.');

  step('old filter names land on the new chips, and the address is rewritten');
  for (const [old, now] of [['needs/todo', 'steps'], ['needs/blocked', 'unstick'], ['inbox/asks', 'question'], ['needs/needs-you', 'all'], ['needs/reviews', 'pr']]) {
    await go(page, `#/~hub/${old}`);
    await page.waitForFunction(value => document.querySelector('.hub-chip.on')?.getAttribute('data-filter') === value, now);
    assert.equal(await page.evaluate(() => location.hash), `#/~hub/needs/${now}`, `${old} is rewritten.`);
  }
  await go(page, '#/~hub/needs/steps');
  await page.locator('.ni[data-kind="steps"]').waitFor();
  await page.waitForFunction(() => document.querySelectorAll('.ni').length === 1);
  assert.deepEqual(await page.locator('.ni').evaluateAll(list => list.map(item => item.getAttribute('data-kind'))), ['steps'], 'A chip narrows the list.');
  await go(page, '#/~hub/needs/design');
  await page.locator('.needs-empty', { hasText: 'No design review waits on you.' }).waitFor();
  await go(page, '#/~hub/needs/answered');
  await page.locator('.hub-row', { hasText: 'Update the router settings' }).waitFor();
  assert.equal(await page.locator('.ni').count(), 0, 'Answered is history, not cards.');

  step('a Today row opens the list on its item, flashed');
  await go(page, '#/~hub/today');
  const row = page.locator('.nrow[data-nrow="steps"]');
  await row.waitFor();
  await row.click();
  await page.locator('.hub[data-screen="needs"]').waitFor();
  await page.locator(`.ni[data-need="checklist-${FIXTURE_CHECKLIST}"].flash`).waitFor();
  const top = await page.evaluate(id => {
    const card = document.querySelector(`[data-need="checklist-${id}"]`).getBoundingClientRect();
    const hub = document.querySelector('.hub').getBoundingClientRect();
    return card.top - hub.top;
  }, FIXTURE_CHECKLIST);
  assert.ok(top >= 0 && top < 120, `The item is scrolled to the top of the list (${top} px).`);
  await page.locator(`.ni[data-need="checklist-${FIXTURE_CHECKLIST}"].flash`).waitFor({ state: 'detached', timeout: 4000 });

  assert.equal(await page.locator('.ni').first().evaluate(node => getComputedStyle(node).transitionDuration), '0s', 'No collapse animation with reduced motion.');

  step('an Ask is answered where it stands: pick B, write a note, send; the card leaves with no animation under reduced motion');
  await go(page, '#/~hub/needs');
  const card = page.locator(`.ni[data-need="ask-${FIXTURE_ASK}"]`);
  await card.waitFor();
  assert.equal(await card.getByRole('button', { name: 'Send answer' }).isDisabled(), true, 'Nothing to send yet.');
  await card.locator('[data-option="B"] .hub-option-pick').click();
  await card.locator('textarea').fill('shorter hang here');
  await card.getByRole('button', { name: 'Send answer' }).click();
  await card.waitFor({ state: 'detached' });
  assert.deepEqual([answerOf(FIXTURE_ASK).choice, answerOf(FIXTURE_ASK).note, answerOf(FIXTURE_ASK).by], ['B', 'shorter hang here', 'local']);
  await page.locator('.ni-status', { hasText: 'Answered.' }).waitFor();
  await page.waitForFunction(() => document.querySelector('.hub-chip[data-filter="all"] .n')?.textContent === '3');
  assert.equal(await page.locator('.hub-chip[data-filter="question"]').count(), 0, 'The Question chip hides when nothing is left.');
  await page.waitForFunction(() => document.querySelector('[data-hub-tab-badge]')?.textContent === '3');

  step('a step is ticked in place: it shows at once, and a new mark file is written');
  const list = page.locator(`.ni[data-need="checklist-${FIXTURE_CHECKLIST}"]`);
  const before = files(`sections/inbox/checklists/${FIXTURE_CHECKLIST}/tick-`).length;
  await list.locator('[data-item="02"] [data-box]').click();
  await list.locator('[data-item="02"] [data-box][aria-checked="true"]').waitFor();
  await list.locator('[data-progress]', { hasText: '2 of 4 done' }).waitFor();
  assert.equal(files(`sections/inbox/checklists/${FIXTURE_CHECKLIST}/tick-`).length, before + 1);
  await list.locator('[data-four]').getByText('2 of 4 done').waitFor();

  step('Mark done on a pull request review and on a blocked session removes the card, and the writes are events');
  await page.locator('.ni[data-kind="pr"]').getByRole('button', { name: 'Mark done' }).click();
  await page.locator('.ni[data-kind="pr"]').waitFor({ state: 'detached' });
  await page.locator('.ni[data-kind="unstick"]').getByRole('button', { name: 'Mark done' }).click();
  await page.locator('.ni[data-kind="unstick"]').waitFor({ state: 'detached' });
  const done = [...fixture.fake.objects.keys()].filter(key => key.includes('/events/')).map(key => fixture.fake.json(key)).filter(event => event.kind === 'review-done');
  assert.equal(done.length, 2);
  await page.locator('.ni-status', { hasText: 'Marked done.' }).waitFor();

  step('Snooze a day takes an Ask off the list and writes snooze.json for a day');
  const snoozed = askJson({ id: askId('snooze-me', 's1s1'), now: new Date(), question: 'Snooze me?' });
  fixture.seed.ask(snoozed);
  await page.reload();
  const sn = page.locator('.ni', { hasText: 'Snooze me?' });
  await sn.waitFor();
  await sn.getByRole('button', { name: 'Snooze a day' }).click();
  await sn.waitFor({ state: 'detached' });
  const snooze = fixture.fake.json(`sections/inbox/asks/${snoozed.id}/snooze.json`);
  const hours = (new Date(snooze.until ?? snooze.snoozedUntil).getTime() - Date.now()) / 3600000;
  assert.ok(hours > 23 && hours <= 24.1, `Snoozed for a day (${hours} h).`);
  await page.locator('.ni-status', { hasText: 'Snoozed for a day.' }).waitFor();

  step('with the collapse on, the card is still on screen during the animation and gone after it');
  const motion = await open({ width: 1280, height: 800 });
  const one = askJson({ id: askId('motion', 'm1m1'), now: new Date(), question: 'Leave slowly?' });
  fixture.seed.ask(one);
  await motion.goto(`${fixture.url}#/~hub/needs/question`);
  const slow = motion.locator('.ni', { hasText: 'Leave slowly?' });
  await slow.waitFor();
  await motion.route('**/api/hub/inbox*', async route => { await new Promise(resolve => setTimeout(resolve, 700)); await route.continue().catch(() => {}); });
  await slow.locator('textarea').fill('ok');
  await slow.getByRole('button', { name: 'Send answer' }).click();
  await motion.locator('.ni.leaving', { hasText: 'Leave slowly?' }).waitFor({ timeout: 2000 });
  assert.notEqual(await slow.evaluate(node => getComputedStyle(node).transitionDuration), '0s', 'The collapse is animated when motion is allowed.');
  await slow.waitFor({ state: 'detached' });
  await motion.unroute('**/api/hub/inbox*');

  step('phone: no sideways scroll, targets of at least 44 px, the chips scroll sideways inside their row');
  fixture.seed.event(eventJson({ kind: 'blocked', ts: new Date(Date.now() - 4 * 60000), session: 'sess-phone', title: 'Phone session' }));
  fixture.seed.event(eventJson({ kind: 'ready-for-review', ts: new Date(Date.now() - 5 * 60000), title: 'Phone review' }));
  fixture.seed.ask(askJson({ id: askId('phone', 'p1p1'), now: new Date(), question: 'Phone question?', options: threeOptions() }));
  const phone = await open({ width: 375, height: 812 }, { hasTouch: true, isMobile: true, reducedMotion: 'reduce' });
  await phone.goto(`${fixture.url}#/~hub/needs`);
  await phone.locator('.ni', { hasText: 'Phone question?' }).waitFor();
  await phone.waitForTimeout(300);
  await noSideways(phone, 'Needs you at 375 px');
  const widthOfFour = await phone.locator('.ni').first().locator('.four').evaluate(node => getComputedStyle(node).gridTemplateColumns.split(' ').length);
  assert.equal(widthOfFour, 2, 'The four cells are two by two under 760 px.');
  await tall(phone.locator('.ni .hub-option-pick'), 'options');
  await tall(phone.locator('.ni .hub-actions .hub-btn, .ni .ni-a .hub-btn'), 'buttons');
  await tall(phone.locator('.hub-chips .hub-chip'), 'chips');
  await tall(phone.locator('.ni [data-box]'), 'step boxes');
  await go(phone, `#/~hub/ask/${FIXTURE_ASK}`);
  await phone.locator('.hub-option').first().waitFor();
  await noSideways(phone, 'the Ask view at 375 px');
} finally {
  for (const context of contexts) await context.close().catch(() => {});
  await browser.close();
  await fixture.close();
}
console.log('hub-needs-ui: passed');
