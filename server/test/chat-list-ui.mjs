// Run after npm run build. The chat list through a real browser, over the Hub fixture service with the fake Hermes: Pinned, Today, the
// Archived and Trash rows, Rename, Pin, Mark unread, Archive (menu and swipe) with Undo, Delete to the Trash with Undo and Restore,
// a trashed chat opened by link (it reads, and cannot send), the transcript bytes untouched, Back past a chat deleted here, and a guest.
// 390 px with touch, then 1280 px.
import { chromium } from '@playwright/test';
import { ms } from './ui-timeouts.mjs';
import assert from 'node:assert/strict';
import { startHubFixture } from './hub-fixture.mjs';
import { hashOf, noSideways } from './shell-helpers.mjs';

const step = name => console.log(`- ${name}`);
const channel = process.env.BUW_TEST_BROWSER || 'msedge';
const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
const ID = { a: `${day}-aaaa01`, b: `${day}-bbbb02`, c: `${day}-cccc03`, d: `${day}-dddd04` };
const TITLE = { a: 'Plan the forest level', b: 'Fix the docs deploy', c: 'Name the new boss', d: 'Price the soundtrack' };
const line = (role, text) => JSON.stringify({ role, text, at: new Date().toISOString() });
const keyOf = id => `sections/inbox/chat/${id}.jsonl`;

const fixture = await startHubFixture({ hermes: true, chatRuns: true });
for (const [name, id] of Object.entries(ID)) fixture.fake.seed(keyOf(id), `${[line('user', TITLE[name]), line('assistant', `Done: ${TITLE[name]}.`)].join('\n')}\n`, 'application/x-ndjson');
const bytes = Object.fromEntries(Object.values(ID).map(id => [id, fixture.fake.text(keyOf(id))]));
const browser = await chromium.launch({ headless: true, channel });
const open = async (viewport, options = {}) => {
  const context = await browser.newContext({ viewport, serviceWorkers: 'block', reducedMotion: 'reduce', ...options });
  const page = await context.newPage();
  page.setDefaultTimeout(ms(15000));
  page.on('pageerror', error => { throw error; });
  return page;
};
const row = (page, id) => page.locator(`[data-chat-list] [data-swipe="${id}"]`);
const link = (page, id) => page.locator(`[data-chat-list] [data-conversation="${id}"]`);
const menuOf = async (page, id, name) => {
  await row(page, id).locator('[data-row-menu]').click();
  await page.getByRole('menuitem', { name, exact: true }).click();
};
const toast = page => page.locator('[data-undo-toast]');
const undo = async page => { await toast(page).getByRole('button', { name: 'Undo' }).click(); };
const swipe = async (page, id, dx, dy = 0) => {
  const box = await row(page, id).boundingBox();
  const cdp = await page.context().newCDPSession(page);
  const x = box.x + box.width * 0.65;
  const y = box.y + box.height / 2;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  for (let i = 1; i <= 6; i += 1) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + (dx * i) / 6, y: y + (dy * i) / 6 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
};
const titles = page => page.locator('[data-chat-list] [data-swipe] .cl-title').allInnerTexts();
const count = (page, selector) => page.locator(selector).count();

