// Run after npm run build. The Needs you list through a real browser, over the fixture service (one Ask with three
// options, a checklist, a review, a blocked session, and a second, submitted checklist): the chips and their counts, the old
// filter names, the four cells, an Ask answered where it stands, a step ticked in place, Snooze, Mark done on a review
// and a blocked session, the Today row that opens on its item, 44 px targets and no sideways scroll at 375 px, and no
// collapse animation with reduced motion. Nothing is ever overwritten: the bucket only gains files.
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { FIXTURE_ASK, FIXTURE_CHECKLIST, askId, startHubFixture } from './hub-fixture.mjs';
import { askJson, checklistJson, designAskJson, eventJson, playtestJson, plainOptions, threeOptions } from '../../site/api/test/hub-fixtures.mjs';
import { solidPng } from '../../site/api/test/png.mjs';

const step = name => console.log(`- ${name}`);
const channel = process.env.BUW_TEST_BROWSER || 'msedge';

const fixture = await startHubFixture({ checklists: true });
let second = null;
let third = null;
let fourth = null;
let fifth = null;
let sixth = null;
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

const pasteImage = (page, { text = '', width = 0 } = {}) => page.evaluate(async ({ base64, text }) => {
  const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
  const transfer = new DataTransfer();
  transfer.items.add(new File([bytes], 'image.png', { type: 'image/png' }));
  if (text) transfer.setData('text/plain', text);
  const target = document.activeElement && document.activeElement !== document.body ? document.activeElement : document.querySelector('[data-progress]');
  const event = new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}, { base64: solidPng(30 + width, 30).toString('base64'), text });
