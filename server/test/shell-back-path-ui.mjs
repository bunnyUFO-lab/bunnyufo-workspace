// Run after npm run build. Back on a PATH-routes host, which is the real site: popstate reaches the app before hashchange, so a
// screen that mounts on Back must still read the entry it landed on. Every other UI test runs on hash routes (the local service),
// where that listener is never installed. Here /api/capabilities is patched to `routes: 'path'`.
//   - Back from a search result keeps the search's text and chip; Back from a chat message hit keeps the chat list's text;
//   - Delete a chat, open it from the Trash, Back, open it again: the thread shows both times (no bounce to the Trash list).
import { chromium } from '@playwright/test';
import { ms } from './ui-timeouts.mjs';
import assert from 'node:assert/strict';
import { startHubFixture } from './hub-fixture.mjs';
import { hashOf } from './shell-helpers.mjs';

const step = name => console.log(`- ${name}`);
const channel = process.env.BUW_TEST_BROWSER || 'msedge';
const fixture = await startHubFixture({ hermes: true, chatRuns: true });
const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
const ID = { a: `${day}-pathaa`, b: `${day}-pathbb` };
const at = new Date().toISOString();
for (const [id, title] of [[ID.a, 'Plan the lantern festival'], [ID.b, 'Name the new boss']]) {
  fixture.fake.seed(`sections/inbox/chat/${id}.jsonl`, `${[{ role: 'user', text: title, at }, { role: 'assistant', text: `Done: ${title}.`, at }].map(line => JSON.stringify(line)).join('\n')}\n`, 'application/x-ndjson');
}
const browser = await chromium.launch({ headless: true, channel });
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block', reducedMotion: 'reduce' });
  await context.route('**/api/capabilities', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...(await response.json()), routes: 'path' } });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(ms(15000));
  page.on('pageerror', error => { throw error; });
  await page.goto(`${fixture.url}#/~hub/today`);
  await page.locator('.hub[data-screen="today"]').waitFor();
  assert.equal(await page.evaluate(() => fetch('/api/capabilities').then(r => r.json()).then(c => c.routes)), 'path', 'The host answers path routes, as the real site does.');
  // The app read the capabilities before this step: make sure it did so as a path host (the listener is installed only then).
  await page.reload();
  await page.locator('.hub[data-screen="today"]').waitFor();

  step('path routes: Back from a search result finds the search with its text and chip');
  await page.keyboard.press('Control+k');
  const dialog = page.locator('dialog[data-search="dialog"]');
  await dialog.waitFor();
  await dialog.locator('input').fill('hub card');
  await page.locator('[data-search-chip="library"]').click();
  await dialog.locator('[role="option"]', { hasText: 'The hub card' }).first().click();
  await page.locator('.buw-markdown h1', { hasText: 'The hub card' }).waitFor();
  await page.goBack();
  await dialog.waitFor();
  assert.equal(await hashOf(page), '#/~hub/search');
  assert.equal(await dialog.locator('input').inputValue(), 'hub card', 'Back keeps the text.');
  assert.equal(await page.locator('[data-search-chip="library"]').getAttribute('aria-pressed'), 'true', 'Back keeps the chip.');

  step('path routes: Back from a message hit finds the chat list with its text');
  await page.goto(`${fixture.url}#/~hub/chat`);
  await page.locator('[data-chat-list] [data-conversation]').first().waitFor();
  await page.locator('[data-chat-search]').fill('lantern');
  await page.locator('[data-chat-hit]').first().click();
  await page.waitForURL(new RegExp(`${ID.a}/m/[0-9]+$`));
  await page.locator('.hub-bubble').first().waitFor();
  await page.goBack();
  await page.locator('[data-chat-list]').waitFor();
  assert.equal(await page.locator('[data-chat-search]').inputValue(), 'lantern', 'Back keeps the chat list text.');

  step('path routes: Delete, open it from the Trash, Back, open it again: the thread shows both times');
  await page.locator('[data-chat-search]').fill('');
  await page.locator(`[data-chat-list] [data-swipe="${ID.b}"] [data-row-menu]`).click();
  await page.getByRole('menuitem', { name: 'Delete', exact: true }).click();
  await page.locator(`[data-chat-list] [data-conversation="${ID.b}"]`).waitFor({ state: 'detached' });
  await page.goto(`${fixture.url}#/~hub/chat/trash`).catch(() => {});
  await page.locator('[data-chat-set-aside="trash"]').waitFor();
  for (const turn of [1, 2]) {
    await page.locator(`[data-chat-set-aside] [data-conversation="${ID.b}"]`).click();
    await page.locator('[data-chat-trashed]').waitFor();
    assert.match(await hashOf(page), new RegExp(`${ID.b}$`), `Visit ${turn}: the thread is open, not bounced to the Trash.`);
    await page.goBack();
    await page.locator('[data-chat-set-aside="trash"]').waitFor();
  }
  console.log('shell-back-path-ui: passed');
} finally {
  await browser.close();
  await fixture.close();
}
