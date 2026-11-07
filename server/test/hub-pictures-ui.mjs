// Run after npm run build. Pictures on inbox items through a real browser, over the fixture service (fake bucket, never the real inbox):
// an Ask answered with pictures (pick, preview, remove, add again, the words for each failure, Retry, paste, reload, send), the same
// button and tray on a checklist's note, and the same picker markup at 1280 and 375 px with touch (44 px, no sideways scroll, no `capture`).
import { chromium } from '@playwright/test';
import { ms } from './ui-timeouts.mjs';
import assert from 'node:assert/strict';
import { FIXTURE_ASK, FIXTURE_CHECKLIST, askId, startHubFixture } from './hub-fixture.mjs';
import { askJson, seeder } from '../../site/api/test/hub-fixtures.mjs';
import { solidPng } from '../../site/api/test/png.mjs';

const step = name => console.log(`- ${name}`);
const channel = process.env.BUW_TEST_BROWSER || 'msedge';
const PLAIN = askId('plain', 'p9p9');
const PASTE = askId('paste', 'q8q8');

const fixture = await startHubFixture({ checklists: true });
seeder(fixture.fake).ask(askJson({ id: PLAIN, now: new Date(Date.now() - 5 * 60_000), question: 'Anything to add?', allowDrawing: false }));
seeder(fixture.fake).ask(askJson({ id: PASTE, now: new Date(Date.now() - 6 * 60_000), question: 'Paste a screenshot here?', allowDrawing: false }));
const browser = await chromium.launch({ headless: true, channel });
const contexts = [];
const open = async (viewport, options = {}) => {
  const context = await browser.newContext({ viewport, serviceWorkers: 'block', ...options });
  await context.addInitScript(() => { try { localStorage.setItem('hub.undoMs', '0'); } catch { /* no storage */ } });
  contexts.push(context);
  const page = await context.newPage();
  page.setDefaultTimeout(ms(15000));
  page.on('pageerror', error => { throw error; });
  return page;
};
const go = async (page, hash) => { await page.evaluate(value => { location.hash = value; }, hash); };
const eventually = async check => {
  const deadline = Date.now() + ms(10000);
  for (;;) {
    try { return check(); } catch (error) { if (Date.now() > deadline) throw error; await new Promise(resolve => setTimeout(resolve, 100)); }
  }
};
const picture = (name = 'photo.png') => ({ name, mimeType: 'image/png', buffer: solidPng(64, 48) });
const stored = (folder, id, pattern) => [...fixture.fake.objects.keys()].filter(key => key.startsWith(`sections/inbox/${folder}/${id}/`) && pattern.test(key.split('/').pop()));
const ANSWER_PIC = /^answer\.pic-/;
const NOTE_PIC = /^shot-note-/;

