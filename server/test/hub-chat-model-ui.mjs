// Run after npm run build. The Model menu of Chat and Get help through a real browser, over the fixture service with the fake
// Hermes on runs: New chat starts on Auto; Haiku is sent as a run on the Anthropic API; the chat reopens on Haiku with the
// footer under the reply and the tag in the drawer; Get help shows the menu on Auto; "Start a job instead..." opens the Spawn
// sheet with the draft and sends nothing; at 390 px the menu line does not wrap and the page does not scroll sideways.
import { chromium } from '@playwright/test';
import { ms } from './ui-timeouts.mjs';
import assert from 'node:assert/strict';
import { startHubFixture } from './hub-fixture.mjs';
import { closeChatSheet, openChatSheet } from './shell-helpers.mjs';

const step = name => console.log(`- ${name}`);
const channel = process.env.BUW_TEST_BROWSER || 'msedge';
const browser = await chromium.launch({ headless: true, channel });
const fixtures = [];
const open = async (viewport, options = {}) => {
  const context = await browser.newContext({ viewport, serviceWorkers: 'block', reducedMotion: 'reduce', ...options });
  const page = await context.newPage();
  page.setDefaultTimeout(ms(15000));
  page.on('pageerror', error => { throw error; });
  return page;
};
const chatFiles = fixture => [...fixture.fake.objects.keys()].filter(key => /inbox\/chat\/[^/]+\.jsonl$/.test(key));
const selected = page => page.locator('[data-chat-model]').evaluate(select => select.options[select.selectedIndex].textContent);
try {
  const fx = await startHubFixture({ hermes: true, chatRuns: true });
  fixtures.push(fx);
  const page = await open({ width: 1280, height: 900 });

  step('New chat: the menu reads Auto and lists the choices and the job entry');
  await page.goto(`${fx.url}#/~hub/chat`);
  await openChatSheet(page);
  assert.equal(await selected(page), 'Auto · Codex first');
  const options = await page.locator('[data-chat-model] option').evaluateAll(list => list.map(option => option.textContent));
  assert.deepEqual(options, ['Auto · Codex first', 'Codex 6.1 Sol', 'Codex 6.1 Terra', 'Codex 6 Astra', 'Codex 6 Luna', 'Sonnet 5.5 · API', 'Haiku 5.5 · API', 'Opus 5.5 · API', 'DeepSeek Flash · API', '──────────', 'Start a job instead…']);
  assert.match(await page.locator('[data-chat-model-note]').innerText(), /Codex/);

  step('Haiku: the run names the Anthropic pair, the footer says Haiku, the chat reopens on Haiku and the drawer tags it');
  await page.locator('[data-chat-model]').selectOption('haiku');
  await closeChatSheet(page);
  await page.locator('textarea[aria-label="Message"]').fill('Say hi');
  await page.keyboard.press('Enter');
  await page.locator('.hub-bubble.assistant [data-bubble-model]', { hasText: 'Haiku 5.5' }).waitFor();
  assert.equal(fx.hermes.runs.length, 1);
  assert.equal(fx.hermes.runs[0].body.provider, 'anthropic');
  assert.equal(fx.hermes.runs[0].body.model, 'claude-haiku-5-5');
  assert.match(page.url(), /#\/~hub\/chat\/\d{8}-[a-z0-9]{6}$/);
  await page.reload();
  await page.locator('.hub-bubble.assistant').first().waitFor();
  await openChatSheet(page);
  assert.equal(await selected(page), 'Haiku 5.5 · API');
  await page.locator('.hub-bubble.assistant [data-bubble-model]', { hasText: 'Haiku 5.5' }).waitFor();
  assert.equal((await page.locator('[data-conversation-model]').first().innerText()).trim(), 'Haiku 5.5');

  step('Opus: the menu marks it as billed through the API and says so; picking it sends the Anthropic Opus pair');
  await page.goto(`${fx.url}#/~hub/chat`);
  await openChatSheet(page);
  await page.locator('[data-chat-model]').selectOption('opus');
  assert.equal(await selected(page), 'Opus 5.5 · API');
  assert.match(await page.locator('[data-chat-model-note]').innerText(), /Billed through the Anthropic API, the most expensive here/);
  await page.locator('textarea[aria-label="Message"]').fill('Say hi to Opus');
  await page.keyboard.press('Enter');
  await page.locator('.hub-bubble.assistant [data-bubble-model]', { hasText: 'Opus' }).waitFor();
  assert.equal(fx.hermes.runs.length, 2);
  assert.deepEqual([fx.hermes.runs[1].body.provider, fx.hermes.runs[1].body.model], ['anthropic', 'claude-opus-5-5']);

  step('a new chat after that starts on Auto again, and an Auto turn names no provider');
  await page.goto(`${fx.url}#/~hub/chat`);
  await openChatSheet(page);
  assert.equal(await selected(page), 'Auto · Codex first');
  await page.locator('textarea[aria-label="Message"]').fill('Say hi again');
  await page.keyboard.press('Enter');
  await page.locator('.hub-bubble.assistant').first().waitFor();
  await page.waitForURL(/#\/~hub\/chat\/\d{8}-[a-z0-9]{6}$/);
  assert.equal(fx.hermes.runs.length, 3);
  assert.ok(!('provider' in fx.hermes.runs[2].body) && !('model' in fx.hermes.runs[2].body));
  assert.equal(await page.locator('[data-bubble-model]').count(), 0, 'Auto shows no footer.');

  step('Start a job instead: the Spawn sheet opens with the draft, nothing is sent, the menu keeps its value');
  await page.goto(`${fx.url}#/~hub/chat`);
  await openChatSheet(page);
  const filesBefore = chatFiles(fx).length;
  await page.locator('textarea[aria-label="Message"]').fill('Research tug-of-war card games');
  await page.locator('[data-chat-model]').selectOption({ label: 'Start a job instead…' });
  await page.locator('[data-spawn-sheet]').waitFor();
  assert.equal(await page.locator('[data-spawn-text]').inputValue(), 'Research tug-of-war card games');
  assert.equal(chatFiles(fx).length, filesBefore);
  assert.equal(fx.hermes.runs.length, 3);
  await page.goBack();   // Spawn's own entry
  await page.locator('[data-spawn-sheet]').waitFor({ state: 'detached' });
  await openChatSheet(page);
  assert.equal(await selected(page), 'Auto · Codex first');

  step('Get help: the menu shows on Auto');
  await page.goto(`${fx.url}#/~hub/needs`);
  await page.locator('[data-get-help]').first().waitFor();
  await page.locator('[data-get-help]').first().click();
  await openChatSheet(page);
  assert.match(page.url(), /#\/~hub\/chat\/help\//);
  assert.equal(await selected(page), 'Auto · Codex first');

  step('an old chat saved on a retired row id opens on its family row and still sends');
  const oldAt = new Date().toISOString();
  const oldLines = [{ role: 'user', text: 'Saved on the old row', at: oldAt, model: 'codex-6-1-sol' }, { role: 'assistant', text: 'Old answer', at: oldAt, model: 'codex-6-1-sol' }];
  fx.fake.seed('sections/inbox/chat/20261104-oldrw1.jsonl', oldLines.map(line => JSON.stringify(line)).join('\n') + '\n', 'application/x-ndjson');
  await page.goto(`${fx.url}#/~hub/chat/20261104-oldrw1`);
  await page.locator('.hub-bubble.assistant', { hasText: 'Old answer' }).waitFor();
  await openChatSheet(page);
  await page.waitForFunction(() => document.querySelector('[data-chat-model] option:checked')?.textContent === 'Codex 6.1 Sol');
  await closeChatSheet(page);
  const runsBefore = fx.hermes.runs.length;
  await page.locator('textarea[aria-label="Message"]').fill('Still works?');
  await page.keyboard.press('Enter');
  await page.locator('.hub-bubble.assistant').nth(1).waitFor();
  for (let tries = 0; fx.hermes.runs.length === runsBefore && tries < 100; tries++) await page.waitForTimeout(100);
  const sent = fx.hermes.runs.at(-1);
  assert.equal(fx.hermes.runs.length, runsBefore + 1);
  assert.deepEqual([sent.body.provider, sent.body.model], ['openai-codex', 'gpt-6.1-sol']);

  step('390 px: the sheet fits (its note shows, there is room now) and the page does not scroll sideways');
  const phone = await open({ width: 390, height: 800 }, { hasTouch: true, isMobile: true });
  await phone.goto(`${fx.url}#/~hub/chat/new`);
  await openChatSheet(phone);
  await phone.locator('[data-chat-model]').selectOption('deepseek-flash');
  const line = await phone.locator('[data-chat-model]').evaluate(node => ({ box: node.getBoundingClientRect().toJSON(), scroll: document.scrollingElement.scrollWidth, inner: innerWidth, noteShown: getComputedStyle(document.querySelector('[data-chat-model-note]')).display }));
  assert.ok(line.box.height >= 44 && line.box.left >= 0 && line.box.right <= line.inner, `the model menu fits the sheet (${JSON.stringify(line.box)})`);
  assert.ok(line.scroll <= line.inner, `the page scrolls sideways (${line.scroll} > ${line.inner})`);
  assert.notEqual(line.noteShown, 'none', 'The note shows in the sheet.');
  console.log('ok');
} finally {
  await browser.close();
  for (const fixture of fixtures) await fixture.close();
}