try {
  const phone = await open({ width: 390, height: 844 }, { hasTouch: true, isMobile: true });
  await phone.goto(`${fixture.url}#/~hub/chat`);
  await phone.locator('[data-chat-list] [data-conversation]').first().waitFor();

  step('390: Today lists the chats, the Archived and Trash rows count nothing yet, the tab bar shows');
  assert.equal(await count(phone, '[data-chat-list] [data-conversation]'), 4);
  assert.equal(await count(phone, '[data-tabs]'), 1, 'The list has the tab bar.');
  assert.equal(await phone.locator('[data-chat-place="archived"] .cl-count').innerText(), '0');
  assert.equal(await phone.locator('[data-chat-place="trash"] .cl-count').innerText(), '0');
  await noSideways(phone, 'chat list at 390');
  const rowBox = await row(phone, ID.a).boundingBox();
  assert.ok(rowBox.height >= 44, `A row is at least 44 px tall (${rowBox.height}).`);
  const menuBox = await row(phone, ID.a).locator('[data-row-menu]').boundingBox();
  assert.ok(menuBox.width >= 44 && menuBox.height >= 44, 'The menu button is 44 px.');

  step('390: a thread has no tabs, and Back returns to the list');
  await link(phone, ID.a).click();
  await phone.locator('[data-chat-thread]').waitFor();
  assert.equal(await count(phone, '[data-tabs]'), 0, 'A thread has no tab bar.');
  assert.equal(await count(phone, '[data-chat-list]'), 0, 'A phone shows one pane.');
  await phone.locator('.hub-bubble', { hasText: `Done: ${TITLE.a}.` }).waitFor();
  await phone.locator('[data-back]').first().click();
  await phone.locator('[data-chat-list]').waitFor();
  assert.match(await hashOf(phone), /#\/~hub\/chat$/);

  step('390: Rename keeps its name after a reload; an empty name goes back to the first message');
  await menuOf(phone, ID.b, 'Rename');
  await phone.locator('[data-rename-input]').fill('Docs deploy fix');
  await phone.locator('[data-rename-save]').click();
  await phone.locator('[data-chat-list] .cl-title', { hasText: 'Docs deploy fix' }).waitFor();
  await phone.reload();
  await phone.locator('[data-chat-list] .cl-title', { hasText: 'Docs deploy fix' }).waitFor();
  assert.equal(await count(phone, `[data-chat-list] .cl-title:text("${TITLE.b}")`), 0);
  await menuOf(phone, ID.b, 'Rename');
  await phone.locator('[data-rename-input]').fill('');
  await phone.locator('[data-rename-save]').click();
  await phone.locator('[data-chat-list] .cl-title', { hasText: TITLE.b }).waitFor();

  step('390: Pin puts a chat first, under Pinned');
  await menuOf(phone, ID.c, 'Pin');
  await phone.locator(`[data-conversation="${ID.c}"][data-pinned]`).waitFor();
  assert.equal((await titles(phone))[0], TITLE.c);
  assert.equal(await phone.locator('[data-chat-list] .ui-sechead h2').first().innerText(), 'Pinned');

  step('390: Mark unread shows a dot, and opening the chat clears it');
  await menuOf(phone, ID.d, 'Mark as unread');
  await phone.locator(`[data-conversation="${ID.d}"] [data-unread-dot]`).waitFor();
  await link(phone, ID.d).click();
  await phone.locator('.hub-bubble', { hasText: `Done: ${TITLE.d}.` }).waitFor();
  await phone.locator('[data-back]').first().click();
  await phone.locator('[data-chat-list]').waitFor();
  await phone.waitForFunction(id => !document.querySelector(`[data-conversation="${id}"] [data-unread-dot]`), ID.d);

  step('390: a mostly vertical drag does not archive; a left swipe does, with Undo, and the Archived row counts it');
  await swipe(phone, ID.a, -30, 90);
  await phone.waitForTimeout(ms(400));
  assert.equal(await count(phone, `[data-conversation="${ID.a}"]`), 1, 'A vertical drag leaves the chat.');
  await swipe(phone, ID.a, -190);
  await phone.locator(`[data-conversation="${ID.a}"]`).waitFor({ state: 'detached' });
  await toast(phone).filter({ hasText: `Archived: ${TITLE.a}` }).waitFor();
  assert.equal(await phone.locator('[data-chat-place="archived"] .cl-count').innerText(), '1');
  await undo(phone);
  await phone.locator(`[data-conversation="${ID.a}"]`).waitFor();
  assert.equal(await phone.locator('[data-chat-place="archived"] .cl-count').innerText(), '0');

  step('390: Archive from the menu, then Restore from the Archived list');
  await menuOf(phone, ID.a, 'Archive');
  await phone.locator(`[data-conversation="${ID.a}"]`).waitFor({ state: 'detached' });
  await phone.locator('[data-chat-place="archived"]').click();
  await phone.locator('[data-chat-set-aside="archived"]').waitFor();
  assert.equal(await count(phone, '[data-tabs]'), 0, 'The Archived list has no tab bar.');
  await phone.locator(`[data-chat-restore="${ID.a}"]`).click();
  await phone.locator(`[data-chat-set-aside] [data-conversation="${ID.a}"]`).waitFor({ state: 'detached' });
  await phone.locator('[data-back]').first().click();
  await phone.locator(`[data-chat-list] [data-conversation="${ID.a}"]`).waitFor();

  step('390: Delete goes to the Trash with Undo; Undo brings it back; the transcript is not touched');
  await menuOf(phone, ID.b, 'Delete');
  await phone.locator(`[data-conversation="${ID.b}"]`).waitFor({ state: 'detached' });
  await toast(phone).filter({ hasText: `Moved to Trash: ${TITLE.b}` }).waitFor();
  assert.equal(fixture.fake.text(keyOf(ID.b)), bytes[ID.b], 'Delete left the transcript as it was.');
  await undo(phone);
  await phone.locator(`[data-conversation="${ID.b}"]`).waitFor();

  step('390: Delete, then the Trash lists it; Restore brings every message back, and it can send');
  await menuOf(phone, ID.b, 'Delete');
  await phone.locator(`[data-conversation="${ID.b}"]`).waitFor({ state: 'detached' });
  await phone.locator('[data-chat-place="trash"] .cl-count').filter({ hasText: '1' }).waitFor();
  await phone.locator('[data-chat-place="trash"]').click();
  await phone.locator('[data-chat-set-aside="trash"]').waitFor();
  await phone.locator(`[data-chat-set-aside] [data-conversation="${ID.b}"]`).waitFor();
  assert.equal(fixture.fake.text(keyOf(ID.b)), bytes[ID.b], 'The Trash holds the same bytes.');
  await phone.locator(`[data-chat-restore="${ID.b}"]`).click();
  await phone.locator(`[data-chat-set-aside] [data-conversation="${ID.b}"]`).waitFor({ state: 'detached' });
  await phone.locator('[data-back]').first().click();
  await link(phone, ID.b).click();
  await phone.locator('.hub-bubble', { hasText: `Done: ${TITLE.b}.` }).waitFor();
  assert.equal(await count(phone, '.hub-bubble'), 2, 'Every message is still there.');
  await phone.locator('textarea[aria-label="Message"]').fill('One more thing');
  await phone.keyboard.press('Enter');
  await phone.locator('.hub-bubble.assistant').nth(1).waitFor();
  await noSideways(phone, 'thread at 390');

  step('390: a trashed chat opened from a link reads, says so, and has no composer');
  await phone.locator('[data-back]').first().click();
  await phone.locator('[data-chat-list]').waitFor();
  await menuOf(phone, ID.c, 'Delete');
  await phone.locator(`[data-conversation="${ID.c}"]`).waitFor({ state: 'detached' });
  await phone.goto(`${fixture.url}#/~hub/chat/${ID.c}`);
  await phone.reload();
  await phone.locator('[data-chat-trashed]').waitFor();
  await phone.locator('.hub-bubble', { hasText: `Done: ${TITLE.c}.` }).waitFor();
  assert.equal(await count(phone, 'textarea[aria-label="Message"]'), 0, 'No composer in the Trash.');
  assert.equal(await count(phone, '[data-attach-input]'), 0);
  await phone.locator('[data-chat-trashed] [data-chat-restore]').click();
  await phone.locator('[data-chat-trashed]').waitFor({ state: 'detached' });
  await phone.locator('textarea[aria-label="Message"]').waitFor();
  assert.equal(fixture.fake.text(keyOf(ID.c)), bytes[ID.c]);

  step('390: Delete from a thread goes back to the list');
  await phone.goto(`${fixture.url}#/~hub/chat`);
  await phone.locator('[data-chat-list]').waitFor();
  await link(phone, ID.d).click();
  await phone.locator('[data-chat-thread]').waitFor();
  await phone.locator('.hub-chat-head [data-row-menu]').click();
  await phone.getByRole('menuitem', { name: 'Delete', exact: true }).click();
  await phone.locator('[data-chat-list]').waitFor();
  assert.match(await hashOf(phone), /#\/~hub\/chat$/);
  assert.equal(await count(phone, `[data-conversation="${ID.d}"]`), 0);
  await undo(phone);
  await phone.locator(`[data-conversation="${ID.d}"]`).waitFor();

  step('1280: the list and the thread sit side by side; the menu is a small sheet');
  const wide = await open({ width: 1280, height: 900 });
  await wide.goto(`${fixture.url}#/~hub/chat/${ID.a}`);
  await wide.locator('[data-chat-list] [data-conversation]').first().waitFor();
  await wide.locator('[data-chat-thread]').waitFor();
  await wide.locator('.hub-bubble', { hasText: `Done: ${TITLE.a}.` }).waitFor();
  assert.equal(await count(wide, '[data-rail]'), 1);
  assert.equal(await link(wide, ID.a).getAttribute('aria-current'), 'page', 'The open chat is lit in the list.');
  await row(wide, ID.b).locator('[data-row-menu]').click();
  const sheet = await wide.locator('.ui-sheet').boundingBox();
  assert.ok(sheet.width < 600, `A small sheet at 1280 (${sheet.width}).`);
  await wide.keyboard.press('Escape').catch(() => {});
  await wide.goBack();
  await wide.locator('.ui-sheet').waitFor({ state: 'detached' });

  step('1280: the title opens the sheet with Talk to and Model');
  await wide.locator('[data-chat-options]').click();
  await wide.locator('[data-chat-sheet] [data-chat-model]').waitFor();
  assert.equal(await wide.locator('[data-chat-sheet] [data-chat-persona]').count(), 0, 'A saved chat has its agent, no picker.');
  await wide.goBack();
  await wide.locator('[data-chat-sheet]').waitFor({ state: 'detached' });

  step('1280: Back skips a chat that was deleted here, going back; going forward lands on the list');
  await wide.goto(`${fixture.url}#/~hub/chat`);
  await wide.locator('[data-chat-list] [data-conversation]').first().waitFor();
  await link(wide, ID.a).click();
  await wide.waitForURL(new RegExp(`${ID.a}$`));
  await link(wide, ID.b).click();
  await wide.waitForURL(new RegExp(`${ID.b}$`));
  await link(wide, ID.c).click();
  await wide.waitForURL(new RegExp(`${ID.c}$`));
  await menuOf(wide, ID.b, 'Delete');
  await wide.locator(`[data-chat-list] [data-conversation="${ID.b}"]`).waitFor({ state: 'detached' });
  assert.match(await hashOf(wide), new RegExp(`${ID.c}$`), 'Deleting another chat leaves this one open.');
  const entries = await wide.evaluate(() => history.length);
  await wide.goBack();
  await wide.waitForURL(new RegExp(`${ID.a}$`));
  assert.equal(await wide.evaluate(() => history.length), entries, 'Skipping added no entry.');
  await wide.goForward();
  await wide.waitForURL(/#\/~hub\/chat$/);
  assert.equal(await wide.evaluate(() => history.length), entries, 'Forward onto it replaced it with the list: no entry added.');

  step('1280: the Archived list sits beside the chat list; Ctrl+K finds an archived chat and marks it');
  await menuOf(wide, ID.d, 'Archive');
  await wide.locator(`[data-chat-list] [data-conversation="${ID.d}"]`).waitFor({ state: 'detached' });
  await wide.locator('[data-chat-place="archived"]').click();
  await wide.locator('[data-chat-set-aside="archived"] [data-conversation]').waitFor();
  assert.equal(await count(wide, '[data-chat-list]'), 1, 'The list stays beside it.');
  await wide.keyboard.press('Control+k');
  await wide.locator('dialog[data-search="dialog"]').waitFor();
  await wide.keyboard.type('soundtrack');
  await wide.locator('dialog[data-search="dialog"] [role="option"]', { hasText: TITLE.d }).first().waitFor();
  assert.match(await wide.locator('dialog[data-search="dialog"] [role="option"]', { hasText: TITLE.d }).first().innerText(), /Archived/);
  await wide.keyboard.press('Escape');

  step('a guest sees the sign-in line and no list');
  const guest = await open({ width: 1280, height: 900 });
  await guest.route('**/api/capabilities', async route => {
    const response = await route.fetch();
    const caps = await response.json();
    await route.fulfill({ response, json: { ...caps, write: false, chat: false, approve: false, create: false, cards: false } });
  });
  await guest.goto(`${fixture.url}#/~hub/chat`);
  await guest.locator('[data-hub-chat-note]').waitFor();
  assert.equal(await count(guest, '[data-chat-list]'), 0);
  assert.equal(await count(guest, '[data-row-menu]'), 0);

  console.log('ok');
} finally {
  await browser.close();
  await fixture.close();
}
