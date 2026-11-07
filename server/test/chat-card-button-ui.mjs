// Run after npm run build. A link in a chat reply to a card on this site is an "Open card" button that opens a new tab and
// downloads nothing; a link to another host, or to a hub screen, is not a button. Both while a reply streams and once it is saved.
// The local copy of the app has no /w/ files and cannot open a section, so pressing the button shows its own "open it on the
// site" note here; that the site serves the card's page rather than a file is tested in site/api/test/api.test.mjs.
import { chromium } from '@playwright/test';
import { ms } from './ui-timeouts.mjs';
import assert from 'node:assert/strict';
import { startHubFixture } from './hub-fixture.mjs';

const step = name => console.log(`- ${name}`);
const channel = process.env.BUW_TEST_BROWSER || 'msedge';
const STREAMING = 'Here it is: [the gameplay references](/assistant#/sample-card-with-a-very-long-name-that-has-to-wrap-on-a-phone-screen)';
const REPLY = `${STREAMING}\n\nAlso [the docs](https://example.com/docs) and [the chat](#/~hub/chat/new).\n\n/assistant#/bare-card`;
const fixture = await startHubFixture({ hermes: true, chatRuns: true, hermesOptions: { runScripts: [[STREAMING, { hold: true }], [STREAMING, { hold: true }]] } });
const browser = await chromium.launch({ headless: true, channel });
try {
  for (const width of [1280, 360]) {
    step(`at ${width} wide`);
    const context = await browser.newContext({ viewport: { width, height: 800 }, acceptDownloads: true });
    const page = await context.newPage();
    page.setDefaultTimeout(ms(15000));
    page.on('pageerror', error => { throw error; });
    const downloads = [];
    page.on('download', download => downloads.push(download.suggestedFilename()));
    const popups = [];
    page.on('popup', popup => popups.push(popup));
    await page.goto(`${fixture.url}#/~hub/chat/new`);
    await page.locator('textarea[aria-label="Message"]').fill(`Where is it? ${width}`);
    await page.keyboard.press('Enter');

    step('a streaming reply shows the button, and pressing it leaves the chat and the stream in place');
    const streaming = page.locator('[data-pending] a[data-card-link]');
    await streaming.waitFor();
    assert.match(await streaming.innerText(), /^Open card: the gameplay references$/);
    assert.equal(await streaming.getAttribute('target'), '_blank');
    assert.match(await streaming.getAttribute('rel'), /noopener/);
    assert.equal(await streaming.getAttribute('href'), '/assistant#/sample-card-with-a-very-long-name-that-has-to-wrap-on-a-phone-screen');
    assert.ok((await streaming.getAttribute('class')).split(' ').includes('hub-btn'));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false, 'A long card name wraps.');
    const url = page.url();
    await streaming.click();
    await page.locator('[data-hub-no-site]').waitFor();
    assert.equal(page.url(), url, 'This page stays.');
    await page.getByRole('button', { name: 'Stop' }).waitFor();
    assert.deepEqual(downloads, []);

    step('a saved reply: the card link is a button, an outside link and a hub link are not');
    const run = fixture.hermes.runs.at(-1);
    fixture.hermes.release(run.id, REPLY);
    const reply = page.locator('.hub-bubble.assistant:not([data-pending])', { hasText: 'the docs' });
    await reply.waitFor();
    assert.equal(await reply.locator('a[data-card-link]').count(), 1);
    assert.match(await reply.locator('a[data-card-link]').innerText(), /^Open card: /);
    const outside = reply.locator('a', { hasText: 'the docs' });
    assert.equal(await outside.getAttribute('target'), '_blank');
    assert.ok(!(await outside.getAttribute('class') ?? '').includes('hub-btn'));
    assert.ok(!(await reply.locator('a', { hasText: 'the chat' }).getAttribute('class') ?? '').includes('hub-btn'));
    const bare = reply.locator('a[data-card-link]');
    assert.equal(await bare.count(), 1, 'A bare path is plain text, not a link.');
    assert.deepEqual(popups, []);
    assert.deepEqual(downloads, []);
    await context.close();
  }
  console.log('chat-card-button-ui: passed');
} finally {
  await browser.close();
  await fixture.close?.();
}
