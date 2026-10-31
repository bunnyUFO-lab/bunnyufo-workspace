// Run after npm run build. Commands in Chat read like code, as in other chat apps: a fenced block the owner pastes shows as
// code (not with its backticks), a reply keeps its line breaks and its paragraphs apart, and a reply's code block has a
// Copy button that copies a plain PowerShell block as one line.
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { startHubFixture } from './hub-fixture.mjs';

const step = name => console.log(`- ${name}`);
const channel = process.env.BUW_TEST_BROWSER || 'msedge';
const REPLY = 'No. For step 01, open PowerShell and run:\ncd C:\\Users\\owner\nclaude plugin list\n\nOr copy this:\n\n```powershell\ncd C:\\Users\\owner\nclaude plugin list\n```\n\nThen restart the app.';
const fixture = await startHubFixture({ hermes: true, chatRuns: true, hermesOptions: { runScript: [REPLY] } });
const browser = await chromium.launch({ headless: true, channel });
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => { throw error; });
  await page.goto(fixture.url);
  await page.locator('[data-hub-link="chat"]').click();

  step('a fenced block in the owner\'s message shows as code, without its backticks');
  await page.locator('textarea[aria-label="Message"]').fill('Is this right?\n```\nPS> git pull\nYou are not currently on a branch.\n```');
  await page.keyboard.press('Enter');
  const mine = page.locator('.hub-bubble.user').last();
  await mine.locator('pre').waitFor();
  assert.equal(await mine.locator('pre').innerText(), 'PS> git pull\nYou are not currently on a branch.');
  assert.ok(!(await mine.innerText()).includes('```'), 'No backticks show.');
  assert.match(await mine.locator('p').first().innerText(), /^Is this right\?$/);

  step('the reply keeps its line breaks, and its paragraphs and code have room between them');
  const reply = page.locator('.hub-bubble.assistant', { hasText: 'Then restart the app.' });
  await reply.waitFor();
  const first = reply.locator('.hub-md > p').first();
  assert.equal(await first.locator('br').count(), 2, 'Each command is on its own line.');
  assert.equal(await first.innerText(), 'No. For step 01, open PowerShell and run:\ncd C:\\Users\\owner\nclaude plugin list');
  const gaps = await reply.locator('.hub-md > *').evaluateAll(nodes => nodes.map(node => parseFloat(getComputedStyle(node).marginTop)));
  assert.equal(gaps[0], 0, 'Nothing above the first block.');
  assert.ok(gaps.slice(1).every(gap => gap >= 8), `Room between blocks: ${gaps}`);

  step('the reply\'s code block has a Copy button, and a plain PowerShell block copies as one line');
  await reply.locator('.hub-copy').click();
  await reply.locator('.hub-copy', { hasText: 'Copied as one line' }).waitFor();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'cd C:\\Users\\owner; claude plugin list');
  console.log('hub-chat-code-ui: passed');
} finally {
  await browser.close();
  await fixture.close?.();
}
