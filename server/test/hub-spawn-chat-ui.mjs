// Run after npm run build. "Chat with <agent>" on the Spawn sheet (ws-q9y.8), through a real browser over the fixture service with
// the fake Hermes on runs: the tile sits next to the templates; chosen, it hides the project, repo, route, model and estimate, and the
// button reads "Open chat"; pressing it opens a new Chat on that agent with its preferred model and the typed text as an unsent draft,
// and files nothing (no write to the service, no request in the fake S3, no Hermes run). Other templates are unchanged. Phone width
// has no sideways scroll. Set BUW_SHOTS=<folder> to save the PR screenshots.
import { chromium } from '@playwright/test';
import { ms } from './ui-timeouts.mjs';
import assert from 'node:assert/strict';
import { startHubFixture } from './hub-fixture.mjs';
import { closeChatSheet, openChatSheet } from './shell-helpers.mjs';

const step = name => console.log(`- ${name}`);
const channel = process.env.BUW_TEST_BROWSER || 'msedge';
const shots = process.env.BUW_SHOTS;
const browser = await chromium.launch({ headless: true, channel });
const contexts = [];
const fixtures = [];
const open = async (viewport, options = {}) => {
  const context = await browser.newContext({ viewport, serviceWorkers: 'block', reducedMotion: 'reduce', ...options });
  contexts.push(context);
  const page = await context.newPage();
  page.setDefaultTimeout(ms(15000));
  page.on('pageerror', error => { throw error; });
  return page;
};
const requestsIn = fixture => [...fixture.fake.objects.keys()].filter(key => /sections\/inbox\/requests\//.test(key));
const noSideways = async (page, what) => {
  const widths = await page.evaluate(() => ({ scroll: document.scrollingElement.scrollWidth, inner: innerWidth, sheet: document.querySelector('[data-spawn-sheet]')?.scrollWidth ?? 0, sheetInner: document.querySelector('[data-spawn-sheet]')?.clientWidth ?? 0 }));
  assert.ok(widths.scroll <= widths.inner && widths.sheet <= widths.sheetInner, `${what}: sideways scroll ${JSON.stringify(widths)}`);
};
const shot = async (page, name) => { if (shots) await page.screenshot({ path: `${shots}/${name}.png` }); };

try {
  const fx = await startHubFixture({ hermes: true, chatRuns: true });
  fixtures.push(fx);
  const writes = [];
  const watch = page => page.on('request', request => { if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method()) && request.url().startsWith(fx.url)) writes.push(`${request.method()} ${request.url()}`); });
  const page = await open({ width: 1280, height: 900 });
  watch(page);

  step('Today: the Spawn sheet offers "Chat with Hermes" after the nine templates; the template chips are still nine');
  await page.goto(`${fx.url}#/~hub/today`);
  await page.locator('[data-spawn-open]').click();
  await page.locator('[data-spawn-sheet] [data-preset]').first().waitFor();
  assert.equal(await page.locator('[data-spawn-sheet] [data-preset]').count(), 10);
  const tile = page.locator('[data-spawn-chat]');
  await tile.waitFor();
  assert.equal((await tile.innerText()).trim(), 'Chat with Hermes');
  assert.equal(await tile.getAttribute('aria-pressed'), 'false');

  step('Picking it hides the project, repo, route, model and estimate; the button reads Open chat');
  await tile.click();
  assert.equal(await tile.getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('[data-preset="code-task"]').getAttribute('aria-pressed'), 'false');
  for (const hidden of ['[data-spawn-project]', '[data-spawn-repo-pick]', '[data-spawn-route]', '[data-spawn-model-row]', '[data-spawn-estimate]', '[data-spawn-done]']) assert.equal(await page.locator(hidden).count(), 0, `${hidden} is hidden`);
  assert.equal(await page.locator('[data-spawn-go]').innerText(), 'Open chat');
  assert.equal(await page.locator('[data-spawn-go]').isEnabled(), true);
  assert.match(await page.locator('[data-spawn-note]').innerText(), /Nothing is filed/);
  assert.match(await page.locator('[data-spawn-agent]').innerText(), /Hermes/);
  await page.locator('[data-spawn-text]').fill('What should I build after the roadmap?');
  await shot(page, 'spawn-chat-desktop');

  step('Open chat: Chat is open on a new conversation with Hermes, the text is in the composer and not sent');
  await page.locator('[data-spawn-go]').click();
  await page.waitForURL(/#\/~hub\/chat$/);
  await openChatSheet(page);
  assert.equal(await page.locator('[data-spawn-sheet]').count(), 0, 'The sheet is gone.');
  assert.equal(await page.locator('[data-chat-persona]').inputValue(), 'hermes');
  assert.equal(await page.locator('textarea[aria-label="Message"]').inputValue(), 'What should I build after the roadmap?');
  assert.equal(await page.locator('.hub-bubble').count(), 0, 'Nothing was sent.');

  step('A research template: the tile reads "Chat with Researcher"; Chat opens on Researcher with Codex and the draft (from Chat itself)');
  await page.locator('[data-chat-model]').selectOption({ label: 'Start a job instead…' });
  await page.locator('[data-spawn-sheet] [data-preset]').first().waitFor();
  await page.locator('[data-preset="research"]').click();
  await page.locator('[data-spawn-chat]', { hasText: 'Chat with Researcher' }).click();
  await page.locator('[data-spawn-text]').fill('Compare two tug-of-war card games');
  await page.locator('[data-spawn-go]').click();
  await openChatSheet(page);
  await page.waitForFunction(() => document.querySelector('[data-chat-persona]')?.value === 'researcher');
  assert.equal(await page.locator('textarea[aria-label="Message"]').inputValue(), 'Compare two tug-of-war card games');
  assert.equal(await page.locator('[data-chat-model] option:checked').innerText(), 'Codex 6.1 Sol', "The agent's own model.");
  assert.equal(await page.locator('[data-chat-with]').getAttribute('data-chat-with'), 'researcher');
  await shot(page, 'chat-opened-with-draft');

  step('The draft sends like any message once the owner presses Enter');
  await page.locator('textarea[aria-label="Message"]').press('Enter');
  await page.locator('.hub-bubble.assistant [data-who="researcher"]').waitFor();
  assert.equal(fx.hermes.runs.length, 1);
  assert.equal(fx.hermes.runs[0].body.input, 'Compare two tug-of-war card games');

  step('Nothing was filed: no write from the page to the service except the chat turn, no request in the fake S3');
  assert.deepEqual(writes.filter(line => !/\/chat(\/|$)/.test(line)), [], 'Only the chat turn itself wrote.');
  assert.deepEqual(requestsIn(fx), []);

  step('An earlier manual model pick does not survive the switch: the new agent opens on its own model');
  await page.goto(`${fx.url}#/~hub/chat`);
  await openChatSheet(page);
  await page.locator('[data-chat-model]').selectOption('sonnet');
  assert.equal(await page.locator('[data-chat-model] option:checked').innerText(), 'Sonnet 5.5 · API');
  await page.locator('[data-chat-model]').selectOption({ label: 'Start a job instead…' });
  await page.locator('[data-spawn-sheet] [data-preset]').first().waitFor();
  await page.locator('[data-preset="game-teardown"]').click();
  await page.locator('[data-spawn-chat]', { hasText: 'Chat with Teardown' }).click();
  await page.locator('[data-spawn-text]').fill('How does it teach?');
  await page.locator('[data-spawn-go]').click();
  await openChatSheet(page);
  await page.waitForFunction(() => document.querySelector('[data-chat-persona]')?.value === 'teardown');
  assert.equal(await page.locator('[data-chat-model] option:checked').innerText(), 'Codex 6.1 Sol');
  assert.equal(await page.locator('textarea[aria-label="Message"]').inputValue(), 'How does it teach?');

  step('Busy: a reply is still streaming; Open chat lands in a fresh conversation, and nothing stays queued for a later open');
  const slow = await startHubFixture({ hermes: true, chatRuns: true, hermesOptions: { runScript: ['Working. ', { hold: true }] } });
  fixtures.push(slow);
  const other = await open({ width: 1280, height: 900 });
  await other.goto(`${slow.url}#/~hub/chat`);
  await other.locator('textarea[aria-label="Message"]').fill('Hold on');
  await other.keyboard.press('Enter');
  await other.locator('[data-pending]').waitFor();
  assert.equal(await other.locator('.hub-bubble.user').count(), 1);
  await other.keyboard.press('Control+k');
  await other.locator('input[role="combobox"]').fill('spawn compare two card games');
  await other.keyboard.press('Enter');
  await other.locator('[data-spawn-sheet] [data-preset]').first().waitFor();
  await other.locator('[data-preset="research"]').click();
  await other.locator('[data-spawn-chat]', { hasText: 'Chat with Researcher' }).click();
  await other.locator('[data-spawn-text]').fill('A second thought');
  await other.locator('[data-spawn-go]').click();
  await openChatSheet(other);
  await other.waitForFunction(() => document.querySelector('[data-chat-persona]')?.value === 'researcher');
  assert.equal(await other.locator('textarea[aria-label="Message"]').inputValue(), 'A second thought');
  assert.equal(await other.locator('.hub-bubble').count(), 0, 'A fresh conversation, not the busy one.');
  assert.equal(await other.locator('[data-chat-model] option:checked').innerText(), 'Codex 6.1 Sol');
  await other.goto(`${slow.url}#/~hub/needs`);
  await other.goto(`${slow.url}#/~hub/chat`);
  await openChatSheet(other);
  assert.equal(await other.locator('[data-chat-persona]').inputValue(), 'hermes', 'No old start comes back.');
  assert.equal(await other.locator('textarea[aria-label="Message"]').inputValue(), '');

  step('Another template is unchanged: its fields and estimate come back');
  await page.goto(`${fx.url}#/~hub/today`);
  await page.locator('[data-spawn-open]').click();
  await page.locator('[data-spawn-sheet] [data-preset]').first().waitFor();
  await page.locator('[data-spawn-chat]').click();
  await page.locator('[data-preset="code-task"]').click();
  assert.equal(await page.locator('[data-spawn-chat]').getAttribute('aria-pressed'), 'false');
  await page.locator('[data-spawn-project]').waitFor();
  await page.locator('[data-spawn-estimate]').waitFor();
  assert.notEqual(await page.locator('[data-spawn-go]').innerText(), 'Open chat');
  await page.keyboard.press('Escape');

  step('Phone: the tile is there, tappable, and the sheet does not scroll sideways');
  const phone = await open({ width: 390, height: 844 }, { hasTouch: true, isMobile: true });
  await phone.goto(`${fx.url}#/~hub/needs`);
  await phone.locator('.needs-actions [data-spawn-open]').click();
  await phone.locator('[data-spawn-chat]').click();
  await phone.locator('[data-spawn-text]').fill('A quick question');
  const box = await phone.locator('[data-spawn-chat]').boundingBox();
  assert.ok(box.height >= 44 && box.x >= 0 && box.x + box.width <= 390);
  await noSideways(phone, 'chat tile');
  await shot(phone, 'spawn-chat-phone');
  await phone.locator('[data-spawn-go]').click();
  await phone.waitForFunction(() => document.querySelector('textarea[aria-label="Message"]')?.value === 'A quick question');
  await shot(phone, 'chat-opened-phone');

  console.log('hub-spawn-chat-ui: passed');
} finally {
  for (const context of contexts) await context.close().catch(() => {});
  await browser.close();
  for (const fixture of fixtures) await fixture.close().catch(() => {});
}