const dropOn = (page, selector, { image = true } = {}) => page.evaluate(async ({ selector, base64, image }) => {
  const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
  const transfer = new DataTransfer();
  transfer.items.add(image ? new File([bytes], 'drop.png', { type: 'image/png' }) : new File(['no'], 'notes.txt', { type: 'text/plain' }));
  const target = document.querySelector(selector);
  const make = type => new DragEvent(type, { dataTransfer: transfer, bubbles: true, cancelable: true });
  const over = make('dragover');
  target.dispatchEvent(make('dragenter'));
  target.dispatchEvent(over);
  await new Promise(resolve => setTimeout(resolve, 50));
  const outlined = target.closest('.hub-cl-item')?.classList.contains('hub-cl-drop') ?? false;
  const drop = make('drop');
  target.dispatchEvent(drop);
  return { overPrevented: over.defaultPrevented, dropPrevented: drop.defaultPrevented, outlined };
}, { selector, base64: solidPng(40, 30).toString('base64'), image });
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
  await page.locator('[data-next-note]', { hasText: 'Answered' }).waitFor();
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

  step('a link with an event file in the filter place opens the list on that blocked item, flashed, and the address becomes needs/all');
  const blockedFile = [...fixture.fake.objects.keys()].filter(key => key.includes('/events/')).find(key => fixture.fake.json(key).kind === 'blocked').split('/').pop();
  const linkedPage = await open({ width: 1280, height: 800 });
  await linkedPage.goto(`${fixture.url}#/~hub/needs/${blockedFile}`);
  await linkedPage.locator('.ni[data-kind="unstick"].flash').waitFor();
  assert.match(await linkedPage.evaluate(() => location.hash), /needs\/all$/);
  assert.equal(await linkedPage.locator('.hub-chip.on').getAttribute('data-filter'), 'all');

  step('a picture is attached to a step: a thumbnail shows at once, one file is stored in the checklist folder, a reload keeps it');
  const folder = `sections/inbox/checklists/${FIXTURE_CHECKLIST}/`;
  assert.equal(files(`${folder}evidence-`).length, 0);
  await list.locator('[data-item="02"] [data-attach-input]').setInputFiles({ name: 'photo.png', mimeType: 'image/png', buffer: solidPng(64, 48) });
  await list.locator('[data-item="02"] [data-evidence] img').waitFor();
  assert.equal(files(`${folder}evidence-`).length, 1);
  assert.match(files(`${folder}evidence-`)[0], /\/evidence-02-\d{8}T\d{9}Z-[a-z0-9]{4}\.png$/);
  assert.equal(await list.locator('[data-item="01"] [data-evidence]').count(), 0, 'Only the step with a picture has a thumbnail.');
  const thumb = await list.locator('[data-item="02"] [data-evidence]').boundingBox();
  assert.ok(thumb && thumb.width === 48 && thumb.height === 48, 'The thumbnail is 48 px.');
  assert.ok((await list.locator('[data-item="02"] [data-attach]').boundingBox()).height >= 44, 'The camera button is 44 px tall.');
  const reopened = await open({ width: 1280, height: 800 }, { reducedMotion: 'reduce' });
  await reopened.goto(`${fixture.url}#/~hub/checklist/${FIXTURE_CHECKLIST}`);
  await reopened.locator('[data-item="02"] [data-evidence] img').waitFor();
  await reopened.waitForFunction(() => { const image = document.querySelector('[data-item="02"] [data-evidence] img'); return image && image.complete && image.naturalWidth > 0; });
  step('a file that is not a picture shows its error under the step and stores nothing');
  await list.locator('[data-item="03"] [data-attach-input]').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('not a picture') });
  await list.locator('[data-item="03"] [data-item-error]').waitFor();
  assert.match(await list.locator('[data-item="03"] [data-item-error]').innerText(), /can't be opened/);
  assert.equal(files(`${folder}evidence-`).length, 1);

  step('paste: with no step touched, the list says "Tap a step first, then paste." and stores nothing');
  const storedCount = () => files(`${folder}evidence-`).length;
  const storedBefore = storedCount();
  await reopened.locator('[data-progress]').click();
  assert.equal(await pasteImage(reopened), true, 'The paste is taken.');
  await reopened.locator('[data-paste-hint]', { hasText: 'Tap a step first, then paste.' }).waitFor();
  await reopened.waitForTimeout(300);
  assert.equal(storedCount(), storedBefore, 'No picture was stored.');

  step('paste: after a step is touched, Ctrl+V puts the picture on it, and the step says so');
  await list.locator('[data-item="03"] [data-box]').focus();
  assert.equal(await list.locator('.hub-cl-item.target').count(), 1, 'One step is marked as the target.');
  assert.equal(await list.locator('.hub-cl-item.target').getAttribute('data-item'), '03');
  await pasteImage(page);
  await list.locator('[data-item="03"] [data-attached-note]', { hasText: 'Pasted to step 3' }).waitFor();
  await list.locator('[data-item="03"] [data-evidence] img').waitFor();
  assert.equal(storedCount(), storedBefore + 1);
  assert.match(files(`${folder}evidence-`).find(key => key.includes('evidence-03-')), /evidence-03-\d{8}T\d{9}Z-[a-z0-9]{4}\.png$/);
  assert.equal(await list.locator('[data-item="03"] [data-item-error]').count(), 0, 'The earlier error is gone.');

  step('paste: text with a picture into the note stays the browser paste, and nothing is uploaded');
  await list.locator('textarea').focus();
  assert.equal(await pasteImage(page, { text: 'hello' }), false, 'The browser keeps its own paste.');
  await page.waitForTimeout(300);
  assert.equal(storedCount(), storedBefore + 1, 'Nothing was uploaded.');

  step('paste: an image-only paste while the note has focus still goes to the touched step');
  await pasteImage(page, { width: 1 });
  for (let wait = 0; wait < 100 && storedCount() < storedBefore + 2; wait += 1) await page.waitForTimeout(100);
  assert.equal(storedCount(), storedBefore + 2);

  step('drop: a picture on a step outlines it, is stored for that step, and says so');
  const dropped = await dropOn(page, `.ni[data-need="checklist-${FIXTURE_CHECKLIST}"] [data-item="04"] .hub-cl-title`);
  assert.equal(dropped.overPrevented, true);
  assert.equal(dropped.outlined, true, 'The row shows the drop outline.');
  await list.locator('[data-item="04"] [data-attached-note]', { hasText: 'Dropped on step 4' }).waitFor();
  assert.match(files(`${folder}evidence-`).find(key => key.includes('evidence-04-')), /evidence-04-/);

  step('drop: a file on the panel header does not open in the tab, and the list says where to drop');
  const header = await dropOn(page, `.ni[data-need="checklist-${FIXTURE_CHECKLIST}"] [data-progress]`);
  assert.equal(header.dropPrevented, true, 'The browser is kept from navigating to the file.');
  await list.locator('[data-paste-hint]', { hasText: 'Drop the picture on a step.' }).waitFor();
  assert.equal(new URL(page.url()).origin, new URL(fixture.url).origin, 'Still on the app.');

  step('drop: a file that is not a picture shows the usual error on that step');
  await dropOn(page, `.ni[data-need="checklist-${FIXTURE_CHECKLIST}"] [data-item="01"] .hub-cl-title`, { image: false });
  await list.locator('[data-item="01"] [data-item-error]', { hasText: "can't be opened" }).waitFor();

  step('paste: a sixth picture on one step shows the server limit on that step');
  await list.locator('[data-item="03"] [data-box]').focus();
  for (let have = files(`${folder}evidence-03-`).length; have < 5; have += 1) {
    await pasteImage(page, { width: 10 + have });
    for (let wait = 0; wait < 100 && files(`${folder}evidence-03-`).length <= have; wait += 1) await page.waitForTimeout(100);
  }
  assert.equal(files(`${folder}evidence-03-`).length, 5);
  await pasteImage(page, { width: 40 });
  await list.locator('[data-item="03"] [data-item-error]', { hasText: 'at most 5 pictures' }).waitFor();
  assert.equal(files(`${folder}evidence-03-`).length, 5);

  step('paste: with two lists open, only the list whose step was touched last takes it');
  sixth = await startHubFixture({ seedData: false });
  const listA = checklistJson({ id: askId('lista', 'a1a1'), now: new Date(Date.now() - 8 * 60000), title: 'List A' });
  const listB = checklistJson({ id: askId('listb', 'b1b1'), now: new Date(Date.now() - 7 * 60000), title: 'List B' });
  sixth.seed.checklist(listA);
  sixth.seed.checklist(listB);
  const two = await open({ width: 1280, height: 800 }, { reducedMotion: 'reduce' });
  await two.goto(`${sixth.url}#/~hub/needs`);
  const cardA = two.locator(`.ni[data-need="checklist-${listA.id}"]`);
  const cardB = two.locator(`.ni[data-need="checklist-${listB.id}"]`);
  await cardA.waitFor();
  await cardB.waitFor();
  const inList = (fix, id) => [...fix.fake.objects.keys()].filter(key => key.startsWith(`sections/inbox/checklists/${id}/evidence-`)).length;
  await cardA.locator('[data-item="02"] [data-box]').focus();
  await cardB.locator('[data-item="01"] [data-box]').focus();
  await pasteImage(two);
  await cardB.locator('[data-item="01"] [data-attached-note]', { hasText: 'Pasted to step 1' }).waitFor();
  assert.equal(inList(sixth, listB.id), 1);
  assert.equal(inList(sixth, listA.id), 0, 'The other list took nothing.');
  assert.equal(await cardA.locator('.hub-cl-item.target').count(), 0, 'Only one step on the page is the target.');
  await cardA.locator('[data-item="02"] [data-box]').focus();
  await pasteImage(two, { width: 5 });
  await cardA.locator('[data-item="02"] [data-attached-note]', { hasText: 'Pasted to step 2' }).waitFor();
  assert.equal(inList(sixth, listA.id), 1);
  assert.equal(inList(sixth, listB.id), 1);

  step('Mark done on a pull request review and on a blocked session removes the card, and the writes are events');
  await page.locator('.ni[data-kind="pr"]').getByRole('button', { name: 'Mark done' }).click();
  await page.locator('.ni[data-kind="pr"]').waitFor({ state: 'detached' });
  await page.locator('.ni[data-kind="unstick"]').getByRole('button', { name: 'Mark done' }).click();
  await page.locator('.ni[data-kind="unstick"]').waitFor({ state: 'detached' });
  const done = [...fixture.fake.objects.keys()].filter(key => key.includes('/events/')).map(key => fixture.fake.json(key)).filter(event => event.kind === 'review-done');
  assert.equal(done.length, 2);
  await page.locator('[data-next-note]', { hasText: 'Marked done' }).waitFor();

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
  await page.locator('[data-next-note]', { hasText: 'Snoozed' }).waitFor();

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
  fixture.seed.ask(askJson({ id: askId('phone', 'p1p1'), now: new Date(), question: 'Phone question?', options: plainOptions() }));
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
  await go(phone, '#/~hub/needs');
  await phone.locator('.hub-chips-wrap[data-overflow~="end"]').waitFor();
  assert.equal(await phone.locator('.hub-chips-wrap').getAttribute('data-overflow'), 'end', 'The chip row fades at the cut edge.');
  await tall(phone.locator('.ni [data-box]'), 'step boxes');
  await tall(phone.locator('.ni [data-attach]'), 'camera buttons');
  await phone.locator('.ni [data-item="02"] [data-evidence] img').waitFor();
  await go(phone, `#/~hub/ask/${FIXTURE_ASK}`);
  await phone.locator('.hub-option').first().waitFor();
  await noSideways(phone, 'the Ask view at 375 px');
  assert.equal(await phone.locator('.hub-btn', { hasText: 'Back to Needs you' }).getAttribute('href'), '#/~hub/needs', 'Back to Needs you opens All, like the checklist and review pages.');

  // ---- The next item: a second fixture with a known queue (Questions, a list, a blocked session). ----
  second = await startHubFixture({ seedData: false });
  const nowMs = Date.now();
  const q1 = askJson({ id: askId('first', 'f1f1'), now: new Date(nowMs - 20 * 60000), question: 'Question one?' });
  const q2 = askJson({ id: askId('second', 's2s2'), now: new Date(nowMs - 10 * 60000), question: 'Question two?' });
  const q3 = askJson({ id: askId('third', 't3t3'), now: new Date(nowMs - 5 * 60000), question: 'Question three?' });
  const listOne = checklistJson({ id: askId('steps', 'c4c4'), now: new Date(nowMs - 30 * 60000), title: 'Steps for you' });
  for (const item of [q1, q2]) second.seed.ask(item);
  second.seed.checklist(listOne);
  second.seed.event(eventJson({ kind: 'blocked', ts: new Date(nowMs - 40 * 60000), session: 'sess-next', title: 'Stuck session' }));
  const flat = text => text.replace(/\s+/g, ' ').trim();
  const reduced = await open({ width: 1280, height: 800 }, { reducedMotion: 'reduce' });

  step('next item, in the list: answering the first Question collapses it, a note names the next one, focus moves to it');
  await reduced.goto(`${second.url}#/~hub/needs`);
  const first = reduced.locator(`.ni[data-need="ask-${q2.id}"]`);
  await first.waitFor();
  assert.deepEqual(await reduced.locator('.ni .ni-t').allTextContents(), ['Question two?', 'Question one?', 'Steps for you', 'Stuck session'], 'The server order: newest Ask first.');
  await first.locator('textarea').fill('two is fine');
  await first.getByRole('button', { name: 'Send answer' }).click();
  const note = reduced.locator('[data-next-note]');
  await note.waitFor();
  assert.equal(flat(await note.textContent()), 'Answered · next: Question one?Back', 'The note names what was done and what comes next.');
  assert.equal(await note.getAttribute('role'), 'status');
  await first.waitFor({ state: 'detached' });
  assert.equal(await reduced.evaluate(() => document.activeElement?.closest('.ni')?.getAttribute('data-need')), `ask-${q1.id}`, 'Focus is on the next card.');
  assert.equal(await reduced.evaluate(() => document.activeElement?.classList.contains('ni-t')), true, 'On its title.');
  assert.equal(await reduced.locator('.nq > *').first().evaluate(node => node.matches('[data-next-note]')), true, 'The note sits in the slot the card left.');
  assert.equal(second.fake.json(`sections/inbox/asks/${q2.id}/answer.json`).note, 'two is fine');

  step('Back opens the answered item and shows its answer');
  assert.equal(await note.locator('[data-next-back]').getAttribute('href'), `#/~hub/ask/${q2.id}`);
  await note.locator('[data-next-back]').click();
  await reduced.locator('.hub-answer', { hasText: 'two is fine' }).waitFor();
  assert.equal(await reduced.locator('[data-next-note]').count(), 0, 'No note on the settled item itself.');

  step('next item, from a deep link: Submit lands on the next item with the note, and the browser Back returns to the list');
  await go(reduced, `#/~hub/checklist/${listOne.id}`);
  await reduced.locator('[data-submit]').waitFor();
  await reduced.locator('[data-submit]').click();
  await reduced.locator('[data-warning]').waitFor();
  await reduced.locator('[data-submit]').click();
  await reduced.locator('[data-next-note]', { hasText: 'Submitted · next: Stuck session' }).waitFor();
  await reduced.locator('.ni[data-kind="unstick"].flash').waitFor();
  assert.equal(await reduced.evaluate(() => location.hash), '#/~hub/needs/unstick', 'The Ask came before the list in the queue, so the next item is the blocked session: no page of its own, so the Unstick chip.');
  assert.equal(await reduced.locator('[data-next-note] [data-next-back]').getAttribute('href'), `#/~hub/checklist/${listOne.id}`);
  await reduced.goBack();
  await reduced.locator('.hub-cl[data-state="submitted"]').waitFor();

  step('an Unstick item has no page of its own: its link is the Unstick chip with the card in focus; the last Mark done leaves the empty state with the note');
  await go(reduced, `#/~hub/ask/${q1.id}`);
  await reduced.locator('textarea').fill('one is fine');
  await reduced.getByRole('button', { name: 'Send answer' }).click();
  await reduced.locator('[data-next-note]', { hasText: 'Answered · next: Stuck session' }).waitFor();
  assert.equal(await reduced.evaluate(() => location.hash), '#/~hub/needs/unstick');
  await reduced.locator('.ni[data-kind="unstick"]').waitFor();
  await reduced.locator('.ni[data-kind="unstick"] .ni-t').waitFor();
  await reduced.locator('.ni[data-kind="unstick"]').getByRole('button', { name: 'Mark done' }).click();
  await reduced.locator('.needs-empty').waitFor();
  const empty = reduced.locator('[data-next-note]');
  assert.equal(flat(await empty.textContent()), 'Marked done. Nothing else waits on you.Back');
  assert.equal(await empty.locator('[data-next-back]').getAttribute('href'), '#/~hub/needs/unstick');
  assert.equal(await reduced.locator('.hub-chip.on').getAttribute('data-filter'), 'unstick');

  step('Snooze counts as settled: from a deep link the next item opens');
  const q4 = askJson({ id: askId('fourth', 'q4q4'), now: new Date(nowMs - 1 * 60000), question: 'Question four?' });
  second.seed.ask(q3);
  second.seed.ask(q4);
  await go(reduced, `#/~hub/ask/${q4.id}`);
  await reduced.getByRole('button', { name: 'Snooze a day' }).waitFor();
  await reduced.getByRole('button', { name: 'Snooze a day' }).click();
  await reduced.locator('[data-next-note]', { hasText: 'Snoozed · next: Question three?' }).waitFor();
  assert.equal(await reduced.evaluate(() => location.hash), `#/~hub/ask/${q3.id}`);

  step('phone: the note fits at 375 px, Back is 44 px tall, nothing scrolls sideways, the note is above the tab bar');
  const phone2 = await open({ width: 375, height: 812 }, { hasTouch: true, isMobile: true, reducedMotion: 'reduce' });
  second.seed.ask(askJson({ id: askId('p-one', 'p1p1'), now: new Date(nowMs - 4 * 60000), question: 'A phone question with a title long enough to need clipping on a narrow screen, really quite long indeed?' }));
  second.seed.ask(askJson({ id: askId('p-two', 'p2p2'), now: new Date(nowMs - 3 * 60000), question: 'Phone question two?' }));
  await phone2.goto(`${second.url}#/~hub/needs/question`);
  await phone2.locator('.ni').nth(2).waitFor();
  const target = phone2.locator('.ni').first();
  await target.locator('textarea').fill('ok');
  await target.getByRole('button', { name: 'Send answer' }).tap();
  const phoneNote = phone2.locator('[data-next-note]');
  await phoneNote.waitFor();
  await phone2.waitForTimeout(400);
  const back = await phoneNote.locator('[data-next-back]').boundingBox();
  assert.ok(back && back.height >= 44, `Back is ${back?.height} px tall.`);
  const box = await phoneNote.boundingBox();
  const bar = await phone2.locator('nav.hub-tabs').boundingBox();
  assert.ok(box && box.y >= 0 && box.y + box.height <= (bar?.y ?? 812), 'The note is on screen and above the phone bar.');
  assert.ok(back.x + back.width <= 375, 'Back is not pushed off screen.');
  assert.ok(await phoneNote.locator('.nq-next-text').evaluate(node => node.getBoundingClientRect().height < 70), 'The note is at most two lines.');
  await noSideways(phone2, 'the next-item note at 375 px');

  // ---- Design reviews: a third fixture with one review (picture and three decisions) and one pick (three pictures). ----
  third = await startHubFixture({ seedData: false });
  const review = designAskJson({ id: askId('design', 'g1g1'), now: new Date(nowMs - 10 * 60000) });
  const pick = askJson({ id: askId('pick', 'k1k1'), now: new Date(nowMs - 5 * 60000), question: 'Which card back?', options: threeOptions(), allowDrawing: true });
  third.seed.ask(review);
  third.seed.ask(pick);
  const stroke = async target => {
    const canvas = target.locator('.drawing-editor canvas.interactive');
    await canvas.waitFor();
    await target.waitForTimeout(700);
    const box = await canvas.boundingBox();
    await target.locator('.drawing-editor label[title^="Draw"]').click();
    await target.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.5);
    await target.mouse.down();
    await target.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.55, { steps: 6 });
    await target.mouse.move(box.x + box.width * 0.65, box.y + box.height * 0.45, { steps: 6 });
    await target.mouse.up();
  };

  step('design review: its own chip and kind, the four cells, the picture at the left and a verdict control per decision');
  const designPage = await open({ width: 1280, height: 800 }, { reducedMotion: 'reduce' });
  await designPage.goto(`${third.url}#/~hub/needs`);
  await designPage.locator('.ni[data-kind="design"]').first().waitFor();
  assert.deepEqual(await chips(designPage), [['all', '2'], ['design', '2'], ['answered', null]]);
  const card1 = designPage.locator(`.ni[data-need="ask-${review.id}"]`);
  assert.equal(await card1.getAttribute('data-kind'), 'design');
  assert.deepEqual(await card1.locator('.four dd').allInnerTexts(), ['3 decisions on one design', 'Waiting for your review', 'Approve, change or skip each one', 'Your review']);
  assert.match(await card1.locator('.ni-meta').innerText(), /^Design review/);
  await card1.locator('[data-design-image] img').waitFor();
  const sides = await card1.evaluate(node => ({ pic: node.querySelector('.dr-pic').getBoundingClientRect(), side: node.querySelector('.dr-side').getBoundingClientRect() }));
  assert.ok(sides.pic.right <= sides.side.left + 1 && sides.pic.width <= 291, 'The picture is at the left, at most 290 px wide.');
  assert.equal(await card1.locator('[data-decision]').count(), 3);
  assert.equal(await card1.locator('[data-decision="d2"] .dr-detail').innerText(), 'Matches the Wood board');
  assert.equal(await card1.locator('[data-decision="d1"] [role="group"]').count(), 1);

  step('design review: Send review stays off until every decision has a verdict; Change shows its note box; Annotate attaches a drawing, Clear drops it');
  const send = card1.getByRole('button', { name: 'Send review' });
  assert.equal(await send.isDisabled(), true);
  await card1.locator('[data-decision="d1"] [data-verdict-btn="approve"]').click();
  assert.equal(await card1.locator('[data-decision="d1"] [data-verdict-btn="approve"]').getAttribute('aria-pressed'), 'true');
  assert.equal(await card1.locator('[data-decision="d1"] [data-verdict-btn="skip"]').getAttribute('aria-pressed'), 'false');
  assert.equal(await card1.locator('.dr-note').count(), 0, 'No note box until Change.');
  await card1.locator('[data-decision="d2"] [data-verdict-btn="change"]').click();
  await card1.locator('[data-decision="d2"] .dr-note').fill('Bottom-left');
  assert.equal(await send.isDisabled(), true, 'Two of three is not enough.');
  await card1.locator('[data-decision="d3"] [data-verdict-btn="skip"]').click();
  assert.equal(await send.isDisabled(), false);
  await card1.locator('[data-annotate]').click();
  await stroke(designPage);
  await designPage.locator('.drawing-bar button', { hasText: /^Done$/ }).click();
  await card1.locator('[data-attached]').waitFor();
  await card1.locator('[data-clear-drawing]').click();
  assert.equal(await card1.locator('[data-attached]').count(), 0, 'Clear drops the drawing.');
  await card1.locator('[data-annotate]').click();
  await stroke(designPage);
  await designPage.locator('.drawing-bar button', { hasText: /^Done$/ }).click();
  await card1.locator('[data-attached]').waitFor();
  await card1.locator('textarea').fill('Close. Fix the corner.');

  step('design review: sending stores the three verdicts, the change note, the summary and the drawing; the note says "Review sent"');
  await send.click();
  await card1.waitFor({ state: 'detached' });
  const stored = third.fake.json(`sections/inbox/asks/${review.id}/answer.json`);
  assert.deepEqual(stored.decisions, { d1: { verdict: 'approve' }, d2: { verdict: 'change', note: 'Bottom-left' }, d3: { verdict: 'skip' } });
  assert.equal(stored.note, 'Close. Fix the corner.');
  assert.deepEqual(stored.drawing, { excalidraw: 'answer.excalidraw', png: 'answer.png' });
  const scene = third.fake.json(`sections/inbox/asks/${review.id}/answer.excalidraw`);
  assert.ok(scene.elements.some(element => element.type === 'image') && scene.elements.some(element => element.type === 'freedraw'), 'The picture is the background of the drawing.');
  await designPage.locator('[data-next-note]', { hasText: 'Review sent · next: Which card back?' }).waitFor();
  await designPage.locator('[data-next-back]').click();
  await designPage.locator('[data-decisions-answer]').waitFor();
  assert.match(await designPage.locator('[data-decisions-answer]').innerText(), /Approve · Frame: warm oak[\s\S]*Change · Stack counter[^\n]*\(Bottom-left\)[\s\S]*Skip · Drop the gold/);

  step('design review, pick: a 2 by 2 grid labelled by letter, Send pick stays off until one is chosen');
  await go(designPage, '#/~hub/needs/design');
  const card2 = designPage.locator(`.ni[data-need="ask-${pick.id}"]`);
  await card2.locator('.hub-options.pick').waitFor();
  assert.deepEqual(await card2.locator('.four dd').allInnerTexts(), ['3 takes to pick from', 'Waiting for your review', 'Pick one, or draw on them', 'Your review']);
  const grid = await card2.locator('.hub-option').evaluateAll(list => list.map(item => { const box = item.getBoundingClientRect(); return [Math.round(box.left), Math.round(box.top)]; }));
  assert.equal(grid[0][1], grid[1][1], 'A and B share a row.');
  assert.ok(grid[2][1] > grid[0][1] && grid[2][0] === grid[0][0], 'C starts the second row.');
  assert.deepEqual(await card2.locator('.hub-option-label b').allTextContents(), ['A', 'B', 'C']);
  const pickSend = card2.getByRole('button', { name: 'Send pick' });
  assert.equal(await pickSend.isDisabled(), true);
  await card2.locator('[data-option="C"] .hub-option-pick').click();
  assert.equal(await card2.locator('[data-option="C"] .dr-use').innerText(), 'Chosen');
  await pickSend.click();
  await card2.waitFor({ state: 'detached' });
  assert.equal(third.fake.json(`sections/inbox/asks/${pick.id}/answer.json`).choice, 'C');
  assert.equal(third.fake.json(`sections/inbox/asks/${pick.id}/answer.json`).decisions, undefined);

  step('design review at 375 px: one column, targets of 44 px, no sideways scroll, both variants');
  const review2 = designAskJson({ id: askId('design2', 'g2g2'), now: new Date(nowMs - 3 * 60000), question: 'Review the second frame' });
  const pick2 = askJson({ id: askId('pick2', 'k2k2'), now: new Date(nowMs - 2 * 60000), question: 'Which back, round two?', options: threeOptions(), allowDrawing: true });
  third.seed.ask(review2);
  third.seed.ask(pick2);
  const small = await open({ width: 375, height: 812 }, { hasTouch: true, isMobile: true, reducedMotion: 'reduce' });
  await small.goto(`${third.url}#/~hub/needs/design`);
  await small.locator(`.ni[data-need="ask-${review2.id}"] [data-design-image] img`).waitFor();
  await small.locator(`.ni[data-need="ask-${pick2.id}"] .hub-options.pick img`).first().waitFor();
  await small.waitForTimeout(300);
  await noSideways(small, 'design reviews at 375 px');
  const phoneCard = small.locator(`.ni[data-need="ask-${review2.id}"]`);
  const stack = await phoneCard.evaluate(node => ({ pic: node.querySelector('.dr-pic').getBoundingClientRect(), side: node.querySelector('.dr-side').getBoundingClientRect() }));
  assert.ok(stack.side.top >= stack.pic.bottom - 1, 'The decisions sit under the picture.');
  await tall(phoneCard.locator('.dr-pill'), 'verdict buttons');
  await tall(phoneCard.locator('[data-annotate]'), 'Annotate');
  await tall(small.locator(`.ni[data-need="ask-${pick2.id}"] .hub-option-pick`), 'pick options');
  await phoneCard.locator('[data-decision="d1"] [data-verdict-btn="change"]').tap();
  await tall(phoneCard.locator('.dr-note'), 'the change note');
  await noSideways(small, 'a Change note at 375 px');
  const pills = await phoneCard.locator('[data-decision="d1"] .dr-seg').boundingBox();
  assert.ok(pills && pills.x >= 0 && pills.x + pills.width <= 375, 'The three buttons fit the width.');

  // ---- The end of a chip: a fifth fixture with one Design review and one Question. ----
  fifth = await startHubFixture({ seedData: false });
  const lone = designAskJson({ id: askId('lone', 'l1l1'), now: new Date(nowMs - 8 * 60000), question: 'Review the lone frame' });
  const left = askJson({ id: askId('left', 'l2l2'), now: new Date(nowMs - 4 * 60000), question: 'Which one is left?', options: plainOptions() });
  fifth.seed.ask(lone);
  fifth.seed.ask(left);
  const endPage = await open({ width: 375, height: 812 }, { hasTouch: true, isMobile: true, reducedMotion: 'reduce' });

  step('the last item of a chip: the note says no more of that kind, how many wait in All, and links to All; it never says "Nothing else waits"');
  await endPage.goto(`${fifth.url}#/~hub/needs/design`);
  const loneCard = endPage.locator(`.ni[data-need="ask-${lone.id}"]`);
  await loneCard.waitFor();
  for (const id of ['d1', 'd2', 'd3']) await loneCard.locator(`[data-decision="${id}"] [data-verdict-btn="approve"]`).tap();
  await loneCard.getByRole('button', { name: 'Send review' }).tap();
  const endNote = endPage.locator('[data-next-note]');
  await endNote.waitFor();
  const endText = await endNote.innerText();
  assert.match(endText, /Review sent\./);
  assert.match(endText, /No more design reviews\./);
  assert.match(endText, /1 more wait in All/);
  assert.doesNotMatch(endText, /Nothing else waits/);
  assert.equal(await endNote.locator('[data-next-all]').getAttribute('href'), '#/~hub/needs');
  await endPage.locator('.needs-empty', { hasText: 'No design review waits on you.' }).waitFor();
  assert.equal(await endPage.locator('.hub-chip[data-filter="all"] .n').textContent(), '1', 'The All chip counts what All lists next.');
  await noSideways(endPage, 'the end-of-chip note at 375 px');
  await endNote.locator('[data-next-all]').tap();
  await endPage.locator('.hub-chip.on[data-filter="all"]').waitFor();
  await endPage.locator('.ni').first().waitFor();
  assert.equal(await endPage.locator('.ni').count(), 1, 'All lists the one question the note counted.');
  assert.equal(await endPage.locator('[data-next-note]').count(), 0, 'The note belongs to the chip it was left on.');
  const leftCard = endPage.locator(`.ni[data-need="ask-${left.id}"]`);
  await leftCard.locator('[data-option="B"] .hub-option-pick').tap();
  await leftCard.getByRole('button', { name: 'Send answer' }).tap();
  await endPage.locator('[data-next-note]', { hasText: 'Nothing else waits on you.' }).waitFor();
  assert.equal(await endPage.locator('[data-next-all]').count(), 0, 'With the whole queue empty there is nothing to link to.');

  // ---- Playtests: a fourth fixture with one playtest checklist. ----
  fourth = await startHubFixture({ seedData: false });
  const play = playtestJson({ id: askId('play', 'y1y1'), now: new Date(nowMs - 10 * 60000), platform: 'windows', build: 'https://example.test/build/win' });
  fourth.seed.checklist(play);
  const playPage = await open({ width: 1280, height: 800 }, { reducedMotion: 'reduce' });

  step('playtest: its own chip and kind, the four cells, the build link, what to try and what to look for');
  await playPage.goto(`${fourth.url}#/~hub/needs`);
  const pcard = playPage.locator(`.ni[data-need="checklist-${play.id}"]`);
  await pcard.waitFor();
  assert.equal(await pcard.getAttribute('data-kind'), 'playtest');
  assert.deepEqual(await chips(playPage), [['all', '1'], ['playtest', '1'], ['answered', null]]);
  assert.deepEqual(await pcard.locator('.four dd').allInnerTexts(), ['A build to play on windows', 'Build is live', 'Play it, rate it, list issues', 'Your verdict']);
  const open1 = pcard.locator('[data-open-build]');
  assert.equal(await open1.getAttribute('href'), 'https://example.test/build/win');
  assert.equal(await open1.getAttribute('target'), '_blank');
  assert.match(await open1.getAttribute('rel'), /noopener/);
  assert.match(await open1.innerText(), /Open build · windows/);
  assert.match(await pcard.locator('[data-look-for]').innerText(), /Any moment where it gets hard all at once\./);
  assert.equal(await pcard.locator('[data-item]').count(), 3, 'The steps to try are ticks.');
  assert.equal(await pcard.locator('[data-attach]').count(), 0, 'Steps of a playtest take no evidence picture.');
  await pcard.locator('[data-item="01"] [data-box]').click();
  await pcard.locator('[data-item="01"][data-done="true"]').waitFor();

  step('playtest: Send report stays off until a rating and a verdict; an issue takes a screenshot; the report is stored and the card leaves');
  const report = pcard.getByRole('button', { name: 'Send report' });
  assert.equal(await report.isDisabled(), true);
  await pcard.locator('[data-star="4"]').click();
  assert.equal(await pcard.locator('[data-star="4"]').getAttribute('aria-pressed'), 'true');
  assert.equal(await report.isDisabled(), true, 'A rating alone is not enough.');
  await pcard.locator('[data-issue-input]').fill('Goop builds up off-screen');
  await pcard.locator('[data-shot-input]').setInputFiles({ name: 'goop.png', mimeType: 'image/png', buffer: solidPng(64, 48) });
  await pcard.locator('[data-pending-shot]').waitFor();
  assert.equal([...fourth.fake.objects.keys()].filter(key => key.startsWith(`sections/inbox/checklists/${play.id}/shot-`)).length, 1, 'One screenshot is stored.');
  await pcard.locator('[data-add-issue]').click();
  await pcard.locator('[data-issue] [data-issue-shot] img').waitFor();
  step('playtest: pasting while a step has focus only says what to do; with the issue box focused it becomes the next screenshot');
  await pcard.locator('[data-item="01"] [data-box]').focus();
  await pasteImage(playPage);
  await pcard.locator('[data-paste-hint]', { hasText: 'Paste a screenshot while writing an issue.' }).waitFor();
  assert.equal([...fourth.fake.objects.keys()].filter(key => key.startsWith(`sections/inbox/checklists/${play.id}/shot-`)).length, 1, 'Nothing new was stored.');
  await pcard.locator('[data-issue-input]').fill('Jump feels floaty');
  await pcard.locator('[data-issue-input]').focus();
  await pasteImage(playPage);
  await pcard.locator('[data-pending-shot]').waitFor();
  assert.equal([...fourth.fake.objects.keys()].filter(key => key.startsWith(`sections/inbox/checklists/${play.id}/shot-`)).length, 2, 'The pasted screenshot is stored.');
  await pcard.locator('[data-add-issue]').click();
  assert.equal(await pcard.locator('[data-issue]').count(), 2);
  await pcard.locator('[data-verdict-btn="fix-first"]').click();
  assert.equal(await report.isDisabled(), false);
  await report.click();
  await pcard.waitFor({ state: 'detached' });
  const sentReport = fourth.fake.json(`sections/inbox/checklists/${play.id}/submit.json`);
  assert.equal(sentReport.rating, 4);
  assert.equal(sentReport.verdict, 'fix-first');
  assert.equal(sentReport.issues.length, 2);
  assert.match(sentReport.issues[0].shot, /^shot-\d{8}T\d{9}Z-[a-z0-9]{4}\.png$/);
  assert.match(sentReport.issues[1].shot, /^shot-\d{8}T\d{9}Z-[a-z0-9]{4}\.png$/, 'The pasted screenshot went with the second issue.');
  assert.deepEqual(sentReport.done, ['01']);
  await playPage.locator('[data-next-note]', { hasText: 'Report sent' }).waitFor();
  await playPage.locator('[data-next-back]').click();
  await playPage.locator('[data-report-summary]').waitFor();
  assert.match(await playPage.locator('[data-report-summary]').innerText(), /Rating 4\/5 · Fix first · 2 issues/);

  step('playtest at 375 px: one column, stars and verdict at 44 px, no sideways scroll');
  const play2 = playtestJson({ id: askId('play2', 'y2y2'), now: new Date(nowMs - 5 * 60000), title: 'A second build' });
  fourth.seed.checklist(play2);
  const ptPhone = await open({ width: 375, height: 812 }, { hasTouch: true, isMobile: true, reducedMotion: 'reduce' });
  await ptPhone.goto(`${fourth.url}#/~hub/checklist/${play2.id}`);
  await ptPhone.locator('[data-playtest-report]').waitFor();
  await ptPhone.waitForTimeout(300);
  await noSideways(ptPhone, 'a playtest at 375 px');
  await tall(ptPhone.locator('.pt-star'), 'stars');
  await tall(ptPhone.locator('.pt-verdict .dr-pill'), 'verdict buttons');
  await tall(ptPhone.locator('[data-open-build]'), 'Open build');
  await ptPhone.locator('[data-issue-input]').fill('A long issue text that has to wrap on a narrow phone screen without pushing anything sideways at all');
  await ptPhone.locator('[data-add-issue]').tap();
  await noSideways(ptPhone, 'a playtest issue at 375 px');
  const col = await ptPhone.evaluate(() => ({ left: document.querySelector('.pt-left').getBoundingClientRect(), right: document.querySelector('.pt-right').getBoundingClientRect() }));
  assert.ok(col.right.top >= col.left.bottom - 1, 'The report sits under the steps.');
} finally {
  for (const context of contexts) await context.close().catch(() => {});
  await browser.close();
  await fixture.close();
  await second?.close();
  await third?.close();
  await fourth?.close();
  await fifth?.close();
  await sixth?.close();
}
console.log('hub-needs-ui: passed');
