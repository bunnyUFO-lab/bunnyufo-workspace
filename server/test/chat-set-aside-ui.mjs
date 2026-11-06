// Run after npm run build. The Trash and Archived lists page: 105 set-aside chats show 100, "Show more" brings the rest, and a Restore
// still works on a row from the second page. Over the Hub fixture service, at 390 px.
import { chromium } from '@playwright/test';
import { ms } from './ui-timeouts.mjs';
import assert from 'node:assert/strict';
import { startHubFixture } from './hub-fixture.mjs';

const step = name => console.log(`- ${name}`);
const channel = process.env.BUW_TEST_BROWSER || 'msedge';
const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
const TOTAL = 105;
const idOf = n => `${day}-${String(n).padStart(6, 'a')}`;
const line = (role, text, at) => JSON.stringify({ role, text, at });

const fixture = await startHubFixture({ hermes: true, chatRuns: true });
const marks = {};
for (let n = 0; n < TOTAL; n += 1) {
  const at = new Date(Date.now() - n * 60_000).toISOString();
  fixture.fake.seed(`sections/inbox/chat/${idOf(n)}.jsonl`, `${[line('user', `Chat number ${n}`, at), line('assistant', 'Done.', at)].join('\n')}\n`, 'application/x-ndjson');
  marks[idOf(n)] = { trashed: at };
}
fixture.fake.seed('sections/inbox/chat/state.json', JSON.stringify({ v: 1, chats: marks }), 'application/json');
const browser = await chromium.launch({ headless: true, channel });
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block', reducedMotion: 'reduce' });
  const page = await context.newPage();
  page.setDefaultTimeout(ms(15000));
  page.on('pageerror', error => { throw error; });
  const rows = page.locator('[data-chat-set-aside] [data-conversation]');

  step('390: the Trash shows the newest 100 and a Show more button that says how many are left');
  await page.goto(`${fixture.url}#/~hub/chat/trash`);
  await rows.first().waitFor();
  assert.equal(await rows.count(), 100);
  assert.match(await page.locator('[data-chat-more]').innerText(), /5 left/);

  step('390: Show more adds the last five, and the button goes');
  await page.locator('[data-chat-more]').click();
  await page.locator('[data-chat-set-aside] [data-conversation]').nth(104).waitFor();
  assert.equal(await rows.count(), TOTAL);
  assert.equal(await page.locator('[data-chat-more]').count(), 0);

  step('390: a chat from the second page restores, and leaves the list');
  await page.locator(`[data-chat-restore="${idOf(104)}"]`).click();
  await page.locator(`[data-conversation="${idOf(104)}"]`).waitFor({ state: 'detached' });
  assert.equal(fixture.fake.json('sections/inbox/chat/state.json').chats[idOf(104)]?.trashed ?? null, null, 'Restore cleared the mark.');
  console.log('chat-set-aside-ui: passed');
} finally {
  await browser.close();
  await fixture.close();
}
