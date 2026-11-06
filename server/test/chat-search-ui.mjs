// Run after npm run build. Words inside chat messages, through a real browser over the Hub fixture service: Search's Chats chip and the
// chat list's own field both find a phrase, mark it, and open the thread at that message (which flashes); Back returns to the text;
// a trashed chat's words are not found; an archived chat's are, marked Archived. 390 px with touch, then 1280 px.
import { chromium } from '@playwright/test';
import { ms } from './ui-timeouts.mjs';
import assert from 'node:assert/strict';
import { startHubFixture } from './hub-fixture.mjs';
import { hashOf, noSideways } from './shell-helpers.mjs';

const step = name => console.log(`- ${name}`);
const channel = process.env.BUW_TEST_BROWSER || 'msedge';
const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
const ID = { plan: `${day}-plan01`, harbour: `${day}-harb02`, zebra: `${day}-zebr03` };
const line = (role, text) => JSON.stringify({ role, text, at: new Date().toISOString() });
const seedChat = (fixture, id, lines) => fixture.fake.seed(`sections/inbox/chat/${id}.jsonl`, `${lines.map(([role, text]) => line(role, text)).join('\n')}\n`, 'application/x-ndjson');

const fixture = await startHubFixture({ hermes: true, chatRuns: true });
seedChat(fixture, ID.plan, [['user', 'Plan the redesign'], ['assistant', 'We agreed on the lantern festival schedule for spring.']]);
seedChat(fixture, ID.harbour, [['user', 'Budget the harbour'], ['assistant', 'The harbour crane costs nine thousand.']]);
seedChat(fixture, ID.zebra, [['user', 'Name the zebra'], ['assistant', 'The zebra is called Stripe, a secret.']]);
const now = new Date().toISOString();
fixture.fake.seed('sections/inbox/chat/state.json', JSON.stringify({ v: 1, chats: { [ID.harbour]: { archived: now }, [ID.zebra]: { trashed: now } } }), 'application/json');
const before = [...fixture.fake.objects.keys()].sort();

const browser = await chromium.launch({ headless: true, channel });
const open = async (viewport, options = {}) => {
  const context = await browser.newContext({ viewport, serviceWorkers: 'block', reducedMotion: 'reduce', ...options });
  const page = await context.newPage();
  page.setDefaultTimeout(ms(15000));
  page.on('pageerror', error => { throw error; });
  return page;
};
const landed = async (page, id) => {
  await page.waitForURL(new RegExp(`#/~hub/chat/${id}/m/1$`));
  const bubble = page.locator('[data-line="1"]');
  await bubble.waitFor();
  await page.waitForFunction(() => document.querySelector('[data-line="1"]')?.classList.contains('hub-flash'));
  assert.ok(await bubble.evaluate(node => { const box = node.getBoundingClientRect(); return box.top >= 0 && box.bottom <= innerHeight; }), 'The message is on screen.');
};

try {
  const phone = await open({ width: 390, height: 844 }, { hasTouch: true, isMobile: true });
  await phone.goto(`${fixture.url}#/~hub/today`);
  await phone.locator('.hub[data-screen="today"]').waitFor();

  step('390 Search: a phrase from inside a chat gives a Chats result with the phrase marked; tapping it opens the message, flashing');
  await phone.locator('[data-tabs] [data-nav="search"]').tap();
  await phone.locator('[data-search="screen"]').waitFor();
  await phone.locator('[data-search-input]').fill('lantern festival');
  const hit = phone.locator('[data-search-group="chats"] [role="option"]', { hasText: 'Plan the redesign' });
  await hit.waitFor();
  assert.match(await hit.locator('mark').first().innerText(), /lantern/i);
  await hit.tap();
  await landed(phone, ID.plan);

  step('390 Search: Back shows search with its text, and Back again shows where it began');
  await phone.goBack();
  await phone.locator('[data-search="screen"]').waitFor();
  assert.equal(await phone.locator('[data-search-input]').inputValue(), 'lantern festival');
  await phone.goBack();
  await phone.locator('.hub[data-screen="today"]').waitFor();

  step('390 Search: a trashed chat\'s words are not found, an archived chat\'s are, marked Archived');
  await phone.locator('[data-tabs] [data-nav="search"]').tap();
  await phone.locator('[data-search-input]').fill('secret');
  await phone.locator('[data-search-empty]').waitFor();
  assert.equal(await phone.locator('[data-search-group="chats"]').count(), 0, 'No result from the Trash.');
  await phone.locator('[data-search-input]').fill('crane');
  const archived = phone.locator('[data-search-group="chats"] [role="option"]', { hasText: 'Budget the harbour' });
  await archived.waitFor();
  assert.match(await archived.innerText(), /Archived/);

  step('390 chat list: its field finds the same phrase, marks it, and Back keeps the text');
  await phone.goto(`${fixture.url}#/~hub/chat`);
  await phone.locator('[data-chat-list] [data-conversation]').first().waitFor();
  await phone.locator('[data-chat-search]').fill('lantern');
  const listed = phone.locator('[data-chat-hit]', { hasText: 'Plan the redesign' });
  await listed.waitFor();
  assert.match(await listed.locator('mark').first().innerText(), /lantern/i);
  await noSideways(phone, 'chat list search at 390');
  await listed.tap();
  await landed(phone, ID.plan);
  await phone.goBack();
  await phone.locator('[data-chat-list]').waitFor();
  assert.equal(await phone.locator('[data-chat-search]').inputValue(), 'lantern', 'Back to the list finds the text again.');
  await phone.locator('[data-chat-hit]', { hasText: 'Plan the redesign' }).waitFor();

  step('1280: the same from Ctrl+K');
  const wide = await open({ width: 1280, height: 900 });
  await wide.goto(`${fixture.url}#/~hub/today`);
  await wide.locator('.hub[data-screen="today"]').waitFor();
  await wide.keyboard.press('Control+k');
  await wide.locator('dialog[data-search="dialog"]').waitFor();
  await wide.keyboard.type('lantern festival');
  const row = wide.locator('dialog[data-search="dialog"] [role="option"]', { hasText: 'Plan the redesign' });
  await row.waitFor();
  assert.match(await row.locator('mark').first().innerText(), /lantern/i);
  await row.click();
  await landed(wide, ID.plan);

  step('1280: the chat list\'s field finds words in messages beside the open thread; a trashed chat\'s are missing; an archived chat\'s are marked');
  await wide.goto(`${fixture.url}#/~hub/chat`);
  await wide.locator('[data-chat-list] [data-conversation]').first().waitFor();
  await wide.locator('[data-chat-search]').fill('crane');
  const found = wide.locator('[data-chat-hit]', { hasText: 'Budget the harbour' });
  await found.waitFor();
  assert.match(await found.innerText(), /Archived/);
  await wide.locator('[data-chat-search]').fill('secret');
  await wide.locator('[data-chat-nomatch]').waitFor();
  assert.equal(await wide.locator('[data-chat-hit]').count(), 0);
  await wide.locator('[data-chat-search]').fill('lantern');
  await wide.locator('[data-chat-hit]', { hasText: 'Plan the redesign' }).click();
  await landed(wide, ID.plan);
  assert.equal(await wide.locator('[data-chat-list]').count(), 1, 'The list stays beside the thread.');
  assert.match(await hashOf(wide), new RegExp(`${ID.plan}/m/1$`));

  step('a search wrote nothing: the bucket holds the same objects');
  assert.deepEqual([...fixture.fake.objects.keys()].sort(), before);

  console.log('ok');
} finally {
  await browser.close();
  await fixture.close();
}
