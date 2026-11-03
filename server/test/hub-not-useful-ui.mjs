// Run after npm run build. "Not useful" on the Needs you list through a real browser, over the fixture service (every kind of
// item, from needs-kinds-seed): the button is on an Ask, a list, a pull request review and a blocked session and on no approval; the
// panel with four reasons and a line; one tap on a reason files it, the card leaves with the note "Marked not useful", the record and
// the event are in the bucket; Send files the typed line; Cancel and Escape close it with no write and give focus back to the
// button; a read-only copy shows the sign-in note and sends nothing; 40 px targets and no sideways scroll at 390 px.
// The bucket is the fixture's own; nothing real is read or written.
import { chromium } from '@playwright/test';
import { ms } from './ui-timeouts.mjs';
import assert from 'node:assert/strict';
import { startHubFixture } from './hub-fixture.mjs';
import { TITLES, seedMixed } from './needs-kinds-seed.mjs';

const step = name => console.log(`- ${name}`);
const channel = process.env.BUW_TEST_BROWSER || 'msedge';

const fixture = await startHubFixture({ seedData: false });
const ids = seedMixed(fixture);
const browser = await chromium.launch({ headless: true, channel });
const contexts = [];
const open = async (viewport, options = {}) => {
  const context = await browser.newContext({ viewport, serviceWorkers: 'block', reducedMotion: 'reduce', ...options });
  contexts.push(context);
  const page = await context.newPage();
  page.setDefaultTimeout(ms(15000));
  page.on('pageerror', error => { throw error; });
  return page;
};
const noSideways = async (page, what) => {
  const widths = await page.evaluate(() => ({ scroll: document.scrollingElement.scrollWidth, inner: innerWidth, hub: document.querySelector('.hub')?.scrollWidth ?? 0, hubInner: document.querySelector('.hub')?.clientWidth ?? 0 }));
  assert.ok(widths.scroll <= widths.inner, `${what}: the page scrolls sideways (${widths.scroll} > ${widths.inner}).`);
  assert.ok(widths.hub <= widths.hubInner, `${what}: the Hub scrolls sideways (${widths.hub} > ${widths.hubInner}).`);
};
const keys = prefix => [...fixture.fake.objects.keys()].filter(key => key.startsWith(prefix));
const eventually = async (check, limit = ms(15000)) => {
  const end = Date.now() + limit;
  for (;;) {
    try { return check(); } catch (error) {
      if (Date.now() > end) throw error;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
};
const records = () => keys('sections/inbox/feedback/').filter(key => key.endsWith('/not-useful.json'));
const eventsOf = kind => keys('sections/inbox/events/').map(key => fixture.fake.json(key)).filter(event => event?.kind === kind);
const PRESET_LABELS = ['Nothing to decide', 'Too long', 'Unclear what to do', 'Already done'];

try {
  const page = await open({ width: 1280, height: 900 });
  const row = title => page.locator('.ni', { has: page.locator('.ni-t', { hasText: title }) });
  await page.goto(`${fixture.url}#/~hub/needs`);
  await page.waitForFunction(count => document.querySelectorAll('.ni').length === count, 17);

  step('the button is on an Ask, a list, a pull request review and a blocked session, and on no approval');
  for (const title of [TITLES.askVerify, TITLES.stepsVerify, TITLES.designReview, TITLES.playtest, TITLES.review, TITLES.blocked]) {
    assert.equal(await row(title).locator('[data-not-useful]').count(), 1, title);
  }
  for (const title of [TITLES.request, TITLES.hermesAsks]) assert.equal(await row(title).locator('[data-not-useful]').count(), 0, `${title}: keeps Decline or its answer`);
  assert.equal(await page.locator('[data-not-useful]').count(), 15, 'fifteen of the seventeen rows');

  step('the panel: four reasons, a line, Send and Cancel; 40 px targets; nothing is written by opening it');
  const review = row(TITLES.review);
  await review.locator('[data-not-useful]').click();
  const panel = review.locator('[data-not-useful-panel]');
  await panel.waitFor();
  assert.equal(await panel.getAttribute('role'), 'group');
  assert.equal(await panel.getAttribute('aria-label'), 'Why is this not useful?');
  assert.deepEqual(await panel.locator('[data-preset]').allInnerTexts(), PRESET_LABELS);
  assert.deepEqual(await panel.locator('[data-preset]').evaluateAll(list => list.map(item => item.getAttribute('data-preset'))), ['nothing-to-decide', 'too-long', 'unclear', 'already-done']);
  assert.equal(await panel.locator('input').getAttribute('placeholder'), 'Or say why (optional)');
  assert.equal(await panel.locator('input').getAttribute('maxlength'), '200');
  for (const target of await panel.locator('button, input').all()) {
    const box = await target.boundingBox();
    assert.ok(box && box.height >= 40, `a target is ${box?.height} px tall`);
  }
  assert.deepEqual(records(), []);

  step('Cancel and Escape close the panel with no write and return focus to the button');
  await panel.getByRole('button', { name: 'Cancel' }).click();
  await panel.waitFor({ state: 'detached' });
  assert.equal(await review.locator('[data-not-useful]').evaluate(node => node === document.activeElement), true, 'focus is back on the button after Cancel');
  await review.locator('[data-not-useful]').click();
  await panel.waitFor();
  await panel.locator('input').fill('half a thought');
  await page.keyboard.press('Escape');
  await panel.waitFor({ state: 'detached' });
  assert.equal(await review.locator('[data-not-useful]').evaluate(node => node === document.activeElement), true, 'focus is back on the button after Escape');
  assert.deepEqual(records(), []);
  assert.deepEqual(eventsOf('not-useful'), []);

  step('one tap on a reason files it: the card leaves, the note says so, the record and the event are in the bucket');
  await review.locator('[data-not-useful]').click();
  await panel.locator('[data-preset="too-long"]').click();
  await page.locator('.ni', { has: page.locator('.ni-t', { hasText: TITLES.review }) }).waitFor({ state: 'detached' });
  await page.locator('[data-next-note]', { hasText: 'Marked not useful' }).waitFor();
  const [reviewRecord] = await eventually(() => { const list = records(); assert.equal(list.length, 1); return list; });
  const body = fixture.fake.json(reviewRecord);
  assert.match(reviewRecord, /\/feedback\/bunnylink\/review\/[^/]+\/not-useful\.json$/);
  assert.deepEqual([body.project, body.item.kind, body.reason, body.reasonText, body.by, body.source.by], ['bunnylink', 'review', { preset: 'too-long' }, 'Too long', 'local', 'agent']);
  assert.equal(body.copy.row.title, TITLES.review);
  const filedEvent = await eventually(() => { const list = eventsOf('not-useful'); assert.equal(list.length, 1); return list[0]; });
  assert.deepEqual([filedEvent.title, filedEvent.reason, filedEvent.project, filedEvent.key], [`Not useful: ${TITLES.review}`, 'Too long', 'bunnylink', body.key]);
  assert.equal(eventsOf('review-done').length, 1, 'the review closed the way Mark done closes it');

  step('a typed line files with Send; a blocked session is closed too');
  const blocked = row(TITLES.blocked);
  await blocked.locator('[data-not-useful]').click();
  await blocked.locator('[data-not-useful-note]').fill('Claude just wanted a permission');
  await blocked.getByRole('button', { name: 'Send' }).click();
  await row(TITLES.blocked).waitFor({ state: 'detached' });
  const blockedRecord = await eventually(() => { const list = records().filter(key => key.includes('/blocked/')); assert.equal(list.length, 1); return fixture.fake.json(list[0]); });
  assert.deepEqual([blockedRecord.reason, blockedRecord.reasonText, blockedRecord.source.by, blockedRecord.project], [{ note: 'Claude just wanted a permission' }, 'Claude just wanted a permission', 'session', 'sprite-studio']);

  step('an Ask is cancelled, so the agent that waits sees it; a list is cancelled too');
  const ask = row(TITLES.askVerify);
  await ask.locator('[data-not-useful]').click();
  await ask.locator('[data-preset="nothing-to-decide"]').click();
  await row(TITLES.askVerify).waitFor({ state: 'detached' });
  await eventually(() => assert.ok(fixture.fake.json(`sections/inbox/asks/${ids.askVerify}/cancel.json`)));
  const list = row(TITLES.stepsVerify);
  await list.locator('[data-not-useful]').click();
  await list.locator('[data-preset="already-done"]').click();
  await row(TITLES.stepsVerify).waitFor({ state: 'detached' });
  await eventually(() => assert.equal(fixture.fake.json(`sections/inbox/checklists/${ids.stepsVerify}/cancel.json`).notUseful, true));
  assert.equal(records().length, 4);
  assert.equal(eventsOf('not-useful').length, 4);
  await page.waitForFunction(count => document.querySelectorAll('.ni').length === count, 13);

  step('a read-only copy shows the sign-in note and sends nothing');
  const guest = await open({ width: 1280, height: 900 });
  const writes = [];
  guest.on('request', request => { if (request.method() === 'POST') writes.push(request.url()); });
  await guest.route('**/api/capabilities', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ write: false, create: false, cards: false, hub: true, chat: false, reason: 'Read-only here.' }) }));
  await guest.goto(`${fixture.url}#/~hub/needs`);
  const guestCard = guest.locator('.ni', { has: guest.locator('.ni-t', { hasText: TITLES.designReview }) });
  await guestCard.locator('[data-not-useful]').waitFor();
  assert.equal(await guestCard.locator('[data-readonly-note]', { hasText: 'Sign in to mark this.' }).count(), 0, 'quiet until someone taps');
  await guestCard.locator('[data-not-useful]').click({ force: true });
  await guestCard.locator('[data-readonly-note]', { hasText: 'Sign in to mark this.' }).waitFor();
  assert.equal(await guestCard.locator('[data-not-useful-panel]').count(), 0);
  assert.deepEqual(writes, []);
  assert.equal(records().length, 4);

  step('at 390 px: the button and the open panel fit, targets are 40 px, two taps file a list');
  const phone = await open({ width: 390, height: 844 }, { hasTouch: true, isMobile: true });
  await phone.goto(`${fixture.url}#/~hub/needs`);
  const phoneRow = title => phone.locator('.ni', { has: phone.locator('.ni-t', { hasText: title }) });
  await phoneRow(TITLES.playtest).locator('[data-not-useful]').waitFor();
  assert.ok(await phoneRow(TITLES.playtest).locator('[data-not-useful]').innerText().then(text => text.trim() === 'Not useful'), 'the label shows at phone width');
  await noSideways(phone, 'the list at 390 px');
  const shown = phoneRow(TITLES.designReview);
  await shown.locator('[data-not-useful]').tap();
  await shown.locator('[data-not-useful-panel]').waitFor();
  for (const target of await shown.locator('[data-not-useful-panel] button, [data-not-useful-panel] input').all()) {
    const box = await target.boundingBox();
    assert.ok(box && box.height >= 40, `a phone target is ${box?.height} px tall`);
  }
  await noSideways(phone, 'the open panel at 390 px');
  await shown.locator('[data-preset="unclear"]').tap();
  await phoneRow(TITLES.designReview).waitFor({ state: 'detached' });
  await phone.locator('[data-next-note]', { hasText: 'Marked not useful' }).waitFor();
  await eventually(() => assert.equal(records().length, 5));
  assert.equal(fixture.fake.json(records().find(key => key.includes(ids.designReview))).reason.preset, 'unclear');
} finally {
  for (const context of contexts) await context.close().catch(() => {});
  await browser.close();
  await fixture.close();
}
console.log('hub-not-useful-ui: passed');