try {
  const page = await open({ width: 1280, height: 900 });
  await page.goto(`${fixture.url}#/~hub/needs`);
  const card = page.locator(`.ni[data-need="ask-${PLAIN}"]`);
  await card.waitFor();

  step('the picker has no capture and explicit types, and a note on an Ask shows the button');
  const input = card.locator('[data-ask-pictures] [data-attach-input]');
  assert.equal(await input.getAttribute('capture'), null);
  assert.ok((await input.getAttribute('accept')).split(',').includes('image/jpeg'));
  assert.equal(await card.locator('[data-ask-pictures] [data-pic-button]').count(), 1);

  step('pick a picture: a preview, saved in the Ask\'s folder at once, and removing it deletes the file');
  await input.setInputFiles(picture());
  await card.locator('[data-tray] .hub-tray-item[data-state="ready"]').waitFor();
  await eventually(() => assert.equal(stored('asks', PLAIN, ANSWER_PIC).length, 1));
  await card.getByRole('button', { name: 'Remove picture 1' }).click();
  await eventually(() => assert.equal(stored('asks', PLAIN, ANSWER_PIC).length, 0));
  assert.equal(await card.locator('[data-tray] .hub-tray-item').count(), 0);

  step('the words for each failure: not a picture, too many, and a failed save with Retry');
  await input.setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('not a picture') });
  await card.locator('[data-tray]', { hasText: 'Only pictures can be attached.' }).waitFor();
  await input.setInputFiles(Array.from({ length: 5 }, (_, index) => picture(`many-${index}.png`)));
  await card.locator('[data-tray]', { hasText: 'An answer takes at most 4 pictures.' }).waitFor();
  await card.locator('.hub-tray-item[data-state="ready"]').nth(3).waitFor();
  assert.equal(await card.locator('.hub-tray-item').count(), 4);
  assert.equal(stored('asks', PLAIN, ANSWER_PIC).length, 4);
  for (let at = 0; at < 4; at += 1) await card.getByRole('button', { name: 'Remove picture 1' }).click();
  await eventually(() => assert.equal(stored('asks', PLAIN, ANSWER_PIC).length, 0));
  await page.route('**/api/hub/asks/*/files', route => route.abort());
  await input.setInputFiles(picture());
  await card.locator('[data-tray]', { hasText: "The picture didn't save. Check the connection, then tap Retry." }).waitFor();
  assert.equal(await card.getByRole('button', { name: 'Send answer' }).isDisabled(), true, 'Send stays off while a picture has not saved.');
  await page.unroute('**/api/hub/asks/*/files');
  await card.locator('[data-retry]').click();
  await card.locator('.hub-tray-item[data-state="ready"]').waitFor();
  assert.equal(await card.getByRole('button', { name: 'Send answer' }).isDisabled(), false, 'A picture alone answers an Ask with no options.');

  step('a reload keeps a saved picture: the Hub lists it');
  await page.reload();
  const again = page.locator(`.ni[data-need="ask-${PLAIN}"]`);
  await again.locator('[data-tray] .hub-tray-item').waitFor();
  assert.equal(await again.locator('.hub-tray-item').count(), 1);
  await again.locator('.hub-tray-item img').waitFor();

  step('send: the answer names exactly the kept pictures, and no big-picture prompt appears');
  await again.locator('textarea').fill('see the screenshot');
  await again.getByRole('button', { name: 'Send answer' }).click();
  await again.waitFor({ state: 'detached' });
  await eventually(() => assert.ok(fixture.fake.objects.has(`sections/inbox/asks/${PLAIN}/answer.json`)));
  const [kept] = stored('asks', PLAIN, ANSWER_PIC);
  assert.deepEqual(fixture.fake.json(`sections/inbox/asks/${PLAIN}/answer.json`).pictures, [kept.split('/').pop()]);
  assert.equal(await page.locator('[data-big-confirm]').count(), 0);

  step('paste on a desktop: a picture on the clipboard goes to the note it was pasted in');
  const pasteCard = page.locator(`.ni[data-need="ask-${PASTE}"]`);
  await pasteCard.waitFor();
  await pasteCard.locator('textarea').evaluate((node, bytes) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array(bytes)], 'shot.png', { type: 'image/png' }));
    node.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
  }, [...solidPng(32, 24)]);
  await pasteCard.locator('.hub-tray-item[data-state="ready"]').waitFor();
  await eventually(() => assert.equal(stored('asks', PASTE, ANSWER_PIC).length, 1));
  assert.equal(await page.locator(`.ni[data-need="ask-${FIXTURE_ASK}"] .hub-tray-item`).count(), 0, 'Only that card took it.');

  step('the same button and tray on a checklist note: saved at once, named by the submission');
  await go(page, `#/~hub/checklist/${FIXTURE_CHECKLIST}`);
  const notes = page.locator('[data-note-pictures]');
  await notes.waitFor();
  const noteInput = notes.locator('[data-attach-input]');
  assert.equal(await noteInput.getAttribute('capture'), null);
  await noteInput.setInputFiles(picture('note.png'));
  await notes.locator('.hub-tray-item[data-state="ready"]').waitFor();
  await eventually(() => assert.equal(stored('checklists', FIXTURE_CHECKLIST, NOTE_PIC).length, 1));
  await page.locator('textarea').last().fill('with a picture');
  await page.locator('[data-submit]').click();
  const submit = () => fixture.fake.json(`sections/inbox/checklists/${FIXTURE_CHECKLIST}/submit.json`);
  if (await page.locator('[data-warning]').count()) await page.locator('[data-submit]').click();
  await eventually(() => assert.equal(submit().pictures.length, 1));
  assert.equal(submit().pictures[0], stored('checklists', FIXTURE_CHECKLIST, NOTE_PIC)[0].split('/').pop());

  step('at 375 px with touch: the button is 44 px tall and nothing scrolls sideways');
  const phone = await open({ width: 375, height: 800 }, { hasTouch: true, isMobile: true });
  await phone.goto(`${fixture.url}#/~hub/needs`);
  const small = phone.locator(`.ni[data-need="ask-${FIXTURE_ASK}"]`);
  await small.waitFor();
  const button = small.locator('[data-ask-pictures] [data-pic-button]');
  assert.ok((await button.boundingBox()).height >= 44, 'The picture button is 44 px tall.');
  assert.equal(await small.locator('[data-ask-pictures] [data-attach-input]').getAttribute('capture'), null);
  await small.locator('[data-ask-pictures] [data-attach-input]').setInputFiles(picture('phone.png'));
  await small.locator('.hub-tray-item[data-state="ready"]').waitFor();
  const widths = await phone.evaluate(() => ({ scroll: document.scrollingElement.scrollWidth, inner: innerWidth }));
  assert.ok(widths.scroll <= widths.inner, `the page scrolls sideways (${widths.scroll} > ${widths.inner})`);
  const remove = await small.getByRole('button', { name: 'Remove picture 1' }).boundingBox();
  assert.ok(remove.height >= 44 && remove.width >= 44, 'The remove target is 44 px.');
  console.log('ok');
} finally {
  for (const context of contexts) await context.close().catch(() => {});
  await browser.close();
  await fixture.close();
}
